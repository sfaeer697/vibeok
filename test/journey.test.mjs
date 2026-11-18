import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJourney, replayJourney, listJourneys, splitTargets } from "../dist/index.js";

const PORT = 3920;
const BASE = `http://localhost:${PORT}`;
const repo = process.cwd();
const work = mkdtempSync(join(tmpdir(), "vibeok-journey-"));
let server;

before(async () => {
  server = spawn(process.execPath, [join(repo, "examples/broken-vibe-app/server.mjs")], { env: { ...process.env, PORT: String(PORT) } });
  await once(server.stdout, "data");
  process.chdir(work); // saved journeys go to <work>/.vibeok/journeys
});
after(() => {
  process.chdir(repo);
  server?.kill();
});

/**
 * Stands in for an LLM: reads the same numbered page a model gets, follows a plan, and
 * reacts to failures the way the system prompt asks (a failed check → done, passed=false).
 */
function scriptedModel(plan) {
  let i = 0;
  const prompts = [];
  const chat = async (system, user) => {
    prompts.push(system + "\n" + user);
    const done = user.split("DONE SO FAR:")[1]?.split("CURRENT PAGE:")[0] ?? "";
    const lastLine = done.trim().split("\n").pop() ?? "";
    if (/FAILED:/.test(lastLine)) {
      return JSON.stringify({ action: "done", passed: false, summary: lastLine.replace(/^\d+\.\s*/, ""), say: "Found a problem" });
    }
    const step = plan[i++];
    if (!step) return JSON.stringify({ action: "done", passed: true, summary: "Everything worked." });
    const out = { ...step, say: step.say ?? step.action };
    if (step.find) {
      const line = user.split("\n").find((l) => /^\s+\[\d+\]/.test(l) && step.find.test(l));
      if (!line) return JSON.stringify({ action: "done", passed: false, summary: `Couldn't find ${step.find}` });
      out.ref = Number(line.match(/\[(\d+)\]/)[1]);
      delete out.find;
    }
    // Models often wrap JSON in prose or code fences: the parser must cope.
    return "Here is my next step:\n```json\n" + JSON.stringify(out) + "\n```";
  };
  return { chat, prompts };
}

const base = { maxSteps: 25, headless: true, cursor: false };

test("plain-English journey passes on a page that saves correctly, and is saved for replay", { timeout: 90_000 }, async () => {
  const m = scriptedModel([
    { find: /textbox "New note"/, action: "fill", value: "Hello {{run}}" },
    { find: /button "Add note"/, action: "click" },
    { action: "expect", value: "Hello {{run}}" },
    { action: "reload" },
    { action: "expect", value: "Hello {{run}}" },
  ]);
  const r = await runJourney({ ...base, url: BASE + "/notes", goal: "Add a note and check it's saved after a reload", chat: m.chat });
  assert.ok(r.journey.passed, r.journey.verdict + "\n" + JSON.stringify(r.journey.steps, null, 1));
  assert.equal(r.findings.length, 0, r.findings.map((f) => f.title).join("\n"));
  assert.ok(r.journey.savedAs, "saved for replay");
  const saved = JSON.parse(readFileSync(join(work, r.journey.savedAs), "utf8"));
  assert.deepEqual(saved.steps.map((s) => s.action), ["GOTO", "FILL", "CLICK", "EXPECT", "RELOAD", "EXPECT"]);
  assert.deepEqual(saved.steps[1].target, { role: "textbox", name: "New note" });
  assert.equal(saved.steps[1].value, "Hello {{run}}", "tokens are saved, not values");
  assert.ok(m.prompts[0].includes('[') && m.prompts[0].includes('textbox "New note"'), "model sees the numbered page");
});

test("free replay (no AI) passes", { timeout: 60_000 }, async () => {
  const [{ journey }] = listJourneys();
  const r = await replayJourney(journey, { url: BASE, headless: true, cursor: false });
  assert.ok(r.journey.passed, r.journey.verdict);
  assert.equal(r.journey.mode, "replay");
});

test("replay notices when the app changed and says how to update", { timeout: 60_000 }, async () => {
  const [{ journey, file }] = listJourneys();
  const changed = structuredClone(journey);
  changed.steps[2].target.name = "Save note"; // the button was renamed
  const r = await replayJourney(changed, { url: BASE, headless: true, cursor: false });
  assert.ok(!r.journey.passed);
  assert.match(r.journey.verdict, /app changed.*Save note/);
  writeFileSync(join(work, file), JSON.stringify(journey)); // leave the original untouched
});

test("journey behind login catches data that disappears after a reload; the password never reaches the model", { timeout: 120_000 }, async () => {
  const m = scriptedModel([
    { action: "goto", value: "/login" },
    { find: /textbox\(email\) "Email"/, action: "fill", value: "{{login.email}}" },
    { find: /textbox\(password\)/, action: "fill", value: "{{login.password}}" },
    { find: /button "Log in"/, action: "click" },
    { action: "goto", value: "/projects" },
    { find: /textbox "Project name"/, action: "fill", value: "Launch {{run}}" },
    { find: /button "Create project"/, action: "click" },
    { action: "expect", value: "Launch {{run}}" },
    { action: "reload" },
    { action: "expect", value: "Launch {{run}}" },
  ]);
  const asked = [];
  const auth = {
    choose: async (info) => (asked.push(info), { mode: "credentials", email: "demo@taskpilot.dev", password: "demo1234" }),
    waitForManualLogin: async () => {},
  };
  const r = await runJourney({ ...base, url: BASE + "/", goal: "Log in, create a project called Launch, and check it's still there after a reload", chat: m.chat, auth });
  assert.equal(asked.length, 1, "asked for login details once");
  assert.ok(!r.journey.passed);
  assert.match(r.journey.verdict, /NOT on \/projects/);
  const steps = r.journey.steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.text}`);
  assert.ok(steps.includes('✓ See "Launch ' + steps.find((s) => s.startsWith("✓ See")).split("Launch ")[1]), steps.join("\n"));
  assert.ok(r.findings.some((f) => f.kind === "journey-failed" && f.severity === "high"));
  const leaks = m.prompts.flatMap((p) => p.split("\n").filter((l) => l.includes("demo1234")));
  // The demo login page prints its own demo password as page text; anything else would be a leak.
  assert.deepEqual(leaks.filter((l) => !/Demo account:/.test(l)), [], "password never sent to the model");
  assert.ok(m.prompts.some((p) => p.includes("{{login.password}}")), "the model only ever sees the token");
  assert.ok(r.journey.steps.some((s) => s.text.includes("••••••••")), "password masked on screen");
  assert.ok(!r.journey.savedAs, "failed journeys aren't saved");
});

test("no login details and nobody to ask: tells the model to stop with instructions", { timeout: 60_000 }, async () => {
  const m = scriptedModel([
    { action: "goto", value: "/login" },
    { find: /textbox\(email\) "Email"/, action: "fill", value: "{{login.email}}" },
  ]);
  const r = await runJourney({ ...base, url: BASE + "/", goal: "Log in and open projects", chat: m.chat });
  assert.ok(!r.journey.passed);
  assert.match(r.journey.verdict, /npx vibeok login|VIBEOK_EMAIL/);
});

test("won't click risky buttons unless the journey asks", { timeout: 60_000 }, async () => {
  const m = scriptedModel([{ find: /button "Delete workspace"/, action: "click" }]);
  const r = await runJourney({ ...base, url: BASE + "/dashboard", goal: "Check the dashboard loads", chat: m.chat });
  assert.match(r.journey.steps[1].detail ?? "", /won't click "Delete workspace"/);
});

test("CLI arguments: URL and journey in any order", () => {
  assert.deepEqual(splitTargets(["sign up and create a project"]), { url: "http://localhost:3000/", goal: "sign up and create a project" });
  assert.deepEqual(splitTargets(["5173", "log in"]), { url: "http://localhost:5173/", goal: "log in" });
  assert.deepEqual(splitTargets(["log in", "localhost:4000/app"]), { url: "http://localhost:4000/app", goal: "log in" });
  assert.deepEqual(splitTargets(["myapp.vercel.app"]), { url: "https://myapp.vercel.app/", goal: undefined });
  assert.deepEqual(splitTargets([]), { url: "http://localhost:3000/", goal: undefined });
});
