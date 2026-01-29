import { tool } from "@langchain/core/tools";
import { z } from "zod";

const SCRAPER_URL = process.env.SCRAPER_URL ?? "http://localhost:8000";
const SERPER_API_KEY = process.env.SERPER_API_KEY;

async function searchWeb(query: string): Promise<string[]> {
  if (!SERPER_API_KEY) {
    console.warn("SERPER_API_KEY not set, skipping web search");
    return [];
  }

  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: `PlayStation ${query}`,
        num: 5,
      }),
    });

    if (!res.ok) return [];

    const data = await res.json();
    const urls: string[] = (data.organic ?? [])
      .map((r: { link?: string }) => r.link)
      .filter(Boolean);

    console.log("Serper found %d URLs for '%s'", urls.length, query);
    return urls;
  } catch (err) {
    console.error("Serper search failed:", err);
    return [];
  }
}

async function triggerScraper(urls: string[]): Promise<void> {
  if (urls.length === 0) return;

  try {
    await fetch(`${SCRAPER_URL}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, max_pages: 5 }),
    });
    console.log("Scraper triggered for %d URLs", urls.length);
  } catch (err) {
    console.error("Failed to trigger scraper:", err);
  }
}

export const searchAndScrapeTool = tool(
  async ({ query }: { query: string }) => {
    const urls = await searchWeb(query);
    if (urls.length === 0) {
      return "No relevant URLs found for this query.";
    }
    await triggerScraper(urls);
    return `Found and triggered scraping for ${urls.length} URLs: ${urls.join(", ")}. New content will be available in the knowledge base shortly.`;
  },
  {
    name: "search_and_scrape",
    description:
      "Search the web for PlayStation-related pages and trigger the scraper to index them into the knowledge base. Use when the user asks to update knowledge, or when you lack information to answer accurately.",
    schema: z.object({
      query: z
        .string()
        .describe("The search query describing what PlayStation content to find"),
    }),
  }
);
