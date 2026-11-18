import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { describeModel, detectModel, makeChat } from "./ai.js";
import { defaultHeadless } from "./browser.js";
import { openBrowserSession, type BrowserSession } from "./browser-session.js";
import { runJourney, saveJourney } from "./journey.js";
import { isLocalUrl, normalizeUrl } from "./local.js";
import { markdownReport } from "./report.js";
import { Runner, type Action, type SavedStep } from "./runner.js";
import { DEFAULTS, errorFindings, mergeAcrossPages, networkFindings, scan, sortFindings } from "./scan.js";
import { scoreFindings } from "./score.js";
import { DEFAULT_SESSION_PATH } from "./session.js";
import type { Finding } from "./types.js";
import { VERSION } from "./version.js";

/**
 * MCP server over stdio. stdout carries JSON-RPC only: nothing here may write to stdout.
 *
 * Three ways for an agent to use VibeOK:
 *  1. vibeok_check: test every page and button (no key).
 *  2. vibeok_open_app → vibeok_act → vibeok_finish: the agent drives a journey itself, step by step (no key).
 *  3. vibeok_journey: VibeOK drives the whole journey with its own model (needs a key in the MCP config).
 */

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
const sessionPath = () => process.env.VIBEOK_SESSION || DEFAULT_SESSION_PATH;

const TOKENS_HELP =
  "To log in, fill fields with the tokens {{login.email}} and {{login.password}} (VibeOK fills in the user's test account from their saved login or VIBEOK_EMAIL/VIBEOK_PASSWORD; never ask the user for a password in chat). " +
  "For a brand-new account use {{new.email}} and {{new.password}}. Make created names unique with {{run}}, e.g. \"Launch {{run}}\", and use the same text in expect.";

function guardTarget(url: string, confirmed?: boolean): string | { error: string } {
  let target: string;
  try {
    target = normalizeUrl(url);
  } catch {
    return { error: `Invalid URL: ${url}` };
  }
  if (!isLocalUrl(target) && !confirmed) {
    return {
      error: `${target} is not a local app. VibeOK clicks buttons and can submit forms, so ask the user to confirm they own this app (or have permission to test it), then call again with user_confirmed_ownership: true.`,
    };
  }
  return target;
}

// One agent-driven browser at a time.
let live: { s: BrowserSession; runner: Runner; goal?: string; url: string; steps: SavedStep[]; findings: Finding[]; timer?: NodeJS.Timeout } | null = null;
async function closeLive() {
  if (!live) return;
  clearTimeout(live.timer);
  await live.s.close();
  live = null;
}
function touch() {
  if (!live) return;
  clearTimeout(live.timer);
  live.timer = setTimeout(() => void closeLive(), 10 * 60_000);
  live.timer.unref();
}

export async function startMcpServer() {
  const server = new McpServer({ name: "vibeok", version: VERSION });
  const ownership = z.boolean().optional().describe("Required for non-local URLs: true only if the user said they own the app or may test it");
  const showBrowser = z.boolean().optional().describe("Open a visible browser with the VibeOK cursor (default true on desktops)");

  server.registerTool(
    "vibeok_check",
    {
      title: "Test every page and button",
      description:
        "Opens the app in a real browser, crawls up to `pages` pages, clicks every safe button, submits forms with test data, " +
        "checks the phone-size layout, and reports dead buttons, silent server errors, uncaught exceptions, console errors, " +
        "broken links and mobile overflow, each with a concrete fix. Use it after changing UI or API code, then fix the issues and " +
        "run it again. Pages behind login are tested only if the user has run `npx vibeok login` or set VIBEOK_EMAIL / VIBEOK_PASSWORD; " +
        "if the report says login pages were skipped, tell the user. Never ask for a password in chat.",
      inputSchema: {
        url: z.string().describe("App URL, e.g. http://localhost:3000"),
        pages: z.number().int().min(1).max(15).optional().describe("Max pages to visit (default 3)"),
        submit_forms: z.boolean().optional().describe("Fill and submit forms with test data (default true for local apps)"),
        show_browser: showBrowser,
        user_confirmed_ownership: ownership,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ url, pages, submit_forms, show_browser, user_confirmed_ownership }) => {
      const target = guardTarget(url, user_confirmed_ownership);
      if (typeof target !== "string") return text(target.error, true);
      const headless = show_browser === undefined ? defaultHeadless() : !show_browser;
      try {
        const result = await scan(
          { ...DEFAULTS, url: target, maxPages: pages ?? 3, headless, cursor: !headless, forms: submit_forms ?? isLocalUrl(target), sessionPath: sessionPath() },
          { step: (m) => process.stderr.write(`[vibeok] ${m}\n`), detail: () => {} },
        );
        return text(markdownReport(result));
      } catch (e) {
        return text(`VibeOK couldn't test ${target}: ${(e as Error).message}${/ECONNREFUSED|CONNECTION_REFUSED/.test((e as Error).message) ? " Is the dev server running?" : ""}`, true);
      }
    },
  );

  server.registerTool(
    "vibeok_journey",
    {
      title: "Test a user journey described in plain English (VibeOK drives)",
      description:
        "VibeOK uses the app like a real user to check a journey end to end, e.g. \"sign up, create a project called Launch, and check it's still on the dashboard after a reload\". " +
        "It returns pass/fail, every step, and any server errors, crashes or dead buttons along the way, with fixes. Passed journeys are saved for free replays (`npx vibeok replay`). " +
        "Needs a model key in this MCP server's env (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY or OLLAMA_HOST). If there isn't one, drive the journey yourself with vibeok_open_app, vibeok_act and vibeok_finish.",
      inputSchema: {
        url: z.string().describe("Where the journey starts, e.g. http://localhost:3000 or http://localhost:3000/signup"),
        journey: z.string().describe("What a user should be able to do, in plain English"),
        max_steps: z.number().int().min(3).max(80).optional().describe("Default 30"),
        show_browser: showBrowser,
        user_confirmed_ownership: ownership,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ url, journey, max_steps, show_browser, user_confirmed_ownership }) => {
      const target = guardTarget(url, user_confirmed_ownership);
      if (typeof target !== "string") return text(target.error, true);
      const model = detectModel();
      if (!model) {
        return text(
          "No model key is set for VibeOK, so it can't drive the journey itself. Drive it yourself instead: call vibeok_open_app, then vibeok_act for each step, then vibeok_finish. " +
            "(Or the user can add ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY to the vibeok MCP server's env.)",
          true,
        );
      }
      const headless = show_browser === undefined ? defaultHeadless() : !show_browser;
      try {
        const result = await runJourney({
          url: target, goal: journey, chat: makeChat(model), model: describeModel(model), maxSteps: max_steps ?? 30,
          headless, cursor: !headless, sessionPath: sessionPath(),
          onStep: (st) => process.stderr.write(`[vibeok] ${st.ok ? "✓" : "✗"} ${st.text}\n`),
        });
        return text(markdownReport(result));
      } catch (e) {
        return text(`VibeOK couldn't run the journey: ${(e as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    "vibeok_open_app",
    {
      title: "Open the app to test a journey step by step (you drive)",
      description:
        "Opens the app in a real browser and returns the page as a numbered list of elements, like [3] button \"Save\". Then call vibeok_act once per step " +
        "(click, fill, select, check, press, goto, reload, expect, expect_absent) and vibeok_finish at the end. Each vibeok_act result says what changed and lists " +
        "server errors, crashes or dead clicks, so you see bugs without reading logs. Verify outcomes with expect, and after creating something reload and expect " +
        "again (data that disappears after a reload was never saved). " + TOKENS_HELP,
      inputSchema: {
        url: z.string().describe("Where to start, e.g. http://localhost:3000/login"),
        journey: z.string().optional().describe("The journey you're about to test, in plain English. Needed to save it for free replays."),
        show_browser: showBrowser,
        user_confirmed_ownership: ownership,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ url, journey, show_browser, user_confirmed_ownership }) => {
      const target = guardTarget(url, user_confirmed_ownership);
      if (typeof target !== "string") return text(target.error, true);
      await closeLive();
      const headless = show_browser === undefined ? defaultHeadless() : !show_browser;
      try {
        const s = await openBrowserSession({ url: target, headless, cursor: !headless, sessionPath: sessionPath() });
        const runner = new Runner(s, { cursor: !headless, headless, goal: journey });
        live = { s, runner, goal: journey, url: target, steps: [], findings: [] };
        touch();
        const first = await runner.act({ action: "goto", value: new URL(target).pathname + new URL(target).search, say: "Ready. Waiting for your steps…" });
        if (first.saved) live.steps.push(first.saved);
        const snap = await runner.snapshot();
        return text(
          [
            `Opened ${target}.${s.hadSavedLogin ? " A saved login is loaded, so you may already be logged in." : ""}`,
            first.ok ? "" : `Note: ${first.summary}`,
            "",
            Runner.format(snap),
            "",
            "Next: call vibeok_act with an action and a ref number from this list.",
          ].filter(Boolean).join("\n"),
        );
      } catch (e) {
        await closeLive();
        return text(`Couldn't open ${target}: ${(e as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    "vibeok_act",
    {
      title: "Do one step in the open app",
      description:
        "Does one action in the app opened with vibeok_open_app and returns what happened (new text, navigation, and PROBLEMS like server errors or crashes) plus the updated numbered page. " +
        "Ref numbers change after every step: always use the newest list. " + TOKENS_HELP,
      inputSchema: {
        action: z.enum(["click", "fill", "select", "check", "uncheck", "press", "goto", "reload", "expect", "expect_absent", "wait"]),
        ref: z.number().int().optional().describe("Element number from the latest page list (click, fill, select, check, uncheck)"),
        value: z.string().optional().describe("fill: text; select: option label; press: Enter/Escape/Tab; goto: a path like /signup; expect: the text that must be visible; wait: ms"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ action, ref, value }) => {
      if (!live) return text("No app is open. Call vibeok_open_app first.", true);
      touch();
      const r = await live.runner.act({ action: action as Action["action"], ref, value });
      if (r.saved) live.steps.push(r.saved);
      if (r.deadClick) {
        live.findings.push({
          kind: "dead-button", severity: "medium", title: `"${r.deadClick.name}" button does nothing`, page: r.deadClick.path,
          evidence: ["No DOM change, network request or navigation after the click"],
          fix: `Wire the "${r.deadClick.name}" button on ${r.deadClick.path} to its action, or disable it until the feature exists.`,
        });
      }
      const snap = await live.runner.snapshot();
      return text([`${r.ok ? "OK" : "FAILED"}: ${r.summary}`, "", Runner.format(snap)].join("\n"), !r.ok && !r.failedExpect);
    },
  );

  server.registerTool(
    "vibeok_finish",
    {
      title: "Finish the step-by-step journey and get the report",
      description:
        "Closes the browser opened with vibeok_open_app and returns every issue VibeOK saw during the journey (server errors, crashes, console errors, dead buttons) with fixes. " +
        "Set passed=true only if every part of the journey worked and you verified it with expect; a passed journey is saved so the user can replay it free with `npx vibeok replay`.",
      inputSchema: {
        passed: z.boolean().describe("Did the whole journey work?"),
        summary: z.string().describe("One sentence: what worked, or exactly what broke"),
      },
    },
    async ({ passed, summary }) => {
      if (!live) return text("No app is open.", true);
      const l = live;
      await l.s.collector.flush();
      const findings = sortFindings(mergeAcrossPages([...l.findings, ...networkFindings(l.s.collector.net), ...errorFindings(l.s.collector)]));
      let savedAs: string | undefined;
      if (passed && l.goal && l.steps.length > 1) {
        savedAs = saveJourney({
          version: 1,
          name: l.goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").split("-").filter(Boolean).slice(0, 6).join("-") || "journey",
          goal: l.goal,
          startPath: new URL(l.url).pathname,
          createdAt: new Date().toISOString(),
          model: "mcp-agent",
          steps: l.steps,
        });
      }
      await closeLive();
      const { score, grade } = scoreFindings(findings);
      return text(
        markdownReport({
          url: l.url, startedAt: new Date().toISOString(), durationMs: 0, pagesVisited: [], elementsClicked: l.steps.length, skipped: [],
          findings, notes: [], loggedIn: false, score, grade,
          journey: { goal: l.goal ?? "(not given)", passed, verdict: summary, steps: [], mode: "ai", savedAs },
        }),
      );
    },
  );

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[vibeok] MCP server v${VERSION} ready\n`);
}
