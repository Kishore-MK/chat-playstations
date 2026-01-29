import logging
import os
from datetime import datetime, timedelta, timezone

import psycopg2
from pgvector.psycopg2 import register_vector

logger = logging.getLogger(__name__)

SCRAPE_COOLDOWN_HOURS = int(os.getenv("SCRAPE_COOLDOWN_HOURS", "24"))


def get_db_conn():
    conn = psycopg2.connect(os.getenv("SUPABASE_DB_URL"))
    register_vector(conn)
    return conn


def init_db():
    """Create the playstation_content table and pgvector extension if they don't exist."""
    conn = get_db_conn()
    cur = conn.cursor()
    cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS playstation_content (
            id BIGSERIAL PRIMARY KEY,
            text TEXT NOT NULL,
            embedding VECTOR(768),
            source_url TEXT NOT NULL,
            page_title TEXT,
            section_heading TEXT,
            scraped_at TIMESTAMPTZ DEFAULT NOW(),
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS playstation_content_embedding_idx
        ON playstation_content USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100);
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS playstation_content_source_url_idx ON playstation_content(source_url);")
    cur.execute("CREATE INDEX IF NOT EXISTS playstation_content_scraped_at_idx ON playstation_content(scraped_at);")
    conn.commit()
    cur.close()
    conn.close()
    logger.info("Database initialized")


def store_chunks(url: str, title: str, chunks: list[str], vectors: list[list[float]]):
    """Store chunked text and embeddings into Supabase pgvector."""
    conn = get_db_conn()
    cur = conn.cursor()
    now = datetime.now(timezone.utc)

    # Remove old entries for this URL to avoid duplicates on re-scrape
    cur.execute("DELETE FROM playstation_content WHERE source_url = %s", (url,))

    for chunk_text, vector in zip(chunks, vectors):
        cur.execute(
            """INSERT INTO playstation_content
               (text, embedding, source_url, page_title, scraped_at)
               VALUES (%s, %s::vector, %s, %s, %s)""",
            (chunk_text, vector, url, title, now),
        )

    conn.commit()
    cur.close()
    conn.close()
    logger.info("Stored %d chunks from %s", len(chunks), url)


def is_recently_scraped(url: str) -> bool:
    """Check if a URL was scraped within the cooldown period."""
    conn = get_db_conn()
    cur = conn.cursor()
    cutoff = datetime.now(timezone.utc) - timedelta(hours=SCRAPE_COOLDOWN_HOURS)
    cur.execute(
        "SELECT 1 FROM playstation_content WHERE source_url = %s AND scraped_at > %s LIMIT 1",
        (url, cutoff),
    )
    found = cur.fetchone() is not None
    cur.close()
    conn.close()
    if found:
        logger.info("Skipping %s — scraped within the last %d hours", url, SCRAPE_COOLDOWN_HOURS)
    return found
