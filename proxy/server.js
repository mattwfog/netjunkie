import express from "express";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = resolve(__dirname, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = parseInt(process.env.PORT || "9877", 10);
const ALLOWED_EXTENSION_ID = process.env.EXTENSION_ID || null;

if (!GEMINI_API_KEY || !ANTHROPIC_API_KEY) {
  console.error("Missing GEMINI_API_KEY or ANTHROPIC_API_KEY in .env");
  process.exit(1);
}

if (!ALLOWED_EXTENSION_ID) {
  console.warn(
    "WARNING: No EXTENSION_ID set in .env. Any chrome extension can access this proxy.\n" +
    "Set EXTENSION_ID=<your-extension-id> after loading the extension in chrome://extensions"
  );
}

const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 60;
let requestTimestamps = [];

function checkRateLimit() {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter((t) => now - t < RATE_WINDOW_MS);
  if (requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  requestTimestamps = [...requestTimestamps, now];
  return true;
}

const SUMMARIZE_TIMEOUT_MS = 30_000;
const ANALYZE_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(url, options, timeoutMs = SUMMARIZE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

function truncate(body, maxLen = 2000) {
  if (!body) return null;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + "...[truncated]";
}

const app = express();
app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin || "";

  if (ALLOWED_EXTENSION_ID) {
    const expectedOrigin = `chrome-extension://${ALLOWED_EXTENSION_ID}`;
    if (origin === expectedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
  } else if (origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method === "POST") {
    if (ALLOWED_EXTENSION_ID) {
      const expectedOrigin = `chrome-extension://${ALLOWED_EXTENSION_ID}`;
      if (origin !== expectedOrigin) {
        res.status(403).json({ error: "Forbidden: unknown origin" });
        return;
      }
    }

    if (!checkRateLimit()) {
      res.status(429).json({ error: "Rate limit exceeded. Max 60 requests/minute." });
      return;
    }
  }

  next();
});

app.post("/summarize", async (req, res) => {
  const { entry } = req.body;
  if (
    !entry ||
    !entry.method || typeof entry.method !== "string" ||
    !entry.url || typeof entry.url !== "string" ||
    typeof entry.status !== "number"
  ) {
    res.status(400).json({ error: "Invalid entry: requires method (string), url (string), status (number)" });
    return;
  }

  const compact = {
    method: entry.method,
    url: entry.url,
    status: entry.status,
    requestContentType: entry.requestContentType || null,
    requestBody: truncate(entry.requestBody),
    responseContentType: entry.responseContentType || null,
    responseBody: truncate(entry.responseBody),
    responseSize: entry.responseSize || 0,
    durationMs: entry.durationMs || 0,
  };

  const prompt = `You are a network traffic analyst. Summarize what this HTTP request did in 1-2 concise sentences. Focus on the action performed, data exchanged, and any notable patterns. Be specific about what data was sent/received, not generic descriptions.

Request:
${JSON.stringify(compact, null, 2)}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

  try {
    const resp = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.3 },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      res.status(resp.status).json({ error: errText });
      return;
    }

    const data = await resp.json();
    const candidate = data.candidates && data.candidates[0];
    if (!candidate || !candidate.content || !candidate.content.parts) {
      res.status(502).json({ error: "Unexpected Gemini response format" });
      return;
    }

    const summary = candidate.content.parts.map((p) => p.text).join("");
    res.json({ summary });
  } catch (err) {
    if (err.name === "AbortError") {
      res.status(504).json({ error: "Gemini API request timed out" });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.post("/analyze", async (req, res) => {
  const { entries, totalCaptured } = req.body;
  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    res.status(400).json({ error: "Missing or empty entries array" });
    return;
  }

  const summaries = entries.map((e, i) => ({
    index: i,
    method: e.method || "UNKNOWN",
    url: e.url || "",
    status: e.status || 0,
    durationMs: e.durationMs || 0,
    requestBody: truncate(e.requestBody, 500),
    responseBody: truncate(e.responseBody, 500),
    responseSize: e.responseSize || 0,
    contentType: e.contentType || null,
    aiSummary: e.aiSummary || null,
  }));

  const totalNote = totalCaptured && totalCaptured > summaries.length
    ? `\n\nNote: ${totalCaptured} total requests were captured. These ${summaries.length} were selected as the most likely to be high-value (mutations, auth, errors, requests with bodies/cookies). Low-value requests (static assets, trackers, polling duplicates) were filtered out.`
    : "";

  const prompt = `You are a senior security and product analyst reviewing a captured session of network requests from a web application.

Analyze these ${summaries.length} network requests and identify the HIGH-VALUE actions - requests that represent meaningful user actions, sensitive data exchanges, authentication flows, payment processing, data mutations, PII transfers, API key usage, or any security-relevant activity.

For each high-value request, explain:
1. What it does and why it matters
2. What sensitive data is involved (if any)
3. Security implications or concerns

Group related requests into logical flows where applicable (e.g., "Login Flow: requests #3, #7, #12").

Ignore static asset loads, analytics pings, and routine polling unless they leak sensitive data.${totalNote}

Network Requests:
${JSON.stringify(summaries, null, 2)}`;

  try {
    const resp = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    }, ANALYZE_TIMEOUT_MS);

    if (!resp.ok) {
      const errText = await resp.text();
      res.status(resp.status).json({ error: errText });
      return;
    }

    const data = await resp.json();
    if (!data.content || !data.content[0]) {
      res.status(502).json({ error: "Unexpected Anthropic response format" });
      return;
    }

    const analysis = data.content.map((block) => block.text).join("\n");
    res.json({ analysis });
  } catch (err) {
    if (err.name === "AbortError") {
      res.status(504).json({ error: "Anthropic API request timed out" });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`NetJunkie proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`Gemini key: ...${GEMINI_API_KEY.slice(-4)}`);
  console.log(`Anthropic key: ...${ANTHROPIC_API_KEY.slice(-4)}`);
  if (ALLOWED_EXTENSION_ID) {
    console.log(`Locked to extension: ${ALLOWED_EXTENSION_ID}`);
  }
});
