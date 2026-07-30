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

import { $, api, el, followJob, formatDuration, formatCount, setNotice } from "./app.js";

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
    this.render();
    this.loadSkipped();

    if (!this.isRemote) {
      const { config } = await api(`/api/player-config?provider=${this.provider.id}`);
      this.web = this.provider.id === "apple"
        ? new AppleWebPlayer(config)
        : new YouTubeWebPlayer(config, "ytmount");

      this.web
        .on("ended", () => this.report("track_ended"))
        .on("error", (err) => {
          this.notify(err.message, "notice-critical");
          // A track that will not play must not stall the deck.
          this.report("playback_failed");
        })
        .on("progress", () => {});

      await this.web.init();
    } else {
      await this.loadDevices();
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
      this.notify(err.message, "notice-critical");
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
      this.notify(`Playback failed: ${err.message}`, "notice-critical");
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
          : [el("option", { value: "" }, "No device found — open Spotify first")])
      );
      $("#startBtn").disabled = devices.length === 0;
      if (!devices.length) {
        this.notify(
          "No Spotify device is available. Open Spotify on a phone, computer or speaker and play anything for a second, then reload this page.",
          "notice-ok"
        );
      }
    } catch (err) {
      this.notify(err.message, "notice-critical");
    }
  }

  /* -- rendering ----------------------------------------------------------- */

  notify(text, variant) { setNotice($("#playerNotice"), text, variant); }

  /** Entries that never entered the deck, with the reason each was left out. */
  async loadSkipped() {
    const box = $("#skippedBox");
    if (!box) return;
    try {
      const { skipped } = await api(`/api/runs/${this.runId}/skipped`);
      if (!skipped.length) return;          // stays hidden — nothing was dropped
      box.classList.remove("hidden");
      $("#skippedSummary").textContent =
        `${formatCount(skipped.length)} entries left out`;
      $("#skippedList").replaceChildren(
        ...skipped.map((s) =>
          el("div", { class: "spread" },
            el("span", { class: "muted" }, [s.name, s.artist].filter(Boolean).join(" — ") || s.track_id),
            el("span", { class: "faint" }, REASON_TEXT[s.reason] || s.reason)))
      );
    } catch {
      box.classList.add("hidden");
    }
  }

  /** The remaining stack, drawn as cards rather than a percentage. */
  renderStack() {
    const mount = $("#stackviz");
    if (!mount || !this.state) return;
    const { cursor, total } = this.state;
    if (!total) return mount.replaceChildren();

    // One bar per card up to a cap, so a 1,500-track deck still reads.
    const bars = Math.min(total, 90);
    const scale = total / bars;
    mount.replaceChildren(
      ...Array.from({ length: bars }, (_, i) => {
        const at = Math.floor(i * scale);
        const cls = at < cursor ? "done" : at === Math.floor(cursor) ? "current" : "";
        return el("i", cls ? { class: cls } : {});
      })
    );
  }

  render() {
    const s = this.state;
    if (!s) return;

    const done = s.status === "completed";
    const current = s.current;

    $("#nowTitle").textContent = done
      ? "Deck complete"
      : current?.name || `Track ${s.cursor + 1}`;
    $("#nowArtist").textContent = done
      ? `All ${formatCount(s.total)} tracks played exactly once.`
      : current?.artist || "";

    const art = $("#nowArt");
    if (current?.artwork_url) {
      art.src = current.artwork_url;
      art.classList.remove("hidden");
    } else {
      art.classList.add("hidden");
    }

    $("#deckDealt").textContent = formatCount(Math.min(s.cursor + (done ? 0 : 1), s.total));
    $("#deckTotal").textContent = formatCount(s.total);
    $("#deckLeft").textContent = formatCount(s.remaining);
    $("#deckRail").style.width = `${s.progress_pct}%`;
    this.renderStack();

    const statusPill = $("#runStatus");
    statusPill.textContent = statusLabel(s);
    statusPill.className = `pill ${statusClass(s)}`;

    const watchPill = $("#watchStatus");
    if (watchPill) {
      const w = s.watcher || {};
      watchPill.classList.toggle("hidden", !this.isRemote);
      watchPill.textContent = w.drifted
        ? `${this.provider.display_name} is playing something else`
        : w.watching ? "Advancing on its own" : "Not following playback";
      watchPill.className = `pill ${w.drifted ? "pill-critical" : w.watching ? "pill-live" : "pill-off"}`;
    }

    $("#upnext").replaceChildren(
      ...(s.upcoming || []).map((t) =>
        el("li", {},
          el("span", { class: "pos" }, String(t.index + 1)),
          el("span", {},
            el("span", { class: "name" }, t.name || t.id),
            el("span", { class: "who" }, [t.artist, formatDuration(t.duration_ms)].filter(Boolean).join(" · "))
          )
        )
      )
    );
    if (!s.upcoming?.length) {
      $("#upnext").replaceChildren(el("li", {}, el("span", { class: "pos" }, "—"),
        el("span", { class: "name muted" }, done ? "Nothing left to deal" : "Loading…")));
    }

    $("#startBtn").textContent = this.playing ? "Restart current track" : (s.cursor > 0 ? "Resume deck" : "Start deck");
    $("#nextBtn").disabled = done;
    $("#prevBtn").disabled = s.cursor === 0;
    $("#pauseBtn").disabled = !this.playing;
  }
}

const REASON_TEXT = {
  local_file: "local file",
  not_playable: "not available here",
  wrong_kind: "not a music track",
  duplicate: "already in the deck",
  missing_id: "no track id",
};

function statusLabel(s) {
  if (s.status === "completed") return "Complete";
  if (s.status === "paused") return "Paused";
  if (s.status === "cancelled") return "Cancelled";
  return "Live";
}
function statusClass(s) {
  if (s.status === "completed") return "pill-ok";
  if (s.status === "cancelled") return "pill-critical";
  if (s.status === "paused") return "pill-off";
  return "pill-live";
}

export { followJob };
