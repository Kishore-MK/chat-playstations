"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";

interface ImageData {
  image_url: string;
  alt_text: string;
  description: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: ImageData[];
}

const IMAGE_DELIMITER = "<!--IMAGES_JSON-->";

function parseStreamContent(raw: string): { text: string; images: ImageData[] } {
  const idx = raw.indexOf(IMAGE_DELIMITER);
  if (idx === -1) return { text: raw, images: [] };
  const text = raw.slice(0, idx);
  try {
    const images = JSON.parse(raw.slice(idx + IMAGE_DELIMITER.length));
    return { text, images };
  } catch {
    return { text, images: [] };
  }
}

let nextId = 0;

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const query = input.trim();
    if (!query || isLoading) return;

    const userMsg: Message = { id: String(nextId++), role: "user", content: query };
    const assistantId = String(nextId++);
    const updated = [...messages, userMsg];

    setMessages(updated);
    setInput("");
    setIsLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: updated.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error("Stream failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let rawContent = "";

      // Add empty assistant message to start streaming into
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "" },
      ]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawContent += decoder.decode(value, { stream: true });
        const { text, images } = parseStreamContent(rawContent);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: text, images } : m
          )
        );
      }

      // Final parse after stream ends
      const { text, images } = parseStreamContent(rawContent);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: text, images } : m
        )
      );
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: "assistant",
          content: "Failed to reach the server.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  const showThinking =
    isLoading && messages[messages.length - 1]?.role === "user";

  return (
    <div className="flex h-dvh flex-col" style={{ background: "var(--background)" }}>
      {/* Header */}
      <header
        className="flex items-center gap-2 border-b px-5 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <span className="text-lg font-semibold tracking-tight">PlayStation Chat</span>
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {messages.length === 0 && !isLoading && (
            <div className="flex flex-col items-center justify-center gap-2 pt-32 text-center">
              <p className="text-2xl font-semibold">What do you want to know?</p>
              <p style={{ color: "var(--muted-foreground)" }} className="text-sm">
                Ask anything about PlayStation history, hardware, or games.
              </p>
            </div>
          )}

          {messages.map((msg, index) => (
            <div key={index}>
              <div
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className="max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed overflow-hidden break-words"
                  style={
                    msg.role === "user"
                      ? { background: "var(--accent)", color: "#fff" }
                      : { background: "var(--muted)", color: "var(--foreground)" }
                  }
                >
                  {msg.role === "assistant" ? (
                    <div className="prose prose-invert prose-sm max-w-none break-words [&_a]:break-all">
                      <ReactMarkdown
                        components={{
                          a: ({ href, children }) => (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-400 underline hover:text-blue-300"
                            >
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <span className="whitespace-pre-wrap">{msg.content}</span>
                  )}
                </div>
              </div>

              {/* Image grid below assistant message */}
              {msg.role === "assistant" && msg.images && msg.images.length > 0 && (
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 max-w-[80%]">
                  {msg.images.map((img, i) => (
                    <a
                      key={i}
                      href={img.image_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group overflow-hidden rounded-lg border"
                      style={{ borderColor: "var(--border)", background: "var(--muted)" }}
                    >
                      <img
                        src={img.image_url}
                        alt={img.alt_text || img.description}
                        loading="lazy"
                        className="aspect-video w-full object-cover transition-transform group-hover:scale-105"
                      />
                      {(img.alt_text || img.description) && (
                        <p
                          className="truncate px-2 py-1.5 text-xs"
                          style={{ color: "var(--muted-foreground)" }}
                        >
                          {img.alt_text || img.description}
                        </p>
                      )}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}

          {showThinking && (
            <div className="flex justify-start">
              <div
                className="flex items-center gap-1 rounded-2xl px-4 py-3"
                style={{ background: "var(--muted)" }}
              >
                <span className="thinking-dot h-2 w-2 rounded-full" style={{ background: "var(--muted-foreground)" }} />
                <span className="thinking-dot h-2 w-2 rounded-full" style={{ background: "var(--muted-foreground)" }} />
                <span className="thinking-dot h-2 w-2 rounded-full" style={{ background: "var(--muted-foreground)" }} />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </main>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="border-t px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <div
          className="mx-auto flex max-w-2xl items-center gap-2 rounded-xl border px-3 py-2"
          style={{ borderColor: "var(--border)", background: "var(--muted)" }}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about PlayStation..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-500"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-opacity disabled:opacity-30"
            style={{ background: "var(--accent)" }}
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
