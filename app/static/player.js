/*
 * Run player.
 *
 * Two very different worlds meet here, behind one interface:
 *
 *  - REMOTE_DEVICE (Spotify): the *server* drives an app the listener already
 *    has open, and a background watcher advances the deck. This page only
 *    reflects that state, so it polls.
 *
 *  - WEB_PLAYER (Apple Music, YouTube Music): *this tab* owns the audio, so it
 *    is the only thing that can know a track ended. It reports every end and
 *    every skip to the server, which owns the deck and the cursor.
 *
 * The server is the single source of truth for the cursor in both cases; the
 * page never decides what plays next on its own.
 */

import { $, api, el, followJob, formatDuration, formatCount, setNote, artistTint } from "./app.js";

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
      setTimeout(() => reject(new Error("The YouTube player did not load.")), 15000);
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
  if (code === 101 || code === 150) return "The video's owner does not allow it to be played outside YouTube.";
  if (code === 100) return "This video was removed or made private.";
  if (code === 2) return "YouTube rejected the video id.";
  return `The YouTube player reported error ${code}.`;
}

function loadScript(src, isReady) {
  if (isReady && isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    const node = existing || Object.assign(document.createElement("script"), { src, async: true });
    node.addEventListener("load", () => resolve());
    node.addEventListener("error", () => reject(new Error(`Could not load ${src}`)));
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
/* Run controller                                                             */
/* ========================================================================== */

export class RunPlayer {
  constructor(runId, provider) {
    this.runId = runId;
    this.provider = provider;
    this.state = null;
    this.web = null;
    this.poller = null;
    this.playing = false;
    this.lastPlayedId = null;
  }

  get isRemote() { return this.provider.playback === "remote_device"; }

  async boot() {
    this.state = await api(`/api/runs/${this.runId}`);
    // Returning to a deck that is already running is the product's core path.
    // Without this the page claimed "LÄUFT" over frozen content, with Pause
    // disabled while music was actually playing.
    this.playing = this.state.status === "active";
    this.render();
    this.loadSkipped();
    if (this.isRemote && this.playing) this.startPolling();

    if (!this.isRemote) {
      const { config } = await api(`/api/player-config?provider=${this.provider.id}`);
      this.web = this.provider.id === "apple"
        ? new AppleWebPlayer(config)
        : new YouTubeWebPlayer(config, "ytmount");

      this.web
        .on("ended", () => this.report("track_ended"))
        .on("error", (err) => {
          this.notify(err.message, "note-stop", "Wiedergabe");
          // A track that will not play must not stall the deck.
          this.report("playback_failed");
        })
        .on("progress", () => {});

      await this.web.init();
    } else {
      await this.loadDevices();
    }
  }

  /** A page that cannot load its run says so, and stops offering transport. */
  failed(message) {
    this.playing = false;
    this.stopPolling();
    $("#nowTitle").textContent = "Lauf nicht geladen";
    $("#nowArtist").textContent = message;
    for (const id of ["#startBtn", "#prevBtn", "#nextBtn", "#pauseBtn"]) {
      const node = $(id);
      if (node) node.disabled = true;
    }
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

  /** Space bar: start the deck, or pause/resume once it is running. */
  async toggle() {
    if (this.state?.status === "completed") return;
    if (!this.playing) return this.start();
    return this.pause();
  }

  async move(endpoint, body) {
    this.state = await api(`/api/runs/${this.runId}/${endpoint}`, { method: "POST", body });
    await this.syncWebPlayback();
    this.render();
  }

  /** Tell the server something happened in this tab's player. */
  async report(type) {
    try {
      this.state = await api(`/api/runs/${this.runId}/event`, {
        method: "POST", body: { type },
      });
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
    this.state = await api(`/api/runs/${this.runId}`);
    this.render();
  }

  /** Push the server's current card into the in-tab player, if it changed. */
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
        if (next.cursor !== this.state?.cursor || next.status !== this.state?.status) {
          this.state = next;
          this.render();
        }
        if (next.status !== "active") this.stopPolling();
      } catch { /* transient; the next tick retries */ }
    }, 4000);
  }

  stopPolling() { clearInterval(this.poller); this.poller = null; }

  async loadDevices() {
    const select = $("#deviceSelect");
    if (!select) return;
    try {
      const { devices } = await api(`/api/devices?provider=${this.provider.id}`);
      select.replaceChildren(
        ...(devices.length
          ? devices.map((d) => el("option", { value: d.id, selected: d.is_active || null },
              `${d.name} · ${d.kind}`))
          : [el("option", { value: "" }, "Kein Gerät gefunden")])
      );
      $("#startBtn").disabled = devices.length === 0;
      if (!devices.length) {
        this.notify(
          `Kein ${this.provider.display_name}-Gerät aktiv. Öffne ${this.provider.display_name} auf Handy, Rechner oder Box, spiel dort kurz irgendetwas an und lade diese Seite neu.`,
          "", "Kein Gerät"
        );
      }
    } catch (err) {
      this.notify(err.message, "note-stop", "Fehler");
    }
  }

  /* -- rendering ----------------------------------------------------------- */

  notify(text, variant, label) { setNote($("#playerNote"), text, variant, label); }

  /** Entries that never entered the deck, with the reason each was left out. */
  async loadSkipped() {
    const box = $("#skippedBox");
    if (!box) return;
    try {
      const { skipped } = await api(`/api/runs/${this.runId}/skipped`);
      if (!skipped.length) return;          // stays hidden — nothing was dropped
      box.classList.remove("hidden");
      $("#skippedSummary").textContent =
        `${formatCount(skipped.length)} Einträge nicht ins Fach gekommen`;
      $("#skippedList").replaceChildren(
        ...skipped.map((s) =>
          el("div", { class: "spread" },
            el("span", { class: "dim" },
              [s.name, s.artist].filter(Boolean).join(" — ") || s.track_id),
            el("span", { class: "faint" }, REASON_TEXT[s.reason] || s.reason)))
      );
    } catch {
      box.classList.add("hidden");
    }
  }

  /**
   * The rack: one bar per card, and a divider that travels to the cursor.
   *
   * Bars are rebuilt only when the deck's size changes; an advance moves one
   * absolutely positioned element, because "moving that divider forward IS the
   * advance" and a teleporting divider does not say that.
   *
   * The bar count is measured from the mount rather than fixed, so a
   * 1,500-track deck does not overflow a phone and clip the cursor away.
   */
  renderRack() {
    const mount = $("#rack");
    if (!mount || !this.state) return;
    const { cursor, total } = this.state;
    if (!total) return mount.replaceChildren();

    const width = mount.clientWidth || 320;
    const bars = Math.max(8, Math.min(total, Math.floor(width / 4)));

    if (this._rackBars !== bars || this._rackTotal !== total) {
      this._rackBars = bars;
      this._rackTotal = total;
      this._divider = el("span", { class: "divider" });
      mount.replaceChildren(
        ...Array.from({ length: bars }, () => el("i")),
        this._divider
      );
      this._bars = Array.from(mount.querySelectorAll("i"));
    }

    const played = Math.round((cursor / total) * bars);
    this._bars.forEach((bar, i) => {
      if (i < played) bar.setAttribute("data-played", "");
      else bar.removeAttribute("data-played");
    });
    if (this._divider) {
      this._divider.style.left = `${(cursor / total) * 100}%`;
    }
  }

  render() {
    const s = this.state;
    if (!s) return;

    const done = s.status === "completed";
    const current = s.current;

    $("#nowTitle").textContent = done
      ? "Fach durchgehört"
      : current?.name || `Karte ${s.cursor + 1}`;
    $("#nowArtist").textContent = done
      ? `Alle ${formatCount(s.total)} Titel genau einmal gespielt.`
      : current?.artist || "";

    $("#deckAt").textContent = formatCount(Math.min(s.cursor + (done ? 0 : 1), s.total));
    $("#deckTotal").textContent = formatCount(s.total);
    $("#deckLeft").textContent = formatCount(s.remaining);
    this.renderRack();

    const statusChip = $("#runStatus");
    statusChip.textContent = STATUS_TEXT[s.status] || s.status;
    statusChip.className = `chip ${STATUS_CLASS[s.status] || ""}`;

    const watchChip = $("#watchStatus");
    if (watchChip) {
      const w = s.watcher || {};
      watchChip.classList.toggle("hidden", !this.isRemote);
      watchChip.textContent = w.drifted
        ? `${this.provider.display_name} spielt etwas anderes`
        : w.watching ? "Rückt selbst weiter" : "Folgt nicht";
      watchChip.className = `chip ${w.drifted ? "chip-stop" : w.watching ? "chip-live" : "chip-off"}`;
    }

    const upcoming = s.upcoming || [];
    $("#upnext").replaceChildren(
      ...(upcoming.length
        ? upcoming.map((t) =>
            el("li", {},
              el("span", { class: "edge", "data-t": artistTint(t.artist) || null }),
              el("span", { class: "pos" }, String(t.index + 1)),
              el("span", {},
                el("span", { class: "name" }, t.name || t.id),
                el("span", { class: "who" },
                  [t.artist, formatDuration(t.duration_ms)].filter(Boolean).join(" · ")))))
        : [el("li", {},
            el("span", { class: "edge" }),
            el("span", { class: "pos" }, "—"),
            el("span", { class: "name faint" },
              done ? "Nichts mehr im Fach" : "Wird geladen…"))])
    );

    $("#startBtn").textContent = this.playing
      ? "Karte neu starten"
      : (s.cursor > 0 ? "Lauf fortsetzen" : "Lauf starten");
    $("#nextBtn").disabled = done;
    $("#prevBtn").disabled = s.cursor === 0;
    $("#pauseBtn").disabled = !this.playing;
  }
}

const REASON_TEXT = {
  local_file: "lokale Datei",
  not_playable: "hier nicht verfügbar",
  wrong_kind: "kein Musiktitel",
  duplicate: "schon im Fach",
  missing_id: "keine Titel-ID",
};

const STATUS_TEXT = {
  active: "Läuft", paused: "Pausiert",
  completed: "Durch", cancelled: "Beendet",
};

const STATUS_CLASS = {
  active: "chip-live", paused: "chip-off",
  completed: "chip-ok", cancelled: "chip-stop",
};

export { followJob };
