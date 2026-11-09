# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: spotify-observed-playback.spec.ts >> COR1: an unclear next, then later looks still show the same play: Weiter stays closed, also after a reload
- Location: e2e/spotify-observed-playback.spec.ts:490:1

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  locator('.now-copy h2')
Expected: "Song 6"
Received: "Song 1"
Timeout:  15000ms

Call log:
  - Expect "toHaveText" locator('.now-copy h2') with timeout 15000ms
  - waiting for locator('.now-copy h2')
    - found getByRole('dialog', { name: /^Neu in Version / }), intercepting action to run the handler
    - locator handler has finished, waiting for getByRole('dialog', { name: /^Neu in Version / }) to be hidden
    - interception handler has finished, continuing
    33 × locator resolved to <h2>Song 1</h2>
       - unexpected value "Song 1"

```

```yaml
- heading "Song 1" [level=2]
```

# Test source

```ts
  400 | 	await expect(checkpoint(page)).toContainText(name(a));
  401 | 
  402 | 	h.fake.failWhen = null;
  403 | 	h.fake.user("mika").player.deviceId = null;
  404 | 	await look(h);
  405 | 	await reread(page);
  406 | 	await expect(title(page)).toHaveText("Spotify spielt gerade nichts");
  407 | 	await expect(checkpoint(page)).toContainText(name(a));
  408 | });
  409 | 
  410 | // ---------------------------------------------------------------------------
  411 | // One transport per unconfirmed observed play, and late answers kept to their
  412 | // own song (TS-NP-OBSERVED-COR1-261017). Spotify's answers are injected here
  413 | // only (failWhen / a lost /api answer); the shared stand-ins are unchanged.
  414 | 
  415 | /** Spotify accepts the next "next" without moving yet (it lags). */
  416 | function acceptWithoutMoving(h: H) {
  417 | 	let left = 1;
  418 | 	h.fake.failWhen = (m, p) =>
  419 | 		m === "POST" && p === "/me/player/next" && left-- > 0 ? { status: 200, body: {} } : null;
  420 | }
  421 | 
  422 | /** A later successful look that still shows the same play of B. */
  423 | async function stillPlaying(h: H) {
  424 | 	h.clock.t += 2_000;
  425 | 	h.fake.advance(2_000);
  426 | 	await look(h, 0);
  427 | }
  428 | 
  429 | const nieWieder = (page: Page) =>
  430 | 	page.getByRole("button", { name: "Daumen runter: diesen Song nie wieder" });
  431 | const favorit = (page: Page) => page.getByRole("button", { name: "Daumen hoch: Favorit" });
  432 | 
  433 | test("COR1: an accepted next Spotify has not shown yet: the same tab, a reload and a second tab (Weiter, Nie wieder) send no second next; C operable", async ({
  434 | 	page,
  435 | 	context,
  436 | }, info) => {
  437 | 	const { h, outside, name } = await world();
  438 | 	const served = await serve(page, h);
  439 | 	await page.goto("/");
  440 | 	const [b, c] = outside;
  441 | 	h.fake.playSong("mika", b!);
  442 | 	await look(h);
  443 | 	await reread(page);
  444 | 	await expect(title(page)).toHaveText(name(b!));
  445 | 	const nexts = calls(h, NEXT);
  446 | 	acceptWithoutMoving(h);
  447 | 	await weiter(page).click();
  448 | 	await expect.poll(() => calls(h, NEXT)).toBe(nexts + 1);
  449 | 	// Spotify accepted but has not moved: the following successful looks still show B.
  450 | 	await stillPlaying(h);
  451 | 	await reread(page);
  452 | 	await expect(title(page)).toHaveText(name(b!));
  453 | 	await expect(weiter(page)).toBeDisabled();
  454 | 	// A reload: the hub's status, not the page's memory, holds the key.
  455 | 	await page.reload();
  456 | 	await expect(title(page)).toHaveText(name(b!));
  457 | 	await expect(weiter(page)).toBeDisabled();
  458 | 	await expect(
  459 | 		page.getByRole("status").filter({ hasText: "schon an Spotify gesendet" }),
  460 | 	).toBeVisible();
  461 | 	// A second tab: Weiter closed; "Nie wieder" is stored, its skip not sent again.
  462 | 	const tab2 = await context.newPage();
  463 | 	const served2 = await serve(tab2, h);
  464 | 	await tab2.goto("/");
  465 | 	await expect(title(tab2)).toHaveText(name(b!));
  466 | 	await expect(weiter(tab2)).toBeDisabled();
  467 | 	await nieWieder(tab2).click();
  468 | 	await expect.poll(() => h.hub.memory(b!).thumb).toBe(-1);
  469 | 	await expect(tab2.getByText("Wird gespeichert …")).toHaveCount(0);
  470 | 	await expect(
  471 | 		tab2.getByRole("status").filter({ hasText: "schon an Spotify gesendet" }),
  472 | 	).toBeVisible();
  473 | 	expect(calls(h, NEXT)).toBe(nexts + 1);
  474 | 	expect(h.fake.current()).toBe(b);
  475 | 	// A new, confirmed play: operable at once.
  476 | 	h.fake.playSong("mika", c!);
  477 | 	await look(h);
  478 | 	await reread(tab2);
  479 | 	await expect(title(tab2)).toHaveText(name(c!));
  480 | 	await expect(weiter(tab2)).toBeEnabled();
  481 | 	await weiter(tab2).click();
  482 | 	await expect.poll(() => calls(h, NEXT)).toBe(nexts + 2);
  483 | 	await record(info, "cor1-provider-requests", {
  484 | 		nextTransports: calls(h, NEXT) - nexts,
  485 | 		page: served.requests.filter((r) => r.path !== "/api/state"),
  486 | 		tab2: served2.requests.filter((r) => r.path !== "/api/state"),
  487 | 	});
  488 | });
  489 | 
  490 | test("COR1: an unclear next, then later looks still show the same play: Weiter stays closed, also after a reload", async ({
  491 | 	page,
  492 | }, info) => {
  493 | 	const { h, outside, name } = await world();
  494 | 	const served = await serve(page, h);
  495 | 	await page.goto("/");
  496 | 	const b = outside[0]!;
  497 | 	h.fake.playSong("mika", b);
  498 | 	await look(h);
  499 | 	await reread(page);
> 500 | 	await expect(title(page)).toHaveText(name(b));
      |                            ^ Error: expect(locator).toHaveText(expected) failed
  501 | 	const nexts = calls(h, NEXT);
  502 | 	h.fake.failWhen = (m, p) => (m === "POST" && p === "/me/player/next" ? { status: 503 } : null);
  503 | 	await weiter(page).click();
  504 | 	await expect(
  505 | 		page.getByRole("status").filter({ hasText: "Es wird nicht wiederholt" }),
  506 | 	).toBeVisible();
  507 | 	h.fake.failWhen = null;
  508 | 	await stillPlaying(h);
  509 | 	await reread(page);
  510 | 	await expect(title(page)).toHaveText(name(b));
  511 | 	await expect(weiter(page)).toBeDisabled();
  512 | 	await page.reload();
  513 | 	await expect(title(page)).toHaveText(name(b));
  514 | 	await expect(weiter(page)).toBeDisabled();
  515 | 	expect(calls(h, NEXT)).toBe(nexts + 1);
  516 | 	await record(info, "cor1-unclear-requests", {
  517 | 		nextTransports: calls(h, NEXT) - nexts,
  518 | 		requests: served.requests.filter((r) => r.path !== "/api/state"),
  519 | 	});
  520 | });
  521 | 
  522 | test("COR1: Nie wieder whose answer is lost after Spotify accepted, saved again, then Weiter: one next only", async ({
  523 | 	page,
  524 | }, info) => {
  525 | 	const { h, outside, name } = await world();
  526 | 	const served = await serve(page, h);
  527 | 	await page.goto("/");
  528 | 	const b = outside[0]!;
  529 | 	h.fake.playSong("mika", b);
  530 | 	await look(h);
  531 | 	await reread(page);
  532 | 	await expect(title(page)).toHaveText(name(b));
  533 | 	const nexts = calls(h, NEXT);
  534 | 	acceptWithoutMoving(h);
  535 | 	served.lose.add(`/api/tracks/${b}/thumb`);
  536 | 	await nieWieder(page).click();
  537 | 	await expect.poll(() => calls(h, NEXT)).toBe(nexts + 1);
  538 | 	await expect(page.getByRole("button", { name: "Nochmal speichern" })).toBeVisible();
  539 | 	expect(h.hub.memory(b).thumb).toBe(-1);
  540 | 	await stillPlaying(h);
  541 | 	await reread(page);
  542 | 	await expect(title(page)).toHaveText(name(b));
  543 | 	// The page saves its answer again (the hub stored it already): the skip is not sent again.
  544 | 	await page.getByRole("button", { name: "Nochmal speichern" }).click();
  545 | 	await expect(page.getByText("Wird gespeichert …")).toHaveCount(0);
  546 | 	await expect(page.getByRole("button", { name: "Nochmal speichern" })).toHaveCount(0);
  547 | 	expect(calls(h, NEXT)).toBe(nexts + 1);
  548 | 	await expect(weiter(page)).toBeDisabled();
  549 | 	expect(calls(h, NEXT)).toBe(nexts + 1);
  550 | 	expect(h.fake.current()).toBe(b);
  551 | 	await record(info, "cor1-lost-answer-requests", {
  552 | 		nextTransports: calls(h, NEXT) - nexts,
  553 | 		requests: served.requests.filter((r) => r.path !== "/api/state"),
  554 | 	});
  555 | });
  556 | 
  557 | test("COR1: B's held Nie wieder released after C was confirmed as Favorit: C's message, rating and play stay; B's result named for B", async ({
  558 | 	page,
  559 | }, info) => {
  560 | 	const { h, outside, name } = await world();
  561 | 	const served = await serve(page, h);
  562 | 	await page.goto("/");
  563 | 	const [b, c] = outside;
  564 | 	h.fake.playSong("mika", b!);
  565 | 	await look(h);
  566 | 	await reread(page);
  567 | 	await expect(title(page)).toHaveText(name(b!));
  568 | 	let release!: () => void;
  569 | 	served.hold.set(
  570 | 		`/api/tracks/${b}/thumb`,
  571 | 		new Promise<void>((r) => {
  572 | 			release = r;
  573 | 		}),
  574 | 	);
  575 | 	await nieWieder(page).click();
  576 | 	await expect(page.getByText("Wird gespeichert …")).toBeVisible();
  577 | 	h.fake.playSong("mika", c!);
  578 | 	await look(h);
  579 | 	await reread(page);
  580 | 	await expect(title(page)).toHaveText(name(c!));
  581 | 	await favorit(page).click();
  582 | 	await expect(favorit(page)).toHaveAttribute("aria-pressed", "true");
  583 | 	await expect.poll(() => h.hub.memory(c!).thumb).toBe(1);
  584 | 	const flash = page.locator(".flash");
  585 | 	await expect(flash).toHaveText("Als Favorit gemerkt");
  586 | 	const nexts = calls(h, NEXT);
  587 | 	release();
  588 | 	await expect.poll(() => h.hub.memory(b!).thumb).toBe(-1);
  589 | 	// B's result, said for B, beside C's newer message — never in its place.
  590 | 	const note = page.getByRole("status").filter({ hasText: name(b!) });
  591 | 	await expect(note).toContainText("Der Song lief da schon nicht mehr");
  592 | 	await expect(flash).toHaveText("Als Favorit gemerkt");
  593 | 	await expect(favorit(page)).toHaveAttribute("aria-pressed", "true");
  594 | 	await expect(nieWieder(page)).toHaveAttribute("aria-pressed", "false");
  595 | 	expect(h.hub.memory(c!).thumb).toBe(1);
  596 | 	expect(calls(h, NEXT)).toBe(nexts);
  597 | 	expect(h.fake.current()).toBe(c);
  598 | 	await expect(page.getByRole("button", { name: "Jetzt überspringen" })).toHaveCount(0);
  599 | 	await expect(page.getByRole("button", { name: /erneut/ })).toHaveCount(0);
  600 | 	await record(info, "cor1-late-b-requests", {
```