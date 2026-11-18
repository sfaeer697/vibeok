import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import pc from "picocolors";
import { aiFixPrompt, describeModel, detectModel, makeChat, modelFromKey, type ModelConfig } from "./ai.js";
import { defaultHeadless, launchBrowser } from "./browser.js";
import { EXPLORE_GOAL, listJourneys, replayJourney, runJourney } from "./journey.js";
import { isLocalUrl, normalizeUrl, splitTargets as split } from "./local.js";
import { askHidden, terminalPrompter } from "./prompt.js";
import { fixPrompt, printStep, terminalReport } from "./report.js";
import { DEFAULTS, scan } from "./scan.js";
import { DEFAULT_SESSION_PATH, deleteSession, loadSession, saveSession } from "./session.js";
import type { Logger, ScanResult } from "./types.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("vibeok")
  .description(
    "Test your web app like a real user. Run it alone to check every page and button, or describe a journey in plain English.",
  )
  .version(VERSION)
  .argument("[target...]", 'your app (default localhost:3000) and/or a journey in quotes, e.g. "sign up and create a project"')
  .option("--explore", "let the AI find and test your app's main features by itself (needs a model)")
  .option("-p, --pages <n>", "max pages to visit", String(DEFAULTS.maxPages))
  .option("--max-clicks <n>", "max elements to click per page", String(DEFAULTS.maxClicksPerPage))
  .option("--max-steps <n>", "max steps for a journey", "30")
  .option("--wait <ms>", "how long to wait for a reaction after each click", String(DEFAULTS.waitMs))
  .option("--headless", "run without a visible browser window")
  .option("--headed", "always show the browser window")
  .option("--no-cursor", "don't draw the VibeOK cursor and HUD")
  .addOption(new Option("--forms", "fill and submit forms (default: on for local apps, off for live sites)"))
  .option("--no-forms", "never submit forms")
  .option("--no-mobile", "skip the phone-size layout check")
  .option("--no-save", "don't save a passed journey for replays")
  .option("-o, --out <file>", "where to write the fix prompt", "VIBEOK_FIX_PROMPT.md")
  .option("--ai", "write the fix prompt with your model")
  .option("--json", "print the full result as JSON")
  .option("--fail-under <score>", "exit with code 1 if the score is below this (for CI)")
  .option("--yes-i-own-this", "confirm you own (or may test) a non-local app; VibeOK clicks its buttons")
  .option("--session <file>", "where your saved login is kept", DEFAULT_SESSION_PATH)
  .option("--no-session", "don't use or save a login")
  .option("--no-ask", "never stop to ask questions (uses VIBEOK_EMAIL / VIBEOK_PASSWORD if set)")
  .action(async (targets: string[], o) => {
    let parsed: { url: string; goal?: string };
    try {
      parsed = split(targets);
    } catch {
      fail(`"${targets.join(" ")}" doesn't look like a URL or a journey.`);
    }
    const { url, goal } = parsed;
    const local = await checkTarget(url, o);
    const quiet = Boolean(o.json);
    const interactive = Boolean(process.stdin.isTTY) && !quiet && o.ask !== false;
    const headless = o.headed ? false : o.headless ? true : defaultHeadless();
    const sessionPath = o.session === false ? undefined : (o.session as string);
    const auth = interactive ? terminalPrompter({ canSave: Boolean(sessionPath) }) : undefined;

    if (!quiet) {
      process.stderr.write(`\n  ${pc.bold("VibeOK")} ${pc.dim(`v${VERSION}`)} testing ${pc.bold(url)}${headless ? pc.dim(" (headless)") : ""}\n`);
      if (sessionPath && loadSession(sessionPath, new URL(url).origin)) {
        process.stderr.write(pc.dim(`    Using your saved login (${sessionPath}). Run "npx vibeok logout" to forget it.\n`));
      }
    }

    // ── Journey mode: plain English, or --explore ──────────────────────────────
    if (goal || o.explore) {
      const model = await getModel(interactive);
      const g = goal ?? EXPLORE_GOAL;
      if (!quiet) {
        process.stderr.write(`\n  ${pc.bold(o.explore && !goal ? "🧭 Exploring your app" : "🧭 Journey")}${goal ? `: ${goal}` : ""}\n`);
        process.stderr.write(
          pc.dim(`     Model: ${describeModel(model)} ${model.provider === "ollama" ? "(runs on your machine)" : `(your key, sent only to ${model.provider})`}\n\n`),
        );
      }
      const result = await guard(url, () =>
        runJourney({
          url, goal: g, chat: makeChat(model), model: describeModel(model),
          maxSteps: int(o.maxSteps, o.explore && !goal ? 60 : 30),
          headless, cursor: o.cursor !== false && !headless, auth, sessionPath,
          explore: Boolean(o.explore && !goal), save: o.save !== false,
          onStep: quiet ? undefined : (s, say) => printStep(s, say),
        }),
      );
      await finish(result, o, url, model);
      if (!result.journey?.passed) process.exitCode = 1;
      return;
    }

    // ── Scan mode: every page and button ──────────────────────────────────────
    const formsFlag = process.argv.includes("--forms") ? true : process.argv.includes("--no-forms") ? false : local;
    if (!quiet && !formsFlag) process.stderr.write(pc.dim(`    Forms won't be submitted${local ? "" : " on a live site (add --forms to allow)"}.\n`));
    const log: Logger = {
      step: (m) => !quiet && process.stderr.write(`  ${pc.green("›")} ${m}\n`),
      detail: (m) => !quiet && process.stderr.write(`    ${pc.dim(m)}\n`),
    };
    const result = await guard(url, () =>
      scan(
        {
          url,
          maxPages: int(o.pages, DEFAULTS.maxPages),
          maxClicksPerPage: int(o.maxClicks, DEFAULTS.maxClicksPerPage),
          waitMs: int(o.wait, DEFAULTS.waitMs),
          headless,
          cursor: o.cursor !== false && !headless,
          forms: formsFlag,
          mobile: o.mobile !== false,
          sessionPath,
          auth,
        },
        log,
      ),
    );
    await finish(result, o, url, o.ai ? detectModel() ?? undefined : undefined);
    if (!quiet) {
      const saved = listJourneys();
      process.stderr.write(
        saved.length
          ? pc.dim(`  You have ${saved.length} saved journey${saved.length > 1 ? "s" : ""}. Replay free: npx vibeok replay\n\n`)
          : pc.dim(`  Next: test a whole flow in plain English, e.g. npx vibeok "sign up and create a project"\n\n`),
      );
    }
    const failUnder = o.failUnder ? Number(o.failUnder) : undefined;
    if (failUnder !== undefined && result.score < failUnder) process.exitCode = 1;
  });

program
  .command("replay")
  .description("re-run your saved journeys without AI: fast and free (re-learns with AI if the page changed)")
  .argument("[name]", "a saved journey (default: all of them)")
  .option("-u, --url <url>", "your app", "localhost:3000")
  .option("--headless", "run without a visible browser window")
  .option("--headed", "always show the browser window")
  .option("--session <file>", "your saved login", DEFAULT_SESSION_PATH)
  .option("--json", "print results as JSON")
  .action(async (name: string | undefined, o) => {
    const url = normalizeUrl(o.url);
    await checkTarget(url, o);
    const all = listJourneys();
    const picked = name ? all.filter((x) => x.journey.name === name || x.journey.name.startsWith(name)) : all;
    if (!picked.length) {
      fail(
        all.length
          ? `No saved journey called "${name}". Saved: ${all.map((x) => x.journey.name).join(", ")}`
          : 'No saved journeys yet. Run one first, e.g. npx vibeok "sign up and create a project". Passed journeys are saved automatically.',
      );
    }
    const headless = o.headed ? false : o.headless ? true : defaultHeadless();
    const interactive = Boolean(process.stdin.isTTY) && !o.json;
    const model = detectModel();
    const results: ScanResult[] = [];
    for (const { journey } of picked) {
      if (!o.json) process.stderr.write(`\n  ${pc.bold("↻ Replaying")} ${journey.name} ${pc.dim(`(${journey.steps.length} steps, no AI)`)}\n`);
      const r = await guard(url, () =>
        replayJourney(journey, {
          url, headless, cursor: !headless, sessionPath: o.session,
          auth: interactive ? terminalPrompter({ canSave: true }) : undefined,
          chat: model ? makeChat(model) : undefined, model: model ? describeModel(model) : undefined,
          onStep: o.json ? undefined : (s) => printStep(s),
        }),
      );
      results.push(r);
      if (!o.json) {
        const j = r.journey!;
        process.stderr.write(j.passed ? `  ${pc.green("✔ Passed")} ${pc.dim(j.verdict)}\n` : `  ${pc.red("✖ Failed")} ${j.verdict}\n`);
      }
    }
    if (o.json) process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    const failed = results.filter((r) => !r.journey?.passed).length;
    if (!o.json) {
      const total = results.length === 1 ? "The journey" : `All ${results.length} journeys`;
      process.stderr.write(`\n  ${failed ? pc.red(`${failed} of ${results.length} journey${results.length > 1 ? "s" : ""} failed`) : pc.green(`${total} passed`)}\n`);
      process.stderr.write(pc.dim(`  Run these every 15 minutes on your live app → https://tryvibeok.site/?utm_source=vibeok-cli\n\n`));
      const worst = results.find((r) => !r.journey?.passed);
      if (worst) {
        writeFileSync(resolve("VIBEOK_FIX_PROMPT.md"), fixPrompt(worst));
        process.stderr.write(`  ${pc.green("✔")} Fix prompt written to ${pc.bold("VIBEOK_FIX_PROMPT.md")}\n\n`);
      }
    }
    if (failed) process.exitCode = 1;
  });

program
  .command("journeys")
  .description("list your saved journeys")
  .action(() => {
    const all = listJourneys();
    if (!all.length) {
      process.stderr.write(`  No saved journeys yet. Try: npx vibeok "sign up and create a project"\n`);
      return;
    }
    for (const { file, journey } of all) {
      process.stderr.write(`  ${pc.bold(journey.name)} ${pc.dim(`· ${journey.steps.length} steps · ${file}`)}\n    ${journey.goal}\n`);
    }
  });

program
  .command("login")
  .description("open a browser, log in to your app yourself, and save the session so VibeOK can test pages behind login")
  .argument("[url]", "your app, e.g. localhost:3000")
  .option("--session <file>", "where to save the login", DEFAULT_SESSION_PATH)
  .action(async (rawUrl: string | undefined, o: { session: string }) => {
    const url = normalizeUrl(rawUrl);
    if (defaultHeadless()) fail("vibeok login needs a screen to show the browser. Use VIBEOK_EMAIL / VIBEOK_PASSWORD in CI instead.");
    const browser = await launchBrowser(false);
    try {
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();
      await page.goto(url).catch(() => fail(`Nothing is running at ${url}. Start your dev server first.`));
      process.stderr.write(
        `\n  ${pc.bold("🔐 Log in to your app")} in the browser window that just opened.\n` +
          pc.dim("     Use a test account, not your real one: VibeOK will click buttons while logged in.\n") +
          pc.dim("     Google sign-in, magic links and 2FA all work.\n\n"),
      );
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      await rl.question(`  Press ${pc.bold("Enter")} here when you're logged in… `);
      rl.close();
      await saveSession(context, o.session, new URL(url).origin);
      process.stderr.write(`\n  ${pc.green("✔")} Login saved to ${pc.bold(o.session)} (git-ignored). Now run ${pc.bold("npx vibeok " + (rawUrl ?? ""))}\n\n`);
    } finally {
      await browser.close().catch(() => {});
    }
  });

program
  .command("logout")
  .description("forget the saved login")
  .option("--session <file>", "the saved login file", DEFAULT_SESSION_PATH)
  .action((o: { session: string }) => {
    const removed = deleteSession(o.session);
    process.stderr.write(removed ? `  ${pc.green("✔")} Saved login removed.\n` : `  No saved login at ${o.session}.\n`);
  });

program
  .command("mcp")
  .description("start the MCP server (stdio) for Claude Code, Cursor, Codex, Windsurf and other MCP clients")
  .action(async () => {
    const { startMcpServer } = await import("./mcp.js");
    await startMcpServer();
  });

// ── helpers ───────────────────────────────────────────────────────────────────

async function checkTarget(url: string, o: { yesIOwnThis?: boolean }): Promise<boolean> {
  const local = isLocalUrl(url);
  if (!local && !o.yesIOwnThis) {
    if (!process.stdin.isTTY) {
      fail(`${url} isn't a local app. VibeOK clicks buttons, so re-run with --yes-i-own-this if you own it or have permission to test it.`);
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const a = await rl.question(
      `\n  ${pc.yellow("!")} ${url} isn't on your machine. VibeOK will click its buttons like a real user.\n    Do you own this app or have permission to test it? (y/N) `,
    );
    rl.close();
    if (!/^y(es)?$/i.test(a.trim())) fail("Stopped. VibeOK only tests apps you own or have permission to test.");
  }
  return local;
}

/** The user's model: from the environment, or a key pasted for this run only. */
async function getModel(interactive: boolean): Promise<ModelConfig> {
  const found = detectModel();
  if (found) return found;
  const help =
    "Journeys need an AI model to read your pages and decide each step. Use any of these:\n" +
    `     ${pc.bold("ANTHROPIC_API_KEY")}, ${pc.bold("OPENAI_API_KEY")} or ${pc.bold("GEMINI_API_KEY")} (Gemini has a free tier)\n` +
    `     ${pc.bold("OLLAMA_HOST=http://localhost:11434")} for a free local model\n` +
    `     Or skip the key: run VibeOK inside Claude Code, Cursor or Codex (npx vibeok mcp) and your agent drives.`;
  if (!interactive) fail(help);
  process.stderr.write(`\n  ${pc.yellow("🔑")} ${help}\n\n`);
  const key = await askHidden(`  Paste an API key to use for this run only ${pc.dim("(not saved; Enter to cancel)")}: `);
  if (!key.trim()) fail("No model, no journey. Set one of the keys above and run again.");
  const m = modelFromKey(key);
  if (!m) fail("That doesn't look like an Anthropic (sk-ant-…), OpenAI (sk-…) or Gemini (AIza…) key.");
  return m;
}

async function guard<T>(url: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = (e as Error).message;
    if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(msg)) fail(`Nothing is running at ${url}. Start your dev server first (e.g. npm run dev), then run this again.`);
    fail(msg);
  }
}

async function finish(result: ScanResult, o: { json?: boolean; out: string; ai?: boolean }, url: string, model?: ModelConfig) {
  let promptPath: string | undefined;
  if (result.findings.length) {
    let prompt = fixPrompt(result);
    if (o.ai && model) {
      try {
        const text = await aiFixPrompt(result, model);
        if (text.trim()) prompt = text.trim() + "\n";
      } catch (e) {
        process.stderr.write(pc.yellow(`  AI fix prompt failed, using the built-in one: ${(e as Error).message}\n`));
      }
    } else if (o.ai) {
      process.stderr.write(pc.yellow("  --ai: no model found (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY or OLLAMA_HOST). Using the built-in fix prompt.\n"));
    }
    promptPath = o.out;
    writeFileSync(resolve(promptPath), prompt);
  }
  if (o.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else process.stdout.write(terminalReport(result, promptPath));
}

function int(v: string, d: number) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

function fail(msg: string): never {
  process.stderr.write(`\n  ${pc.red("✖")} ${msg}\n\n`);
  process.exit(2);
}

program.parseAsync().catch((e) => fail((e as Error).message));
