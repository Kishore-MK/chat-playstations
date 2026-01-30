import { tool } from "@langchain/core/tools";
import { z } from "zod";

const SCRAPER_URL = process.env.SCRAPER_URL ?? "http://localhost:8000";
const SERPER_API_KEY = process.env.SERPER_API_KEY;

export interface SerperImage {
  image_url: string;
  alt_text: string;
  description: string;
  source_url: string;
}

interface SearchResult {
  urls: string[];
  images: SerperImage[];
}

async function searchWeb(query: string): Promise<SearchResult> {
  if (!SERPER_API_KEY) {
    console.warn("SERPER_API_KEY not set, skipping web search");
    return { urls: [], images: [] };
  }

  try {
    // Fire both organic and image search in parallel
    const [organicRes, imageRes] = await Promise.all([
      fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query, num: 5 }),
      }),
      fetch("https://google.serper.dev/images", {
        method: "POST",
        headers: {
          "X-API-KEY": SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query, num: 9 }),
      }),
    ]);

    const urls: string[] = [];
    const images: SerperImage[] = [];

    // Extract URLs + thumbnails from organic results
    if (organicRes.ok) {
      const data = await organicRes.json();
      for (const r of data.organic ?? []) {
        if (r.link) urls.push(r.link);
        // Organic results sometimes have imageUrl or thumbnailUrl
        const imgUrl = r.imageUrl || r.thumbnailUrl;
        if (imgUrl) {
          images.push({
            image_url: imgUrl,
            alt_text: r.title ?? "",
            description: r.snippet ?? "",
            source_url: r.link ?? "",
          });
        }
      }
    }

    // Extract from dedicated image search results
    if (imageRes.ok) {
      const data = await imageRes.json();
      const seen = new Set(images.map((i) => i.image_url));
      for (const r of data.images ?? []) {
        const imgUrl = r.imageUrl || r.thumbnailUrl;
        if (imgUrl && !seen.has(imgUrl)) {
          seen.add(imgUrl);
          images.push({
            image_url: imgUrl,
            alt_text: r.title ?? "",
            description: r.snippet ?? r.title ?? "",
            source_url: r.link ?? "",
          });
        }
      }
    }

    console.log(
      "Serper found %d URLs and %d images for '%s'",
      urls.length,
      images.length,
      query
    );
    return { urls, images: images.slice(0, 9) };
  } catch (err) {
    console.error("Serper search failed:", err);
    return { urls: [], images: [] };
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

// Store the latest images from a tool call so the route can access them
let _lastToolImages: SerperImage[] = [];

export function getLastToolImages(): SerperImage[] {
  const imgs = _lastToolImages;
  _lastToolImages = [];
  return imgs;
}

export const searchAndScrapeTool = tool(
  async ({ query }: { query: string }) => {
    const { urls, images } = await searchWeb(query);

    // Stash images for the route to pick up
    _lastToolImages = images;

    if (urls.length === 0) {
      return "No relevant URLs found for this query.";
    }
    await triggerScraper(urls);
    return `Found and triggered scraping for ${urls.length} URLs: ${urls.join(", ")}. New content will be available in the knowledge base shortly.`;
  },
  {
    name: "search_and_scrape",
    description:
      "Search the web for PlayStation-related pages and trigger the scraper to index them into the knowledge base. Use when the user explicitly asks to update knowledge or search for something, or when you truly lack information to answer.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "A short, simple web search query (3-6 words). Example: 'PS5 Pro specs release date'. Do NOT use quotes or long sentences."
        ),
    }),
  }
);
