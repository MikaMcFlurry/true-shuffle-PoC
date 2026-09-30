# True Shuffle Cloudflare continuation

Read CODEX_START.md and docs/CLOUDFLARE_CONTINUATION.md first. This is Preact/TypeScript/Vite + Hono Worker + SQLite-backed Durable Objects, not the Python implementation on main.

The deployment base is claude/true-shuffle-spotify-95zw0m. Preserve user history, Durable Object class names/bindings/migration tags, APP_SECRET and existing account isolation. No production merge/deploy without an explicit release instruction. Never print secrets or access tokens. Do not edit vendored skill or node_modules as application code.

Use the project-local Impeccable skill for the requested new calm music-player UI. Its available version is 4.1.2; the online update previously failed due to download-host DNS. Do not claim successful online updating or that legacy Python screenshots verify this UI.

Verify npm build/typecheck/lint/tests and relevant browser behavior. Separate simulated results from live Spotify/HA acceptance. Never infer completed listening from wall time alone.
