const ORIGINAL_HTML = "data-discord-translate-original-html";
const TRANSLATED = "data-discord-translate-translated";
const CACHED_TEXT = "data-discord-translate-cached-text";
const CACHED_SRC = "data-discord-translate-cached-src";

const messageViewState = new Map();

function isReplyPreviewContent(el) {
  if (!el) return false;
  if (el.matches?.('[class*="repliedTextContent"], [class*="repliedTextPreview"]')) return true;
  return Boolean(el.closest?.('[class*="repliedTextPreview"], [class*="repliedTextContent"]'));
}

function collectMessageKeys(messageEl) {
  const keys = [];
  if (!messageEl) return keys;

  function add(key) {
    if (key && !keys.includes(key)) keys.push(key);
  }

  if (!isReplyPreviewContent(messageEl)) {
    add(messageEl.id);
  }
  add(messageEl.getAttribute?.("data-list-item-id") || "");

  for (const el of messageEl.querySelectorAll?.('[id^="message-content-"]') || []) {
    if (isReplyPreviewContent(el)) continue;
    add(el.id);
  }

  if (
    messageEl.id &&
    String(messageEl.id).startsWith("message-content-") &&
    !isReplyPreviewContent(messageEl)
  ) {
    add(messageEl.id);
  }

  return keys;
}

function messageKey(messageEl) {
  return collectMessageKeys(messageEl)[0] || "";
}

function getStateRecordByKey(key) {
  if (!key) return null;
  let record = messageViewState.get(key);
  if (!record) {
    record = { view: null, cache: new Map() };
    messageViewState.set(key, record);
  }
  return record;
}

function getStateRecord(messageEl) {
  return getStateRecordByKey(messageKey(messageEl));
}

function getStoredView(messageEl) {
  let translated = false;
  let original = false;
  for (const key of collectMessageKeys(messageEl)) {
    const view = messageViewState.get(key)?.view;
    if (view === "translated") translated = true;
    if (view === "original") original = true;
  }
  if (original) return "original";
  if (translated) return "translated";
  return null;
}

function getViewState(messageEl) {
  return getStoredView(messageEl) ?? (isTranslated(messageEl) ? "translated" : "original");
}

function setViewState(messageEl, state) {
  const keys = collectMessageKeys(messageEl);
  if (!keys.length) return;
  for (const key of keys) {
    getStateRecordByKey(key).view = state;
  }
}

function findMessageRoot(el) {
  if (!el?.closest) return null;
  return (
    el.closest('[id^="chat-messages-"]') ||
    el.closest('[data-list-item-id*="chat-messages"]') ||
    el.closest('[class*="messageListItem"]') ||
    el.closest('[role="listitem"]') ||
    null
  );
}

function shouldShowTranslation(messageEl) {
  return Boolean(messageEl) && getStoredView(messageEl) === "translated";
}

function isSameLanguageMessage(messageEl) {
  for (const key of collectMessageKeys(messageEl)) {
    if (messageViewState.get(key)?.sameLanguage) return true;
  }
  return false;
}

function markSameLanguage(messageEl) {
  for (const key of collectMessageKeys(messageEl)) {
    getStateRecordByKey(key).sameLanguage = true;
    getStateRecordByKey(key).translationReady = false;
  }
}

function markTranslationReady(messageEl) {
  for (const key of collectMessageKeys(messageEl)) {
    const record = getStateRecordByKey(key);
    record.translationReady = true;
    record.sameLanguage = false;
  }
}

function messageHasCachedTranslation(messageEl) {
  for (const target of collectTranslateTargets(messageEl)) {
    const text = extractTargetText(target.el);
    if (!text) continue;
    if (getCachedTranslation(target.el, text) || getMemoryCachedTranslation(messageEl, text)) {
      return true;
    }
  }
  return false;
}

function rememberTranslation(messageEl, src, dst) {
  if (!src || !dst) return;
  for (const key of collectMessageKeys(messageEl)) {
    const cache = getStateRecordByKey(key).cache;
    cache.set(src, dst);
    while (cache.size > 24) {
      cache.delete(cache.keys().next().value);
    }
  }
}

function getMemoryCachedTranslation(messageEl, srcText) {
  if (!srcText) return null;
  const trimmed = srcText.trim();
  for (const key of collectMessageKeys(messageEl)) {
    const record = messageViewState.get(key);
    if (!record?.cache?.size) continue;
    if (record.cache.has(srcText)) return record.cache.get(srcText);
    for (const [src, dst] of record.cache.entries()) {
      if (src.trim() === trimmed) return dst;
    }
  }
  return null;
}

function showCachedTranslation(messageEl) {
  if (!shouldShowTranslation(messageEl)) return false;
  const targets = collectTranslateTargets(messageEl);
  let applied = false;
  for (const target of targets) {
    if (!shouldShowTranslation(messageEl)) return applied;
    const text = extractTargetText(target.el);
    if (!text) continue;
    const cached =
      getCachedTranslation(target.el, text) || getMemoryCachedTranslation(messageEl, text);
    if (!cached) continue;
    setCachedTranslation(target.el, text, cached);
    applyInlineText(target.el, cached);
    rememberTranslation(messageEl, text, cached);
    applied = true;
  }
  return applied;
}

function resetMessageToOriginal(messageEl) {
  restoreMessage(messageEl);
  messageEl.querySelectorAll(".discord-translate-inline-error").forEach((el) => {
    el.classList.remove("discord-translate-inline-error");
  });
  setViewState(messageEl, "original");
}

function findLiveMessageEl(messageEl) {
  if (messageEl?.isConnected) return messageEl;
  const keys = collectMessageKeys(messageEl);
  for (const el of collectMessageElements()) {
    const elKeys = collectMessageKeys(el);
    if (elKeys.some((key) => keys.includes(key))) return el;
  }
  return messageEl;
}

function isDiscordEmojiImage(img) {
  if (!(img instanceof HTMLImageElement)) return false;
  const cls = typeof img.className === "string" ? img.className : String(img.className || "");
  if (/emoji/i.test(cls)) return true;
  if ((img.getAttribute("data-type") || "").toLowerCase() === "emoji") return true;
  const src = img.currentSrc || img.src || "";
  if (/discord(?:app)?\.com\/emojis\//i.test(src)) return true;
  const alt = img.alt || "";
  if (/^:[\w~+-]+:$/.test(alt)) return true;
  return false;
}

function collectEmojiImages(root) {
  if (!root) return [];
  return [...root.querySelectorAll("img")].filter(isDiscordEmojiImage);
}

function emojiPlaceholder(index) {
  return `⟦${index}⟧`;
}

function prepareContentClone(contentEl, { reply = false } = {}) {
  if (!contentEl) return null;
  const clone = contentEl.cloneNode(true);
  clone.classList.remove("discord-translate-content-suppressed");
  const removeSel = reply
    ? ".discord-translate-inline-translation, [class*='timestamp'], [class*='hiddenVisually'], time"
    : ".discord-translate-translate-btn, .discord-translate-translate-wrap, .discord-translate-inline-translation";
  clone.querySelectorAll(removeSel).forEach((n) => n.remove());
  collectEmojiImages(clone).forEach((img, i) => {
    img.replaceWith(document.createTextNode(emojiPlaceholder(i)));
  });
  return clone;
}

function extractMessageText(contentEl) {
  const clone = prepareContentClone(contentEl);
  if (!clone) return "";
  return (clone.innerText || clone.textContent || "").trim();
}

function isReplyContext(el) {
  if (!el) return false;
  const cls = typeof el.className === "string" ? el.className : "";
  if (/repliedTextContent|repliedTextPreview|repliedMessage|referencedMessage|replyBar/.test(cls)) {
    return true;
  }
  return Boolean(
    el.closest?.(
      '[class*="repliedMessage"], [class*="referencedMessage"], [class*="replyBar"], [class*="repliedTextPreview"], [class*="repliedTextContent"]'
    )
  );
}

function findReplyRoot(messageEl) {
  return (
    messageEl.querySelector('[class*="repliedMessage"], [class*="referencedMessage"]') ||
    messageEl.querySelector('[class*="repliedTextPreview"]')
  );
}

function findMessageContent(messageEl) {
  const contents = messageEl.querySelector('[class*="contents"]') || messageEl;
  const replyRoot = findReplyRoot(messageEl);

  const all = [...contents.querySelectorAll('[id^="message-content-"]')];
  for (const el of all) {
    if (el.matches?.('[class*="repliedTextContent"], [class*="repliedTextPreview"]')) continue;
    if (replyRoot && replyRoot.contains(el)) continue;
    if (isReplyContext(el)) continue;
    if (el.classList.contains("discord-translate-inline-translation")) continue;
    return el;
  }

  if (all.length) {
    const last =
      all.findLast?.((el) => !el.classList.contains("discord-translate-inline-translation")) ??
      [...all].reverse().find((el) => !el.classList.contains("discord-translate-inline-translation"));
    if (
      last &&
      !last.matches?.('[class*="repliedTextContent"], [class*="repliedTextPreview"]') &&
      !(replyRoot && replyRoot.contains(last)) &&
      !isReplyContext(last)
    ) {
      return last;
    }
  }

  const fallbacks = [
    ...contents.querySelectorAll('[class*="messageContent"]'),
    ...contents.querySelectorAll('[class*="markup_"], [class*="markup-"]'),
  ];
  for (const el of fallbacks) {
    if (el.matches?.('[class*="repliedTextContent"], [class*="repliedTextPreview"]')) continue;
    if (el.classList.contains("discord-translate-inline-translation")) continue;
    if (replyRoot && replyRoot.contains(el)) continue;
    if (isReplyContext(el)) continue;
    if (!extractMessageText(el)) continue;
    return el;
  }

  for (const el of messageEl.querySelectorAll('[id^="message-content-"]')) {
    if (el.matches?.('[class*="repliedTextContent"], [class*="repliedTextPreview"]')) continue;
    if (isReplyContext(el)) continue;
    if (el.classList.contains("discord-translate-inline-translation")) continue;
    if (!extractMessageText(el)) continue;
    return el;
  }

  return null;
}

function findReplyContent(messageEl) {
  if (!messageEl) return null;

  const textEl = messageEl.querySelector(
    '[class*="repliedTextContent"]:not(.discord-translate-inline-translation)'
  );
  if (textEl && extractReplyText(textEl)) return textEl;

  const preview = messageEl.querySelector(
    '[class*="repliedTextPreview"]:not(.discord-translate-inline-translation)'
  );
  if (preview && extractReplyText(preview)) {
    return preview.querySelector('[class*="repliedTextContent"]') || preview;
  }

  return null;
}

function getReplyMessageSpan(textEl) {
  if (!textEl) return null;
  for (const span of textEl.querySelectorAll(":scope > span")) {
    if (span.matches?.('[class*="timestamp"], [class*="hiddenVisually"]')) continue;
    if (span.querySelector?.("time")) continue;
    const text = (span.textContent || "").trim();
    if (text || collectEmojiImages(span).length) return span;
  }
  return null;
}

function extractReplyText(contentEl) {
  const clone = prepareContentClone(contentEl, { reply: true });
  if (!clone) return "";
  const messageSpan = getReplyMessageSpan(clone);
  if (messageSpan) return (messageSpan.innerText || messageSpan.textContent || "").trim();
  return (clone.innerText || clone.textContent || "").trim();
}

function renderTranslatedOverlay(overlay, translatedText, sourceEl) {
  const emojis = collectEmojiImages(sourceEl);
  const frag = document.createDocumentFragment();
  const re = /⟦(\d+)⟧/g;
  let lastIndex = 0;
  let match;
  let restored = 0;
  while ((match = re.exec(translatedText))) {
    if (match.index > lastIndex) {
      frag.append(translatedText.slice(lastIndex, match.index));
    }
    const emoji = emojis[Number(match[1])];
    if (emoji) {
      frag.append(emoji.cloneNode(true));
      restored += 1;
    } else {
      frag.append(match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < translatedText.length) {
    frag.append(translatedText.slice(lastIndex));
  }
  if (emojis.length && restored === 0 && !/⟦\d+⟧/.test(translatedText)) {
    if (translatedText) frag.append(" ");
    for (const emoji of emojis) frag.append(emoji.cloneNode(true));
  }
  overlay.replaceChildren(frag);
}

function extractTargetText(contentEl) {
  if (isReplyPreviewContent(contentEl)) return extractReplyText(contentEl);
  return extractMessageText(contentEl);
}

function collectTranslateTargets(messageEl) {
  const targets = [];
  const reply = findReplyContent(messageEl);
  const main = findMessageContent(messageEl);

  if (reply) {
    targets.push({ el: reply });
  }
  if (main && main !== reply && !(reply && reply.contains(main))) {
    targets.push({ el: main });
  }
  return targets;
}

function isTranslated(messageEl) {
  return Boolean(
    messageEl?.querySelector?.(`.discord-translate-inline-translation, [${TRANSLATED}="1"], [${ORIGINAL_HTML}], .discord-translate-content-suppressed`)
  );
}

function getCachedTranslation(contentEl, srcText) {
  if (!contentEl || !srcText) return null;
  if (contentEl.getAttribute(CACHED_SRC) !== srcText) return null;
  return contentEl.getAttribute(CACHED_TEXT);
}

function setCachedTranslation(contentEl, srcText, translatedText) {
  contentEl.setAttribute(CACHED_SRC, srcText);
  contentEl.setAttribute(CACHED_TEXT, translatedText);
}

function clearCachedTranslation(contentEl) {
  contentEl.removeAttribute(CACHED_SRC);
  contentEl.removeAttribute(CACHED_TEXT);
}

function ensureContentTargetId(contentEl) {
  if (isReplyPreviewContent(contentEl)) {
    if (!contentEl.dataset.discordTranslateTargetId) {
      contentEl.dataset.discordTranslateTargetId = `reply-${contentEl.id || Math.random().toString(36).slice(2, 9)}`;
    }
    return contentEl.dataset.discordTranslateTargetId;
  }
  if (contentEl.id && String(contentEl.id).startsWith("message-content-")) {
    contentEl.dataset.discordTranslateTargetId = contentEl.id;
    return contentEl.id;
  }
  if (!contentEl.dataset.discordTranslateTargetId) {
    contentEl.dataset.discordTranslateTargetId = `t-${Math.random().toString(36).slice(2, 9)}`;
  }
  return contentEl.dataset.discordTranslateTargetId;
}

function findTranslationOverlay(contentEl) {
  const tid = contentEl.dataset.discordTranslateTargetId;
  if (!tid) return null;
  const parent = contentEl.parentElement;
  if (!parent) return null;
  return parent.querySelector(`.discord-translate-inline-translation[data-discord-translate-for="${CSS.escape(tid)}"]`);
}

function applyInlineText(contentEl, text) {
  const messageEl = findMessageRoot(contentEl);
  if (messageEl && getStoredView(messageEl) === "original") return;

  const hideEl =
    contentEl.closest?.('[class*="repliedTextContent"]') ||
    (isReplyPreviewContent(contentEl) ? contentEl : contentEl);

  const tid = ensureContentTargetId(hideEl);
  let overlay = findTranslationOverlay(hideEl);
  if (
    overlay &&
    overlay.isConnected &&
    overlay.dataset.discordTranslateBody === text &&
    hideEl.hidden &&
    hideEl.classList.contains("discord-translate-content-suppressed")
  ) {
    return;
  }

  hideEl.setAttribute(TRANSLATED, "1");
  hideEl.setAttribute(ORIGINAL_HTML, "1");
  hideEl.classList.add("discord-translate-content-suppressed");
  hideEl.hidden = true;
  hideEl.style.setProperty("display", "none", "important");

  let sibling = hideEl.nextElementSibling;
  while (sibling?.classList?.contains("discord-translate-inline-translation")) {
    const next = sibling.nextElementSibling;
    if (sibling.dataset.discordTranslateFor !== tid) sibling.remove();
    sibling = next;
  }

  overlay = findTranslationOverlay(hideEl);
  if (!overlay) {
    overlay = document.createElement(hideEl.tagName || "div");
    overlay.className = `${hideEl.className} discord-translate-inline-translation`.replace(
      /\bdiscord-translate-content-suppressed\b/g,
      ""
    );
    overlay.dataset.discordTranslateFor = tid;
    overlay.removeAttribute("id");
    overlay.setAttribute(TRANSLATED, "1");
    hideEl.insertAdjacentElement("afterend", overlay);
  }
  if (messageEl && getStoredView(messageEl) === "original") {
    overlay.remove();
    hideEl.classList.remove("discord-translate-content-suppressed");
    hideEl.hidden = false;
    hideEl.style.removeProperty("display");
    hideEl.removeAttribute(ORIGINAL_HTML);
    hideEl.removeAttribute(TRANSLATED);
    return;
  }
  if (overlay.dataset.discordTranslateBody !== text) {
    overlay.dataset.discordTranslateBody = text;
    renderTranslatedOverlay(overlay, text, hideEl);
  }
}

function restoreOriginal(contentEl) {
  const hideEl =
    contentEl.closest?.('[class*="repliedTextContent"]') ||
    (isReplyPreviewContent(contentEl) ? contentEl : contentEl);
  findTranslationOverlay(hideEl)?.remove();
  let sibling = hideEl.nextElementSibling;
  while (sibling?.classList?.contains("discord-translate-inline-translation")) {
    const next = sibling.nextElementSibling;
    sibling.remove();
    sibling = next;
  }
  hideEl.classList.remove("discord-translate-content-suppressed");
  hideEl.hidden = false;
  hideEl.style.removeProperty("display");
  hideEl.removeAttribute(ORIGINAL_HTML);
  hideEl.removeAttribute(TRANSLATED);
}

function restoreMessage(messageEl) {
  messageEl.querySelectorAll(".discord-translate-inline-translation").forEach((n) => n.remove());
  messageEl.querySelectorAll(`[${TRANSLATED}], [${ORIGINAL_HTML}], .discord-translate-content-suppressed`).forEach((el) => {
    el.classList.remove("discord-translate-content-suppressed");
    el.hidden = false;
    el.style.removeProperty("display");
    el.removeAttribute(ORIGINAL_HTML);
    el.removeAttribute(TRANSLATED);
  });
}

function getTranslateWrap(messageEl) {
  return messageEl.querySelector(".discord-translate-translate-wrap");
}

function getTranslateButton(messageEl) {
  return messageEl.querySelector(".discord-translate-translate-btn");
}

function setTranslateButtonLabel(messageEl, mode, settings) {
  const btn = getTranslateButton(messageEl);
  if (!btn) return;

  const lang = languageLabel(settings?.incoming) || settings?.incoming || "";
  let label = "Translate";
  if (mode === "translated") label = "See original";
  else if (mode === "busy") label = "Translating…";
  else if (mode === "wait") label = "Wait…";
  else label = lang ? `Translate to ${lang}` : "Translate";

  btn.textContent = label;
  btn.setAttribute("aria-label", label);
  btn.removeAttribute("title");
  btn.classList.toggle("discord-translate-btn--active", mode === "translated");
  btn.classList.toggle("discord-translate-btn--busy", mode === "busy" || mode === "wait");
  btn.classList.remove("discord-translate-btn--same");
}

function ensureContentSuppressedForOverlays(messageEl) {
  for (const target of collectTranslateTargets(messageEl)) {
    const hideEl =
      target.el.closest?.('[class*="repliedTextContent"]') ||
      (isReplyPreviewContent(target.el) ? target.el : target.el);
    const overlay =
      findTranslationOverlay(hideEl) ||
      (hideEl.nextElementSibling?.classList?.contains("discord-translate-inline-translation")
        ? hideEl.nextElementSibling
        : null);
    if (!overlay) continue;
    if (overlay.dataset.discordTranslateFor && !hideEl.dataset.discordTranslateTargetId) {
      hideEl.dataset.discordTranslateTargetId = overlay.dataset.discordTranslateFor;
    }
    hideEl.classList.add("discord-translate-content-suppressed");
    hideEl.hidden = true;
    hideEl.style.setProperty("display", "none", "important");
    hideEl.setAttribute(TRANSLATED, "1");
    hideEl.setAttribute(ORIGINAL_HTML, "1");
  }
}

function syncTranslateButtonLabel(messageEl, settings) {
  if (shouldShowTranslation(messageEl)) {
    showCachedTranslation(messageEl);
    if (!shouldShowTranslation(messageEl)) {
      restoreMessage(messageEl);
      setTranslateButtonLabel(messageEl, "idle", settings);
      return;
    }
    ensureContentSuppressedForOverlays(messageEl);
    setTranslateButtonLabel(messageEl, "translated", settings);
    return;
  }

  if (isTranslated(messageEl)) {
    restoreMessage(messageEl);
  }
  setTranslateButtonLabel(messageEl, "idle", settings);
}

function removeTranslateButtons() {
  document.querySelectorAll(".discord-translate-translate-wrap").forEach((el) => el.remove());
}

function findReactionsContainer(messageEl) {
  const replyRoot = findReplyRoot(messageEl);
  for (const el of messageEl.querySelectorAll('[class*="reactions"]')) {
    if (replyRoot && replyRoot.contains(el)) continue;
    if (el.closest(".discord-translate-translate-wrap")) continue;
    if (!el.querySelector('[class*="reaction"], [class*="emoji"]')) continue;
    return el;
  }
  return null;
}

function placeTranslateButton(messageEl, wrap) {
  const reactions = findReactionsContainer(messageEl);
  if (reactions) {
    wrap.classList.add("discord-translate-translate-wrap--with-reactions");
    if (wrap.parentElement !== reactions || reactions.lastElementChild !== wrap) {
      reactions.appendChild(wrap);
    }
    return;
  }

  wrap.classList.remove("discord-translate-translate-wrap--with-reactions");
  const main = findMessageContent(messageEl);
  if (!main) return;
  const overlay =
    findTranslationOverlay(main) ||
    (main.nextElementSibling?.classList?.contains("discord-translate-inline-translation")
      ? main.nextElementSibling
      : null);
  const anchor = overlay || main;
  if (wrap.previousElementSibling !== anchor || !wrap.isConnected) {
    anchor.insertAdjacentElement("afterend", wrap);
  }
}

function ensureTranslateButton(messageEl, getSettingsSnapshot) {
  const settings = getSettingsSnapshot();
  if (!settings?.enabled) {
    getTranslateWrap(messageEl)?.remove();
    return;
  }

  if (isSameLanguageMessage(messageEl)) {
    getTranslateWrap(messageEl)?.remove();
    return;
  }

  if (messageHasCachedTranslation(messageEl)) {
    markTranslationReady(messageEl);
  }

  const targets = collectTranslateTargets(messageEl);
  if (!targets.some((t) => extractTargetText(t.el))) {
    getTranslateWrap(messageEl)?.remove();
    return;
  }

  let wrap = getTranslateWrap(messageEl);
  let btn = getTranslateButton(messageEl);

  if (!wrap || !btn) {
    wrap?.remove();
    wrap = document.createElement("span");
    wrap.className = "discord-translate-translate-wrap";

    btn = document.createElement("div");
    btn.className = "discord-translate-translate-btn";
    btn.setAttribute("role", "button");
    btn.tabIndex = 0;

    const onActivate = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const live = findLiveMessageEl(messageEl) || messageEl;
      handleTranslateClick(live, getSettingsSnapshot);
    };
    btn.addEventListener("click", onActivate);
    btn.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") onActivate(event);
    });

    wrap.appendChild(btn);
  }

  placeTranslateButton(messageEl, wrap);
  syncTranslateButtonLabel(messageEl, settings);
}

async function translateTarget(target, settings, messageEl, { apply = true } = {}) {
  if (apply && messageEl && getStoredView(messageEl) === "original") return "skip";

  const text = extractTargetText(target.el);
  if (!text) return "skip";

  const record = messageEl ? getStateRecord(messageEl) : null;
  const cached =
    getCachedTranslation(target.el, text) ||
    (record?.cache?.has(text) ? record.cache.get(text) : null) ||
    (messageEl ? getMemoryCachedTranslation(messageEl, text) : null);
  if (cached) {
    if (apply && messageEl && getStoredView(messageEl) === "original") return "skip";
    setCachedTranslation(target.el, text, cached);
    if (messageEl) rememberTranslation(messageEl, text, cached);
    if (apply) applyInlineText(target.el, cached);
    return "translated";
  }

  const result = await translateText(text, settings.incoming, "auto");
  if (apply && messageEl && getStoredView(messageEl) === "original") return "skip";
  if (translationUnchanged(result, text, settings.incoming)) {
    if (apply) restoreOriginal(target.el);
    clearCachedTranslation(target.el);
    return "same";
  }

  setCachedTranslation(target.el, text, result.text);
  if (messageEl) rememberTranslation(messageEl, text, result.text);
  if (apply) applyInlineText(target.el, result.text);
  return "translated";
}

async function processIncomingMessage(
  messageEl,
  settings,
  getSettingsSnapshot,
  { revealErrors = false } = {}
) {
  if (!settings.enabled) return;

  const key = messageKey(messageEl);
  if (!key) return;
  if (isRateLimitedFor(messageEl, key)) return;

  const targets = collectTranslateTargets(messageEl);
  if (!targets.length) return;

  const hasText = targets.some((t) => extractTargetText(t.el));
  if (!hasText) return;

  messageEl.setAttribute(DISCORD_TRANSLATE_ATTR.PROCESSED, `pending:${key}`);

  let rateLimited = false;
  let lastError = "";
  let translated = false;
  let sameLanguage = false;

  for (const target of targets) {
    try {
      const result = await translateTarget(target, settings, messageEl, { apply: true });
      if (result === "translated") translated = true;
      if (result === "same") sameLanguage = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      if (msg.includes("429") || msg.includes("rate limited")) {
        rateLimited = true;
      }
      console.warn("[Discord Translate] translate target failed:", err);
    }
  }

  if (getStoredView(messageEl) === "original") {
    restoreMessage(messageEl);
    ensureTranslateButton(messageEl, getSettingsSnapshot);
    return;
  }

  if (messageKey(messageEl) !== key) return;

  if (rateLimited) {
    restoreMessage(messageEl);
    setViewState(messageEl, "original");
    const until = Date.now() + 30_000;
    messageEl.setAttribute(DISCORD_TRANSLATE_ATTR.PROCESSED, `limited:${key}:${until}`);
    ensureTranslateButton(messageEl, getSettingsSnapshot);
    return;
  }

  if (lastError && !translated) {
    restoreMessage(messageEl);
    setViewState(messageEl, "original");
    if (revealErrors) {
      const main = findMessageContent(messageEl) || targets[0]?.el;
      if (main) {
        applyInlineText(main, `Translation error: ${lastError}`);
        main.classList.add("discord-translate-inline-error");
      }
    }
    messageEl.removeAttribute(DISCORD_TRANSLATE_ATTR.PROCESSED);
    ensureTranslateButton(messageEl, getSettingsSnapshot);
    return;
  }

  if (!translated && sameLanguage) {
    restoreMessage(messageEl);
    markSameLanguage(messageEl);
    setViewState(messageEl, "original");
    messageEl.setAttribute(DISCORD_TRANSLATE_ATTR.PROCESSED, key);
    ensureTranslateButton(messageEl, getSettingsSnapshot);
    return;
  }

  setViewState(messageEl, translated ? "translated" : "original");
  if (translated) markTranslationReady(messageEl);
  messageEl.setAttribute(DISCORD_TRANSLATE_ATTR.PROCESSED, key);
  ensureTranslateButton(messageEl, getSettingsSnapshot);
}

async function handleTranslateClick(messageEl, getSettingsSnapshot) {
  const settings = getSettingsSnapshot();
  if (!settings?.enabled) return;

  messageEl = findLiveMessageEl(messageEl) || messageEl;

  const key = messageKey(messageEl);
  if (!key) return;

  if (isRateLimitedFor(messageEl, key)) {
    setTranslateButtonLabel(messageEl, "wait", settings);
    return;
  }

  if (isSameLanguageMessage(messageEl)) return;

  if (getViewState(messageEl) === "translated") {
    resetMessageToOriginal(messageEl);
    messageEl.removeAttribute(DISCORD_TRANSLATE_ATTR.PROCESSED);
    ensureTranslateButton(messageEl, getSettingsSnapshot);
    return;
  }

  if (isPendingFor(messageEl, key)) return;

  setViewState(messageEl, "translated");

  if (showCachedTranslation(messageEl)) {
    messageEl.setAttribute(DISCORD_TRANSLATE_ATTR.PROCESSED, key);
    ensureTranslateButton(messageEl, getSettingsSnapshot);
    return;
  }

  setTranslateButtonLabel(messageEl, "busy", settings);
  await processIncomingMessage(messageEl, settings, getSettingsSnapshot, { revealErrors: true });
}

function isPendingFor(messageEl, key) {
  return messageEl.getAttribute(DISCORD_TRANSLATE_ATTR.PROCESSED) === `pending:${key}`;
}

function isRateLimitedFor(messageEl, key) {
  const value = messageEl.getAttribute(DISCORD_TRANSLATE_ATTR.PROCESSED) || "";
  if (!value.startsWith(`limited:${key}:`)) return false;
  const until = Number(value.slice(`limited:${key}:`.length));
  return Number.isFinite(until) && Date.now() < until;
}

function collectMessageElements() {
  const map = new Map();

  function add(el, key) {
    if (!el || !key || map.has(key)) return;
    map.set(key, el);
  }

  for (const el of document.querySelectorAll('[id^="chat-messages-"]')) {
    add(el, el.id);
  }
  for (const el of document.querySelectorAll('[data-list-item-id*="chat-messages"]')) {
    add(el, el.getAttribute("data-list-item-id") || "");
  }
  for (const el of document.querySelectorAll('[class*="messageListItem"]')) {
    add(el, messageKey(el) || el.id || `mli-${map.size}`);
  }

  for (const content of document.querySelectorAll('[id^="message-content-"]')) {
    if (isReplyPreviewContent(content)) {
      const replyWrap =
        content.closest('[id^="chat-messages-"]') ||
        content.closest('[data-list-item-id*="chat-messages"]') ||
        content.closest('[class*="messageListItem"]') ||
        content.closest('[role="listitem"]');
      if (replyWrap) add(replyWrap, messageKey(replyWrap) || replyWrap.id);
      continue;
    }
    const wrap =
      content.closest('[id^="chat-messages-"]') ||
      content.closest('[data-list-item-id*="chat-messages"]') ||
      content.closest('[class*="messageListItem"]') ||
      content.closest('[role="listitem"]') ||
      content.closest("li") ||
      content;
    add(wrap, messageKey(wrap) || content.id);
  }

  if (map.size) return [...map.values()];

  const scroller = document.querySelector(
    '[data-list-id="chat-messages"], [class*="scrollerInner"][role="log"], [aria-label*="Messages in" i]'
  );
  if (!scroller) return [];

  for (const el of scroller.querySelectorAll('[role="listitem"], li, [class*="message_"]')) {
    const hasText =
      el.querySelector('[id^="message-content-"], [class*="markup_"], [class*="markup-"], [class*="messageContent"]');
    if (!hasText) continue;
    const key = messageKey(el) || el.id || `scroller-${map.size}-${(el.textContent || "").slice(0, 24)}`;
    add(el, key);
  }

  return [...map.values()];
}

const MESSAGE_STATE_MAX = 400;
const OUR_UI_SELECTOR =
  ".discord-translate-translate-wrap, .discord-translate-inline-translation, .discord-translate-draft-translate-wrap, .discord-translate-tooltip, .discord-translate-content-suppressed";
const IGNORED_OVERLAY_SELECTOR =
  "[class*='emojiPicker'], [class*='emoji-picker'], [class*='EmojiPicker'], [class*='gifPicker'], [class*='GifPicker'], [class*='expressionPicker'], [class*='ExpressionPicker'], [class*='stickers'], [aria-label*='Emoji picker' i], [id*='emoji-picker']";

function isOurTranslateNode(node) {
  if (!node) return false;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!el?.closest) return false;
  if (el.closest(OUR_UI_SELECTOR)) return true;
  if (el.classList?.contains("discord-translate-inline-translation")) return true;
  return Boolean(el.dataset?.discordTranslateFor || el.dataset?.discordTranslateTargetId);
}

function isIgnoredOverlayNode(node) {
  if (!node) return false;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return Boolean(el?.closest?.(IGNORED_OVERLAY_SELECTOR));
}

function mutationAddsChatContent(mutation) {
  if (mutation.type !== "childList") return false;

  for (const node of mutation.removedNodes) {
    if (!(node instanceof Element)) continue;
    if (
      node.classList?.contains("discord-translate-translate-wrap") ||
      node.querySelector?.(".discord-translate-translate-wrap, .discord-translate-translate-btn")
    ) {
      return true;
    }
  }

  if (!mutation.addedNodes.length) return false;
  for (const node of mutation.addedNodes) {
    if (!(node instanceof Element)) continue;
    if (isOurTranslateNode(node) || isIgnoredOverlayNode(node)) continue;
    if (
      node.id?.startsWith("chat-messages-") ||
      node.id?.startsWith("message-content-") ||
      node.getAttribute?.("data-list-item-id")?.includes("chat-messages") ||
      node.matches?.(
        '[class*="messageListItem"], [class*="message_"], [class*="reactions"], [id^="chat-messages-"], [id^="message-content-"]'
      )
    ) {
      return true;
    }
    if (
      node.querySelector?.(
        '[id^="chat-messages-"], [id^="message-content-"], [data-list-item-id*="chat-messages"], [class*="messageListItem"], [class*="reactions"]'
      )
    ) {
      return true;
    }
  }
  return false;
}

function pruneMessageViewState(liveKeys) {
  if (messageViewState.size <= MESSAGE_STATE_MAX) return;
  for (const key of messageViewState.keys()) {
    if (messageViewState.size <= MESSAGE_STATE_MAX) break;
    if (liveKeys.has(key)) continue;
    messageViewState.delete(key);
  }
}

function startMessageObserver(getSettingsSnapshot) {
  let scanTimer = 0;
  let syncing = false;

  function syncMessages() {
    if (syncing) return;
    syncing = true;
    try {
      const settings = getSettingsSnapshot();
      if (!settings?.enabled) {
        removeTranslateButtons();
        return;
      }

      const liveKeys = new Set();
      for (const el of collectMessageElements()) {
        for (const key of collectMessageKeys(el)) liveKeys.add(key);
        ensureTranslateButton(el, getSettingsSnapshot);
      }
      pruneMessageViewState(liveKeys);
    } finally {
      syncing = false;
    }
  }

  function scheduleSync(delayMs = 250) {
    if (syncing) return;
    if (scanTimer) window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => {
      scanTimer = 0;
      syncMessages();
    }, delayMs);
  }

  const mutationObserver = new MutationObserver((mutations) => {
    if (syncing) return;
    for (const mutation of mutations) {
      if (!mutationAddsChatContent(mutation)) continue;
      const dropped = [...mutation.removedNodes].some(
        (n) =>
          n instanceof Element &&
          (n.classList?.contains("discord-translate-translate-wrap") ||
            n.querySelector?.(".discord-translate-translate-wrap"))
      );
      scheduleSync(dropped ? 50 : mutations.length > 40 ? 500 : 250);
      return;
    }
  });

  const root = document.body || document.documentElement;
  mutationObserver.observe(root, {
    childList: true,
    subtree: true,
  });

  window.setInterval(() => scheduleSync(0), 12_000);
  syncMessages();
}

function resetIncomingTranslations() {
  document.querySelectorAll(`[${DISCORD_TRANSLATE_ATTR.PROCESSED}]`).forEach((el) => {
    el.removeAttribute(DISCORD_TRANSLATE_ATTR.PROCESSED);
  });
  document.querySelectorAll(".discord-translate-inline-translation").forEach((el) => el.remove());
  document.querySelectorAll(`[${ORIGINAL_HTML}], .discord-translate-content-suppressed`).forEach((el) => {
    el.classList.remove("discord-translate-content-suppressed", "discord-translate-inline-error");
    el.hidden = false;
    el.style.removeProperty("display");
    el.removeAttribute(ORIGINAL_HTML);
    el.removeAttribute(TRANSLATED);
  });
  document.querySelectorAll(`[${CACHED_TEXT}], [${CACHED_SRC}]`).forEach((el) => {
    clearCachedTranslation(el);
  });
  messageViewState.clear();
  removeTranslateButtons();
  hideDiscordTranslateTooltip();
}
