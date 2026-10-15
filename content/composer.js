const PICKER_ROOT_SELECTOR =
  "[class*='emojiPicker'], [class*='emoji-picker'], [class*='EmojiPicker'], [class*='gifPicker'], [class*='GifPicker'], [class*='expressionPicker'], [class*='ExpressionPicker'], [class*='stickerPicker'], [class*='StickerPicker'], [aria-label*='Emoji picker' i], [id*='emoji-picker']";

function isDiscordTranslateUi(el) {
  return Boolean(
    el?.closest?.(
      ".discord-translate-translate-btn, .discord-translate-translate-wrap, .discord-translate-draft-translate-btn, .discord-translate-draft-translate-wrap, .discord-translate-tooltip"
    )
  );
}

function isInsidePicker(el) {
  return Boolean(el?.closest?.(PICKER_ROOT_SELECTOR));
}

function isComposerCandidate(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (isDiscordTranslateUi(el)) return false;
  if (isInsidePicker(el)) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT" && /^(text|search)$/i.test(el.type || "text")) return true;

  const ce = (el.getAttribute("contenteditable") || "").toLowerCase();
  if (ce === "true" || ce === "plaintext-only" || ce === "") {
    if (el.isContentEditable) return true;
  }
  if (el.getAttribute("data-slate-editor") === "true") return true;
  if (el.getAttribute("data-slate-node") === "value") return true;
  if (el.getAttribute("role") === "textbox") return true;
  return false;
}

function composerScore(el) {
  let score = 0;
  if (el.closest('[class*="channelTextArea"], [class*="slateContainer"], form')) score += 5;
  if (el.getAttribute("data-slate-editor") === "true") score += 4;
  if (el.getAttribute("data-slate-node") === "value") score += 3;
  if (/message/i.test(el.getAttribute("aria-label") || "")) score += 3;
  if (el.getAttribute("role") === "textbox") score += 2;
  if (el.isContentEditable) score += 1;
  if (el.tagName === "TEXTAREA") score += 1;
  return score;
}

function getComposer() {
  const active = document.activeElement;
  if (isComposerCandidate(active) && active.closest?.('[class*="channelTextArea"], [class*="slateContainer"], form')) {
    return active;
  }
  if (active instanceof Element && !isInsidePicker(active)) {
    const wrap = active.closest(
      '[contenteditable], [data-slate-editor="true"], [data-slate-node="value"], [role="textbox"], textarea'
    );
    if (
      isComposerCandidate(wrap) &&
      wrap.closest?.('[class*="channelTextArea"], [class*="slateContainer"], form')
    ) {
      return wrap;
    }
  }

  const selectors = [
    '[class*="channelTextArea"] [data-slate-editor="true"]',
    '[class*="channelTextArea"] [data-slate-node="value"]',
    '[class*="channelTextArea"] [contenteditable="true"]',
    '[class*="channelTextArea"] [contenteditable="plaintext-only"]',
    '[class*="channelTextArea"] [contenteditable]',
    '[class*="channelTextArea"] [role="textbox"]',
    '[class*="channelTextArea"] textarea',
    '[data-slate-editor="true"]',
    '[data-slate-node="value"]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[contenteditable]',
    '[role="textbox"]',
    "textarea",
    '[class*="slateTextArea"]',
    "main [contenteditable]",
    "form [contenteditable]",
  ];

  const hits = [];
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (!isComposerCandidate(el)) continue;
      hits.push(el);
    }
  }

  hits.sort((a, b) => composerScore(b) - composerScore(a));
  return hits[0] || null;
}

function getComposerRoot(composer) {
  if (!composer) return null;
  return (
    composer.closest('[class*="channelTextArea"]') ||
    composer.closest('[class*="scrollableContainer"]') ||
    composer.closest("form") ||
    composer.parentElement
  );
}

function isComposerEmojiImage(img) {
  if (!(img instanceof HTMLImageElement)) return false;
  if (img.closest?.('[aria-hidden="true"], [class*="hiddenVisually"]')) return false;
  const cls = typeof img.className === "string" ? img.className : String(img.className || "");
  if (/emoji/i.test(cls)) return true;
  if ((img.getAttribute("data-type") || "").toLowerCase() === "emoji") return true;
  const src = img.currentSrc || img.src || "";
  if (/discord(?:app)?\.com\/emojis\//i.test(src)) return true;
  const alt = img.alt || "";
  if (/^:[\w~+-]+:$/.test(alt)) return true;
  return false;
}

function composerEmojiPlain(img) {
  const alt = (img.getAttribute("alt") || "").trim();
  const aria = (img.getAttribute("aria-label") || "").trim();
  const glyph = [alt, aria].find((v) => v && !/^:[\w~+-]+:$/.test(v));
  if (glyph) return glyph;

  const short = (alt || aria).match(/^:([\w~+-]+):$/);
  const src = img.currentSrc || img.src || "";
  const id = src.match(/\/emojis\/(\d+)/)?.[1];
  if (short && id) {
    const animated = /\.gif(?:\?|$)/i.test(src);
    return animated ? `<a:${short[1]}:${id}>` : `<:${short[1]}:${id}>`;
  }
  return alt || aria || "";
}

function normalizeComposerText(raw) {
  return String(raw || "")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\n+$/g, "")
    .trim();
}

function getComposerText(composer) {
  if (!composer) return "";

  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    return (composer.value || "").trim();
  }

  const parts = [];
  const walker = document.createTreeWalker(composer, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);

  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (!parent?.closest?.("[data-slate-string]")) continue;
      if (parent.closest?.("img")) continue;
      parts.push(node.nodeValue || "");
      continue;
    }
    if (node instanceof HTMLImageElement && isComposerEmojiImage(node)) {
      const plain = composerEmojiPlain(node);
      if (plain) parts.push(plain);
    }
  }

  let raw = parts.join("");
  if (!normalizeComposerText(raw)) {
    raw = composer.innerText || composer.textContent || "";
  }

  return normalizeComposerText(raw);
}

function selectComposerContents(composer) {
  composer.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection.removeAllRanges();
  selection.addRange(range);
}

function setComposerText(composer, text) {
  if (!composer) return;
  const plain = String(text ?? "");

  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    composer.value = plain;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  selectComposerContents(composer);
  document.execCommand("insertText", false, plain);
  composer.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data: plain })
  );
}

function getDraftTranslateWrap() {
  return document.querySelector(".discord-translate-draft-translate-wrap");
}

function getDraftTranslateButton() {
  return document.querySelector(".discord-translate-draft-translate-btn");
}

function findComposerButtonsContainer(root) {
  if (!root) return null;

  const containers = [
    ...root.querySelectorAll('[class*="buttons_"], [class*="buttons-"], [class*="buttonContainer"]'),
  ];
  for (const el of containers) {
    if (el.querySelector('[aria-label*="emoji" i], [aria-label*="Apps" i], [aria-label*="GIF" i]')) {
      return el;
    }
  }

  const emojiBtn = root.querySelector(
    '[aria-label*="emoji" i], [aria-label*="Emoji" i], [aria-label*="Select emoji" i]'
  );
  return emojiBtn?.parentElement || null;
}

function findAppsButton(container) {
  if (!container) return null;
  for (const el of container.querySelectorAll('[role="button"], button, div[aria-label]')) {
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    if (!label) continue;
    if (label === "apps" || label.startsWith("apps ") || label.includes(" app launcher")) {
      return el.closest('[class*="button"], [role="button"], button') || el;
    }
  }
  return null;
}

function placeDraftTranslateButton(wrap) {
  const composer = getComposer();
  const root = getComposerRoot(composer);
  if (!root) {
    (document.body || document.documentElement).appendChild(wrap);
    return;
  }

  const buttons = findComposerButtonsContainer(root);
  if (!buttons) {
    const form = composer.closest("form") || root;
    form.appendChild(wrap);
    return;
  }

  const apps = findAppsButton(buttons);
  if (apps) {
    const host = apps.parentElement === buttons ? apps : apps.parentElement || apps;
    if (wrap.previousElementSibling !== host || wrap.parentElement !== buttons) {
      host.insertAdjacentElement("afterend", wrap);
    }
    return;
  }

  if (wrap.parentElement !== buttons || buttons.lastElementChild !== wrap) {
    buttons.appendChild(wrap);
  }
}

function ensureDraftTranslateButton(onClick) {
  let wrap = getDraftTranslateWrap();
  let btn = getDraftTranslateButton();

  if (!wrap || !btn) {
    wrap?.remove();
    wrap = document.createElement("span");
    wrap.className = "discord-translate-draft-translate-wrap";

    btn = document.createElement("div");
    btn.className = "discord-translate-draft-translate-btn";
    btn.setAttribute("role", "button");
    btn.tabIndex = 0;
    setDiscordTranslateIconButton(btn, "Translate");

    const onActivate = (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    };
    btn.addEventListener("click", onActivate);
    btn.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") onActivate(event);
    });

    wrap.appendChild(btn);
  }

  placeDraftTranslateButton(wrap);
  return btn;
}

function syncDraftButtonLabel(showingTranslated) {
  const btn = getDraftTranslateButton();
  if (!btn) return;
  setDiscordTranslateIconButton(btn, showingTranslated ? "Original" : "Translate", {
    active: showingTranslated,
    busy: false,
  });
}

function clearDraftTranslationState(composer) {
  if (!composer) return;
  delete composer.dataset.discordTranslateOriginalDraft;
  delete composer.dataset.discordTranslateTranslatedDraft;
  delete composer.dataset.discordTranslateDraftTranslated;
  composer.classList.remove("discord-translate-inline-error");
}

function startComposerController(getSettingsSnapshot) {
  let requestSerial = 0;
  let lastComposerText = "";
  let draftState = {
    original: "",
    translated: "",
    showingTranslated: false,
  };

  function removeDraftButton() {
    getDraftTranslateWrap()?.remove();
    document.querySelectorAll(".discord-translate-draft-translate-btn").forEach((el) => el.remove());
  }

  function resetDraftState() {
    draftState = { original: "", translated: "", showingTranslated: false };
  }

  function isDraftBusy() {
    return Boolean(getDraftTranslateButton()?.classList.contains("discord-translate-btn--busy"));
  }

  function resetDraftUi(composer) {
    clearDraftTranslationState(composer);
    resetDraftState();
    lastComposerText = getComposerText(composer);
    syncDraftUi();
  }

  function maybeResetWhenEmpty(composer) {
    if (!draftState.showingTranslated && !draftState.original) return;
    if (getComposerText(composer)) return;
    if (getDraftTranslateButton()?.classList.contains("discord-translate-btn--busy")) return;
    resetDraftUi(composer);
  }

  function scheduleResetAfterSend() {
    if (!draftState.showingTranslated) return;
    window.setTimeout(() => {
      const live = getComposer();
      if (!getComposerText(live)) resetDraftUi(live);
    }, 100);
  }

  function isSendButton(el) {
    const label = (el.getAttribute?.("aria-label") || "").toLowerCase();
    return label.includes("send message") || label === "send";
  }

  async function translateDraft() {
    const settings = getSettingsSnapshot();
    const composer = getComposer();

    if (!settings?.enabled || !composer) return;

    if (draftState.showingTranslated) {
      const original = draftState.original;
      setComposerText(composer, original);
      clearDraftTranslationState(composer);
      resetDraftState();
      lastComposerText = original;
      syncDraftUi();
      return;
    }

    if (isDraftBusy()) return;

    const draft = getComposerText(composer);
    if (!draft || draft.startsWith("/")) return;

    draftState.original = draft;
    draftState.translated = "";
    draftState.showingTranslated = false;
    composer.dataset.discordTranslateOriginalDraft = draft;
    setDiscordTranslateIconButton(getDraftTranslateButton(), "Translating…", { busy: true });

    const serial = ++requestSerial;

    try {
      const result = await translateText(draft, settings.outgoing, "auto");
      const live = getComposer() || composer;
      if (serial !== requestSerial) {
        syncDraftUi();
        return;
      }

      if (translationUnchanged(result, draft, settings.outgoing)) {
        clearDraftTranslationState(live);
        resetDraftState();
        syncDraftUi();
        return;
      }

      const current = getComposerText(live);
      if (!current || current.startsWith("/")) {
        clearDraftTranslationState(live);
        resetDraftState();
        syncDraftUi();
        return;
      }

      if (!result.text) {
        clearDraftTranslationState(live);
        resetDraftState();
        live.classList.add("discord-translate-inline-error");
        syncDraftUi();
        return;
      }

      draftState.original = draft;
      draftState.translated = result.text;
      draftState.showingTranslated = true;
      live.dataset.discordTranslateOriginalDraft = draft;
      live.dataset.discordTranslateTranslatedDraft = result.text;
      live.dataset.discordTranslateDraftTranslated = "1";
      setComposerText(live, result.text);
      lastComposerText = result.text;
      syncDraftUi();
    } catch (err) {
      if (serial !== requestSerial) {
        syncDraftUi();
        return;
      }
      const live = getComposer() || composer;
      clearDraftTranslationState(live);
      resetDraftState();
      live.classList.add("discord-translate-inline-error");
      syncDraftUi();
      console.warn("[Discord Translate] draft translate failed:", err);
    }
  }

  let syncTimer = 0;
  let syncing = false;
  let lastPlacedComposer = null;

  function draftButtonIsCorrectlyPlaced(composer) {
    const wrap = getDraftTranslateWrap();
    if (!wrap?.isConnected || !composer) return false;
    const root = getComposerRoot(composer);
    if (!root?.contains(wrap)) return false;
    const buttons = findComposerButtonsContainer(root);
    if (buttons) return buttons.contains(wrap);
    return true;
  }

  function syncDraftUi() {
    if (syncing) return;
    syncing = true;
    try {
      const settings = getSettingsSnapshot();
      const composer = getComposer();

      if (!settings?.enabled) {
        removeDraftButton();
        clearDraftTranslationState(composer);
        resetDraftState();
        lastPlacedComposer = null;
        return;
      }

      if (!composer) {
        if (isInsidePicker(document.activeElement) && getDraftTranslateWrap()?.isConnected) {
          return;
        }
        removeDraftButton();
        lastPlacedComposer = null;
        return;
      }

      ensureDraftTranslateButton(translateDraft);
      lastPlacedComposer = composer;
      syncDraftButtonLabel(draftState.showingTranslated);
      maybeResetWhenEmpty(composer);
    } finally {
      syncing = false;
    }
  }

  function scheduleDraftSync(delayMs = 200) {
    if (syncing) return;
    if (syncTimer) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
      syncTimer = 0;
      syncDraftUi();
    }, delayMs);
  }

  function mutationAffectsComposerArea(mutation) {
    if (mutation.type !== "childList") return false;

    for (const node of mutation.removedNodes) {
      if (!(node instanceof Element)) continue;
      if (
        node.classList?.contains("discord-translate-draft-translate-wrap") ||
        node.querySelector?.(".discord-translate-draft-translate-wrap, .discord-translate-draft-translate-btn")
      ) {
        return true;
      }
    }

    if (!mutation.addedNodes.length) return false;
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (isDiscordTranslateUi(node)) continue;
      if (isInsidePicker(node)) continue;
      if (
        node.matches?.(
          '[contenteditable], [data-slate-editor], [role="textbox"], textarea, [class*="channelTextArea"], [class*="slateContainer"], [class*="buttons_"], [class*="buttons-"], [class*="buttonContainer"], form'
        ) ||
        node.querySelector?.(
          '[contenteditable], [data-slate-editor], [role="textbox"], textarea, [class*="channelTextArea"], [class*="buttons_"], [class*="buttons-"]'
        )
      ) {
        return true;
      }
    }

    const t = mutation.target;
    if (
      t instanceof Element &&
      t.closest?.('[class*="channelTextArea"], [class*="slateContainer"], [class*="form_"], form') &&
      !t.closest?.(
        `${PICKER_ROOT_SELECTOR}, [id^='chat-messages-'], [data-list-id='chat-messages']`
      )
    ) {
      return true;
    }
    return false;
  }

  syncDraftUi();

  const inputObserver = new MutationObserver((mutations) => {
    if (syncing) return;
    for (const mutation of mutations) {
      if (!mutationAffectsComposerArea(mutation)) continue;
      const dropped = [...mutation.removedNodes].some(
        (n) =>
          n instanceof Element &&
          (n.classList?.contains("discord-translate-draft-translate-wrap") ||
            n.querySelector?.(".discord-translate-draft-translate-wrap"))
      );
      scheduleDraftSync(dropped ? 50 : mutations.length > 40 ? 600 : 200);
      return;
    }
  });
  inputObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  function onComposerInput(event) {
    const t = event.target;
    if (!(t instanceof Element) || isInsidePicker(t)) return;
    if (!isComposerCandidate(t) && !t.closest?.('[contenteditable], [role="textbox"], textarea')) {
      return;
    }
    maybeResetWhenEmpty(getComposer());
  }
  document.addEventListener("input", onComposerInput, true);

  function onComposerKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.isComposing) return;
    const composer = getComposer();
    if (!composer || !draftState.showingTranslated) return;
    if (!composer.contains(event.target) && event.target !== composer) return;
    scheduleResetAfterSend();
  }
  document.addEventListener("keydown", onComposerKeyDown, true);

  function onComposerClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || isDiscordTranslateUi(target)) return;

    const label = (target.closest?.("[aria-label]")?.getAttribute("aria-label") || "").toLowerCase();
    if (
      /emoji|gif|sticker|apps|express/.test(label) &&
      target.closest?.('[class*="channelTextArea"], [class*="buttons_"], [class*="buttons-"], form')
    ) {
      scheduleDraftSync(50);
      window.setTimeout(() => {
        if (!draftButtonIsCorrectlyPlaced(getComposer())) scheduleDraftSync(0);
      }, 350);
    }

    if (!draftState.showingTranslated) return;
    const btn = target.closest('[role="button"], button');
    if (!btn || !isSendButton(btn)) return;
    const composer = getComposer();
    if (!composer || !getComposerRoot(composer)?.contains(btn)) return;
    scheduleResetAfterSend();
  }
  document.addEventListener("click", onComposerClick, true);

  function onFocusIn(event) {
    if (isInsidePicker(event.target)) {
      if (!draftButtonIsCorrectlyPlaced(getComposer())) scheduleDraftSync(50);
      return;
    }
    scheduleDraftSync(100);
  }
  document.addEventListener("focusin", onFocusIn, true);

  function onSettingsChanged() {
    requestSerial += 1;
    const composer = getComposer();
    if (draftState.showingTranslated && draftState.original) {
      setComposerText(composer, draftState.original);
    }
    clearDraftTranslationState(composer);
    resetDraftState();
    removeDraftButton();
    lastPlacedComposer = null;
    syncDraftUi();
  }

  window.setInterval(() => scheduleDraftSync(0), 15_000);

  return { onSettingsChanged };
}
