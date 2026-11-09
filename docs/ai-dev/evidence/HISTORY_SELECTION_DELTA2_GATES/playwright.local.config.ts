/** Local Windows run only (never committed): same suite; cmd-compatible start, short persistence path (MAX_PATH). */
import base from "./playwright.config";

const persist = "C:/Users/mikah/Documents/Codex/2026-10-13/task/work/true-shuffle-PoC/e2e/.artifacts/s";
export default {
	...base,
	webServer: [
		{ ...(base.webServer as object[])[0] },
		{
			...(base.webServer as object[])[1],
			command: `npx vite build && npx wrangler dev -c wrangler.e2e.jsonc --port 8787 --ip 127.0.0.1 --persist-to ${persist}`,
		},
	],
};
