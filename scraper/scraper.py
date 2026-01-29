import logging
import os
import re
import time
from urllib.parse import urlparse

import numpy as np
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
from crawl4ai.content_filter_strategy import PruningContentFilter
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

from supabase_db import is_recently_scraped, store_chunks

logger = logging.getLogger(__name__)

EMBED_RETRIES = int(os.getenv("EMBED_RETRIES", "5"))
EMBED_RETRY_DELAY = int(os.getenv("EMBED_RETRY_DELAY", "10"))

embeddings = GoogleGenerativeAIEmbeddings(
    model="models/text-embedding-004",
    google_api_key=os.getenv("GOOGLE_API_KEY"),
)

text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=200,
)

# Crawl4AI content filter — prunes nav, footer, sidebar, boilerplate automatically
prune_filter = PruningContentFilter(
    threshold=0.45,
    threshold_type="dynamic",
    min_word_threshold=5,
)

crawl_config = CrawlerRunConfig(
    markdown_generator=DefaultMarkdownGenerator(content_filter=prune_filter),
)

MIN_CHUNK_LEN = 100
MAX_CHUNK_LEN = 1000
MIN_WORD_COUNT = 15
MAX_LINK_RATIO = 0.3
RELEVANCE_KEYWORDS = re.compile(
    r"playstation|ps[1-5]|psx|dualsense|dualshock|console|specs|hardware|"
    r"blu-ray|controller|gpu|cpu|ram|teraflops|ssd|hdmi|sony|game|"
    r"exclusive|release|update|firmware|store|network|psn|trophy|vita|psp|vr",
    re.IGNORECASE,
)
DEDUP_THRESHOLD = 0.95


def filter_chunks(chunks: list[str]) -> list[str]:
    """Filter chunks by length, word count, link ratio, and keyword relevance."""
    filtered = []
    for chunk in chunks:
        text = chunk.strip()
        length = len(text)
        if length < MIN_CHUNK_LEN or length > MAX_CHUNK_LEN:
            continue
        words = text.split()
        if len(words) < MIN_WORD_COUNT:
            continue
        # Reject chunks that are mostly links
        link_count = len(re.findall(r"\[.*?\]\(.*?\)", text))
        if link_count > 0 and link_count / len(words) > MAX_LINK_RATIO:
            continue
        if not RELEVANCE_KEYWORDS.search(text):
            continue
        filtered.append(text)
    return filtered


def deduplicate(chunks: list[str], vectors: list[list[float]]) -> tuple[list[str], list[list[float]]]:
    """Remove near-duplicate chunks using cosine similarity on embeddings."""
    if not vectors:
        return chunks, vectors

    arr = np.array(vectors)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1
    normed = arr / norms

    keep: list[int] = []
    for i in range(len(normed)):
        is_dup = False
        for j in keep:
            sim = float(np.dot(normed[i], normed[j]))
            if sim > DEDUP_THRESHOLD:
                is_dup = True
                break
        if not is_dup:
            keep.append(i)

    deduped_chunks = [chunks[i] for i in keep]
    deduped_vectors = [vectors[i] for i in keep]
    removed = len(chunks) - len(deduped_chunks)
    if removed:
        logger.info("Removed %d duplicate chunks", removed)
    return deduped_chunks, deduped_vectors


def embed_with_retry(chunks: list[str]) -> list[list[float]]:
    """Call Gemini embeddings with retry on rate limit errors."""
    for attempt in range(1, EMBED_RETRIES + 1):
        try:
            return embeddings.embed_documents(chunks)
        except Exception as e:
            error_msg = str(e).lower()
            if "429" in error_msg or "rate" in error_msg or "quota" in error_msg or "resource" in error_msg:
                logger.warning(
                    "Gemini rate limit hit (attempt %d/%d), retrying in %ds...",
                    attempt, EMBED_RETRIES, EMBED_RETRY_DELAY,
                )
                time.sleep(EMBED_RETRY_DELAY)
            else:
                raise
    raise RuntimeError(f"Gemini embedding failed after {EMBED_RETRIES} retries")


async def crawl_site(start_url: str, max_pages: int):
    """Crawl starting URL and follow same-domain links up to max_pages."""
    base_domain = urlparse(start_url).netloc
    visited: set[str] = set()
    queue: list[str] = [start_url]
    pages_processed = 0

    async with AsyncWebCrawler() as crawler:
        while queue and pages_processed < max_pages:
            url = queue.pop(0)
            if url in visited:
                continue
            visited.add(url)

            if is_recently_scraped(url):
                continue

            logger.info("[%d/%d] Crawling %s", pages_processed + 1, max_pages, url)
            try:
                result = await crawler.arun(url=url, config=crawl_config)
            except Exception:
                logger.exception("Failed to crawl %s", url)
                continue

            if not result.success:
                logger.warning("Crawl unsuccessful for %s", url)
                continue

            # Discover same-domain internal links
            if result.links and "internal" in result.links:
                for link_obj in result.links["internal"]:
                    href = link_obj.get("href", "")
                    if href and href not in visited:
                        parsed = urlparse(href)
                        if parsed.netloc == base_domain:
                            queue.append(parsed._replace(fragment="").geturl())

            # Use fit_markdown (pruned main content) from Crawl4AI, fall back to raw
            markdown = ""
            if result.markdown:
                markdown = (result.markdown.fit_markdown or "").strip()
                if not markdown:
                    markdown = (result.markdown.raw_markdown or "").strip()
            if not markdown:
                logger.warning("No content from %s, skipping", url)
                continue

            title = result.metadata.get("title", url) if result.metadata else url

            try:
                await embed_and_store(url, title, markdown)
                pages_processed += 1
            except Exception:
                logger.exception("Failed to embed/store %s", url)

    logger.info("Crawl complete: %d pages processed from %s", pages_processed, start_url)


async def embed_and_store(url: str, title: str, markdown: str):
    """Chunk, filter, embed, deduplicate, and store a single page's content."""
    raw_chunks = text_splitter.split_text(markdown)
    logger.info("Split %s into %d raw chunks", url, len(raw_chunks))

    chunks = filter_chunks(raw_chunks)
    if not chunks:
        logger.warning("No relevant chunks after filtering for %s", url)
        return
    logger.info("Kept %d/%d chunks after filtering for %s", len(chunks), len(raw_chunks), url)

    vectors = embed_with_retry(chunks)
    logger.info("Generated %d embeddings for %s", len(vectors), url)

    chunks, vectors = deduplicate(chunks, vectors)

    store_chunks(url, title, chunks, vectors)
