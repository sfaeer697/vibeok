# Contributing to VibeOK

Thanks for helping. The most valuable contributions right now are **false-positive reports** (VibeOK flagged something that works) and **missed bugs** (it didn't catch something real). A minimal HTML page that reproduces it is perfect.

## Setup

```bash
git clone https://github.com/sfaeer697/vibeok && cd vibeok
npm install
npm run build
npm test          # needs Chrome, Edge, or `npx playwright install chromium`
```

Try your change against the demo app:

```bash
npm run demo                     # terminal 1
node dist/cli.js localhost:3000  # terminal 2
```

## Project layout

| Path | What it does |
| --- | --- |
| `src/cli.ts` | Command-line entry (`npx vibeok`) |
| `src/mcp.ts` | MCP server (`npx vibeok mcp`) |
| `src/scan.ts` | Crawls pages, runs checks, turns raw events into findings |
| `src/checks.ts` | Dead-button, form and phone-layout checks |
| `src/collector.ts` | Listens to network, console and exceptions |
| `src/page-helpers.ts` | In-page helpers (injected script) |
| `src/overlay.ts` | The on-screen cursor, bubble and score pill |
| `src/report.ts` | Terminal report, MCP markdown and fix prompt |
| `src/ai.ts` | Bring-your-own-model (Anthropic, OpenAI, Gemini, Ollama) |
| `src/runner.ts` | Does one journey step on a numbered page and reports what happened |
| `src/journey.ts` | The model loop, saving and free replays |
| `src/prompt.ts` / `src/session.ts` | Login questions at the terminal, saved sessions |
| `examples/broken-vibe-app` | Demo app with 10 planted bugs, also used by the tests |

## Rules for checks

1. **No false positives over more findings.** A tool that cries wolf gets uninstalled. When in doubt, skip and list it under "skipped".
2. **Every finding needs evidence and a fix** a coding agent can act on.
3. **Never click anything risky** (delete, pay, log out). Add to the `RISKY` pattern rather than removing from it.
4. **No attack tooling.** VibeOK tests your own app like a user. It doesn't probe other people's sites.
5. Add a planted bug to the demo app and an assertion to the tests for each new check.
6. Passwords never go to the model or to disk. Use `{{login.*}}` tokens.

Tests use a scripted stand-in for the model (`test/journey.test.mjs`), so you don't need an API key to run them.

## Pull requests

- Keep PRs small and focused, one check or fix per PR.
- `npm run typecheck && npm test` must pass.
- Add a line to `CHANGELOG.md` under "Unreleased".
