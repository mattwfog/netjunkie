const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const clearBtn = document.getElementById("clearBtn");
const exportBtn = document.getElementById("exportBtn");
const reqCount = document.getElementById("reqCount");
const requestList = document.getElementById("requestList");
const detailPanel = document.getElementById("detailPanel");
const opusOverlay = document.getElementById("opusOverlay");
const opusResult = document.getElementById("opusResult");
const closeOpus = document.getElementById("closeOpus");
const filterInput = document.getElementById("filterInput");
const methodFilter = document.getElementById("methodFilter");

let selectedId = null;
let currentFilter = "";
let currentMethod = "ALL";
const entryDomMap = new Map();

const GEMINI_CONCURRENCY = 3;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 2000;
let activeGeminiCalls = 0;
const geminiQueue = [];

function enqueueGeminiCall(fn) {
  return new Promise((resolve, reject) => {
    geminiQueue.push({ fn, resolve, reject });
    drainGeminiQueue();
  });
}

function drainGeminiQueue() {
  while (activeGeminiCalls < GEMINI_CONCURRENCY && geminiQueue.length > 0) {
    const { fn, resolve, reject } = geminiQueue.shift();
    activeGeminiCalls++;
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeGeminiCalls--;
        drainGeminiQueue();
      });
  }
}

async function callGeminiWithRetry(entry) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await NetAPI.summarizeWithGemini(entry);
    } catch (err) {
      lastErr = err;
      const is429 = err.message.includes("429") || err.message.includes("rate");
      if (is429 && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function statusClass(code) {
  if (code >= 200 && code < 300) return "status-ok";
  if (code >= 300 && code < 400) return "status-redirect";
  return "status-err";
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

function formatBody(body) {
  if (!body) return "null";
  if (typeof body === "object") return JSON.stringify(body, null, 2);
  if (typeof body === "string") {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  return String(body);
}

function createSpinner() {
  const span = document.createElement("span");
  span.className = "spinner";
  return span;
}

function createTextEl(tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

function matchesFilter(entry) {
  if (currentMethod !== "ALL" && entry.request.method !== currentMethod) return false;
  if (!currentFilter) return true;
  const term = currentFilter.toLowerCase();
  const url = entry.request.url.toLowerCase();
  const status = String(entry.response.status);
  const summary = (entry.aiSummary || "").toLowerCase();
  return url.includes(term) || status.includes(term) || summary.includes(term);
}

function applyFilters() {
  for (const [id, div] of entryDomMap) {
    const entry = NetCapture.getEntries().find((e) => e.id === id);
    if (!entry) continue;
    div.style.display = matchesFilter(entry) ? "" : "none";
  }
}

function renderListItem(entry) {
  const div = document.createElement("div");
  div.className = "request-item";
  div.dataset.id = entry.id;

  if (entry.skipAi) div.classList.add("skipped-ai");

  let shortUrl = entry.request.url;
  try {
    const urlObj = new URL(entry.request.url);
    shortUrl = urlObj.pathname + urlObj.search;
  } catch { /* keep full url */ }

  let hostname = "";
  try { hostname = new URL(entry.request.url).hostname; } catch { /* */ }

  const topRow = document.createElement("div");
  const methodSpan = createTextEl("span", entry.request.method, `method method-${entry.request.method}`);
  const statusSpan = createTextEl("span", String(entry.response.status), statusClass(entry.response.status));
  const durationSpan = createTextEl("span", entry.timing.durationMs + "ms");
  durationSpan.style.color = "#555";
  const badge = document.createElement("span");
  badge.className = "ai-badge";
  badge.id = `badge-${entry.id}`;
  topRow.append(methodSpan, " ", statusSpan, " ", durationSpan, " ", badge);

  const urlDiv = document.createElement("div");
  urlDiv.className = "url";
  urlDiv.title = entry.request.url;
  urlDiv.textContent = shortUrl;

  const metaDiv = document.createElement("div");
  metaDiv.className = "meta";
  metaDiv.append(
    createTextEl("span", hostname),
    createTextEl("span", entry.response.content.mimeType || ""),
    createTextEl("span", formatBytes(entry.response.content.size))
  );

  const dupBadge = document.createElement("span");
  dupBadge.className = "dup-count";
  dupBadge.id = `dup-${entry.id}`;
  if (entry.dupCount > 1) {
    dupBadge.textContent = `x${entry.dupCount}`;
  }
  metaDiv.appendChild(dupBadge);

  div.append(topRow, urlDiv, metaDiv);

  div.addEventListener("click", () => {
    document.querySelectorAll(".request-item.selected").forEach((el) =>
      el.classList.remove("selected")
    );
    div.classList.add("selected");
    selectedId = entry.id;
    renderDetail(entry);
  });

  if (!matchesFilter(entry)) div.style.display = "none";

  return div;
}

function renderSection(title, content) {
  const section = document.createElement("div");
  section.className = "detail-section";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = content || "null";
  section.append(h3, pre);
  return section;
}

function renderDetail(entry) {
  detailPanel.textContent = "";

  if (entry.skipAi) {
    const skipDiv = document.createElement("div");
    skipDiv.className = "ai-summary";
    skipDiv.style.borderColor = "#333";
    skipDiv.style.background = "#151515";
    const skipH3 = document.createElement("h3");
    skipH3.textContent = "AI Skipped";
    skipH3.style.color = "#666";
    const skipText = document.createElement("div");
    skipText.className = "text";
    skipText.style.color = "#666";
    skipText.textContent = "Low-value request (static asset, tracker, or duplicate). AI summarization skipped.";
    skipDiv.append(skipH3, skipText);
    detailPanel.appendChild(skipDiv);
  } else if (entry.aiSummary) {
    const aiDiv = document.createElement("div");
    aiDiv.className = "ai-summary";
    const aiH3 = document.createElement("h3");
    aiH3.textContent = "Gemini Summary";
    const aiText = document.createElement("div");
    aiText.className = "text";
    aiText.textContent = entry.aiSummary;
    aiDiv.append(aiH3, aiText);
    detailPanel.appendChild(aiDiv);
  }

  detailPanel.appendChild(renderSection("Request", JSON.stringify({
    method: entry.request.method,
    url: entry.request.url,
    httpVersion: entry.request.httpVersion,
  }, null, 2)));

  detailPanel.appendChild(renderSection("Request Headers", JSON.stringify(entry.request.headers, null, 2)));

  if (entry.request.cookies.length > 0) {
    detailPanel.appendChild(renderSection("Request Cookies", JSON.stringify(entry.request.cookies, null, 2)));
  }

  if (entry.request.queryString.length > 0) {
    detailPanel.appendChild(renderSection("Query Parameters", JSON.stringify(entry.request.queryString, null, 2)));
  }

  if (entry.request.postData) {
    detailPanel.appendChild(renderSection("Request Body", formatBody(entry.request.postData.text)));
  }

  detailPanel.appendChild(renderSection("Response", JSON.stringify({
    status: entry.response.status,
    statusText: entry.response.statusText,
    httpVersion: entry.response.httpVersion,
  }, null, 2)));

  detailPanel.appendChild(renderSection("Response Headers", JSON.stringify(entry.response.headers, null, 2)));

  if (entry.response.cookies.length > 0) {
    detailPanel.appendChild(renderSection("Response Cookies", JSON.stringify(entry.response.cookies, null, 2)));
  }

  if (entry.response.content.body) {
    detailPanel.appendChild(renderSection(
      `Response Body (${formatBytes(entry.response.content.size)})`,
      formatBody(entry.response.content.body)
    ));
  }

  detailPanel.appendChild(renderSection("Fingerprint", JSON.stringify(entry.fingerprint, null, 2)));
  detailPanel.appendChild(renderSection("Timing", JSON.stringify(entry.timing, null, 2)));

  if (entry.serverIP) {
    detailPanel.appendChild(renderSection("Connection", JSON.stringify({
      serverIP: entry.serverIP,
      connection: entry.connection,
    }, null, 2)));
  }
}

function updateCount() {
  reqCount.textContent = NetCapture.getEntries().length;
}

function setEmptyMessage(text) {
  detailPanel.textContent = "";
  const div = document.createElement("div");
  div.className = "empty";
  div.textContent = text;
  detailPanel.appendChild(div);
}

async function onNewEntry(entry) {
  const div = renderListItem(entry);
  requestList.prepend(div);
  entryDomMap.set(entry.id, div);
  updateCount();

  if (entry.skipAi) {
    const badge = document.getElementById(`badge-${entry.id}`);
    if (badge) {
      badge.textContent = "--";
      badge.style.color = "#555";
    }
    return;
  }

  const badge = document.getElementById(`badge-${entry.id}`);
  if (badge) {
    badge.textContent = "";
    badge.appendChild(createSpinner());
  }

  try {
    const summary = await enqueueGeminiCall(() => callGeminiWithRetry(entry));
    entry.aiSummary = summary;
    if (badge) {
      badge.textContent = "AI";
    }
    if (selectedId === entry.id) renderDetail(entry);
  } catch (err) {
    entry.aiSummary = `Error: ${err.message}`;
    if (badge) {
      badge.textContent = "ERR";
      badge.style.color = "#ff4444";
    }
    if (selectedId === entry.id) renderDetail(entry);
  }
}

let filterTimeout = null;
filterInput.addEventListener("input", () => {
  clearTimeout(filterTimeout);
  filterTimeout = setTimeout(() => {
    currentFilter = filterInput.value.trim();
    applyFilters();
  }, 150);
});

methodFilter.addEventListener("change", () => {
  currentMethod = methodFilter.value;
  applyFilters();
});

function onDedupEntry(entry) {
  const dupEl = document.getElementById(`dup-${entry.id}`);
  if (dupEl) {
    dupEl.textContent = `x${entry.dupCount}`;
  }
}

startBtn.addEventListener("click", () => {
  NetCapture.start(onNewEntry, onDedupEntry);
  startBtn.disabled = true;
  startBtn.classList.add("active");
  stopBtn.disabled = false;
  setEmptyMessage("Listening for network requests...");
});

stopBtn.addEventListener("click", async () => {
  NetCapture.stop();
  startBtn.disabled = false;
  startBtn.classList.remove("active");
  stopBtn.disabled = true;

  const entries = NetCapture.getEntries();
  if (entries.length === 0) return;

  opusOverlay.classList.add("visible");
  opusResult.textContent = "";
  opusResult.append(
    document.createTextNode(`Analyzing ${entries.length} requests with Claude Opus...`),
    createSpinner()
  );

  try {
    const analysis = await NetAPI.analyzeHighValueWithOpus(entries);
    opusResult.textContent = analysis;
  } catch (err) {
    opusResult.textContent = `Error: ${err.message}`;
    opusResult.style.color = "#ff4444";
  }
});

clearBtn.addEventListener("click", () => {
  NetCapture.clear();
  requestList.textContent = "";
  entryDomMap.clear();
  setEmptyMessage("Start monitoring to capture network requests.");
  updateCount();
  selectedId = null;
});

exportBtn.addEventListener("click", () => {
  const entries = NetCapture.getEntries();
  const blob = new Blob([JSON.stringify(entries, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `netjunkie-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

closeOpus.addEventListener("click", () => {
  opusOverlay.classList.remove("visible");
});
