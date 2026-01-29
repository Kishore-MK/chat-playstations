# PlayStation RAG Chatbot

A retrieval-augmented generation chatbot that answers questions about PlayStation history, hardware, and products. The system scrapes web content, embeds it into a vector store, and uses it to ground LLM responses.

## Architecture

```
                         +------------------+
                         |    User (Chat)   |
                         +--------+---------+
                                  |
                                  v
                    +-------------+-------------+
                    |   Next.js Frontend        |
                    |   Dark-themed chat UI     |
                    |   Markdown rendering      |
                    |   Streaming responses     |
                    +-------------+-------------+
                                  |
                                  v
                    +-------------+-------------+
                    |   Chat API Route          |
                    |   /api/chat               |
                    |                           |
                    |  1. Embed user query      |
                    |  2. Vector search (RAG)   |
                    |  3. LLM + tool calling    |
                    +---+---------------+-------+
                        |               |
              has context?       no context / update request
                        |               |
                        v               v
              +---------+-----+   +-----+-----------+
              | Supabase      |   | search_and_scrape|
              | pgvector      |   | Tool (Serper)    |
              | similarity    |   +-----+-----------+
              | search        |         |
              +---------------+         v
                                  +-----+-----------+
                                  | Python Scraper  |
                                  | POST /scrape    |
                                  |                 |
                                  | Crawl4AI        |
                                  | Chunk + Filter  |
                                  | Gemini Embed    |
                                  | Store in pgvec  |
                                  +-----------------+
```

## Project Structure

```
chat-playstation/
├── chat-playstation/          # Next.js app
│   ├── app/
│   │   ├── api/chat/
│   │   │   ├── route.ts       # Chat API: RAG pipeline + streaming
│   │   │   └── tools.ts       # LangChain tool: search_and_scrape
│   │   ├── page.tsx           # Chat UI (dark theme, markdown, thinking indicator)
│   │   ├── layout.tsx         # Root layout with Geist fonts
│   │   └── globals.css        # Dark theme + thinking dot animation
│   ├── .env                   # Supabase, Gemini, Serper, Scraper config
│   └── package.json
│
├── scraper/                   # Python FastAPI service
│   ├── main.py                # FastAPI app, /health, /scrape endpoints
│   ├── scraper.py             # Crawl4AI crawler, chunking, embedding, filtering
│   ├── supabase_db.py         # pgvector storage, table init, dedup
│   ├── .env                   # Supabase DB, Google API key
│   └── requirements.txt
│
└── plan.md                    # Original MVP architecture plan
```

## Components

### 1. Frontend (Next.js)

- Dark-themed chat interface
- Streaming token-by-token responses via `ReadableStream`
- Animated thinking indicator while awaiting first token
- Markdown rendering for assistant messages (`react-markdown` + Tailwind Typography)

### 2. Chat API (`/api/chat`)

Handles the full RAG pipeline per request:

1. **Embed** the user query using Gemini `text-embedding-004`
2. **Search** Supabase pgvector via `match_playstation_content` RPC (cosine similarity, threshold 0.7, top 5)
3. **Augment** the system prompt with retrieved context
4. **Generate** a streaming response via Gemini (`gemini-2.5-flash`)
5. **Tool calling** -- Gemini can invoke `search_and_scrape` when it lacks knowledge or the user asks to update

### 3. Tool: `search_and_scrape`

A LangChain tool bound to the Gemini model. When invoked:

1. Searches the web via [Serper.dev](https://serper.dev) API (`PlayStation {query}`)
2. Sends discovered URLs to the Python scraper (`POST /scrape`)
3. Returns a summary to the LLM, which informs the user that new content is being indexed

The LLM decides when to use this tool based on the system prompt instructions.

### 4. Scraper Service (Python/FastAPI)

**Endpoint:** `POST /scrape`
```json
{
  "urls": ["https://www.playstation.com/en-us/ps5/"],
  "max_pages": 20
}
```

Pipeline per URL (runs async in background):

1. **Crawl** -- Crawl4AI fetches the page and follows same-domain internal links (up to `max_pages`)
2. **Chunk** -- `RecursiveCharacterTextSplitter` (1000 chars, 50 overlap)
3. **Filter** -- Length (50-1000 chars), keyword relevance (playstation, console, specs, etc.)
4. **Embed** -- Gemini `text-embedding-004` (768 dimensions) with retry on rate limits (10s delay, 5 attempts)
5. **Deduplicate** -- Cosine similarity > 0.95 between embeddings removes near-duplicates
6. **Store** -- Insert into Supabase `playstation_content` table via pgvector

### 5. Vector Store (Supabase pgvector)

**Table:** `playstation_content`

| Column | Type | Description |
|---|---|---|
| id | BIGSERIAL | Primary key |
| text | TEXT | Chunked content |
| embedding | VECTOR(768) | Gemini embedding |
| source_url | TEXT | Original page URL |
| page_title | TEXT | Page title |
| section_heading | TEXT | (reserved) |
| scraped_at | TIMESTAMPTZ | When scraped |
| created_at | TIMESTAMPTZ | Row creation time |

**Indexes:** IVFFlat on embeddings (cosine), B-tree on `source_url` and `scraped_at`.

**RPC Function:** `match_playstation_content(query_embedding, match_threshold, match_count)` -- cosine similarity search.

## Setup

### Prerequisites

- Node.js / Bun
- Python 3.10+ (3.13 recommended)
- Supabase project with pgvector enabled
- API keys: Google (Gemini), Serper.dev

### Next.js App

```bash
cd chat-playstation
cp .env.example .env   # Fill in your keys
bun install
bun dev
```

### Scraper

```bash
cd scraper
python3.13 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # Fill in your keys
uvicorn main:app --reload --port 8000
```

### Supabase

Run the following in the Supabase SQL editor:

```sql
-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Content table (created automatically by scraper on startup)
-- RPC function for similarity search
CREATE OR REPLACE FUNCTION match_playstation_content(
  query_embedding VECTOR(768),
  match_threshold FLOAT,
  match_count INT
)
RETURNS TABLE (
  id BIGINT,
  text TEXT,
  source_url TEXT,
  page_title TEXT,
  similarity FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id,
    text,
    source_url,
    page_title,
    1 - (embedding <=> query_embedding) AS similarity
  FROM playstation_content
  WHERE 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
```

## Environment Variables

### Next.js (`chat-playstation/.env`)

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase REST API URL |
| `SUPABASE_ANON_KEY` | Supabase anon/public key |
| `GOOGLE_API_KEY` | Gemini API key |
| `GEMINI_MODEL` | Chat model (default: `gemini-2.0-flash`) |
| `SERPER_API_KEY` | Serper.dev API key |
| `SCRAPER_URL` | Scraper service URL (default: `http://localhost:8000`) |

### Scraper (`scraper/.env`)

| Variable | Description |
|---|---|
| `SUPABASE_DB_URL` | Postgres connection string |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `GOOGLE_API_KEY` | Gemini API key (for embeddings) |
| `MAX_PAGES` | Max pages per crawl (default: `20`) |
| `EMBED_RETRIES` | Retry attempts on rate limit (default: `5`) |
| `EMBED_RETRY_DELAY` | Seconds between retries (default: `10`) |
