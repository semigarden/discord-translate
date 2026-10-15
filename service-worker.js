import { MSG, toApiLang } from "./settings.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const CACHE_STORAGE_KEY = "discordTranslateCache";
const FETCH_TIMEOUT_MS = 8000;
const MIN_GAP_MS = 600;
const MAX_RETRIES = 3;
const TRANSLATE_ORIGIN = "https://translate.google.com";
const TRANSLATE_PA_URL = "https://translate-pa.googleapis.com/v1/translateHtml";
const TRANSLATE_PA_KEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";

let cache = new Map();
let cacheLoaded = false;
let cacheSaveTimer = 0;

let queueTail = Promise.resolve();
let lastRequestAt = 0;
let cooldownUntil = 0;

function cacheKey(text, from, to) {
  return `${from}|${to}|${text}`;
}

async function ensureCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const stored = await browser.storage.local.get(CACHE_STORAGE_KEY);
    const entries = stored[CACHE_STORAGE_KEY];
    if (Array.isArray(entries)) {
      const now = Date.now();
      for (const row of entries) {
        if (!row?.key || !row?.text) continue;
        if (now - (row.at || 0) > CACHE_TTL_MS) continue;
        cache.set(row.key, {
          text: row.text,
          detectedFrom: row.detectedFrom || "unknown",
          at: row.at || now,
        });
      }
    }
  } catch {
    cache = new Map();
  }
}

function scheduleCacheSave() {
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(async () => {
    cacheSaveTimer = 0;
    const now = Date.now();
    const rows = [];
    for (const [key, value] of cache.entries()) {
      if (now - value.at > CACHE_TTL_MS) {
        cache.delete(key);
        continue;
      }
      rows.push({
        key,
        text: value.text,
        detectedFrom: value.detectedFrom,
        at: value.at,
      });
    }
    rows.sort((a, b) => b.at - a.at);
    await browser.storage.local.set({
      [CACHE_STORAGE_KEY]: rows.slice(0, CACHE_MAX),
    });
  }, 500);
}

function pruneCache() {
  if (cache.size <= CACHE_MAX) return;
  const entries = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [key] of entries.slice(0, cache.size - CACHE_MAX)) {
    cache.delete(key);
  }
}

function rememberResult(key, result) {
  cache.set(key, { ...result, at: Date.now() });
  pruneCache();
  scheduleCacheSave();
  return result;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function formatTranslateError(status, detail) {
  if (status === 429 || String(detail).includes("429")) {
    return "rate limited — wait a few seconds";
  }
  const clean = String(detail || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return clean ? `${status}: ${clean.slice(0, 80)}` : String(status);
}

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;|&#x0*27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, "&");
}

function protectEmojiPlaceholders(text) {
  return String(text).replace(/⟦(\d+)⟧/g, '<span translate="no">⟦$1⟧</span>');
}

function restoreEmojiPlaceholders(text) {
  return decodeHtmlEntities(text)
    .replace(/<span[^>]*>\s*⟦\s*(\d+)\s*⟧\s*<\/span>/gi, "⟦$1⟧")
    .replace(/⟦\s*(\d+)\s*⟧/g, "⟦$1⟧")
    .replace(/<\/?span[^>]*>/gi, "");
}

function normalizeTranslatedText(text) {
  return restoreEmojiPlaceholders(text);
}

function parseTranslateResponse(data, source) {
  if (Array.isArray(data) && typeof data[0]?.[0] === "string") {
    const text = normalizeTranslatedText(data[0].filter((part) => typeof part === "string").join(""));
    if (text) {
      const detected = data[1]?.[0] || (source !== "auto" ? source : "unknown");
      return { text, detectedFrom: String(detected).toUpperCase() };
    }
  }

  const translated = normalizeTranslatedText(
    (data?.sentences || [])
      .filter((s) => s && typeof s.trans === "string")
      .map((s) => s.trans)
      .join("")
  );
  if (translated) {
    const detected =
      data?.src ||
      data?.ld_result?.srclangs?.[0] ||
      (source !== "auto" ? source : "unknown");
    return { text: translated, detectedFrom: String(detected).toUpperCase() };
  }

  const chunks = data?.[0];
  if (Array.isArray(chunks) && chunks.length) {
    const legacy = normalizeTranslatedText(chunks.map((row) => row?.[0] ?? "").join(""));
    if (legacy) {
      const detected = data?.src || data?.[2] || (source !== "auto" ? source : "unknown");
      return { text: legacy, detectedFrom: String(detected).toUpperCase() };
    }
  }
  return null;
}

function enqueue(task) {
  const run = queueTail.then(task, task);
  queueTail = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function waitForSlot() {
  const now = Date.now();
  const waitMs = Math.max(0, cooldownUntil - now, MIN_GAP_MS - (now - lastRequestAt));
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  lastRequestAt = Date.now();
}

async function translateViaPa(sl, tl, q) {
  const res = await fetchWithTimeout(TRANSLATE_PA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json+protobuf",
      "X-Goog-API-Key": TRANSLATE_PA_KEY,
    },
    body: JSON.stringify([[[protectEmojiPlaceholders(q)], sl, tl], "wt_lib"]),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(formatTranslateError(res.status, detail));
  }
  return res.json();
}

async function translateViaFetch(sl, tl, q) {
  const body = new URLSearchParams({ sl, tl, q });
  const res = await fetchWithTimeout(`${TRANSLATE_ORIGIN}/translate_a/single?client=at&dt=t&dt=rm&dj=1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      Referer: `${TRANSLATE_ORIGIN}/`,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(formatTranslateError(res.status, detail));
  }
  return res.json();
}

async function translateOnce(sl, tl, q) {
  try {
    return await translateViaPa(sl, tl, q);
  } catch {
    return translateViaFetch(sl, tl, q);
  }
}

async function translateText({ text, from, to }) {
  await ensureCache();

  const target = toApiLang(to);
  if (!target) {
    throw new Error("Target language missing");
  }

  const source = toApiLang(from || "auto") || "auto";
  const key = cacheKey(text, source, target);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { text: normalizeTranslatedText(hit.text), detectedFrom: hit.detectedFrom };
  }

  return enqueue(async () => {
    const again = cache.get(key);
    if (again && Date.now() - again.at < CACHE_TTL_MS) {
      return { text: normalizeTranslatedText(again.text), detectedFrom: again.detectedFrom };
    }

    let lastError = "";
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      await waitForSlot();

      try {
        const data = await translateOnce(source, target, text);
        const parsed = parseTranslateResponse(data, source);
        if (!parsed?.text) {
          lastError = "empty response";
          continue;
        }
        return rememberResult(key, parsed);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (lastError.includes("rate limited") || lastError.includes("429")) {
          cooldownUntil = Date.now() + 2000 * (attempt + 1);
        }
      }
    }

    throw new Error(`Translation failed (${lastError || "unknown error"})`);
  });
}

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message || typeof message !== "object") return;

    if (message.type === MSG.TRANSLATE) {
      const { text, from, to, requestId } = message;
      if (!text || !to) {
        sendResponse({ ok: false, requestId, error: "text and to are required" });
        return;
      }
      try {
        const result = await translateText({ text, from, to });
        sendResponse({ ok: true, requestId, ...result });
      } catch (err) {
        sendResponse({
          ok: false,
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();

  return true;
});

ensureCache();
