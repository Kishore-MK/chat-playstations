import logging
import os

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI
from pydantic import BaseModel

from scraper import crawl_site
from supabase_db import init_db

load_dotenv()

logging.basicConfig(level=logging.INFO)

MAX_PAGES = int(os.getenv("MAX_PAGES", "20"))

app = FastAPI()


class ScrapeRequest(BaseModel):
    urls: list[str]
    max_pages: int = MAX_PAGES


@app.on_event("startup")
def on_startup():
    init_db()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/scrape")
async def scrape(req: ScrapeRequest, background_tasks: BackgroundTasks):
    for url in req.urls:
        background_tasks.add_task(crawl_site, url, req.max_pages)
    return {"message": "Crawl triggered", "urls": req.urls, "max_pages": req.max_pages}
