/**
 * The Verlauf's listening sample: one song the listener tapped, looked up in
 * Deezer's public catalogue (no account, no key), read-only.
 *
 * Exactly one search request per tap, with a deadline. The recording must be
 * the same one the Verlauf names — title, artist, the version marks (live,
 * remix, remaster, edit …) and the length; several different recordings that
 * fit equally, or none, give no sample rather than a guess. The sample's
 * address is taken as Deezer sent it, only from the one media host verified
 * for it (see docs/HISTORY_PREVIEW.md); nothing here builds, fetches, keeps
 * or relays audio, and nothing here touches Spotify or the listener's data.
 */

import type { PreviewResult } from "../../shared/api";

/** The song as the Verlauf stores it (see hub/library.ts PackedTrack). */
export interface PreviewSubject {
	name: string;
	artists: string[];
	album: string;
	durationMs: number;
}

/** The only host Deezer was seen to serve samples from (2026-10-17); the page's CSP allows just this one. */
export const PREVIEW_MEDIA_ORIGIN = "https://cdnt-preview.dzcdn.net";
const LINK_ORIGIN = "https://www.deezer.com";
export const PREVIEW_TIMEOUT_MS = 6_000;
/** Results read from the one search: enough for a song's versions and compilations. */
const SEARCH_LIMIT = 25;
/** Deezer gives whole seconds; Spotify milliseconds. */
const DURATION_SLACK_MS = 3_000;

interface DzTrack {
	id?: number;
	readable?: boolean;
	title?: string;
	title_short?: string;
	title_version?: string;
	isrc?: string;
	link?: string;
	duration?: number;
	preview?: string;
	artist?: { name?: string };
	album?: { title?: string };
}

type Fetch = (req: Request) => Promise<Response>;

const UNAVAILABLE: Record<"missing" | "no_match" | "ambiguous" | "no_preview", string> = {
	// P3: "not there" is not "no clear match".
	missing: "Deezer hat diesen Song nicht — keine Hörprobe.",
	no_match:
		"Bei Deezer gibt es nur andere Fassungen (etwa live, remixt oder anders lang) — keine Hörprobe, um nicht die falsche zu spielen.",
	ambiguous:
		"Bei Deezer passen mehrere Aufnahmen — keine Hörprobe, um nicht die falsche zu spielen.",
	no_preview: "Deezer hat für diese Aufnahme keine Hörprobe.",
};
const ERRORS: Record<"denied" | "rate" | "timeout" | "upstream", string> = {
	denied: "Deezer lässt die Abfrage gerade nicht zu.",
	rate: "Deezer bittet gerade um eine Pause. Später nochmal.",
	timeout: "Deezer hat nicht rechtzeitig geantwortet.",
	upstream: "Deezer antwortet gerade nicht richtig.",
};

const unavailable = (reason: keyof typeof UNAVAILABLE): PreviewResult => ({
	status: "unavailable",
	reason,
	message: UNAVAILABLE[reason],
});
const failed = (reason: keyof typeof ERRORS): PreviewResult => ({
	status: "error",
	reason,
	message: ERRORS[reason],
});

export async function resolveDeezerPreview(
	subject: PreviewSubject,
	deps: { fetch: Fetch; base: string; timeoutMs?: number },
): Promise<PreviewResult> {
	const want = split(subject.name);
	const artist = subject.artists[0];
	if (!want.base || !artist) return unavailable("missing");
	// Asked as written (accents and all); compared folded.
	const url = `${deps.base}/search?q=${encodeURIComponent(`${artist} ${want.words}`)}&limit=${SEARCH_LIMIT}`;
	let body: { data?: DzTrack[]; error?: { code?: number } };
	try {
		const res = await withDeadline(deps.fetch, url, deps.timeoutMs ?? PREVIEW_TIMEOUT_MS);
		if (res.status === 401 || res.status === 403) return failed("denied");
		if (res.status === 429) return failed("rate");
		if (res.status < 200 || res.status > 299) return failed("upstream");
		body = res.body as typeof body;
	} catch (err) {
		return failed(err instanceof DeadlineError ? "timeout" : "upstream");
	}
	if (!body || typeof body !== "object") return failed("upstream");
	if (body.error) {
		const code = body.error.code;
		if (code === 4) return failed("rate"); // "Quota limit exceeded"
		if (code === 200 || code === 300) return failed("denied"); // OAuth
		if (code === 800) return unavailable("missing"); // "no data"
		return failed("upstream");
	}
	return pick(subject, want, Array.isArray(body.data) ? body.data : []);
}

/** The one recording that is the Verlauf's song, or why there is none. */
export function pick(
	subject: PreviewSubject,
	want: { base: string; detail: string; tags: Set<string> },
	data: DzTrack[],
): PreviewResult {
	const artists = new Set(subject.artists.map(fold));
	artists.add(subject.artists.map(fold).join(" and "));
	const album = foldAlbum(subject.album);
	// Nothing by these artists under this title at all: missing, not unclear.
	const candidates = data.filter(
		(d) =>
			artists.has(fold(d.artist?.name ?? "")) &&
			split(d.title ?? "", d.title_short, d.title_version).base === want.base,
	);
	if (candidates.length === 0) return unavailable("missing");
	const fits = candidates.filter((d) => {
		const name = fold(d.artist?.name ?? "");
		if (!name || !artists.has(name)) return false;
		const got = split(d.title ?? "", d.title_short, d.title_version);
		if (got.base !== want.base || !sameSet(got.tags, want.tags)) return false;
		// The named version too: "Alice Remix" is not "Bob Remix", 2011 not 2014.
		if (got.detail !== want.detail) return false;
		if (subject.durationMs > 0)
			return (
				typeof d.duration === "number" &&
				Math.abs(d.duration * 1000 - subject.durationMs) <= DURATION_SLACK_MS
			);
		// Length unknown: only the same album proves it is the same recording.
		return foldAlbum(d.album?.title ?? "") === album;
	});
	if (fits.length === 0) return unavailable("no_match");
	// One recording may sit on several albums: the same ISRC is the same recording.
	const recording = (d: DzTrack) => (d.isrc ? `isrc:${d.isrc}` : `id:${d.id}`);
	let chosen = fits;
	if (new Set(fits.map(recording)).size > 1) {
		chosen = fits.filter((d) => album !== "" && foldAlbum(d.album?.title ?? "") === album);
		if (new Set(chosen.map(recording)).size !== 1) return unavailable("ambiguous");
	}
	const playable = chosen.find((d) => d.readable !== false && mediaUrl(d.preview) !== null);
	if (!playable) return unavailable("no_preview");
	const url = mediaUrl(playable.preview)!;
	return {
		status: "ready",
		source: "deezer",
		url,
		expiresAt: expiry(url),
		title: playable.title ?? "",
		artist: playable.artist?.name ?? "",
		album: playable.album?.title ?? "",
		link: linkOf(playable.link),
	};
}

/** Only an HTTPS address on the verified media host, as sent. */
export function mediaUrl(raw: unknown): string | null {
	if (typeof raw !== "string" || raw === "") return null;
	try {
		const u = new URL(raw);
		return u.protocol === "https:" && u.origin === PREVIEW_MEDIA_ORIGIN && !u.username ? raw : null;
	} catch {
		return null;
	}
}

function linkOf(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	try {
		return new URL(raw).origin === LINK_ORIGIN ? raw : null;
	} catch {
		return null;
	}
}

/** Deezer signs the address with `hdnea=exp=<seconds>~…`. */
function expiry(url: string): number | null {
	const m = /[?&]hdnea=exp=(\d{9,11})/.exec(url);
	return m ? Number(m[1]) * 1000 : null;
}

// ------------------------------------------------------------------ titles

/**
 * Marks that make a different recording of the same song. Read only from the
 * version part ("(Live)", "- Remastered 2011", Deezer's title_version), never
 * from the title itself: "Live Forever" is no live recording.
 */
const MARKS: [string, RegExp][] = [
	["live", /\b(live|en vivo|ao vivo|en directo)\b/],
	["remix", /\b(remix|remixed|mix|rework|dub|vip|bootleg|flip)\b/],
	["remaster", /\b(remaster|remastered|remastering)\b/],
	["acoustic", /\b(acoustic|unplugged|stripped)\b/],
	["edit", /\b(edit|radio version|single version)\b/],
	["instrumental", /\b(instrumental|karaoke|backing track)\b/],
	["demo", /\b(demo|rehearsal|outtake|take \d+|alternate|alt version)\b/],
	["extended", /\b(extended|12 inch|club version)\b/],
	["tempo", /\b(sped up|slowed|nightcore|reverb)\b/],
	["rerecorded", /\b(taylor s version|re recorded|rerecorded|re record)\b/],
	["orchestral", /\b(orchestral|symphonic)\b/],
	["mono", /\b(mono)\b/],
	["cover", /\b(cover)\b/],
];

/** Words of a version part that name nothing ("Remastered Version" is "Remastered"). */
const FILLER = new Set(["version", "the", "a", "an"]);
/** Spellings of one word ("2011 Remaster" is "Remastered 2011"). */
const STEM: Record<string, string> = {
	remastered: "remaster",
	remastering: "remaster",
	remixed: "remix",
};

/**
 * Title without its version part, the version marks it carries, and the
 * version part's own words (`detail`, order and spelling aside): the named
 * version, so two remixes or two remaster years stay apart.
 */
export function split(
	title: string,
	short?: string,
	version?: string,
): { base: string; words: string; detail: string; tags: Set<string> } {
	const extra: string[] = [];
	let base = title.replace(/[([{][^)\]}]*[)\]}]/g, (m) => {
		extra.push(m);
		return " ";
	});
	const dash = /\s[-–—]\s/.exec(base);
	if (dash) {
		extra.push(base.slice(dash.index));
		base = base.slice(0, dash.index);
	}
	if (short) {
		// Deezer's short title is the title without the version; it wins when it is shorter.
		const s = short.replace(/[([{][^)\]}]*[)\]}]/g, " ");
		if (fold(s) && fold(s).length <= fold(base).length) base = s;
	}
	if (version) extra.push(version);
	const tags = new Set<string>();
	// Guest artists ("feat. X", "with Y") name no version.
	const text = fold(
		extra.filter((e) => !/^[\s([{\-–—]*(feat|ft|featuring|with)\b/i.test(e)).join(" "),
	);
	for (const [tag, re] of MARKS) if (re.test(text)) tags.add(tag);
	const detail = [
		...new Set(
			text
				.split(" ")
				.filter((w) => w && !FILLER.has(w))
				.map((w) => STEM[w] ?? w),
		),
	]
		.sort()
		.join(" ");
	const bare = base.replace(/\b(feat|ft|featuring)\.?\s.*$/i, "");
	return { base: fold(bare), words: bare.replace(/\s+/g, " ").trim(), detail, tags };
}

export function fold(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/['’`]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/** Album without its edition note ("Deluxe", "Remastered 2011"): only for telling recordings apart. */
function foldAlbum(s: string): string {
	return fold(s.replace(/[([{][^)\]}]*[)\]}]/g, " ").replace(/\s[-–—]\s.*$/, ""));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

// ------------------------------------------------------------------ request

class DeadlineError extends Error {}

/**
 * One GET with a hard deadline over the whole answer — headers and the body
 * read and parsed — also when the fetch ignores its signal. At the deadline
 * the request is aborted (and with it its body) and the read given up.
 */
async function withDeadline(
	fetch: Fetch,
	url: string,
	ms: number,
): Promise<{ status: number; body: unknown }> {
	const ctl = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			ctl.abort();
			reject(new DeadlineError("timeout"));
		}, ms);
	});
	const answer = (async () => {
		const res = await fetch(
			new Request(url, {
				headers: { "user-agent": "true-shuffle/1.0", accept: "application/json" },
				signal: ctl.signal,
			}),
		);
		if (!res.ok) {
			void res.body?.cancel().catch(() => {});
			return { status: res.status, body: null };
		}
		return { status: res.status, body: (await res.json()) as unknown };
	})();
	answer.catch(() => {}); // given up at the deadline: its late failure is nobody's
	try {
		return await Promise.race([answer, deadline]);
	} finally {
		clearTimeout(timer);
	}
}
