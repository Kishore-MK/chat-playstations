import logging
import os
from datetime import datetime, timedelta, timezone

from supabase import create_client

logger = logging.getLogger(__name__)

SCRAPE_COOLDOWN_HOURS = int(os.getenv("SCRAPE_COOLDOWN_HOURS", "24"))


def get_supabase():
    return create_client(
        os.getenv("SUPABASE_URL"),
        os.getenv("SUPABASE_SERVICE_KEY"),
    )


def init_db():
    """Create the playstation_content table and pgvector extension if they don't exist.

    Note: Table creation and extensions should be set up via Supabase dashboard
    or SQL editor, as the client library doesn't support DDL operations directly.
    This function is kept for compatibility but is now a no-op.
    """
    logger.info("Database initialization should be done via Supabase dashboard SQL editor")


def store_chunks(url: str, title: str, chunks: list[str], vectors: list[list[float]]):
    """Store chunked text and embeddings into Supabase pgvector."""
    sb = get_supabase()
    now = datetime.now(timezone.utc).isoformat()

    # Remove old entries for this URL to avoid duplicates on re-scrape
    sb.table("playstation_content").delete().eq("source_url", url).execute()

    rows = [
        {
            "text": chunk_text,
            "embedding": vector,
            "source_url": url,
            "page_title": title,
            "scraped_at": now,
        }
        for chunk_text, vector in zip(chunks, vectors)
    ]

    # Insert in batches of 500 to avoid payload limits
    batch_size = 500
    for i in range(0, len(rows), batch_size):
        sb.table("playstation_content").insert(rows[i : i + batch_size]).execute()

    logger.info("Stored %d chunks from %s", len(chunks), url)


def is_recently_scraped(url: str) -> bool:
    """Check if a URL was scraped within the cooldown period."""
    sb = get_supabase()
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=SCRAPE_COOLDOWN_HOURS)).isoformat()
    result = (
        sb.table("playstation_content")
        .select("id")
        .eq("source_url", url)
        .gte("scraped_at", cutoff)
        .limit(1)
        .execute()
    )
    found = len(result.data) > 0
    if found:
        logger.info("Skipping %s — scraped within the last %d hours", url, SCRAPE_COOLDOWN_HOURS)
    return found
