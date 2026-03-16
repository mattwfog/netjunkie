const NetAPI = (() => {
  const PROXY_URL = "http://127.0.0.1:9877";
  const MAX_BODY_LEN = 2000;
  const MAX_OPUS_ENTRIES = 200;

  function truncate(body) {
    if (!body) return null;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    if (text.length <= MAX_BODY_LEN) return text;
    return text.substring(0, MAX_BODY_LEN) + "...[truncated]";
  }

  function compactEntry(entry) {
    return {
      method: entry.request.method,
      url: entry.request.url,
      status: entry.response.status,
      requestContentType: entry.request.postData
        ? entry.request.postData.mimeType
        : null,
      requestBody: truncate(
        entry.request.postData ? entry.request.postData.text : null
      ),
      responseContentType: entry.response.content.mimeType,
      responseBody: truncate(entry.response.content.body),
      responseSize: entry.response.content.size,
      durationMs: entry.timing.durationMs,
    };
  }

  function compactForAnalysis(entry) {
    return {
      method: entry.request.method,
      url: entry.request.url,
      status: entry.response.status,
      durationMs: entry.timing.durationMs,
      requestBody: truncate(
        entry.request.postData ? entry.request.postData.text : null
      ),
      responseBody: truncate(entry.response.content.body),
      responseSize: entry.response.content.size,
      contentType: entry.response.content.mimeType,
      aiSummary: entry.aiSummary,
    };
  }

  function prioritizeForOpus(entries) {
    const scored = entries.map((e) => {
      let score = 0;
      const method = e.request.method;
      if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") score += 3;
      if (e.request.cookies.length > 0 || e.response.cookies.length > 0) score += 1;
      if (e.aiSummary && !e.aiSummary.startsWith("Error:")) score += 1;
      if (e.response.status >= 400) score += 2;
      if (e.response.status === 401 || e.response.status === 403) score += 2;
      if (e.request.postData) score += 1;
      if (e.skipAi) score -= 2;
      return { entry: e, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, MAX_OPUS_ENTRIES).map((s) => s.entry);
  }

  async function summarizeWithGemini(entry) {
    const response = await fetch(`${PROXY_URL}/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry: compactEntry(entry) }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(err.error || `Proxy error ${response.status}`);
    }

    const data = await response.json();
    return data.summary;
  }

  async function analyzeHighValueWithOpus(entries) {
    const prioritized = prioritizeForOpus(entries);
    const compact = prioritized.map((e) => compactForAnalysis(e));
    const response = await fetch(`${PROXY_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: compact,
        totalCaptured: entries.length,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(err.error || `Proxy error ${response.status}`);
    }

    const data = await response.json();
    return data.analysis;
  }

  return { summarizeWithGemini, analyzeHighValueWithOpus };
})();
