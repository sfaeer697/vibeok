# VibeOK CLI: notes for coding agents

Open-source (MIT) CLI and MCP server: `npx vibeok [url]` opens a web app in Chromium (playwright-core), clicks every safe button, submits forms, checks the 375px layout, and writes a Vibe Score plus VIBEOK_FIX_PROMPT.md. The paid product (24/7 monitoring) is a separate private repo at tryvibeok.site.

- Build: `npm run build` (tsup → dist/cli.js and dist/index.js). Typecheck: `npm run typecheck`. Tests: `npm test` (node:test; needs Chrome, Edge or Playwright Chromium).
- Entry points: src/cli.ts (CLI), src/mcp.ts (MCP stdio server: never write to stdout there), src/index.ts (library API).
- Core: src/scan.ts (crawl + findings), src/checks.ts (buttons, forms, mobile), src/collector.ts (network/console/exceptions), src/page-helpers.ts + src/overlay.ts (injected scripts, kept as plain strings so the bundler can't rewrite them).
- Journeys: src/runner.ts executes one action on a numbered page snapshot (H.snapshot in page-helpers) and reports problems after every step; src/journey.ts runs the model loop (JSON action per turn, provider-agnostic via src/ai.ts makeChat), saves passed journeys as role+name steps to .vibeok/journeys/, and replays them without AI. Credentials are {{login.*}} / {{new.*}} tokens resolved in the runner, never sent to the model.
- In-page code: always reference helpers as (window as any).__vibeokH inside page.evaluate callbacks, never a Node-side shortcut (it isn't defined in the browser).
- Rules: no false positives over more findings; every finding has evidence and a fix; never click RISKY buttons; local URLs only unless ownership is confirmed; no LLM needed for core checks (src/ai.ts is optional BYOK).
- Login: src/prompt.ts asks at the terminal (demo account / typed test account / log in by hand / skip); src/session.ts saves only the session to .vibeok/session.json (git-ignored). Non-interactive (CI, MCP): saved session, then VIBEOK_EMAIL/VIBEOK_PASSWORD, else skip with a note. Never put passwords on disk or ask for them over MCP.
- examples/broken-vibe-app has 10 planted bugs (bug 9 behind login: demo@taskpilot.dev / demo1234; bug 10 is data loss on /projects that only a journey catches; /notes saves correctly); tests assert the 8 public ones are found, /healthy has none, the login flows in test/auth.test.mjs, journeys/replay with a scripted model in test/journey.test.mjs.
