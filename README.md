<div align="center">

# VibeOK

**Test your web app like a real user. In plain English.**

`npx vibeok "sign up, create a project, and check it's still there after a reload"`

[![npm](https://img.shields.io/npm/v/vibeok?color=10B981)](https://www.npmjs.com/package/vibeok)
[![CI](https://github.com/sfaeer697/vibeok/actions/workflows/ci.yml/badge.svg)](https://github.com/sfaeer697/vibeok/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827)](LICENSE)

<!-- Record the demo (see docs/DEMO.md) and replace this line with: ![VibeOK demo](docs/demo.gif) -->

</div>

You built your app with Lovable, Bolt, Cursor or Claude Code. It looks done. But after a few rounds of prompts, some buttons do nothing, a form says "Saved!" while the server returns a 500, and the project you just created is gone after a refresh.

VibeOK opens your app in a real browser and uses it the way your users will. A green cursor shows what it's doing. When something breaks, you get exactly what broke and a **fix prompt** to paste back into your AI tool.

- **No test code, no YAML.** Describe what a user should be able to do, in your own words.
- **Runs on your machine.** No VibeOK server, no account. Your passwords never reach the AI model.
- **Uses the browser you already have** (Chrome or Edge).
- **Works inside Claude Code, Cursor and Codex**, so your agent can test its own work.

## Three ways to use it

| | Command | What it does | Needs a model? |
| --- | --- | --- | --- |
| 🔎 **Check everything** | `npx vibeok` | Visits your pages, clicks every safe button, submits forms, checks the phone layout | No |
| 🧭 **Test a journey** | `npx vibeok "log in and invite a teammate"` | Follows your journey step by step and verifies each part | Yes: your key or free local Ollama |
| ↻ **Replay for free** | `npx vibeok replay` | Re-runs every journey that passed, with no AI, in seconds | No |

## Quick start

```bash
npm run dev                # start your app first
npx vibeok                 # check every page and button on localhost:3000
```

Then test what matters most in your app:

```bash
npx vibeok "sign up as a new user, create a project called Launch, and check it's on the dashboard"
```

```
  🧭 Journey: sign up as a new user, create a project called Launch, and check it's on the dashboard
     Model: anthropic · claude-haiku-5-5 (your key, sent only to anthropic)

  ✓  1  Open /
  ✓  2  Click "Get started"           Going to the signup page
  ✓  3  Type "vibeok.test+k2x9@example.com" into "Email"
  ✓  4  Type "••••••••" into "Password"
  ✓  5  Click "Create account"
  ✓  6  Click "New project"
  ✓  7  Type "Launch 4kx2" into "Project name"
  ✓  8  Click "Create"
  ✓  9  See "Launch 4kx2"
  ✓ 10  Reload the page               Checking it was really saved
  ✗ 11  See "Launch 4kx2"
        "Launch 4kx2" is NOT on /dashboard.

  ✖ Journey failed · after 11 steps · 24.1s
  The new project disappeared after a reload, so it was never saved.
  ✔ Fix prompt written to VIBEOK_FIX_PROMPT.md. Paste it into Cursor, Claude Code or Lovable.
```

Want to see it catch bugs right away? Run the demo app, which has 10 bugs planted in it:

```bash
git clone https://github.com/sfaeer697/vibeok && cd vibeok
npm install && npm run build
npm run demo                                       # terminal 1: buggy app on :3000
node dist/cli.js                                   # terminal 2: finds the 8 public bugs
node dist/cli.js localhost:3000/app                # log in with demo@taskpilot.dev / demo1234 → bug 9
node dist/cli.js "log in, create a project called Launch, and check it's still there after a reload"   # → bug 10
```

## Journeys in plain English

Write the journey the way you'd explain it to a friend testing your app:

```bash
npx vibeok "log in, open settings, change my name to Sam, and check it's saved"
npx vibeok localhost:5173 "add three items to the cart and check the total updates"
npx vibeok --explore      # no journey: the AI finds your main features and tries each one
```

How it works: on every step VibeOK reads the page as a short numbered list (`[3] button "Save"`), your model picks the next action, and VibeOK does it in the browser. After **every** step it also checks for server errors, crashes and buttons that do nothing, so problems are caught even when they aren't part of the journey. Anything created gets a unique name, and the model is told to reload and check again, which catches data that was never really saved.

**Passed journeys are saved** to `.vibeok/journeys/` as plain steps (`click button "Create project"`). Commit them. `npx vibeok replay` re-runs them all with no AI: free, fast and the same every time, which makes it ideal before every deploy and in CI. If your UI changed and a step can't find its button anymore, VibeOK re-learns the journey with your model and updates the file.

### Choose a model

| Model | Set this | Cost |
| --- | --- | --- |
| Claude | `ANTHROPIC_API_KEY` | Cents per journey with the default small model |
| OpenAI | `OPENAI_API_KEY` | Cents per journey |
| Gemini | `GEMINI_API_KEY` | Free tier available |
| Ollama (local) | `OLLAMA_HOST=http://localhost:11434` | Free, runs on your machine |

No key set? VibeOK asks you to paste one for that run only (it isn't saved). `VIBEOK_MODEL` picks a different model. Your key is sent only to that provider, never to VibeOK.

## Apps with login

When VibeOK reaches a login or signup form, it stops and asks you what to do:

```
  🔐 Found a login form on /login. How should VibeOK get in?
     1) Use my test account (I'll type the email and password)
     2) Let me log in myself in the browser (Google, magic link, 2FA all work)
     3) Skip pages behind login
  Choose 1-3 [1]: 1
  Test account email: demo@myapp.dev
  Password (hidden): ••••••••
  Remember this login for next runs? (saved in .vibeok/, never committed) [Y/n]: y
```

For a signup form it offers to create a demo account with test details (`vibeok.test+…@example.com`), use details you type, or not submit it.

- **The AI model never sees your password.** It types placeholders (`{{login.password}}`), and VibeOK fills in the real value in the browser.
- **Passwords are never saved.** Only the logged-in session is kept, in `.vibeok/session.json`, which is git-ignored automatically. `npx vibeok logout` forgets it.
- **Log in ahead of time** (handy for Google sign-in): `npx vibeok login localhost:3000`.
- **In CI**, set `VIBEOK_EMAIL` and `VIBEOK_PASSWORD` for a test account.
- **Use a test account, not your real one.** VibeOK clicks real buttons.

## Use it from Claude Code, Cursor or Codex (MCP)

**Claude Code**:

```bash
claude mcp add vibeok -- npx -y vibeok mcp
```

**Cursor**: add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "vibeok": { "command": "npx", "args": ["-y", "vibeok", "mcp"] }
  }
}
```

**Codex**: add to `~/.codex/config.toml`:

```toml
[mcp_servers.vibeok]
command = "npx"
args = ["-y", "vibeok", "mcp"]
```

Then just ask your agent:

> *"Test the signup → create project flow with vibeok and fix anything broken."*

| Tool | What the agent gets | Key needed? |
| --- | --- | --- |
| `vibeok_check` | Every page and button checked; a short report with fixes | No |
| `vibeok_open_app` → `vibeok_act` → `vibeok_finish` | **Your agent drives the journey itself**, one step at a time. Each step's result lists server errors, crashes and dead clicks, so the agent sees bugs without reading logs. A passed journey is saved for replays. | No: your agent is the model |
| `vibeok_journey` | VibeOK drives the whole journey with its own model and returns pass/fail plus every step | Yes: add the key to the server's `env` |

To let VibeOK drive journeys from your agent, add your key to the MCP config, e.g. in Cursor: `"env": { "ANTHROPIC_API_KEY": "sk-ant-…" }`.

## What it finds

| Problem | Example |
| --- | --- |
| Journeys that break | `Journey failed: the new project disappeared after a reload` |
| Dead buttons | `"Export CSV" button does nothing` |
| Silent failures | `Form says success but POST /api/signup returned 500` |
| Server errors | `POST /api/projects crashes with 500`, with the response body |
| Missing routes | `POST /api/checkout not found (404)` |
| Crashes | `Uncaught error: TypeError: Cannot read properties of undefined` |
| Placeholders | `"Invite team" is a placeholder ("Coming soon")` |
| Broken links | `/about returns 404` |
| Phone layout | `div.pricing-row is 1100px wide` on a 375px screen |

## Safety

- **Local by default.** It tests `localhost` and your local network. Any other URL needs you to confirm you own the app (or `--yes-i-own-this`). Only test apps you own or have permission to test.
- **Never clicks risky buttons** (delete, remove, log out, cancel subscription, pay, buy, checkout) unless your journey asks for that action.
- **Forms only on local apps** unless you add `--forms`. Use a dev or test database: VibeOK creates records the way a real user would.

## Options

```
npx vibeok [url] ["journey"] [options]

  --explore              let the AI find and test your main features
  --max-steps <n>        max steps for a journey (default 30, explore 60)
  -p, --pages <n>        max pages to visit when checking everything (default 5)
  --max-clicks <n>       max elements to click per page (default 25)
  --headless / --headed  hide or show the browser window
  --no-cursor            don't draw the VibeOK cursor
  --forms / --no-forms   submit forms or not (default: on for local apps)
  --no-mobile            skip the phone-size layout check
  --no-save              don't save a passed journey
  -o, --out <file>       where to write the fix prompt (default VIBEOK_FIX_PROMPT.md)
  --ai                   write the fix prompt with your model
  --json                 print the full result as JSON
  --fail-under <score>   exit with code 1 below this score (for CI)
  --no-ask               never stop to ask (CI)
  --yes-i-own-this       confirm you own a non-local app

npx vibeok replay [name] [--url <url>]   re-run saved journeys, no AI
npx vibeok journeys                      list saved journeys
npx vibeok login [url]                   log in yourself once and save the session
npx vibeok logout                        forget the saved login
npx vibeok mcp                           start the MCP server
```

A failed journey or replay exits with code 1, so it can block a deploy.

### In CI

```yaml
- run: npm run build && (npm start &) && npx wait-on http://localhost:3000
- run: npx vibeok replay --headless          # your saved journeys, no AI, no key
  env:
    VIBEOK_EMAIL: ${{ secrets.TEST_EMAIL }}
    VIBEOK_PASSWORD: ${{ secrets.TEST_PASSWORD }}
- run: npx vibeok --headless --fail-under 80 # every page and button
```

### From code

```ts
import { scan, runJourney, makeChat, detectModel, DEFAULTS } from "vibeok";

const result = await scan({ ...DEFAULTS, url: "http://localhost:3000", headless: true, cursor: false });

const journey = await runJourney({
  url: "http://localhost:3000",
  goal: "sign up and create a project",
  chat: makeChat(detectModel()!),
  maxSteps: 30, headless: true, cursor: false,
});
console.log(journey.journey?.passed, journey.findings);
```

## Roadmap

- [ ] Double-submit check: does clicking submit twice create two records?
- [ ] Exposed secret keys in the JavaScript your app ships
- [ ] Video replay of a run
- [ ] `npx vibeok replay --cloud`: run your saved journeys every few minutes on your live app

Ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Keep it checked after you ship

The CLI tests your app when you run it. **[VibeOK Cloud](https://tryvibeok.site/?utm_source=github)** runs your critical journeys (signup, login, checkout) on your live app every few minutes and alerts you the moment one breaks.

## License

MIT © Muhammad Safeer Baig
