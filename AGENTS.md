# true-shuffle — Cloudflare restart

Read CODEX_START.md, then docs/ai-dev/HANDOFF_MAP.json and its mapped canonical files. This is the Preact/TypeScript/Hono/Cloudflare Durable Object app; main is legacy Python/Fly. The implementation branch is codex/implement-cloudflare-restart; its implemented behavior, actual deployment and still-partial live acceptance are recorded in EVIDENCE.json. Do not repeat the historical preparation as an unfinished implementation.

Use .agents/skills/mika-dev-studio/SKILL.md as orchestrator, the bundled Mika Repo Intelligence, Product Director, Engineering, Verification, Red Team and Repo Handoff workflows as applicable, and .agents/skills/impeccable/SKILL.md for the independent redesign. Do not edit vendored skill copies as application code. Provenance: .agents/skills/MIKA_BUNDLE.json.

Latest owner intent in docs/ai-dev/MISSION.md supersedes the rejected radio design and legacy restart-means-reshuffle behavior. Preserve incumbent functional requirements, history, discovery and customization. Keep protected requirement IDs stable in execution plans and evidence.

Preserve stored identity, UserHub/Registry names/bindings, migration tags, APP_SECRET, histories and account isolation. Only additive reviewed migrations. Never infer completed listening from wall time alone. Normal Play resumes a stable queue occurrence and saved observed progress. Unknown progress falls back to that same unfinished song.

Revalidate baseline and mark generated packets stale after material code/branch/deployment changes. The packet baseline is an ancestor; later documentation commits do not by themselves change its analyzed application. Verify actual Cloudflare version/bindings before live operations. Isolate preview state before writes. No production merge/deploy without an explicit release instruction. Never expose secrets, tokens or user history.

Run build, typecheck, lint, unit/Worker/browser and relevant migration/recovery checks. Separate simulated Spotify from live Spotify and HA/MA acceptance. Fix independent work before reporting narrow access blockers. Downstream mission is implementation, not another plan-only handoff.

Current production: version `c3c3324b-cdab-4cee-a1a8-af69ca289d97`, deployment `e414b5c1-0a5e-46d3-871a-c5d6f1ce5f23`, code `b64e03c09569bb4b763980ebdb6d0d5c78e5d263`, 100% traffic. Existing namespaces, migration v1 and secrets were preserved. Public/API/anonymous-browser readback passes; owner Spotify/HA and actual populated-storage restore remain NOT_RUN. See evidence/CLOUDFLARE_DEPLOYMENT.json under docs/ai-dev. Deployment approval and Cloudflare OAuth already exist; do not request them again.

Quota clarification followup: current source `b64e03c09569bb4b763980ebdb6d0d5c78e5d263` and GitHub Actions 36703665557 pass 325 unit/Worker tests and 17 browser cases. Four fresh independent actual-render cases cover known, expired, boundary and unknown waits. Backend/provider cadence is unchanged. Owner screenshot reports QUOTA_EXCEEDED with 30363-second Retry-After; owner confirms other development apps in the same developer account. Spotify documents a shared developer-account budget. Exact attribution, bucket size/reset window, later provider recovery and sustained owner usage remain unverified. See `docs/ai-dev/evidence/QUOTA_DIAGNOSIS.json`. Full acceptance stays PARTIAL.
