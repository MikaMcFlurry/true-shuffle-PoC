import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState, SessionView } from "../../src/shared/api";

const stateRequest = vi.hoisted(() => vi.fn());
vi.mock("../../src/client/api", () => ({
	ApiError: class extends Error {},
	api: { state: stateRequest },
}));

const session = (stationId = 1, entryId = "A:0", sessionId = "A"): SessionView => ({
	sessionId,
	stationId,
	entryId,
	orderRevision: 1,
	progressMs: 97_000,
	observedAt: 100,
	status: "paused",
	pending: false,
	queue: [],
});
const app = (s: SessionView | null = session(), profile = "mika"): AppState => ({
	session: s,
	profile: { id: profile, name: profile, imageUrl: null },
	onboarded: true,
	stations: [],
	nowPlaying: null,
	guest: { active: false, until: null },
	warnings: [],
	jobs: [],
	history: { importedTracks: 0, importedAt: null, liveSince: null },
	aiSource: "off",
	edition: "private",
	serverTime: 100,
});
const frozen = { entryId: "A:0", position: 97_000, track: null, projected: false };

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers();
	stateRequest.mockReset();
	vi.stubGlobal("window", {
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		addEventListener() {},
		removeEventListener() {},
	});
	vi.stubGlobal("document", {
		visibilityState: "visible",
		addEventListener() {},
		removeEventListener() {},
	});
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it.each([
	["same station later occurrence", session(1, "A:1")],
	["different saved station", session(2, "B:0", "B")],
	["removed saved session", null],
])(
	"retains the definitive failed notice across a same-profile refresh with %s",
	async (_name, next) => {
		const { store } = await import("../../src/client/store");
		store.load = { kind: "ready", state: app() };
		const id = store.beginCommand("play", 2, frozen)!;
		store.acceptCommand(id, {
			ok: false,
			error: { code: "premium", message: "Premium erforderlich" },
		});
		stateRequest.mockResolvedValue({ ...app(next), serverTime: 200 });
		await store.refresh(false, true);
		expect(store.command).toMatchObject({
			id,
			phase: "failed",
			error: "Premium erforderlich",
			stationId: 2,
		});
		const retry = store.beginCommand("play", 2, frozen)!;
		expect(retry).not.toBeNull();
		expect(retry).not.toBe(id);
		expect(store.command).toMatchObject({ id: retry, phase: "sending" });
		expect(store.command?.error).toBeUndefined();
	},
);

it("clears a failed notice on a profile switch instead of leaking it to another account", async () => {
	const { store } = await import("../../src/client/store");
	store.load = { kind: "ready", state: app() };
	const id = store.beginCommand("play", 2, frozen)!;
	store.failCommand(id, "Mika's rejected command");
	stateRequest.mockResolvedValue(app(session(2, "B:0", "B"), "other"));
	await store.refresh(false, true);
	expect(store.command).toBeNull();
});

it("still settles an accepted other-station start only from a fresh actual observation", async () => {
	const { store } = await import("../../src/client/store");
	store.load = { kind: "ready", state: app() };
	const id = store.beginCommand("play", 2, frozen)!;
	store.acceptCommand(id, { ok: true, acceptedAt: 150 });
	stateRequest.mockResolvedValue({ ...app(session(2, "B:0", "B")), serverTime: 200 });
	await store.refresh(false, true);
	expect(store.command?.phase).toBe("accepted");
	const track = {
		id: "song",
		name: "Song",
		artists: "Artist",
		album: "Album",
		imageUrl: null,
		durationMs: 180_000,
		thumb: 0 as const,
	};
	const actual = {
		...session(2, "B:0", "B"),
		observedAt: 200,
		status: "active" as const,
		queue: [{ entryId: "B:0", track }],
	};
	stateRequest.mockResolvedValue({
		...app(actual),
		serverTime: 201,
		nowPlaying: {
			...track,
			stationId: 2,
			observedAt: 200,
			isPlaying: true,
			progressMs: 1000,
			kind: null,
			deviceName: "iPhone",
			orderBroken: false,
			smartShuffle: false,
		},
	});
	await store.refresh(false, true);
	expect(store.command).toBeNull();
});

it("keeps the failed same-station command explanation when another session replaces it", async () => {
	const { store } = await import("../../src/client/store");
	store.load = { kind: "ready", state: app() };
	const id = store.beginCommand("play", 1, frozen)!;
	store.failCommand(id, "Gerät nicht erreichbar");
	stateRequest.mockResolvedValue({ ...app(session(2, "B:0", "B")), serverTime: 200 });
	await store.refresh(false, true);
	expect(store.command).toMatchObject({ id, phase: "failed", error: "Gerät nicht erreichbar" });
});
