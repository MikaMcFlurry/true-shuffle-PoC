/* Shared front-end helpers: API access, theming, small DOM utilities. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined && value !== false) {
      node.setAttribute(key, value);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Fetch JSON from the API, turning error responses into thrown Errors. */
export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { detail: text }; }
  }

  if (!res.ok) {
    const message = (payload && (payload.detail || payload.message)) || `HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return payload;
}

/* -- theme ---------------------------------------------------------------- */

const THEME_KEY = "true_shuffle_theme";

export function initTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "dark" || stored === "light") {
    document.documentElement.dataset.theme = stored;
  }
  const button = $("#themeToggle");
  if (!button) return;
  button.addEventListener("click", () => {
    const current =
      document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    button.setAttribute("aria-label", `Switch to ${next === "dark" ? "light" : "dark"} theme`);
  });
}

/* -- formatting ----------------------------------------------------------- */

export function formatDuration(ms) {
  if (!ms) return "";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function formatCount(value) {
  return Number(value ?? 0).toLocaleString();
}

/**
 * Show a message in a `.note` box, or hide it when the text is empty.
 * The stencilled label carries the severity, so the box needs no edge stripe.
 */
export function setNote(node, text, variant = "", label = "Hinweis") {
  if (!node) return;
  node.className = `note ${variant}`.trim();
  node.classList.toggle("hidden", !text);
  if (!text) {
    node.replaceChildren();
    return;
  }
  node.replaceChildren(
    el("span", { class: "stencil" }, label),
    el("span", {}, text)
  );
}

/** Deterministic printed-card tint for a track, 1–6. Never claims to be art. */
export function spineTint(id) {
  let hash = 0;
  for (let i = 0; i < (id || "").length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return String((hash % 6) + 1);
}

/* -- job progress --------------------------------------------------------- */

/**
 * Follow a background job to completion.
 * Uses server-sent events, falling back to polling if EventSource is missing.
 */
export function followJob(jobId, { onProgress, onDone, onError }) {
  if (typeof EventSource === "undefined") return pollJob(jobId, { onProgress, onDone, onError });

  const source = new EventSource(`/api/jobs/${jobId}/stream`);
  source.onmessage = (event) => {
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }

    if (frame.status === "done") {
      source.close();
      onDone?.(frame.result || {});
    } else if (frame.status === "error") {
      source.close();
      onError?.(new Error(frame.message || "The job failed."));
    } else if (frame.status === "cancelled") {
      source.close();
      onError?.(new Error("The job was cancelled."));
    } else {
      onProgress?.(frame);
    }
  };
  source.onerror = () => {
    source.close();
    // The stream can drop on a proxy timeout; the job itself is unaffected.
    pollJob(jobId, { onProgress, onDone, onError });
  };
  return () => source.close();
}

function pollJob(jobId, { onProgress, onDone, onError }) {
  let stopped = false;
  (async function loop() {
    while (!stopped) {
      try {
        const snap = await api(`/api/jobs/${jobId}`);
        if (snap.status === "done") return onDone?.(snap.result || {});
        if (snap.status === "error") return onError?.(new Error(snap.message || "The job failed."));
        if (snap.status === "cancelled") return onError?.(new Error("The job was cancelled."));
        onProgress?.(snap);
      } catch (err) {
        return onError?.(err);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  })();
  return () => { stopped = true; };
}

initTheme();
