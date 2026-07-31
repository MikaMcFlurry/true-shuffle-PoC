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

/**
 * A response with no usable body still has to say something in the interface's
 * language. These are last resorts — the server sends German details.
 */
const HTTP_TEXT = {
  401: "Nicht angemeldet.",
  403: "Dafür fehlt die Berechtigung.",
  404: "Das gibt es nicht.",
  409: "Das geht in diesem Zustand nicht.",
  429: "Der Dienst bremst gerade — kurz warten und erneut versuchen.",
  500: "Auf dem Server ist etwas schiefgegangen.",
  502: "Der Streamingdienst hat nicht geantwortet.",
  503: "Der Dienst ist gerade nicht erreichbar.",
  504: "Der Streamingdienst hat zu lange gebraucht.",
};

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
    const message = (payload && (payload.detail || payload.message))
      || HTTP_TEXT[res.status] || `HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return payload;
}

/* -- theme ---------------------------------------------------------------- */

const THEME_KEY = "true_shuffle_theme";

/** The control names the state it will switch to, in the interface language. */
function labelTheme(button, current) {
  const next = current === "dark" ? "light" : "dark";
  button.textContent = next === "dark" ? "Dunkel" : "Hell";
  button.setAttribute("aria-label", `Zu ${next === "dark" ? "dunkler" : "heller"} Ansicht wechseln`);
}

export function initTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "dark" || stored === "light") {
    document.documentElement.dataset.theme = stored;
  }
  const button = $("#themeToggle");
  if (!button) return;
  labelTheme(button, document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
  button.addEventListener("click", () => {
    const current =
      document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    labelTheme(button, next);
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
  return Number(value ?? 0).toLocaleString("de-DE");
}

/** "2026-07-30 14:22:11" (UTC, from SQLite) → a legible local time. */
export function formatWhen(value) {
  if (!value) return "";
  const at = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(at.getTime())) return value;
  const minutes = Math.round((Date.now() - at.getTime()) / 60000);
  if (minutes < 1) return "gerade eben";
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.round(hours / 24);
  if (days < 8) return `vor ${days} ${days === 1 ? "Tag" : "Tagen"}`;
  return at.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** "2026-07-30 14:22:11" (UTC, from SQLite) → a German day heading. */
export function formatDay(value) {
  if (!value) return "";
  const at = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
}

/** Local clock time only — pair with formatDay(), which already carries the date. */
export function formatClock(value) {
  if (!value) return "";
  const at = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

/* -- icons -------------------------------------------------------------
   A handful of chip/banner glyphs get built from JS (dashboard cards,
   player state). document.createElement("svg") never yields a real
   SVGElement — its children silently fail to render — so this goes through
   createElementNS instead. `inner` is always a hard-coded, trusted string. */

const SVG_NS = "http://www.w3.org/2000/svg";

export function svgIcon(viewBox, inner, attrs = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
  svg.innerHTML = inner;
  return svg;
}

/**
 * The three system-state glyphs Phase 1 can reach (A/B/D — C has no producer
 * yet, ADR-001). Colour + chip shape already carry the meaning on their own;
 * the icon is the ADR's "additionally", never the only signal.
 */
export const STATE_ICON = {
  a: {
    viewBox: "0 0 16 16", attrs: { fill: "currentColor" },
    inner: '<rect x="1.5" y="6" width="2.6" height="5" rx="1.3"/><rect x="6.7" y="2.5" width="2.6" height="11" rx="1.3"/><rect x="11.9" y="4.5" width="2.6" height="8" rx="1.3"/>',
  },
  b: {
    viewBox: "0 0 16 16",
    attrs: { fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round" },
    inner: '<path d="M5.5 7.5V3.2a1.2 1.2 0 0 1 2.4 0v3.6m0-1.6a1.2 1.2 0 0 1 2.4 0v1.9m0-.9a1.2 1.2 0 0 1 2.4.4v2.9c0 2.6-1.9 4.3-4.5 4.3S4 12.6 3.4 10.6L2.3 7.4a1.1 1.1 0 0 1 2-.8l1.2 1.9"/>',
  },
  d: {
    viewBox: "0 0 16 16",
    attrs: { fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round" },
    inner: '<rect x="4.5" y="1.8" width="7" height="12.4" rx="1.6"/><circle cx="8" cy="10.6" r="1.7"/><path d="M2 2l12 12"/>',
  },
};

/** Contract vocabulary — shared by the dashboard cards and the player header.
 *  "gestoppt" (F1, ADR-003) is a deliberate session end: not live, but fully
 *  resumable — the card offers "Fortsetzen", never "Details". */
export const CONTRACT_TEXT = {
  active: "aktiv", paused: "pausiert", stopped: "gestoppt",
  completed: "abgeschlossen", cancelled: "beendet",
};

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
      onError?.(new Error(frame.message || "Der Auftrag ist fehlgeschlagen."));
    } else if (frame.status === "cancelled") {
      source.close();
      onError?.(new Error("Der Auftrag wurde abgebrochen."));
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
        if (snap.status === "error") return onError?.(new Error(snap.message || "Der Auftrag ist fehlgeschlagen."));
        if (snap.status === "cancelled") return onError?.(new Error("Der Auftrag wurde abgebrochen."));
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
