const NetCapture = (() => {
  let entries = [];
  let listening = false;
  let onEntryCallback = null;
  let onDedupCallback = null;

  const MAX_BODY_SIZE = 500_000;

  const SKIP_MIME_PREFIXES = [
    "image/",
    "font/",
    "audio/",
    "video/",
  ];

  const SKIP_MIME_EXACT = [
    "application/octet-stream",
    "application/font-woff",
    "application/font-woff2",
    "application/x-font-ttf",
    "application/x-font-opentype",
  ];

  const SKIP_EXTENSIONS = [
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp3", ".mp4", ".webm", ".ogg", ".wav",
    ".map",
  ];

  const LOW_VALUE_MIME = [
    "text/css",
    "application/javascript",
    "text/javascript",
    "application/x-javascript",
  ];

  const LOW_VALUE_EXTENSIONS = [
    ".css", ".js", ".mjs",
  ];

  const TRACKER_PATTERNS = [
    "google-analytics.com", "www.google-analytics.com",
    "analytics.google.com",
    "googletagmanager.com", "www.googletagmanager.com",
    "facebook.net", "connect.facebook.net",
    "facebook.com/tr",
    "doubleclick.net",
    "hotjar.com",
    "segment.io", "cdn.segment.com", "api.segment.io",
    "mixpanel.com",
    "amplitude.com", "api.amplitude.com",
    "sentry.io",
    "fullstory.com",
    "clarity.ms",
    "newrelic.com", "bam.nr-data.net",
    "datadoghq.com",
    "intercom.io",
    "crisp.chat",
    "heapanalytics.com",
    "mouseflow.com",
    "logrocket.io", "r.lr-ingest.io",
  ];

  // Dedup: maps dedupKey -> entry id
  const dedupIndex = new Map();

  function dedupKey(method, url, status) {
    let pathname = url;
    try {
      pathname = new URL(url).origin + new URL(url).pathname;
    } catch { /* use raw url */ }
    return method + " " + status + " " + pathname;
  }

  function shouldSkip(harEntry) {
    const url = harEntry.request.url;
    const responseMime = harEntry.response.content
      ? (harEntry.response.content.mimeType || "").split(";")[0].trim().toLowerCase()
      : "";

    for (const prefix of SKIP_MIME_PREFIXES) {
      if (responseMime.startsWith(prefix)) return true;
    }
    for (const mime of SKIP_MIME_EXACT) {
      if (responseMime === mime) return true;
    }

    try {
      const pathname = new URL(url).pathname.toLowerCase();
      for (const ext of SKIP_EXTENSIONS) {
        if (pathname.endsWith(ext)) return true;
      }
    } catch { /* invalid url, don't skip */ }

    return false;
  }

  function shouldSkipAi(harEntry) {
    const url = harEntry.request.url;
    const responseMime = harEntry.response.content
      ? (harEntry.response.content.mimeType || "").split(";")[0].trim().toLowerCase()
      : "";

    for (const mime of LOW_VALUE_MIME) {
      if (responseMime === mime) return true;
    }

    try {
      const pathname = new URL(url).pathname.toLowerCase();
      for (const ext of LOW_VALUE_EXTENSIONS) {
        if (pathname.endsWith(ext)) return true;
      }
    } catch { /* */ }

    try {
      const hostname = new URL(url).hostname.toLowerCase();
      for (const tracker of TRACKER_PATTERNS) {
        if (tracker.includes("/")) {
          const lowerUrl = url.toLowerCase();
          if (lowerUrl.includes(tracker)) return true;
        } else if (hostname === tracker || hostname.endsWith("." + tracker)) {
          return true;
        }
      }
    } catch { /* */ }

    return false;
  }

  function capBody(body) {
    if (!body) return null;
    if (typeof body === "string") {
      if (body.length > MAX_BODY_SIZE) return body.substring(0, MAX_BODY_SIZE) + "...[capped]";
      return body;
    }
    const serialized = JSON.stringify(body);
    if (serialized.length > MAX_BODY_SIZE) {
      return serialized.substring(0, MAX_BODY_SIZE) + "...[capped]";
    }
    return body;
  }

  function extractCookies(headers) {
    if (!headers) return [];
    const cookies = [];
    for (const h of headers) {
      const name = h.name.toLowerCase();
      if (name === "cookie") {
        const parts = h.value.split(";").map((p) => p.trim());
        for (const part of parts) {
          const eqIdx = part.indexOf("=");
          if (eqIdx > 0) {
            cookies.push({
              name: part.substring(0, eqIdx).trim(),
              value: part.substring(eqIdx + 1).trim(),
              header: h.name,
            });
          }
        }
      } else if (name === "set-cookie") {
        const firstSemi = h.value.indexOf(";");
        const cookiePart = firstSemi > 0 ? h.value.substring(0, firstSemi) : h.value;
        const eqIdx = cookiePart.indexOf("=");
        if (eqIdx > 0) {
          cookies.push({
            name: cookiePart.substring(0, eqIdx).trim(),
            value: cookiePart.substring(eqIdx + 1).trim(),
            header: h.name,
          });
        }
      }
    }
    return cookies;
  }

  function extractFingerprint(entry) {
    const fp = {};
    const reqHeaders = entry.request.headers || [];
    const headerMap = {};
    for (const h of reqHeaders) {
      headerMap[h.name.toLowerCase()] = h.value;
    }
    if (headerMap["user-agent"]) fp.userAgent = headerMap["user-agent"];
    if (headerMap["accept-language"]) fp.acceptLanguage = headerMap["accept-language"];
    if (headerMap["accept-encoding"]) fp.acceptEncoding = headerMap["accept-encoding"];
    if (headerMap["accept"]) fp.accept = headerMap["accept"];
    if (headerMap["sec-ch-ua"]) fp.clientHints = headerMap["sec-ch-ua"];
    if (headerMap["sec-ch-ua-platform"]) fp.platform = headerMap["sec-ch-ua-platform"];
    if (headerMap["sec-ch-ua-mobile"]) fp.mobile = headerMap["sec-ch-ua-mobile"];
    if (headerMap["sec-fetch-site"]) fp.fetchSite = headerMap["sec-fetch-site"];
    if (headerMap["sec-fetch-mode"]) fp.fetchMode = headerMap["sec-fetch-mode"];
    if (headerMap["sec-fetch-dest"]) fp.fetchDest = headerMap["sec-fetch-dest"];
    if (headerMap["referer"]) fp.referer = headerMap["referer"];
    if (headerMap["origin"]) fp.origin = headerMap["origin"];
    fp.httpVersion = entry.request.httpVersion || null;
    fp.headerOrder = reqHeaders.map((h) => h.name);
    return fp;
  }

  function buildEntry(harEntry, responseBody, skipAi) {
    const req = harEntry.request;
    const res = harEntry.response;

    return {
      id: crypto.randomUUID(),
      timestamp: harEntry.startedDateTime,
      timing: {
        startedAt: harEntry.startedDateTime,
        durationMs: harEntry.time || 0,
        timings: harEntry.timings || null,
      },
      request: {
        method: req.method,
        url: req.url,
        httpVersion: req.httpVersion,
        headers: req.headers,
        cookies: extractCookies(req.headers),
        queryString: req.queryString || [],
        postData: req.postData
          ? {
              mimeType: req.postData.mimeType,
              text: capBody(req.postData.text),
              params: req.postData.params || null,
            }
          : null,
      },
      response: {
        status: res.status,
        statusText: res.statusText,
        httpVersion: res.httpVersion,
        headers: res.headers,
        cookies: extractCookies(res.headers),
        content: {
          mimeType: res.content ? res.content.mimeType : null,
          size: res.content ? res.content.size : 0,
          body: capBody(responseBody),
        },
        redirectURL: res.redirectURL || null,
      },
      fingerprint: extractFingerprint(harEntry),
      serverIP: harEntry.serverIPAddress || null,
      connection: harEntry.connection || null,
      pageRef: harEntry.pageref || null,
      skipAi,
      dupCount: 1,
      lastSeenAt: harEntry.startedDateTime,
      aiSummary: null,
    };
  }

  function handleRequest(harEntry) {
    if (shouldSkip(harEntry)) return;

    const key = dedupKey(
      harEntry.request.method,
      harEntry.request.url,
      harEntry.response.status
    );

    const existingId = dedupIndex.get(key);
    if (existingId) {
      const existing = entries.find((e) => e.id === existingId);
      if (existing) {
        existing.dupCount = (existing.dupCount || 1) + 1;
        existing.lastSeenAt = harEntry.startedDateTime;
        if (onDedupCallback) {
          onDedupCallback(existing);
        }
        return;
      }
    }

    const skipAi = shouldSkipAi(harEntry);

    harEntry.getContent((body) => {
      let parsedBody = body;
      if (body && typeof body === "string") {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          parsedBody = body;
        }
      }

      const entry = buildEntry(harEntry, parsedBody, skipAi);
      entries = [...entries, entry];
      dedupIndex.set(key, entry.id);

      if (onEntryCallback) {
        onEntryCallback(entry);
      }
    });
  }

  function start(callback, dedupCb) {
    if (listening) return;
    listening = true;
    onEntryCallback = callback;
    onDedupCallback = dedupCb;
    dedupIndex.clear();
    chrome.devtools.network.onRequestFinished.addListener(handleRequest);
  }

  function stop() {
    listening = false;
    onEntryCallback = null;
    onDedupCallback = null;
    chrome.devtools.network.onRequestFinished.removeListener(handleRequest);
  }

  function getEntries() {
    return [...entries];
  }

  function clear() {
    entries = [];
    dedupIndex.clear();
  }

  function isListening() {
    return listening;
  }

  return { start, stop, getEntries, clear, isListening };
})();
