import { NextRequest } from "next/server";
import { ChatOpenAI } from "@langchain/openai";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { createClient } from "@supabase/supabase-js";
import { searchAndScrapeTool } from "./tools";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const model = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
  apiKey: process.env.OPENAI_API_KEY,
});

const embedModel = new GoogleGenerativeAIEmbeddings({
  model: "models/text-embedding-004",
  apiKey: process.env.GOOGLE_API_KEY,
});

const SYSTEM_PROMPT = `You are a PlayStation expert assistant powered by a retrieval-augmented knowledge base. Answer questions about PlayStation consoles, games, hardware, and products.

You have access to a tool called "search_and_scrape". Use it when:
- The user explicitly asks to search, update, or refresh information
- You have no retrieved context and the question is about recent news or specific details you're unsure about

When you call the tool, tell the user that new information is being gathered and they can ask again shortly.

Be concise, accurate, and admit when you don't know something.`;

const RAG_PROMPT = (context: string, sources: string) =>
  `You are a PlayStation expert assistant powered by a retrieval-augmented knowledge base. Your answers MUST be grounded in the retrieved context below. Do not make up information that isn't in the context.

Rules:
- Base your answer on the provided context. If the context covers the topic, use it as your primary source.
- If the context is insufficient or irrelevant, say so honestly and use the search_and_scrape tool to find new content.
- Cite sources inline using markdown links, e.g. "According to [PlayStation Blog](https://blog.playstation.com/...), the PS5 features..."
- End your answer with a "Sources" section listing all referenced sources as a bulleted list of markdown links.
- Only cite sources you actually used.
- Be concise and accurate.

Context:
${context}
`;

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
    langchainMessages.push(response);

    for (const tc of response.tool_calls) {
      if (tc.name === "search_and_scrape") {
        const result = await searchAndScrapeTool.invoke({ query: tc.args.query });
        const content = typeof result === "string" ? result : JSON.stringify(result);
        langchainMessages.push(new ToolMessage({ content, tool_call_id: tc.id! }));
      }
    }

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
