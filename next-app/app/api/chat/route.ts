import { NextRequest } from "next/server";
import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { createClient } from "@supabase/supabase-js";
import { searchAndScrapeTool } from "./tools";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const model = new ChatOpenAI({
  model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY,
});

const embedModel = new GoogleGenerativeAIEmbeddings({
  model: "models/text-embedding-004",
  apiKey: process.env.GOOGLE_API_KEY,
});

function buildSystemPrompt(context: string): string {
  return `You are a PlayStation expert assistant powered by a retrieval-augmented knowledge base.

You have access to a tool called "search_and_scrape" that searches the web and triggers scraping of new content into your knowledge base.

${context ? `## Retrieved Context
The following content was retrieved from your knowledge base. Evaluate whether it is relevant and sufficient to answer the user's question.

${context}

## Instructions
- If the retrieved context is relevant and sufficient, answer using ONLY the context above. Do not make up information.
- If the retrieved context is irrelevant, outdated, or insufficient for the question, call the search_and_scrape tool to find better information.
- If the user explicitly asks to search, update, or refresh information, always call the tool regardless of context.` : `## Instructions
- No relevant content was found in the knowledge base for this query.
- Use the search_and_scrape tool to find and index relevant content.
- If the question is general PlayStation knowledge you're confident about, you may answer directly.
- If the user explicitly asks to search or update, always call the tool.`}

## Response Rules
- Be concise and accurate. Admit when you don't know something.
- When using retrieved context, cite sources inline with markdown links, e.g. "According to [PlayStation Blog](https://url)..."
- End your answer with a "Sources" section listing referenced sources as bulleted markdown links.
- Only cite sources you actually used.
- When you call the tool, tell the user new information is being gathered and they can ask again shortly.`;
}

// Create the LangChain agent — handles the ReAct tool-calling loop automatically
const agent = createAgent({
  model,
  tools: [searchAndScrapeTool],
});

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
  const systemPrompt = buildSystemPrompt(context);

  const agentMessages = [
    { role: "system" as const, content: systemPrompt },
    ...messages.map((m: { role: string; content: string }) =>
      m.role === "user"
        ? new HumanMessage(m.content)
        : new AIMessage(m.content)
    ),
  ];

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        const stream = await agent.stream(
          { messages: agentMessages },
          { streamMode: "messages" }
        );

        for await (const [chunk, metadata] of stream) {
          // Only stream AI text tokens — skip tool calls and tool result nodes
          if (
            chunk._getType() === "ai" &&
            typeof chunk.content === "string" &&
            chunk.content &&
            !metadata?.langgraph_node?.includes("tools")
          ) {
            controller.enqueue(encoder.encode(chunk.content));
          }
        }

        // Append sources footer after agent finishes
        if (sources) {
          const footer = `\n\n---\n\n**Sources:**\n${sources
            .split("\n")
            .map((s) => `- ${s}`)
            .join("\n")}`;
          controller.enqueue(encoder.encode(footer));
        }
      } catch (err) {
        console.error("Agent stream error:", err);
        controller.enqueue(
          encoder.encode("An error occurred while processing your request.")
        );
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
