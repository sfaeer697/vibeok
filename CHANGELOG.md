# Changelog

## Unreleased

## 0.1.0

First release.

- `npx vibeok [url]`: crawls up to 5 pages, clicks every safe button, fills and submits forms, checks the 375px phone layout
- Finds dead buttons, silent form failures, 5xx/4xx responses, uncaught exceptions, console errors, placeholder buttons, broken links and sideways scrolling
- Vibe Score out of 100 and `VIBEOK_FIX_PROMPT.md`
- On-screen VibeOK cursor, thought bubble and score pill (headed mode)
- MCP server (`npx vibeok mcp`) with the `vibeok_check` tool
- Optional `--ai` fix prompt with your own Anthropic, OpenAI, Gemini or Ollama key
- Uses installed Chrome or Edge when Playwright's Chromium isn't installed
- Local-only by default; risky buttons are never clicked
- Login and signup forms: asks whether to use a demo account, your test account, log in yourself, or skip; then tests the pages behind login
- Plain-English journeys: `npx vibeok "sign up and create a project"` with your own model (Anthropic, OpenAI, Gemini or local Ollama); checks for server errors, crashes and dead clicks after every step; the model never sees passwords (tokens)
- `--explore`: the AI finds and tests your main features
- Passed journeys saved to `.vibeok/journeys/`; `vibeok replay` re-runs them with no AI and re-learns them if the UI changed; `vibeok journeys` lists them
- MCP: `vibeok_journey` (VibeOK drives) and `vibeok_open_app` / `vibeok_act` / `vibeok_finish` (your agent drives, no key)
- `vibeok login` / `vibeok logout`; saved session in `.vibeok/` (git-ignored, never contains the password); `VIBEOK_EMAIL` / `VIBEOK_PASSWORD` for CI
