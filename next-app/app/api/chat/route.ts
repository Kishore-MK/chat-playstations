import { NextRequest } from "next/server";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { createClient } from "@supabase/supabase-js";
import { searchAndScrapeTool } from "./tools";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const model = new ChatGoogleGenerativeAI({
  model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
  apiKey: process.env.GOOGLE_API_KEY,
});

const embedModel = new GoogleGenerativeAIEmbeddings({
  model: "models/text-embedding-004",
  apiKey: process.env.GOOGLE_API_KEY,
});

const SYSTEM_PROMPT = `You are a PlayStation expert assistant. Answer questions about PlayStation history, hardware, games, and products. Be concise and accurate. If you're unsure about something, say so.

You have access to a tool called "search_and_scrape". Use it when:
- The user asks you to update, refresh, or learn about specific PlayStation topics
- You don't have enough information to answer about playstation related questions accurately
- The user asks about very recent or specific PlayStation news, products, or specs

When you call the tool, it will search the web for relevant pages and trigger a background scraper to add the content to the knowledge base. Let the user know that new information is being gathered and will be available shortly.`;

const RAG_PROMPT = (context: string, sources: string) =>
  `${SYSTEM_PROMPT}

Use the following retrieved context to answer the user's question. If the context doesn't contain relevant information, you may use the search_and_scrape tool to find and index new content.

IMPORTANT - Citation rules:
- When using information from the context, cite the source inline using markdown links. For example: "According to [PlayStation Blog](https://blog.playstation.com/...), the PS5 features..."
- Reference sources naturally in your answer, e.g. "Based on [source title](url)..." or "As described on [source title](url)..."
- At the end of your answer, include a "Sources" section listing all sources you referenced as a bulleted list of markdown links
- Only cite sources you actually used in your answer

Context:
${context}

Available sources:
${sources}`;

const modelWithTools = model.bindTools([searchAndScrapeTool]);

interface RetrievalResult {
  context: string;
  sources: string;
}

async function retrieveContext(query: string): Promise<RetrievalResult> {
  const queryEmbedding = await embedModel.embedQuery(query);

  console.log("Query embedding length:", queryEmbedding.length);

  const { data, error } = await supabase.rpc("match_playstation_content", {
    query_embedding: queryEmbedding,
    match_threshold: 0.5,
    match_count: 5,
  });

  if (error) {
    console.error("Supabase RPC error:", error);
    return { context: "", sources: "" };
  }

  if (!data || data.length === 0) {
    console.log("No matching context found for query");
    return { context: "", sources: "" };
  }

  console.log("Retrieved %d chunks from pgvector", data.length);

  // Deduplicate sources by URL
  const seenUrls = new Set<string>();
  const uniqueSources: { title: string; url: string }[] = [];

  const context = data
    .map(
      (row: { text: string; page_title: string; source_url: string }) => {
        if (!seenUrls.has(row.source_url)) {
          seenUrls.add(row.source_url);
          uniqueSources.push({ title: row.page_title, url: row.source_url });
        }
        return `[Source: ${row.page_title}](${row.source_url}):\n${row.text}`;
      }
    )
    .join("\n\n---\n\n");

  const sources = uniqueSources
    .map((s, i) => `${i + 1}. [${s.title}](${s.url})`)
    .join("\n");

  return { context, sources };
}

export async function POST(req: NextRequest) {
  const { messages } = await req.json();

  const lastUserMessage = [...messages]
    .reverse()
    .find((m: { role: string }) => m.role === "user")?.content ?? "";

  const { context, sources } = await retrieveContext(lastUserMessage);
  const systemPrompt = context ? RAG_PROMPT(context, sources) : SYSTEM_PROMPT;

  const langchainMessages = [
    new SystemMessage(systemPrompt),
    ...messages.map((m: { role: string; content: string }) =>
      m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)
    ),
  ];

  // First call: model may respond directly or call a tool
  const response = await modelWithTools.invoke(langchainMessages);

  // If the model called the tool, execute it and get a final streamed answer
  if (response.tool_calls && response.tool_calls.length > 0) {
    const toolResults: string[] = [];
    for (const tc of response.tool_calls) {
      if (tc.name === "search_and_scrape") {
        const result = await searchAndScrapeTool.invoke({ query: tc.args.query });
        toolResults.push(typeof result === "string" ? result : JSON.stringify(result));
      }
    }

    langchainMessages.push(response);
    langchainMessages.push(
      new HumanMessage({ content: `[Tool results]: ${toolResults.join("\n")}` })
    );

    const stream = await model.stream(langchainMessages);
    return streamResponse(stream, "");
  }

  // No tool call — stream the response, append sources footer if we had context
  const stream = await model.stream(langchainMessages);
  return streamResponse(stream, sources);
}

function streamResponse(
  stream: AsyncIterable<{ content: string | object }>,
  sourcesFooter: string
): Response {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      for await (const chunk of stream) {
        const text =
          typeof chunk.content === "string"
            ? chunk.content
            : JSON.stringify(chunk.content);
        controller.enqueue(encoder.encode(text));
      }

      // Append sources footer after the LLM stream finishes
      if (sourcesFooter) {
        const footer = `\n\n---\n\n**Sources:**\n${sourcesFooter
          .split("\n")
          .map((s) => `- ${s}`)
          .join("\n")}`;
        controller.enqueue(encoder.encode(footer));
      }

      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
    },
  });
}
