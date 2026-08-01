/*
 * Run player — Control-Center.
 *
 * Two very different worlds meet here, behind one interface:
 *
 *  - REMOTE_DEVICE (Spotify): the *server* drives an app the listener already
 *    has open, and a background watcher advances the run. This page only
 *    reflects that state, so it polls.
 *
 *  - WEB_PLAYER (Apple Music, YouTube Music): *this tab* owns the audio, so it
 *    is the only thing that can know a track ended. It reports every end and
 *    every skip to the server, which owns the run and the cursor.
 *
 * The server is the single source of truth for the cursor in both cases; the
 * page never decides what plays next on its own. It also never claims a
 * system state it has not confirmed — see _deriveSystemState().
 */

import { $, api, el, formatDuration, formatCount, setNote, svgIcon, STATE_ICON, CONTRACT_TEXT } from "./app.js";

/* ========================================================================== */
/* Web players                                                                */
/* ========================================================================== */

class WebPlayerBase {
  constructor() {
    this.handlers = { ended: [], error: [], progress: [] };
  }
  on(event, fn) { this.handlers[event]?.push(fn); return this; }
  emit(event, payload) { for (const fn of this.handlers[event] || []) fn(payload); }
  async init() {}
  async play() {}
  async pause() {}
  async resume() {}
  get label() { return "Web player"; }
}

/** Apple Music via MusicKit JS v3. */
class AppleWebPlayer extends WebPlayerBase {
  constructor(config) { super(); this.config = config; this.music = null; }
  get label() { return "Apple Music (this tab)"; }

  async init() {
    await loadScript("https://js-cdn.music.apple.com/musickit/v3/musickit.js", () =>
      typeof window.MusicKit !== "undefined" && typeof window.MusicKit.configure === "function");

    this.music = await window.MusicKit.configure({
      developerToken: this.config.developer_token,
      app: { name: this.config.app_name || "true-shuffle", build: this.config.app_build || "0.2.0" },
    });

    // The account was authorised when the service was connected; reuse that
    // token so the listener is not prompted again on every run.
    if (this.config.music_user_token && !this.music.isAuthorized) {
      this.music.musicUserToken = this.config.music_user_token;
    }
    if (!this.music.isAuthorized) await this.music.authorize();

    const States = window.MusicKit.PlaybackStates;
    this.music.addEventListener("playbackStateDidChange", ({ state }) => {
      if (state === States.completed || state === States.ended) this.emit("ended");
    });
    this.music.addEventListener("playbackTimeDidChange", ({ currentPlaybackTime }) => {
      this.emit("progress", { position_ms: Math.round((currentPlaybackTime || 0) * 1000) });
    });
  }

  async play(trackId) {
    await this.music.setQueue({ song: trackId, startPlaying: true });
  }
  async pause()  { await this.music.pause(); }
  async resume() { await this.music.play(); }
}

/** YouTube Music via the official YouTube IFrame Player API. */
class YouTubeWebPlayer extends WebPlayerBase {
  constructor(config, mountId) { super(); this.config = config; this.mountId = mountId; this.player = null; }
  get label() { return "YouTube (this tab)"; }

  async init() {
    await loadYouTubeApi();
    await new Promise((resolve, reject) => {
      this.player = new window.YT.Player(this.mountId, {
        height: "220",
        width: "100%",
        playerVars: { autoplay: 1, controls: 1, rel: 0, playsinline: 1 },
        events: {
          onReady: () => resolve(),
          onError: (e) => this.emit("error", new Error(youtubeErrorText(e.data))),
          onStateChange: (e) => {
            if (e.data === window.YT.PlayerState.ENDED) this.emit("ended");
          },
        },
      });
      setTimeout(() => reject(new Error("Der YouTube-Player wurde nicht geladen.")), 15000);
    });

    this.timer = setInterval(() => {
      if (!this.player?.getCurrentTime) return;
      this.emit("progress", { position_ms: Math.round(this.player.getCurrentTime() * 1000) });
    }, 5000);
  }

  async play(trackId) { this.player.loadVideoById(trackId); }
  async pause()  { this.player.pauseVideo(); }
  async resume() { this.player.playVideo(); }
}

function youtubeErrorText(code) {
  if (code === 101 || code === 150) return "Der Rechteinhaber erlaubt keine Wiedergabe außerhalb von YouTube.";
  if (code === 100) return "Dieses Video wurde entfernt oder auf privat gestellt.";
  if (code === 2) return "YouTube hat die Video-ID abgelehnt.";
  return `Der YouTube-Player meldet Fehler ${code}.`;
}

function loadScript(src, isReady) {
  if (isReady && isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    const node = existing || Object.assign(document.createElement("script"), { src, async: true });
    node.addEventListener("load", () => resolve());
    node.addEventListener("error", () => reject(new Error(`${src} konnte nicht geladen werden.`)));
    if (!existing) document.head.append(node);
  });
}

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(); };
    loadScript("https://www.youtube.com/iframe_api").catch(reject);
  });
}

/* ========================================================================== */
/* Icons the player builds itself (chip/banner/transport glyphs change with   */
/* state; everything static lives as markup in player.html).                 */
/* ========================================================================== */

const ICON_PLAY = { viewBox: "0 0 24 24", attrs: { fill: "currentColor" }, inner: '<path d="M8 5.5v13l11-6.5z"/>' };
const ICON_PAUSE = {
  viewBox: "0 0 24 24", attrs: { fill: "currentColor" },
  inner: '<rect x="6.5" y="5" width="3.6" height="14" rx="1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1"/>',
};
const ICON_NO_COVER = { viewBox: "0 0 24 24", attrs: { fill: "currentColor" }, inner: '<path d="M9 3v10.6A3.5 3.5 0 1 0 11 17V7h6.5a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H9z"/>' };
const ICON_ATTRIBUTION = {
  viewBox: "0 0 16 16", attrs: { fill: "currentColor" },
  inner: '<path d="M9.5 1.8v8a2.8 2.8 0 1 0 1.4 2.4V5.4l3-.8V2l-4.4 1.2z" opacity=".9"/><path d="M2 4.5h5v1.4H2zM2 7.3h5v1.4H2zM2 10.1h3.4v1.4H2z"/>',
};
const ICON_DONE = {
  viewBox: "0 0 24 24",
  attrs: { fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round" },
  inner: '<path d="M4 12.5 9.5 18 20 6"/>',
};
const ICON_STOPPED = {
  viewBox: "0 0 24 24",
  attrs: { fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round" },
  inner: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
};

/* WP3-D3 (UC-08/20): per-row favourite / exclude glyphs in "Als Nächstes". */
const ICON_STAR = {
  viewBox: "0 0 24 24",
  attrs: { fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linejoin": "round" },
  inner: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
};
const ICON_BAN = {
  viewBox: "0 0 24 24",
  attrs: { fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round" },
  inner: '<circle cx="12" cy="12" r="8.2"/><path d="M6.4 6.4l11.2 11.2"/>',
};

/* UC-07: per-track draw weight, cycled through three honest stages —
   shape communicates direction (down / level / up), colour is reserved for
   the one stage that is not the default (ADR-001 Auflage 4: no invented
   state colours, only the existing --signal "on" tone the star already
   uses). The exact value always lives in the title tooltip; the rounded
   stage carries the icon + aria-label. */
const ICON_WEIGHT_LOW = {
  viewBox: "0 0 24 24",
  attrs: { fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" },
  inner: '<path d="M12 5v11M7 12l5 5 5-5"/>',
};
const ICON_WEIGHT_MID = {
  viewBox: "0 0 24 24",
  attrs: { fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round" },
  inner: '<path d="M6 9h12M6 15h12"/>',
};
const ICON_WEIGHT_HIGH = {
  viewBox: "0 0 24 24",
  attrs: { fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" },
  inner: '<path d="M12 19V8M7 12l5-5 5 5"/>',
};

//: value → { label, icon }, in cycle order (Selten → Normal → Öfter → …).
const WEIGHT_LEVELS = [
  { value: 0.4, label: "Selten", icon: ICON_WEIGHT_LOW },
  { value: 1.0, label: "Normal", icon: ICON_WEIGHT_MID },
  { value: 2.0, label: "Öfter", icon: ICON_WEIGHT_HIGH },
];

/** Continuous weight → nearest of the three UI stages (server allows 0.1..10). */
function nearestWeightLevel(weight) {
  let best = WEIGHT_LEVELS[1];
  let bestDiff = Infinity;
  for (const level of WEIGHT_LEVELS) {
    const diff = Math.abs((weight ?? 1.0) - level.value);
    if (diff < bestDiff) { bestDiff = diff; best = level; }
  }
  return best;
}

function formatWeightValue(weight) {
  return Number(weight ?? 1.0).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

const REASON_TEXT = {
  local_file: "lokale Datei",
  not_playable: "hier nicht verfügbar",
  wrong_kind: "kein Musiktitel",
  duplicate: "schon im Hörvorgang",
  missing_id: "keine Titel-ID",
};

/* ========================================================================== */
/* Run controller                                                             */
/* ========================================================================== */

export class RunPlayer {
  constructor(runId, provider, statusVocab = {}) {
    this.runId = runId;
    this.provider = provider;
    this.vocab = statusVocab;
    this.state = null;
    this.web = null;
    this.poller = null;
    this.playing = false;
    this.lastPlayedId = null;
    //: Set once a device fetch has actually run — null means "not checked
    //: yet", never treated as "no device" (that would fake system state D).
    this.noDevices = null;
    //: Confirmed name of the run currently holding the one-playing slot
    //: (idx_runs_one_playing) while THIS run sits paused-at-birth. null
    //: until explainIfBlockedBySlot() has actually checked.
    this.slotBlockerName = null;
    this.position = { ms: 0, at: 0, known: false };
    this._posTimer = null;
  }

  get isRemote() { return this.provider.playback === "remote_device"; }

  async boot() {
    this.state = await api(`/api/runs/${this.runId}`);
    // `active` in the database means "this is the live run", NOT "audio is
    // playing" — a run is active from the moment it is dealt. Reading it as
    // playing made a freshly dealt run claim it was running with Pause
    // enabled before anyone had pressed anything.
    //
    // Remote: the server only runs a watcher while it is actually driving
    // playback, so that flag is the honest answer.
    // Web player: this tab just loaded, so it is playing nothing, full stop.
    this.playing = this.isRemote
      && this.state.status === "active"
      && Boolean(this.state.watcher?.watching);
    this.render();
    this.loadSkipped();
    this.loadExcluded();
    if (this.isRemote && this.playing) this.startPolling();

    if (this.isRemote) {
      await this.loadDevices();
      await this.explainIfBlockedBySlot();
    } else if (this.provider.playback === "web_player") {
      const { config } = await api(`/api/player-config?provider=${this.provider.id}`);
      this.web = this.provider.id === "apple"
        ? new AppleWebPlayer(config)
        : new YouTubeWebPlayer(config, "ytmount");

      this.web
        .on("ended", () => this.report("track_ended"))
        .on("error", (err) => {
          this.notify(err.message, "note-stop", "Wiedergabe");
          // A track that will not play must not stall the run.
          this.report("playback_failed");
        })
        .on("progress", (payload) => this.trackPosition(payload.position_ms));

      await this.web.init();
    } else {
      this.notify(
        `${this.provider.display_name} unterstützt keine Wiedergabesteuerung durch true-shuffle — die Playlist läuft eigenständig in der App.`,
        "", "Hinweis"
      );
    }
  }

  /**
   * A page that cannot load its run says so, and stops offering transport.
   *
   * The readings are blanked rather than left at their initial state: a
   * frozen "Wird geladen…" next to dead buttons is a worse lie than an em
   * dash.
   */
  failed(message) {
    this.playing = false;
    this.stopPolling();
    this.stopPositionTimer();
    $("#trackTitle").textContent = "Hörvorgang nicht geladen";
    $("#trackArtist").textContent = message;
    $("#trackPosition").textContent = "–:– / –:–";
    $("#coverWrap")?.replaceChildren();
    $("#runProgressLine")?.replaceChildren(el("span", {}, "—"), el("span", {}, "—"));
    const contract = $("#contractChip");
    if (contract) { contract.textContent = "Fehler"; contract.className = "chip chip-error"; }
    $("#stateChip")?.classList.add("hidden");
    for (const id of ["#prevBtn", "#mainBtn", "#nextBtn"]) {
      const node = $(id);
      if (node) node.setAttribute("aria-disabled", "true");
    }
    const cancel = $("#cancelBtn");
    if (cancel) cancel.disabled = true;
  }

  /* -- transport ---------------------------------------------------------- */

  async start() {
    const deviceId = $("#deviceSelect")?.value || null;
    this.state = await api(`/api/runs/${this.runId}/start`, {
      method: "POST", body: { device_id: deviceId },
    });
    this.playing = true;
    await this.syncWebPlayback();
    this.render();
    this.startPolling();
  }

  async next()     { await this.move("advance", { reason: "user_skip" }); }
  async previous() { await this.move("previous", {}); }

  /** Space bar / main button: start the run, or pause/resume once running. */
  async toggle() {
    if (this.state?.status === "completed" || this.state?.status === "cancelled") return;
    if (!this.playing) return this.start();
    return this.pause();
  }

  async move(endpoint, body) {
    this.state = await api(`/api/runs/${this.runId}/${endpoint}`, { method: "POST", body });
    this.resetPosition();
    await this.syncWebPlayback();
    this.render();
  }

  /** Tell the server something happened in this tab's player. */
  async report(type) {
    try {
      this.state = await api(`/api/runs/${this.runId}/event`, {
        method: "POST", body: { type },
      });
      this.resetPosition();
      await this.syncWebPlayback();
      this.render();
    } catch (err) {
      this.notify(err.message, "note-stop", "Fehler");
    }
  }

  async pause() {
    await api(`/api/runs/${this.runId}/pause`, { method: "POST" });
    await this.web?.pause();
    this.playing = false;
    this.stopPolling();
    this.stopPositionTimer();
    this.state = await api(`/api/runs/${this.runId}`);
    this.render();
  }

  async cancel() {
    await api(`/api/runs/${this.runId}/cancel`, { method: "POST" });
  }

  /** Push the server's current track into the in-tab player, if it changed. */
  async syncWebPlayback() {
    if (this.isRemote || !this.web || !this.playing) return;
    const trackId = this.state?.current?.id;
    if (!trackId || trackId === this.lastPlayedId) return;
    this.lastPlayedId = trackId;
    try {
      await this.web.play(trackId);
    } catch (err) {
      this.notify(`Wiedergabe fehlgeschlagen: ${err.message}`, "note-stop", "Wiedergabe");
      await this.report("playback_failed");
    }
  }

  /* -- remote reflection --------------------------------------------------- */

  startPolling() {
    if (!this.isRemote || this.poller) return;
    this.poller = setInterval(async () => {
      try {
        const next = await api(`/api/runs/${this.runId}`);
        const changed = next.cursor !== this.state?.cursor || next.status !== this.state?.status
          || next.watcher?.watching !== this.state?.watcher?.watching
          || next.watcher?.drifted !== this.state?.watcher?.drifted;
        this.state = next;
        if (changed) this.render();
        if (next.status !== "active") this.stopPolling();
      } catch { /* transient; the next tick retries */ }
    }, 4000);
  }

  stopPolling() { clearInterval(this.poller); this.poller = null; }

  async loadDevices() {
    const select = $("#deviceSelect");
    try {
      const { devices } = await api(`/api/devices?provider=${this.provider.id}`);
      this.noDevices = devices.length === 0;
      if (select) {
        select.replaceChildren(
          ...(devices.length
            ? devices.map((d) => el("option", { value: d.id, selected: d.is_active || null },
                `${d.name} · ${d.kind}`))
            : [el("option", { value: "" }, "Kein Gerät gefunden")])
        );
      }
    } catch (err) {
      this.notify(err.message, "note-stop", "Fehler");
    }
    this.render();
  }

  /**
   * A second Live run of the same provider is honestly dealt 'paused'
   * (idx_runs_one_playing / SP-003 — only one controller run may actively
   * drive a device). Without an explanation this reads as an unexplained
   * "pausiert" on a run nobody paused. Confirmed, not guessed: this only
   * speaks up once it has actually found the run that holds the slot — the
   * same 409 sentence pressing Start would show (runs.py `_slot_conflict`),
   * surfaced here proactively instead of waiting for that press.
   *
   * Renders into #transportHint (BELOW the transport), not the #playerNote
   * banner above it: that banner sits ahead of .player-grid, and on a phone
   * viewport its extra lines push the transport button below the fold —
   * exactly the control ADR-001 requires to stay reachable without
   * scrolling. The hint line already exists for every other "why can't I
   * press this" case (drift, awaiting-decision, no device); this is simply
   * one more.
   */
  async explainIfBlockedBySlot() {
    this.slotBlockerName = null;
    if (!this.isRemote || this.state?.status !== "paused" || (this.state?.cursor || 0) > 0) return;
    try {
      const { runs } = await api("/api/runs");
      const blocker = runs.find((r) =>
        r.id !== this.runId && r.provider === this.provider.id
        && r.mode === "controller" && r.status === "active");
      this.slotBlockerName = blocker ? (blocker.name || blocker.playlist_name || "Ein anderer Hörvorgang") : null;
    } catch { /* best effort — a page that cannot confirm the blocker stays silent */ }
    if (this.slotBlockerName) this.render();
  }

  /* -- rendering ----------------------------------------------------------- */

  async guard(fn) {
    try {
      this.notify("");
      await fn();
    } catch (err) {
      this.notify(err.message, "note-stop", "Fehler");
    }
  }

  notify(text, variant, label) { setNote($("#playerNote"), text, variant, label); }

  /** Entries that never entered the run, with the reason each was left out. */
  async loadSkipped() {
    const card = $("#skippedCard");
    if (!card) return;
    try {
      const { skipped } = await api(`/api/runs/${this.runId}/skipped`);
      if (!skipped.length) return;          // stays hidden — nothing was dropped
      card.classList.remove("hidden");
      $("#skippedRead").textContent =
        `${formatCount(skipped.length)} ${skipped.length === 1 ? "Eintrag" : "Einträge"}`;
      $("#skippedList").replaceChildren(
        ...skipped.map((s) =>
          el("div", {},
            el("span", { class: "k" }, REASON_TEXT[s.reason] || s.reason),
            el("span", { class: "v dim wrap-anywhere" },
              [s.name, s.artist].filter(Boolean).join(" — ") || s.track_id)))
      );
    } catch {
      card.classList.add("hidden");
    }
  }

  /**
   * UC-21: the run's excluded rows — ``excluded_user`` (revocable, this
   * run's own exclusion) and ``excluded_rule`` (import-time, never
   * revocable here — see runs.set_track_exclusion / RunError 409). The
   * section itself always stays visible (a run with nothing excluded is
   * still an honest, expected state, not an error), only its *body* is a
   * disclosure the listener opens.
   */
  async loadExcluded() {
    const section = $("#excludedSection");
    if (!section) return;
    try {
      const { tracks } = await api(`/api/runs/${this.runId}/tracks?state=excluded`);
      this.excludedTracks = tracks;
    } catch {
      this.excludedTracks = [];
    }
    this.renderExcluded();
  }

  renderExcluded() {
    const list = $("#excludedList");
    const read = $("#excludedRead");
    if (!list || !read) return;
    const tracks = this.excludedTracks || [];
    read.textContent = tracks.length
      ? `${formatCount(tracks.length)} ${tracks.length === 1 ? "Titel" : "Titel"}`
      : "Keine";

    if (!tracks.length) {
      list.replaceChildren(
        el("li", { class: "excluded-empty" }, "Keine ausgeschlossenen Titel in diesem Hörvorgang.")
      );
      return;
    }

    list.replaceChildren(
      ...tracks.map((t) => {
        const label = [t.name, t.artist].filter(Boolean).join(" — ") || "Titel ohne Namen";
        const row = el("li", { class: "excluded-row" },
          el("div", {},
            el("span", { class: "u-name wrap-anywhere" }, t.name || "Titel ohne Namen"),
            el("span", { class: "u-meta wrap-anywhere" }, t.artist || "")));
        if (t.state === "excluded_user") {
          row.append(el("button", {
            class: "btn btn-secondary", type: "button",
            onClick: () => this.guard(() => this.reactivateTrack(t)),
          }, "Wieder aufnehmen"));
        } else {
          // excluded_rule: an honest, non-interactive explanation — never a
          // disabled-looking button that promises an action it will 409 on.
          row.append(el("span", { class: "excluded-reason dim sm" },
            "Beim Import ausgeschlossen — nicht wieder aufnehmbar"));
        }
        return row;
      })
    );
  }

  /** UC-21: revoke this run's own exclusion — 404/409 surface via guard(). */
  async reactivateTrack(entry) {
    await api(`/api/runs/${this.runId}/tracks/${entry.run_track_id}/exclude`, {
      method: "DELETE",
    });
    this.state = await api(`/api/runs/${this.runId}`);
    this.render();
    await this.loadExcluded();
    // The pressed button's row is gone from the DOM now — send focus
    // somewhere still meaningful instead of letting it fall back to <body>.
    const nextButton = $("#excludedList button.btn");
    (nextButton || $("#excludedToggle"))?.focus();
    this.notify(
      `„${entry.name || "Titel"}“ ist wieder Teil dieses Hörvorgangs.`,
      "note-ok", "Wieder aufgenommen"
    );
  }

  /* -- position tracking ----------------------------------------------------
     Remote (Spotify) never hands the client a position, so the elapsed side
     stays an honest "–:–" for that mode. Web players report real progress
     events; between events the clock is interpolated so it does not stall. */

  trackPosition(ms) {
    this.position = { ms, at: Date.now(), known: true };
    this.renderPosition();
    if (this.playing && !this._posTimer) {
      this._posTimer = setInterval(() => this.renderPosition(), 500);
    }
  }

  resetPosition() {
    this.position = { ms: 0, at: 0, known: false };
    this.stopPositionTimer();
  }

  stopPositionTimer() {
    clearInterval(this._posTimer);
    this._posTimer = null;
  }

  renderPosition() {
    const node = $("#trackPosition");
    if (!node) return;
    const totalMs = this.state?.current?.duration_ms || 0;
    const totalLabel = totalMs ? formatDuration(totalMs) : "–:–";
    if (!this.position.known || !this.playing) {
      node.textContent = `–:– / ${totalLabel}`;
      return;
    }
    const elapsedMs = Math.max(0, Math.min(totalMs || Infinity, this.position.ms + (Date.now() - this.position.at)));
    node.textContent = `${formatDuration(elapsedMs) || "0:00"} / ${totalLabel}`;
  }

  /**
   * A/B/C/D, derived only from data this page has actually confirmed
   * (UX_IMPL_SPEC.md, "Player-Systemzustands-Ableitung"). C gained its
   * producer with WP3-D3: the server's F8 state machine parks a run in
   * manual_state='awaiting_decision' under the 'ask' policy, and only that
   * confirmed field ever yields "c" here.
   */
  _deriveSystemState() {
    const s = this.state;
    if (!s || s.status !== "active") return null;
    if (s.manual_state === "awaiting_decision") return "c";
    if (this.isRemote && this.noDevices === true) return "d";
    const w = s.watcher || {};
    if (w.drifted) return "b";
    if (w.watching) return "a";
    return "ready";
  }

  /** UX-Zustand C: answer the 'ask' policy's question (F8, WP3-D3). */
  async decideManual(action) {
    await api(`/api/runs/${this.runId}/manual-decision`, {
      method: "POST", body: { action },
    });
    this.playing = action === "resume";
    if (!this.playing) { this.stopPolling(); this.stopPositionTimer(); }
    this.state = await api(`/api/runs/${this.runId}`);
    this.render();
    if (this.playing) this.startPolling();
  }

  /** UC-08: run-scoped favourite toggle for one "Als Nächstes" row. */
  async toggleFavorite(entry) {
    await api(`/api/runs/${this.runId}/tracks/${entry.run_track_id}/favorite`, {
      method: entry.favorite ? "DELETE" : "POST",
    });
    this.state = await api(`/api/runs/${this.runId}`);
    this.render();
  }

  /** UC-20: exclude one row for this run — effective immediately (RUN-08). */
  async excludeTrack(entry) {
    await api(`/api/runs/${this.runId}/tracks/${entry.run_track_id}/exclude`, {
      method: "POST",
    });
    this.state = await api(`/api/runs/${this.runId}`);
    this.render();
    await this.loadExcluded();   // UC-21: newly excluded row appears there right away
    this.notify(
      `„${entry.name || "Titel"}“ ist für diesen Hörvorgang ausgeschlossen und kommt nicht mehr an die Reihe.`,
      "note-ok", "Ausgeschlossen"
    );
  }

  /** UC-07: cycle one row's draw weight Selten → Normal → Öfter → Selten. */
  async cycleWeight(entry) {
    const current = nearestWeightLevel(entry.weight);
    const next = WEIGHT_LEVELS[(WEIGHT_LEVELS.indexOf(current) + 1) % WEIGHT_LEVELS.length];
    await api(`/api/runs/${this.runId}/tracks/${entry.run_track_id}/weight`, {
      method: "PUT", body: { weight: next.value },
    });
    this.state = await api(`/api/runs/${this.runId}`);
    this.render();
  }

  renderCover() {
    const wrap = $("#coverWrap");
    if (!wrap) return;
    const url = this.state?.current?.artwork_url;
    if (url) {
      wrap.replaceChildren(el("div", { class: "player-cover" }, el("img", { src: url, alt: "" })));
    } else {
      wrap.replaceChildren(
        el("div", { class: "player-cover player-cover-fallback", role: "img", "aria-label": "Kein Cover verfügbar" },
          svgIcon(ICON_NO_COVER.viewBox, ICON_NO_COVER.inner, ICON_NO_COVER.attrs),
          el("span", {}, "Ohne Cover")));
    }
  }

  renderBanner(systemState) {
    const banner = $("#stateBanner");
    if (!banner) return;
    const s = this.state;

    if (systemState === "b") {
      banner.className = "banner banner-b";
      banner.setAttribute("role", "status");
      banner.replaceChildren(
        svgIcon(STATE_ICON.b.viewBox, STATE_ICON.b.inner, STATE_ICON.b.attrs),
        el("div", {},
          el("p", { class: "banner-title" }, `${this.provider.display_name} wurde manuell übernommen`),
          el("p", { class: "banner-body" },
            `Du hast in ${this.provider.display_name} selbst etwas gestartet. Dein Hörvorgang ist angehalten und merkt sich deinen Stand: `,
            el("b", {}, `${formatCount(s.cursor)} von ${formatCount(s.total)} Titeln`), ". Nichts geht verloren."),
          el("div", { class: "banner-actions" },
            el("button", { class: "btn btn-primary", type: "button", onClick: () => this.guard(() => this.start()) }, "Hörvorgang fortsetzen"),
            el("button", { class: "btn btn-secondary", type: "button", onClick: () => this.guard(() => this.pause()) }, "Pausiert lassen")),
          el("p", { class: "banner-policy" }, `Sobald du „Hörvorgang fortsetzen" wählst, übernimmt True Shuffle die Wiedergabe wieder.`)));
    } else if (systemState === "c") {
      // UX-Zustand C (F8 'ask'): the run holds until the listener decides.
      banner.className = "banner banner-c";
      banner.setAttribute("role", "status");
      banner.replaceChildren(
        svgIcon(STATE_ICON.c.viewBox, STATE_ICON.c.inner, STATE_ICON.c.attrs),
        el("div", {},
          el("p", { class: "banner-title" }, "Wie soll es weitergehen?"),
          el("p", { class: "banner-body" },
            `Du hast ${this.provider.display_name} zwischendurch selbst genutzt; das ist vorbei. Dein Hörvorgang steht bei `,
            el("b", {}, `${formatCount(s.cursor)} von ${formatCount(s.total)} Titeln`),
            " und wartet auf deine Entscheidung. Nichts geht verloren."),
          el("div", { class: "banner-actions" },
            el("button", { class: "btn btn-primary", type: "button", onClick: () => this.guard(() => this.decideManual("resume")) }, "Hörvorgang fortsetzen"),
            el("button", { class: "btn btn-secondary", type: "button", onClick: () => this.guard(() => this.decideManual("pause")) }, "Pausiert lassen")),
          el("p", { class: "banner-policy" }, `Deine Regel „Nachfragen“: True Shuffle übernimmt erst wieder, wenn du es sagst.`)));
    } else if (systemState === "d") {
      banner.className = "banner banner-d";
      banner.setAttribute("role", "status");
      banner.replaceChildren(
        svgIcon(STATE_ICON.d.viewBox, STATE_ICON.d.inner, STATE_ICON.d.attrs),
        el("div", {},
          el("p", { class: "banner-title" }, "Kein aktives Gerät"),
          el("p", { class: "banner-body" }, `Öffne ${this.provider.display_name} auf einem deiner Geräte, spiel dort kurz irgendetwas an — danach geht es hier sofort weiter.`),
          el("div", { class: "banner-actions" },
            el("button", { class: "btn btn-secondary", type: "button", onClick: () => this.guard(() => this.loadDevices()) }, "Geräteliste aktualisieren"))));
    } else {
      banner.classList.add("hidden");
      banner.replaceChildren();
      return;
    }
    banner.classList.remove("hidden");
  }

  renderCompletion(terminal) {
    const panel = $("#completionPanel");
    const upnextWrap = $("#upnextWrap");
    if (!panel || !upnextWrap) return;
    const s = this.state;

    if (!terminal) {
      panel.classList.add("hidden");
      panel.replaceChildren();
      upnextWrap.classList.remove("hidden");
      return;
    }
    upnextWrap.classList.add("hidden");
    panel.classList.remove("hidden");

    const done = s.status === "completed";
    const title = done ? "Hörvorgang abgeschlossen" : "Hörvorgang beendet";
    // "Durch"/"Übergeben" comes from the server (player.html), the same
    // honesty rule /runs uses — a Handoff run is never reported as played
    // through just because its playlist was written.
    const label = s.mode === "controller"
      ? (this.vocab.completed_controller || "Durch")
      : (this.vocab.completed_utility || "Übergeben");
    const body = done
      ? (s.mode === "controller"
          ? `${label}: Alle ${formatCount(s.total)} Titel genau einmal gespielt.`
          : `${label}: Playlist wurde übergeben — ob sie durchgehört wurde, lässt sich von hier aus nicht feststellen.`)
      : "Dieser Hörvorgang wurde verworfen. Ein neuer Start mischt neu.";

    // WP3-D2: "Neuer Durchlauf" is real now — POST /reset (F2, ADR-003)
    // starts cycle n+1 on THIS run: deck re-opened, fresh order, history and
    // play counts kept. Only a completed run offers it; a cancelled run was
    // discarded and cannot cycle.
    const resetBtn = done
      ? el("button", {
          class: "btn btn-primary", type: "button",
          onClick: (ev) => {
            ev.currentTarget.setAttribute("aria-disabled", "true");
            this.guard(async () => {
              await api(`/api/runs/${this.runId}/reset`, {
                method: "POST", body: { confirm: true },
              });
              this.playing = false;
              this.lastPlayedId = null;
              this.resetPosition();
              this.state = await api(`/api/runs/${this.runId}`);
              this.render();
              this.notify(
                `Durchlauf ${formatCount(this.state.cycle || 2)} gestartet — gleiche Titel, neue Reihenfolge. Der Verlauf bleibt erhalten.`,
                "note-ok", "Neuer Durchlauf"
              );
            });
          },
        }, "Neuer Durchlauf")
      : null;

    panel.replaceChildren(
      el("div", { class: "empty-state" },
        el("span", { class: "empty-glyph" }, svgIcon((done ? ICON_DONE : ICON_STOPPED).viewBox, (done ? ICON_DONE : ICON_STOPPED).inner, (done ? ICON_DONE : ICON_STOPPED).attrs)),
        el("h3", {}, title),
        el("p", {}, body),
        el("div", { class: "empty-actions" },
          resetBtn,
          el("a", { class: `btn ${done ? "btn-secondary" : "btn-primary"}`, href: "/library" }, "Neuer Hörvorgang"),
          // WP3-D4: real navigation to the Config Library (UC-27 preset
          // side) — pick, edit or duplicate a configuration there, then
          // "Auf Playlist anwenden" returns to the builder with it
          // preselected (config_id deep link).
          el("a", { class: "btn btn-secondary", href: "/konfigurationen" }, "Regeln ändern"),
          el("a", { class: "btn btn-quiet", href: `/runs/${this.runId}/verlauf` }, "Verlauf ansehen"))));
  }

  render() {
    const s = this.state;
    if (!s) return;

    // Cancelled is just as terminal as completed: a cancelled run was
    // discarded, so its transport must not offer to move a cursor that no
    // longer means anything. Only `completed` claims the run was played through.
    const done = s.status === "completed";
    const cancelled = s.status === "cancelled";
    const terminal = done || cancelled;
    const current = s.current;
    const systemState = this._deriveSystemState();

    // -- contract chip (always) --------------------------------------------
    const contract = $("#contractChip");
    contract.textContent = CONTRACT_TEXT[s.status] || s.status;
    contract.className = "chip chip-neutral";

    // -- cycle chip (F2/UC-15): "Durchlauf N" from the second lap on --------
    const cycleChip = $("#cycleChip");
    if (cycleChip) {
      const cycle = s.cycle || 1;
      cycleChip.classList.toggle("hidden", cycle <= 1);
      if (cycle > 1) cycleChip.textContent = `Durchlauf ${formatCount(cycle)}`;
    }

    // -- system-state chip (active only — "Bereit ≠ Läuft") -----------------
    // #stateChipMini (in the header, aria-hidden) always mirrors this one —
    // same class, same text — so the state is visible above the fold on a
    // phone without a second accessible announcement.
    const stateChip = $("#stateChip");
    const stateChipMini = $("#stateChipMini");
    if (s.status !== "active") {
      stateChip.classList.add("hidden");
      stateChipMini?.classList.add("hidden");
    } else {
      stateChip.classList.remove("hidden");
      stateChipMini?.classList.remove("hidden");
      if (systemState === "a") {
        stateChip.className = "chip chip-a";
        stateChip.replaceChildren(svgIcon(STATE_ICON.a.viewBox, STATE_ICON.a.inner, STATE_ICON.a.attrs), "True Shuffle steuert");
        if (stateChipMini) { stateChipMini.className = "chip chip-a"; stateChipMini.replaceChildren(svgIcon(STATE_ICON.a.viewBox, STATE_ICON.a.inner, STATE_ICON.a.attrs), "True Shuffle steuert"); }
      } else if (systemState === "b") {
        stateChip.className = "chip chip-b";
        stateChip.replaceChildren(svgIcon(STATE_ICON.b.viewBox, STATE_ICON.b.inner, STATE_ICON.b.attrs), `${this.provider.display_name} manuell übernommen`);
        if (stateChipMini) { stateChipMini.className = "chip chip-b"; stateChipMini.replaceChildren(svgIcon(STATE_ICON.b.viewBox, STATE_ICON.b.inner, STATE_ICON.b.attrs), `${this.provider.display_name} manuell übernommen`); }
      } else if (systemState === "c") {
        stateChip.className = "chip chip-c";
        stateChip.replaceChildren(svgIcon(STATE_ICON.c.viewBox, STATE_ICON.c.inner, STATE_ICON.c.attrs), "Wartet auf deine Entscheidung");
        if (stateChipMini) { stateChipMini.className = "chip chip-c"; stateChipMini.replaceChildren(svgIcon(STATE_ICON.c.viewBox, STATE_ICON.c.inner, STATE_ICON.c.attrs), "Wartet auf deine Entscheidung"); }
      } else if (systemState === "d") {
        stateChip.className = "chip chip-d";
        stateChip.replaceChildren(svgIcon(STATE_ICON.d.viewBox, STATE_ICON.d.inner, STATE_ICON.d.attrs), "Kein aktives Gerät");
        if (stateChipMini) { stateChipMini.className = "chip chip-d"; stateChipMini.replaceChildren(svgIcon(STATE_ICON.d.viewBox, STATE_ICON.d.inner, STATE_ICON.d.attrs), "Kein aktives Gerät"); }
      } else {
        stateChip.className = "chip chip-neutral";
        stateChip.replaceChildren("Bereit");
        if (stateChipMini) { stateChipMini.className = "chip chip-neutral"; stateChipMini.replaceChildren("Bereit"); }
      }
    }

    const zoneRun = $("#zoneRun");
    zoneRun?.classList.toggle("is-b", systemState === "b");
    zoneRun?.classList.toggle("is-d", systemState === "d");

    this.renderBanner(systemState);
    this.renderCover();

    // -- now playing ----------------------------------------------------------
    $("#trackTitle").textContent = cancelled ? "Hörvorgang beendet"
      : done ? "Hörvorgang abgeschlossen"
      : (current?.name || `Titel ${formatCount(s.cursor + 1)}`);
    $("#trackArtist").textContent = cancelled ? "Dieser Hörvorgang wurde verworfen."
      : done ? "Kein Titel spielt mehr."
      : (current?.artist || "");
    this.renderPosition();

    const attributionWrap = $("#attributionWrap");
    if (!terminal && this.playing && current?.id) {
      const spotifyHref = this.provider.id === "spotify" ? `https://open.spotify.com/track/${current.id}` : null;
      const tag = spotifyHref ? "a" : "p";
      const attrs = { class: "attribution" };
      if (spotifyHref) Object.assign(attrs, { href: spotifyHref, target: "_blank", rel: "noopener" });
      attributionWrap.replaceChildren(
        el(tag, attrs, svgIcon(ICON_ATTRIBUTION.viewBox, ICON_ATTRIBUTION.inner, ICON_ATTRIBUTION.attrs),
          `Wiedergabe über ${this.provider.display_name}`));
    } else {
      attributionWrap.replaceChildren();
    }

    // -- transport --------------------------------------------------------
    const blockedByDrift = systemState === "b";
    const blockedByAsk = systemState === "c";
    const blockedByNoDevice = systemState === "d";
    const disabled = terminal || blockedByDrift || blockedByAsk || blockedByNoDevice;
    let reason = "";
    if (done) reason = "Dieser Hörvorgang ist abgeschlossen — nichts mehr zu spielen.";
    else if (cancelled) reason = "Dieser Hörvorgang wurde beendet.";
    else if (blockedByDrift) reason = `Die Steuerung liegt gerade bei ${this.provider.display_name} — setze den Hörvorgang fort, um sie zurückzuholen.`;
    else if (blockedByAsk) reason = "Dein Hörvorgang wartet auf deine Entscheidung — oben im Banner.";
    else if (blockedByNoDevice) reason = `Kein ${this.provider.display_name}-Gerät aktiv. Aktualisiere die Geräteliste oben.`;
    // Paused-at-birth second run (SP-003): Start stays pressable — pressing
    // it re-checks the slot for real — this only explains WHY it is paused.
    else if (s.status === "paused" && s.cursor === 0 && this.slotBlockerName) {
      reason = `„${this.slotBlockerName}“ steuert gerade ${this.provider.display_name} — Start prüft, ob der Platz inzwischen frei ist.`;
    }

    const mainBtn = $("#mainBtn");
    mainBtn.replaceChildren(svgIcon((this.playing ? ICON_PAUSE : ICON_PLAY).viewBox, (this.playing ? ICON_PAUSE : ICON_PLAY).inner, (this.playing ? ICON_PAUSE : ICON_PLAY).attrs));
    mainBtn.setAttribute("aria-disabled", String(disabled));
    mainBtn.setAttribute("aria-label", disabled
      ? `${this.playing ? "Pause" : "Start"} – ${reason}`
      : (this.playing ? "Pause" : (s.cursor > 0 ? "Hörvorgang fortsetzen" : "Hörvorgang starten")));

    const atStart = s.cursor === 0;
    const prevDisabled = disabled || atStart;
    // aria-disabled without a reason in the name is a dead end for anyone
    // not looking at the screen — cursor 0 has no "reason" of its own (it is
    // not blocked, terminal or drifted), so it needs its own explanation.
    const prevReason = reason || (atStart ? "du bist am Anfang" : "");
    const prevBtn = $("#prevBtn");
    prevBtn.setAttribute("aria-disabled", String(prevDisabled));
    prevBtn.setAttribute("aria-label", prevDisabled && prevReason ? `Vorheriger Titel – ${prevReason}` : "Vorheriger Titel");

    const nextBtn = $("#nextBtn");
    nextBtn.setAttribute("aria-disabled", String(disabled));
    nextBtn.setAttribute("aria-label", disabled && reason ? `Nächster Titel – ${reason}` : "Nächster regelkonformer Titel");

    $("#transportHint").textContent = reason || `„Weiter" wählt immer den nächsten regelkonformen Titel.`;

    // -- progress -----------------------------------------------------------
    const pct = s.total ? Math.round((s.cursor / s.total) * 100) : 0;
    const meter = $("#runMeter");
    meter.setAttribute("aria-valuenow", String(pct));
    meter.setAttribute("aria-label", `Fortschritt ${pct} Prozent`);
    meter.querySelector("i").style.width = `${pct}%`;
    $("#runProgressLine").replaceChildren(
      el("span", {}, el("b", { style: "color:var(--ink)" }, formatCount(s.cursor)), ` von ${formatCount(s.total)} gespielt`),
      el("span", {}, `${pct} %`));

    // -- completion panel / upcoming list -----------------------------------
    this.renderCompletion(terminal);
    if (!terminal) {
      const upcoming = s.upcoming || [];
      $("#upnextRead").textContent = upcoming.length ? ` · ${formatCount(upcoming.length)} von ${formatCount(s.remaining)}` : "";
      $("#upnext").replaceChildren(
        ...(upcoming.length
          ? upcoming.map((t) => {
              const row = el("li", {},
                el("span", { class: "u-pos tabular" }, formatCount(t.index + 1)),
                el("div", {},
                  el("span", { class: "u-name" }, t.name || `Titel ${formatCount(t.index + 1)}`),
                  el("span", { class: "u-meta" }, [t.artist, formatDuration(t.duration_ms)].filter(Boolean).join(" · "))));
              // WP3-D3 (UC-08/20): per-row favourite / exclude, only when the
              // server named the deck card behind the row (v3 runs do; a
              // legacy import has no cards and honestly shows no buttons).
              if (t.run_track_id) {
                const label = t.name || `Titel ${formatCount(t.index + 1)}`;
                // UC-07: third control, the draw-weight cycle. Rounds the
                // (possibly continuous, server allows 0.1..10) weight to the
                // nearest of the three UI stages for icon + aria-label; the
                // title tooltip always carries the exact value.
                const level = nearestWeightLevel(t.weight);
                const nextLevel = WEIGHT_LEVELS[(WEIGHT_LEVELS.indexOf(level) + 1) % WEIGHT_LEVELS.length];
                row.append(el("span", { class: "u-actions" },
                  el("button", {
                    class: `u-act${t.favorite ? " is-on" : ""}`, type: "button",
                    "aria-pressed": String(Boolean(t.favorite)),
                    "aria-label": t.favorite ? `Favorit entfernen: ${label}` : `Als Favorit markieren: ${label}`,
                    title: t.favorite ? "Favorit entfernen" : "Als Favorit markieren",
                    onClick: () => this.guard(() => this.toggleFavorite(t)),
                  }, svgIcon(ICON_STAR.viewBox, ICON_STAR.inner, ICON_STAR.attrs)),
                  el("button", {
                    class: `u-act${level.value > 1 ? " is-on" : ""}`, type: "button",
                    "aria-label": `Gewicht für ${label}: aktuell ${level.label}`,
                    title: `Gewicht ${formatWeightValue(t.weight)}× · Klick für „${nextLevel.label}“`,
                    onClick: () => this.guard(() => this.cycleWeight(t)),
                  }, svgIcon(level.icon.viewBox, level.icon.inner, level.icon.attrs)),
                  el("button", {
                    class: "u-act", type: "button",
                    "aria-label": `Titel ausschließen: ${label}`,
                    title: "Für diesen Hörvorgang ausschließen",
                    onClick: () => this.guard(() => this.excludeTrack(t)),
                  }, svgIcon(ICON_BAN.viewBox, ICON_BAN.inner, ICON_BAN.attrs))));
              }
              return row;
            })
          : [el("li", {}, el("span", { class: "u-meta" }, "Keine weiteren Titel in der Vorschau."))])
      );
    }

    const cancel = $("#cancelBtn");
    if (cancel) cancel.disabled = terminal;
  }
}
