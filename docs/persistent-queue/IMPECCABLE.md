# Impeccable installation

Project-local Codex skill: `.agents/skills/impeccable/SKILL.md`, bundled version 4.1.2. It is installed with its references and scripts, so the continuation environment can use the same design workflow.

The official latest CLI was retrieved and its `install --project --providers=codex --no-hooks --yes` command attempted. Its signed bundle download failed at impeccable.style with a DNS resolution error, and installed nothing. The fallback copies the available bundled 4.1.2 skill into the project; it does NOT claim a successful remote update or install an automatic hook. The official upstream repository was also inspected at commit `36034d4b846f040e09050d5e70e45f858fc37427`.

When network access to impeccable.style is available, run `npx impeccable check` and `npx impeccable update` in this project. Review any changes before using a newer workflow. Do not replace user-approved product truth or the Listening Room direction merely because a previous DESIGN.md exists.

The available local detector ran once on the changed CSS, templates and JS and reported no regex findings, but explicitly entered DEGRADED mode because its parser dependencies are unavailable. This is not a computed-style or accessibility pass; browser checks are recorded separately.
