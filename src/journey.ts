import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChatFn } from "./ai.js";
import { openBrowserSession, type BrowserSession } from "./browser-session.js";
import { Runner, type Action, type ActResult, type SavedStep } from "./runner.js";
import { errorFindings, mergeAcrossPages, networkFindings, sortFindings } from "./scan.js";
import { saveSession } from "./session.js";
import { scoreFindings } from "./score.js";
import type { AuthPrompter, Finding, JourneyStepResult, JourneySummary, ScanResult } from "./types.js";

export const JOURNEY_DIR = ".vibeok/journeys";

export const EXPLORE_GOAL =
  "Explore this app like a curious new user. Find its main features from the navigation and pages. Try each important feature once: " +
  "sign up or log in if that's needed to reach them, create something, edit it if possible, and check it's still there after a reload. " +
  "Look for anything broken. Finish with a summary of what works and what's broken.";

export interface JourneyOptions {
  url: string;
  goal: string;
  chat?: ChatFn;
  model?: string;
  maxSteps: number;
  headless: boolean;
  cursor: boolean;
  auth?: AuthPrompter;
  sessionPath?: string;
  explore?: boolean;
  /** Save a passed journey for free replays (default true for normal journeys). */
  save?: boolean;
  /** Called after each step, for live terminal output. */
  onStep?: (s: JourneyStepResult, say?: string) => void;
}

export interface SavedJourney {
  version: 1;
  name: string;
  goal: string;
  startPath: string;
  createdAt: string;
  model?: string;
  steps: SavedStep[];
}

const SYSTEM = `You are VibeOK, a careful QA tester. You test a web app by using it like a real person, one action at a time, to check that a user journey works end to end.

Each turn you get the journey, what you've done so far with results, and the current page, where elements are numbered like [3] button "Save". Reply with ONE JSON object and nothing else:
{"say": "<what you're doing, max 10 words, shown to the person watching>", "action": "<action>", "ref": <number>, "value": "<text>"}

Actions:
- click {ref}
- fill {ref, value}: replaces the field's text
- select {ref, value}: the option's label
- check / uncheck {ref}
- press {value}: Enter, Escape or Tab
- goto {value}: a path on this app, like "/signup"
- reload: reload the page (to check data was really saved)
- expect {value}: check this text is visible on the page
- expect_absent {value}: check this text is NOT visible
- wait {value}: milliseconds, max 3000, only while something is still loading
- done {"passed": true|false, "summary": "<one sentence: what worked, or exactly what broke and where>"}

Rules:
- Use ref numbers from the CURRENT page only. Numbers change after every step.
- Logging in to an existing account: email {{login.email}}, password {{login.password}}. Creating a new account: email {{new.email}}, password {{new.password}}. Type these tokens exactly; VibeOK fills in the real values. Never make up credentials.
- When you create something, make its name unique by ending it with {{run}}, e.g. "Launch {{run}}", and use the same text in expect.
- Verify each part of the journey with expect. After creating or saving something, reload and expect it again: data that disappears after a reload was never saved.
- If a result shows PROBLEMS (a server error, a crash) or NOTHING HAPPENED, or the page shows an error message, that part is broken: try once more, then finish with passed=false and say exactly what broke.
- Don't click delete, remove, log out, pay or buy unless the journey asks for it.
- If you're stuck, or something the journey needs isn't in the app, finish with passed=false and explain.
- passed=true only when every part of the journey worked and you verified it with expect.`;

function parseAction(text: string): Action | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1));
    if (!o || typeof o.action !== "string") return null;
    const a: Action = { action: String(o.action).toLowerCase().trim() as Action["action"] };
    if (o.ref !== undefined && o.ref !== null && o.ref !== "") a.ref = Number(String(o.ref).replace(/[^\d]/g, ""));
    if (o.value !== undefined && o.value !== null) a.value = String(o.value);
    if (o.say) a.say = String(o.say).slice(0, 90);
    if (a.action === "done") {
      a.passed = o.passed === true || o.passed === "true";
      a.summary = String(o.summary ?? "").slice(0, 400);
    }
    return a;
  } catch {
    return null;
  }
}

function slugify(goal: string) {
  return (
    goal
      .toLowerCase()
      .replace(/\{\{[^}]+\}\}/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .split("-")
      .filter(Boolean)
      .slice(0, 6)
      .join("-") || "journey"
  );
}

/** Runs a plain-English journey with the user's model. */
export async function runJourney(opts: JourneyOptions): Promise<ScanResult> {
  if (!opts.chat) throw new Error("Journeys need an AI model (your own key or Ollama).");
  const started = Date.now();
  const s = await openBrowserSession({ url: opts.url, headless: opts.headless, cursor: opts.cursor, sessionPath: opts.sessionPath });
  const runner = new Runner(s, { cursor: opts.cursor, headless: opts.headless, goal: opts.goal, auth: opts.auth });
  const steps: JourneyStepResult[] = [];
  const savedSteps: SavedStep[] = [];
  const history: string[] = [];
  const findings: Finding[] = [];
  const notes: string[] = [];
  let verdict = "";
  let passed = false;
  let expectsPassed = 0;
  let nudgedToVerify = false;

  try {
    const startPath = new URL(opts.url).pathname + new URL(opts.url).search;
    const first = await runner.act({ action: "goto", value: startPath, say: opts.explore ? "Exploring your app…" : "Starting the journey…" });
    record(first, { action: "goto", value: startPath });
    if (!first.ok && /returned (5|4)\d\d/.test(first.summary) && first.problems.some((p) => / → 404/.test(p))) {
      verdict = `The start page ${startPath} returns 404.`;
    }

    let consecutiveFails = 0;
    let repeats = 0;
    let lastSig = "";
    for (let step = 1; step <= opts.maxSteps && !verdict; step++) {
      const snap = await runner.snapshot();
      const nudges: string[] = [];
      if (repeats >= 2) nudges.push("You are repeating the same action with the same result. Try something different, or finish with done.");
      if (step === opts.maxSteps) nudges.push("This is your LAST step: reply with done.");
      const user = [
        `JOURNEY: ${opts.goal}`,
        s.hadSavedLogin ? "A saved login is loaded, so you may already be logged in." : "",
        runner.manualLoginDone ? "The user logged in by hand; you are logged in." : "",
        "DONE SO FAR:",
        history.length ? history.slice(-30).join("\n") : "Nothing yet.",
        nudges.length ? `NOTE: ${nudges.join(" ")}` : "",
        "",
        Runner.format(snap),
        "",
        `Step ${step} of ${opts.maxSteps}. Reply with one JSON object.`,
      ]
        .filter((l) => l !== "")
        .join("\n");

      let action: Action | null = null;
      let reply = "";
      for (let attempt = 0; attempt < 2 && !action; attempt++) {
        reply = await opts.chat(SYSTEM, attempt ? `${user}\n\nYour last reply was not a valid JSON object. Reply with ONLY the JSON object.` : user);
        action = parseAction(reply);
      }
      if (!action) {
        verdict = "The AI model didn't reply with a valid action. Try a stronger model (VIBEOK_MODEL).";
        notes.push(`Model reply that couldn't be read: ${reply.slice(0, 200)}`);
        break;
      }

      if (action.action === "done") {
        if (action.passed && expectsPassed === 0 && !nudgedToVerify) {
          nudgedToVerify = true;
          history.push(`${step}. done → REJECTED: you haven't verified anything with expect yet. Check the result first.`);
          continue;
        }
        passed = Boolean(action.passed);
        verdict = action.summary || (passed ? "The journey worked." : "The journey didn't work.");
        if (action.say) await runner.say(action.say);
        break;
      }

      const r = await runner.act(action);
      record(r, action);
      if (r.saved?.action === "EXPECT" || r.saved?.action === "EXPECT_ABSENT") expectsPassed++;
      history.push(`${step}. ${action.action}${action.ref ? ` [${action.ref}]` : ""}${action.value !== undefined ? ` "${action.value}"` : ""} → ${r.ok ? "" : "FAILED: "}${r.summary}`);

      const sig = `${action.action}|${action.ref}|${action.value}|${r.summary}`;
      repeats = sig === lastSig ? repeats + 1 : 0;
      lastSig = sig;
      consecutiveFails = r.ok ? 0 : consecutiveFails + 1;
      if (repeats >= 5 || consecutiveFails >= 6) {
        verdict = `Got stuck at "${r.display}": ${r.summary}`;
        break;
      }
    }
    if (!verdict) verdict = `Ran out of steps (${opts.maxSteps}) before finishing. Try a shorter journey, or raise --max-steps.`;

    if (runner.saveLogin && opts.sessionPath) await saveSession(s.context, opts.sessionPath, s.origin).catch(() => {});
    await s.collector.flush();
    findings.push(...networkFindings(s.collector.net), ...errorFindings(s.collector));
  } finally {
    await s.close();
  }

  if (!passed) {
    const last = steps.filter((x) => !x.ok).slice(-1)[0];
    findings.push({
      kind: "journey-failed",
      severity: "high",
      title: `Journey failed: ${verdict.slice(0, 120)}`,
      page: "",
      action: last ? last.text : undefined,
      evidence: steps.slice(-5).map((x) => `${x.ok ? "✓" : "✗"} ${x.text}${x.detail ? ` (${x.detail.slice(0, 140)})` : ""}`),
      fix:
        `The user journey "${opts.goal}" doesn't work: ${verdict} ` +
        `Walk through these steps in the app, find where it breaks (see the evidence and any server errors in this report), fix the root cause, and make sure the result is saved and shown after a reload.`,
    });
  }

  let savedAs: string | undefined;
  if (passed && opts.save !== false && !opts.explore && savedSteps.length) {
    savedAs = saveJourney({
      version: 1,
      name: slugify(opts.goal),
      goal: opts.goal,
      startPath: new URL(opts.url).pathname,
      createdAt: new Date().toISOString(),
      model: opts.model,
      steps: savedSteps,
    });
  }

  const journey: JourneySummary = { goal: opts.goal, passed, verdict, steps, mode: opts.explore ? "explore" : "ai", model: opts.model, savedAs };
  return toResult(opts.url, started, journey, findings, notes);

  function record(r: ActResult, a: Action) {
    const st: JourneyStepResult = { n: steps.length + 1, text: r.display || a.action, ok: r.ok, detail: r.ok ? undefined : r.summary };
    if (r.ok && r.problems.length) st.detail = r.problems.join("; ");
    steps.push(st);
    if (r.saved) savedSteps.push(r.saved);
    if (r.deadClick) {
      findings.push({
        kind: "dead-button", severity: "medium", title: `"${r.deadClick.name}" button does nothing`, page: r.deadClick.path,
        action: `clicking "${r.deadClick.name}" during the journey`,
        evidence: ["No DOM change, network request or navigation after the click"],
        fix: `The "${r.deadClick.name}" button on ${r.deadClick.path} has no working click handler. Wire it to its action, or disable it until the feature exists.`,
      });
    }
    opts.onStep?.(st, a.say);
  }
}

export function saveJourney(j: SavedJourney): string {
  const dir = resolve(JOURNEY_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${j.name}.json`);
  writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
  return join(JOURNEY_DIR, `${j.name}.json`);
}

export function listJourneys(): { file: string; journey: SavedJourney }[] {
  const dir = resolve(JOURNEY_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return { file: join(JOURNEY_DIR, f), journey: JSON.parse(readFileSync(join(dir, f), "utf8")) as SavedJourney };
      } catch {
        return null;
      }
    })
    .filter((x): x is { file: string; journey: SavedJourney } => Boolean(x));
}

/**
 * Replays a saved journey without any AI: fast, free and repeatable. Elements are found by
 * role + visible name, so small layout changes don't break it. If a step can't be found
 * and a model is available, the journey is re-run with AI and the saved steps updated.
 */
export async function replayJourney(
  j: SavedJourney,
  opts: Omit<JourneyOptions, "goal" | "maxSteps"> & { maxSteps?: number },
): Promise<ScanResult> {
  const started = Date.now();
  const origin = new URL(opts.url).origin;
  const s: BrowserSession = await openBrowserSession({ url: origin + j.startPath, headless: opts.headless, cursor: opts.cursor, sessionPath: opts.sessionPath });
  const runner = new Runner(s, { cursor: opts.cursor, headless: opts.headless, goal: j.goal, auth: opts.auth });
  const steps: JourneyStepResult[] = [];
  const findings: Finding[] = [];
  let passed = true;
  let verdict = "Every step passed.";
  let lost: string | null = null;

  try {
    for (const step of j.steps) {
      let a: Action;
      if (step.target) {
        const ref = await findRef(runner, step.target);
        if (ref === null) {
          lost = `couldn't find ${step.target.role} "${step.target.name}" on ${runner.path}`;
          steps.push({ n: steps.length + 1, text: `${step.action.toLowerCase()} "${step.target.name}"`, ok: false, detail: lost });
          opts.onStep?.(steps[steps.length - 1]);
          break;
        }
        a = { action: step.action.toLowerCase() as Action["action"], ref, value: step.value };
      } else {
        a = { action: step.action.toLowerCase() as Action["action"], value: step.value };
      }
      const r = await runner.act(a);
      const st: JourneyStepResult = { n: steps.length + 1, text: r.display, ok: r.ok, detail: r.ok ? (r.problems.join("; ") || undefined) : r.summary };
      steps.push(st);
      opts.onStep?.(st);
      if (!r.ok) {
        passed = false;
        verdict = `Step ${st.n} failed: ${r.summary}`;
        break;
      }
    }
    if (runner.saveLogin && opts.sessionPath) await saveSession(s.context, opts.sessionPath, s.origin).catch(() => {});
    await s.collector.flush();
    findings.push(...networkFindings(s.collector.net), ...errorFindings(s.collector));
  } finally {
    await s.close();
  }

  // The app changed and an element can't be found: re-learn the journey with AI, if we can.
  if (lost) {
    if (opts.chat) {
      opts.onStep?.({ n: steps.length + 1, text: `The page changed (${lost}). Re-learning the journey with AI…`, ok: true });
      const healed = await runJourney({ ...opts, goal: j.goal, maxSteps: opts.maxSteps ?? 30, save: true });
      if (healed.journey) healed.journey.verdict = (healed.journey.passed ? "Re-learned after the app changed: " : "") + healed.journey.verdict;
      return healed;
    }
    passed = false;
    verdict = `The app changed: ${lost}. Run the journey again with an AI key to update it: npx vibeok "${j.goal}"`;
  }

  if (!passed && !lost) {
    findings.push({
      kind: "journey-failed",
      severity: "high",
      title: `Saved journey "${j.name}" failed: ${verdict.slice(0, 110)}`,
      page: "",
      evidence: steps.slice(-5).map((x) => `${x.ok ? "✓" : "✗"} ${x.text}${x.detail ? ` (${x.detail.slice(0, 140)})` : ""}`),
      fix: `The journey "${j.goal}" used to pass and now fails: ${verdict} This is a regression: find what changed in this flow and fix it.`,
    });
  }
  const journey: JourneySummary = { goal: j.goal, passed: passed && !lost, verdict, steps, mode: "replay" };
  return toResult(origin + j.startPath, started, journey, findings, []);
}

async function findRef(runner: Runner, target: { role: string; name: string }): Promise<number | null> {
  const norm = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase();
  for (let i = 0; i < 3; i++) {
    const snap = await runner.snapshot();
    const same = snap.items.filter((it) => it.role === target.role);
    const exact = same.find((it) => norm(it.name) === norm(target.name));
    const loose = exact ?? same.find((it) => norm(it.name).includes(norm(target.name)) || norm(target.name).includes(norm(it.name)) && it.name.length > 2);
    if (loose) return loose.ref;
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

function toResult(url: string, started: number, journey: JourneySummary, findings: Finding[], notes: string[]): ScanResult {
  const merged = sortFindings(mergeAcrossPages(findings));
  const { score, grade } = scoreFindings(merged);
  return {
    url,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    pagesVisited: [],
    elementsClicked: journey.steps.length,
    skipped: [],
    findings: merged,
    notes,
    loggedIn: false,
    journey,
    score,
    grade,
  };
}
