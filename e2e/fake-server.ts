/**
 * Local Spotify stand-in for the end-to-end tests and screenshots.
 * All names below are SYNTHETIC demo data — invented artists and songs.
 */

import { createServer } from "node:http";
import { FakeSpotify, fakeId } from "../test/fakes/fake-spotify.ts";

const PORT = Number(process.env.FAKE_PORT ?? 8788);

const ARTISTS = [
	"Nachtbus",
	"Lena Aurich",
	"The Paper Kites Club",
	"Kalte Küche",
	"Moira Vale",
	"Fjordlicht",
	"Die Heizkörper",
	"Sunday Aviators",
	"Ola Brenner",
	"Glasfabrik",
	"Neon Harbour",
	"Mira & die Motoren",
	"Velvet Anchor",
	"Tiefgarage",
	"Hollow Pines",
	"Kiesel",
	"Marta Quell",
	"Autobahnkirche",
	"Silver Lagoon",
	"Brausepulver",
	"The Weekday Saints",
	"Juno Park",
	"Stadtrand",
	"Echo Tram",
	"Wildwechsel",
	"Yara Mond",
	"Low Tide Radio",
	"Feuermelder",
	"Oak & Ash",
	"Klara Sturm",
];
const WORDS = [
	"Autobahn",
	"Sommerregen",
	"Letzte Ausfahrt",
	"Neonlicht",
	"Kilometer",
	"Morgengrauen",
	"Funkloch",
	"Raststätte",
	"Golden Hour",
	"Heatwave",
	"Paper Planes",
	"Slow Motion",
	"Nordsee",
	"Blaue Stunde",
	"Echo",
	"Wasserfarben",
	"Tanzfläche",
	"Parallel",
	"Mitternacht",
	"Fernweh",
	"Satellit",
	"Glühwürmchen",
	"Kaleidoskop",
	"Rücklicht",
	"Wolkenkratzer",
	"Stroboskop",
	"Salzwasser",
	"Leuchtturm",
	"Asphalt",
	"Kopfkino",
	"Sternschnuppe",
	"Horizont",
];
const COLORS = [
	["#e4572e", "#29335c"],
	["#f3a712", "#1b998b"],
	["#2e86ab", "#f6f5ae"],
	["#a23b72", "#f18f01"],
	["#3d5a80", "#ee6c4d"],
	["#6a994e", "#f2e8cf"],
	["#bc4749", "#386641"],
	["#264653", "#e9c46a"],
	["#5f0f40", "#fb8b24"],
	["#0f4c5c", "#e36414"],
	["#9b5de5", "#00bbf9"],
	["#ef476f", "#118ab2"],
];

function cover(i: number): string {
	const [a, b] = COLORS[i % COLORS.length]!;
	const shape = i % 3;
	const art =
		shape === 0
			? `<circle cx='70' cy='60' r='38' fill='${b}'/>`
			: shape === 1
				? `<rect x='20' y='55' width='120' height='18' fill='${b}'/><rect x='20' y='82' width='80' height='18' fill='${b}' opacity='.7'/>`
				: `<path d='M0 150 L80 40 L160 150Z' fill='${b}'/>`;
	const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 160'><rect width='160' height='160' fill='${a}'/>${art}</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const DEVICES = [
	{ id: "mika-phone", name: "Mikas iPhone", type: "Smartphone", restricted: false },
	{ id: "mika-car", name: "Auto (CarPlay)", type: "Automobile", restricted: false },
	{ id: "mika-desk", name: "Schreibtisch", type: "Computer", restricted: false },
];

export function seed(fake: FakeSpotify): void {
	const n = 1500;
	const tracks = fake.addTracks(n, { artists: ARTISTS.length });
	tracks.forEach((t, i) => {
		const ai = i % ARTISTS.length;
		t.artistName = ARTISTS[ai]!;
		const w1 = WORDS[(i * 7) % WORDS.length]!;
		const w2 = WORDS[(i * 13 + 5) % WORDS.length]!;
		const base =
			i % 4 === 0
				? w1
				: i % 4 === 1
					? `${w1} (${w2})`
					: i % 4 === 2
						? `${w1} & ${w2}`
						: `Nie mehr ${w2}`;
		// Names repeat every 480 songs per artist; later takes get a version tag.
		t.name = `${base}${["", " – Live", " – Akustik", " – Remix"][Math.floor(i / 480)] ?? ""}`;
		t.albumName =
			`${WORDS[(Math.floor(i / 10) * 3) % WORDS.length]} ${["EP", "", "LP", "Sessions"][i % 4]}`.trim();
		(t as { cover?: string }).cover = cover(Math.floor(i / 10));
	});
	fake.addUser("mika", { name: "Mika" });
	fake.user("mika").devices = [...DEVICES];
	const ids = tracks.map((t) => t.id);
	fake.addPlaylist("mika", "Alles, was ich mag", ids.slice(0, 1200), fakeId("P", 101));
	fake.addPlaylist("mika", "Indie & Gitarren", ids.slice(300, 700), fakeId("P", 102));
	fake.addPlaylist("mika", "Deutschrap & Pop", ids.slice(700, 1050), fakeId("P", 103));
	fake.addPlaylist("mika", "Lange Autofahrt", ids.slice(900, 1500), fakeId("P", 104));
	fake.addPlaylist("mika", "Ruhig am Abend", ids.slice(1200, 1350), fakeId("P", 105));
	const foreign = fake.addPlaylist(
		"spotify",
		"Today's Top Hits",
		ids.slice(0, 50),
		fakeId("P", 106),
	);
	foreign.followedBy.add("mika");
	fake.user("mika").liked = ids.filter((_, i) => i % 9 === 0).slice(0, 160);
}

const fake = new FakeSpotify();
seed(fake);

// Playback moves in real time.
let last = Date.now();
setInterval(() => {
	const now = Date.now();
	for (const u of fake.users.values()) fake.advance(now - last, u.id);
	last = now;
}, 1000);

const server = createServer(async (req, res) => {
	const url = `http://127.0.0.1:${PORT}${req.url}`;
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	const body = chunks.length ? Buffer.concat(chunks) : undefined;
	let response: Response;
	if (req.url?.startsWith("/__control/")) {
		const u = new URL(url);
		const user = fake.user("mika");
		switch (u.pathname) {
			case "/__control/advance":
				fake.advance(Number(u.searchParams.get("ms") ?? 60_000), "mika");
				break;
			case "/__control/skip":
				fake.skip("mika");
				break;
			case "/__control/pause":
				fake.pause("mika");
				break;
			case "/__control/smart-shuffle":
				user.player.smartShuffle = u.searchParams.get("on") === "1";
				break;
			case "/__control/premium":
				user.premium = u.searchParams.get("on") === "1";
				break;
			case "/__control/devices":
				user.devices = u.searchParams.get("none") === "1" ? [] : [...DEVICES];
				break;
		}
		response = Response.json({
			current: fake.current("mika"),
			context: user.player.contextUri,
			playing: user.player.isPlaying,
			shuffle: user.player.shuffle,
			recent: user.recent.length,
		});
	} else {
		response = await fake.handle(
			new Request(url, {
				method: req.method,
				headers: req.headers as Record<string, string>,
				body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
			}),
		);
	}
	res.writeHead(response.status, Object.fromEntries(response.headers));
	res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(PORT, "127.0.0.1", () => console.log(`fake spotify on ${PORT}`));
