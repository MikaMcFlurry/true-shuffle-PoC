/** The browser bar takes the page ground of the active theme. */
export function syncThemeColor(): void {
	const bg = getComputedStyle(document.documentElement).getPropertyValue("--bar").trim();
	if (!bg) return;
	for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
		meta.content = bg;
}
