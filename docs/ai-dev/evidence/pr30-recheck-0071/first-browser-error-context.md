# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app.spec.ts >> a listener's day >> starts a station in Spotify, in true-shuffle's order
- Location: e2e/app.spec.ts:132:2

# Error details

```
Test timeout of 90000ms exceeded.
```

```
Error: locator.click: Test timeout of 90000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: /^Indie & Gitarren/ })

```

# Page snapshot

```yaml
- generic [ref=f1e3]:
  - link "Zum Inhalt" [ref=f1e4] [cursor=pointer]:
    - /url: "#content"
  - banner [ref=f1e5]:
    - link "true-shuffle" [ref=f1e6] [cursor=pointer]:
      - /url: /
  - main [ref=f1e15]:
    - region [ref=f1e16]:
      - img [aria-hidden] [ref=f1e18]:
        - generic [ref=f1e31]: Deine Playlist
      - generic [ref=f1e47]:
        - heading "Shuffle, das sich merkt, was du gehört hast" [level=1] [ref=f1e48]
        - list [ref=f1e49]:
          - listitem [ref=f1e50]:
            - strong [ref=f1e51]: Jeder Song kommt dran.
            - text: Erst wenn alle einmal liefen, geht es von vorn los.
          - listitem [ref=f1e52]:
            - strong [ref=f1e53]: Keine schnellen Wiederholungen.
            - text: Favoriten öfter, Neues dazwischen.
          - listitem [ref=f1e54]:
            - strong [ref=f1e55]: Deine Stelle bleibt.
            - text: Auch wenn du zwischendurch anderes hörst.
        - status [ref=f1e56]: Spotify hat die Anmeldung nicht bestätigt. Bitte nochmal versuchen.
        - link "Mit Spotify anmelden" [ref=f1e57] [cursor=pointer]:
          - /url: /auth/login
        - paragraph [ref=f1e58]: Braucht Spotify Premium. Spotify spielt die Musik; true-shuffle legt dafür pro Kassette eine private Playlist „true-shuffle · …“ in deinem Konto an.
```

# Test source

```ts
  34  | 	const unnamed = await page.evaluate(() =>
  35  | 		[...document.querySelectorAll("button, a[href], input, select")]
  36  | 			.filter((el) => {
  37  | 				const h = el as HTMLElement;
  38  | 				if (h.offsetParent === null && getComputedStyle(h).position !== "fixed") return false;
  39  | 				const label =
  40  | 					h.getAttribute("aria-label") ??
  41  | 					(h.id ? document.querySelector(`label[for="${h.id}"]`)?.textContent : null) ??
  42  | 					h.closest("label")?.textContent ??
  43  | 					h.textContent;
  44  | 				return !label?.trim();
  45  | 			})
  46  | 			.map((el) => el.outerHTML.slice(0, 120)),
  47  | 	);
  48  | 	expect(unnamed, `${where}: controls without a name`).toEqual([]);
  49  | }
  50  | 
  51  | /** Nothing sticks out of the box it sits in, where a clipping box would cut it off. */
  52  | async function checkContained(page: Page, where: string): Promise<void> {
  53  | 	const out = await page.evaluate(() =>
  54  | 		[...document.querySelectorAll("body *")]
  55  | 			.filter((el) => {
  56  | 				const p = el.parentElement;
  57  | 				if (!p || el.closest("svg")) return false;
  58  | 				const cs = getComputedStyle(el);
  59  | 				// Placed or turned on purpose (lamps, needles, knob caps): not flow content.
  60  | 				if (cs.position === "absolute" || cs.position === "fixed" || cs.transform !== "none")
  61  | 					return false;
  62  | 				const r = el.getBoundingClientRect();
  63  | 				const pr = p.getBoundingClientRect();
  64  | 				if (r.width === 0 || pr.width === 0) return false;
  65  | 				return r.right > pr.right + 1 || r.left < pr.left - 1;
  66  | 			})
  67  | 			.map((el) => `${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""}`),
  68  | 	);
  69  | 	expect(out, `${where}: wider than its box`).toEqual([]);
  70  | }
  71  | 
  72  | /** No words cut off: text that does not fit wraps; it is never clipped or ended with "…". */
  73  | async function checkText(page: Page, where: string): Promise<void> {
  74  | 	const cut = await page.evaluate(() =>
  75  | 		[...document.querySelectorAll("body *")]
  76  | 			.filter((el) => {
  77  | 				const h = el as HTMLElement;
  78  | 				if (![...h.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim())) return false;
  79  | 				const cs = getComputedStyle(h);
  80  | 				if (h.offsetParent === null && cs.position !== "fixed") return false;
  81  | 				// Visually hidden text for screen readers is 1 px on purpose.
  82  | 				if (h.clientWidth <= 2) return false;
  83  | 				if (cs.overflowX === "visible" && cs.overflowY === "visible") return false;
  84  | 				return h.scrollWidth > h.clientWidth + 1 || h.scrollHeight > h.clientHeight + 2;
  85  | 			})
  86  | 			.map((el) => `${el.getAttribute("class") ?? el.tagName}: ${el.textContent?.trim()}`),
  87  | 	);
  88  | 	expect(cut, `${where}: text cut off`).toEqual([]);
  89  | }
  90  | 
  91  | /** Pages whose explanations arrive after the heading: wait for them. */
  92  | const EXPLAINED: Record<string, RegExp> = {
  93  | 	"/suchlauf": /Spotify gibt die Songs nicht heraus/,
  94  | 	"/sender/neu": /Spotify gibt die Songs nicht heraus/,
  95  | 	"/geraete": /Das gerade aktive Gerät, sonst dein Handy/,
  96  | };
  97  | 
  98  | test.describe.configure({ mode: "serial" });
  99  | 
  100 | test.describe("a listener's day", () => {
  101 | 	test.use({ viewport: { width: 390, height: 844 } });
  102 | 
  103 | 	test("shows signed-out users as online after a normal authentication response", async ({
  104 | 		page,
  105 | 	}) => {
  106 | 		const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/state");
  107 | 		await page.goto("/");
  108 | 		expect((await response).status()).toBe(401);
  109 | 		await expect(page.getByRole("link", { name: "Mit Spotify anmelden" })).toBeVisible();
  110 | 		await expect(page.getByText("Offline oder nicht erreichbar.", { exact: false })).toBeHidden();
  111 | 	});
  112 | 
  113 | 	test("signs in with Spotify and saves playlists as stations", async ({ page }) => {
  114 | 		await signIn(page);
  115 | 		await expect(page.getByText("Wähle, welche Playlists Kassetten werden")).toBeVisible();
  116 | 		await checkPage(page, "Sendersuchlauf");
  117 | 		// A playlist of someone else cannot be read (Spotify keeps its songs).
  118 | 		await expect(page.getByRole("checkbox", { name: /Today's Top Hits/ })).toBeDisabled();
  119 | 		await page.getByRole("checkbox", { name: /Indie & Gitarren/ }).check();
  120 | 		await page.getByRole("checkbox", { name: /Lange Autofahrt/ }).check();
  121 | 		await page.getByRole("button", { name: "2 Kassetten anlegen" }).click();
  122 | 
  123 | 		// Home: the automatic "Alles" plus the two stations, ready once imported.
  124 | 		for (const name of ["Alles", "Indie & Gitarren", "Lange Autofahrt"]) {
  125 | 			await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toBeEnabled({
  126 | 				timeout: 60_000,
  127 | 			});
  128 | 		}
  129 | 		await checkPage(page, "home");
  130 | 	});
  131 | 
  132 | 	test("starts a station in Spotify, in true-shuffle's order", async ({ page }) => {
  133 | 		await signIn(page);
> 134 | 		await page.getByRole("button", { name: /^Indie & Gitarren/ }).click();
      |                                                                 ^ Error: locator.click: Test timeout of 90000ms exceeded.
  135 | 		await page.getByRole("button", { name: "Wiedergabe starten" }).click();
  136 | 		const display = page.locator(".player");
  137 | 		await expect(page.locator(".station-actions")).toContainText("Indie & Gitarren");
  138 | 		await expect(page.locator(".promise")).toContainText("Deine Stelle bleibt");
  139 | 		await expect(display).toContainText("Läuft auf Mikas iPhone");
  140 | 		await expect(page.locator(".session-status")).toHaveText("Spielt");
  141 | 
  142 | 		const s = await fake("status");
  143 | 		expect(s.playing).toBe(true);
  144 | 		expect(s.shuffle).toBe(false);
  145 | 		expect(s.context).toMatch(/^spotify:playlist:/);
  146 | 		// Playing now: a tap opens the station instead of starting it over.
  147 | 		const tile = page.getByRole("link", { name: "Indie & Gitarren: Mix und Regeln" });
  148 | 		await expect(tile).toBeVisible();
  149 | 		await tile.click();
  150 | 		await expect(page.getByRole("heading", { name: "Indie & Gitarren", level: 1 })).toBeVisible();
  151 | 		await expect(page.getByText("Läuft gerade").first()).toBeVisible();
  152 | 		expect((await fake("status")).playing).toBe(true);
  153 | 	});
  154 | 
  155 | 	test("counts song time locally without additional API requests", async ({ page }) => {
  156 | 		await signIn(page);
  157 | 		const progress = page.getByRole("progressbar", { name: "Geschätzte Songposition" });
  158 | 		await expect(progress).toBeVisible();
  159 | 		const before = await progress.evaluate((el) => (el as HTMLProgressElement).value);
  160 | 		let calls = 0;
  161 | 		page.on("request", (request) => {
  162 | 			if (new URL(request.url()).pathname.startsWith("/api/")) calls++;
  163 | 		});
  164 | 		await expect
  165 | 			.poll(
  166 | 				async () => (await progress.evaluate((el) => (el as HTMLProgressElement).value)) - before,
  167 | 			)
  168 | 			.toBeGreaterThanOrEqual(1000);
  169 | 		expect(calls).toBe(0);
  170 | 		await expect(page.locator(".progress-labels")).not.toContainText("gespeichert");
  171 | 	});
  172 | 
  173 | 	test("skips and bans a song from the transport keys", async ({ page }) => {
  174 | 		await signIn(page);
  175 | 		const song = page.locator(".now-copy h2");
  176 | 		await expect(song).not.toBeEmpty();
  177 | 		const first = (await fake("status")).current;
  178 | 		expect(first).not.toBeNull();
  179 | 
  180 | 		await page.getByRole("button", { name: "Weiter: Nächster Song" }).click();
  181 | 		await expect(page.getByRole("button", { name: "Weiter: Nächster Song" })).toBeEnabled();
  182 | 		// Synthetic tracks reuse titles; Spotify track identity must change.
  183 | 		await expect.poll(async () => (await fake("status")).current).not.toBe(first);
  184 | 
  185 | 		const before = (await fake("status")).current;
  186 | 		await page.getByRole("button", { name: "Daumen runter: diesen Song nie wieder" }).click();
  187 | 		await expect(page.getByText("Kommt nie wieder")).toBeVisible();
  188 | 		await expect.poll(async () => (await fake("status")).current).not.toBe(before);
  189 | 	});
  190 | 
  191 | 	test("shows the station with its round, mix and next songs", async ({ page }) => {
  192 | 		await signIn(page);
  193 | 		// Every cassette is set up from the shelf (Kassetten).
  194 | 		await page.getByRole("link", { name: "Kassetten" }).click();
  195 | 		await page.getByRole("link", { name: "Indie & Gitarren einstellen" }).click();
  196 | 		await expect(page.getByRole("heading", { name: "Indie & Gitarren", level: 1 })).toBeVisible();
  197 | 		const panel = page.locator(".page");
  198 | 		await expect(panel.getByText(/von 400 Songs gehört/).first()).toBeVisible();
  199 | 		// Song rows only: each row also holds its own list of tags.
  200 | 		const next = page
  201 | 			.getByRole("region", { name: "Als Nächstes" })
  202 | 			.getByRole("listitem")
  203 | 			.filter({ has: page.getByRole("button", { name: / bewerten$/ }) });
  204 | 		await expect(next.first()).toBeVisible();
  205 | 		await checkPage(page, "station");
  206 | 
  207 | 		// On the sheet the mix is printed as the knob's three positions to choose from.
  208 | 		await page.getByRole("radio", { name: "Vertraut" }).check();
  209 | 		await expect(page.getByText(/50 % ungehört/)).toBeVisible();
  210 | 		await page.getByRole("radio", { name: "Entdecker" }).check();
  211 | 		await expect(page.getByText(/60 % ungehört/)).toBeVisible();
  212 | 		// Stepless: any value between the presets, with the shares printed below.
  213 | 		await page.getByRole("slider", { name: /Genau einstellen/ }).fill("40");
  214 | 		await expect(page.getByText(/62 % ungehört/)).toBeVisible();
  215 | 		await expect(page.getByText("Eigene Mischung zwischen den Stufen.")).toBeVisible();
  216 | 		await page.getByRole("radio", { name: "Entdecker" }).check();
  217 | 		await expect(page.getByText(/60 % ungehört/)).toBeVisible();
  218 | 
  219 | 		// Rated afterwards, not only while it plays: a song further down the list.
  220 | 		const third = next.nth(2);
  221 | 		await third.getByRole("button", { name: / bewerten$/ }).click();
  222 | 		const sheet = page.getByRole("dialog");
  223 | 		await expect(sheet).toBeVisible();
  224 | 		await sheet.getByRole("button", { name: "Daumen runter: nie wieder" }).click();
  225 | 		await expect(sheet).toBeHidden();
  226 | 		await expect(third.getByRole("img", { name: "Kommt nie wieder" })).toBeVisible();
  227 | 	});
  228 | 
  229 | 	test("the favourite share keeps every step, also past 60 % and when a save fails", async ({
  230 | 		page,
  231 | 	}) => {
  232 | 		await signIn(page);
  233 | 		const st = (await (await page.request.get("/api/state")).json()) as {
  234 | 			stations: { id: number; name: string }[];
```