import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan, DEFAULTS } from "../dist/index.js";

const PORT = 3919;
const BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "vibeok-"));
const sessionPath = join(dir, ".vibeok", "session.json");
let server;

before(async () => {
  server = spawn(process.execPath, ["examples/broken-vibe-app/server.mjs"], { env: { ...process.env, PORT: String(PORT) } });
  await once(server.stdout, "data");
});
after(() => server?.kill());

const opts = (extra = {}) => ({ ...DEFAULTS, url: BASE + "/app", maxPages: 3, headless: true, cursor: false, waitMs: 800, mobile: false, ...extra });
const bug9 = (r) => r.findings.some((f) => f.kind === "silent-failure" && /api\/settings/.test(f.title));

/** Stands in for the person at the terminal. */
function prompter(choice) {
  const asked = [];
  return { asked, choose: async (info) => (asked.push(info), choice), waitForManualLogin: async () => {} };
}

test("no way to log in: skips, says so, no false findings", { timeout: 60_000 }, async () => {
  const r = await scan(opts());
  assert.ok(!r.loggedIn);
  assert.ok(!bug9(r));
  assert.ok(r.notes.some((n) => /behind login/.test(n)), r.notes.join("\n"));
  assert.ok(r.skipped.some((s) => s.text === "Log in" && /login skipped/.test(s.reason)));
});

test("asks at the login form, logs in with the typed account, tests the page behind login, saves the session", { timeout: 90_000 }, async () => {
  const p = prompter({ mode: "credentials", email: "demo@taskpilot.dev", password: "demo1234", save: true });
  const r = await scan(opts({ auth: p, sessionPath }));
  assert.equal(p.asked.length, 1);
  assert.equal(p.asked[0].kind, "login");
  assert.equal(p.asked[0].path, "/login");
  assert.ok(r.loggedIn);
  assert.ok(bug9(r), r.findings.map((f) => f.title).join("\n"));
  assert.ok(r.skipped.some((s) => s.text === "Log out"), "never clicks Log out");
  assert.ok(existsSync(sessionPath));
  assert.ok(!readFileSync(sessionPath, "utf8").includes("demo1234"), "the password is never saved");
  assert.ok(existsSync(join(dir, ".vibeok", ".gitignore")), "session folder is git-ignored");
});

test("next run reuses the saved session without asking", { timeout: 60_000 }, async () => {
  const p = prompter({ mode: "skip" });
  const r = await scan(opts({ auth: p, sessionPath, maxPages: 1 }));
  assert.equal(p.asked.length, 0);
  assert.ok(bug9(r));
});

test("wrong password: tells the user, doesn't report an app bug", { timeout: 60_000 }, async () => {
  const p = prompter({ mode: "credentials", email: "demo@taskpilot.dev", password: "nope", save: false });
  const r = await scan(opts({ auth: p }));
  assert.ok(!r.loggedIn);
  assert.ok(r.notes.some((n) => /didn't work/.test(n)), r.notes.join("\n"));
});

test("CI: logs in with VIBEOK_EMAIL / VIBEOK_PASSWORD", { timeout: 60_000 }, async () => {
  process.env.VIBEOK_EMAIL = "demo@taskpilot.dev";
  process.env.VIBEOK_PASSWORD = "demo1234";
  try {
    const r = await scan(opts());
    assert.ok(r.loggedIn);
    assert.ok(bug9(r));
  } finally {
    delete process.env.VIBEOK_EMAIL;
    delete process.env.VIBEOK_PASSWORD;
  }
});

test("signup form: asks, and the demo account uses test details", { timeout: 60_000 }, async () => {
  const p = prompter({ mode: "demo" });
  const r = await scan(opts({ url: BASE + "/signup", maxPages: 1, auth: p }));
  assert.equal(p.asked[0].kind, "signup");
  assert.match(p.asked[0].demoEmail, /^vibeok\.test\+.+@example\.com$/);
  assert.ok(r.findings.some((f) => f.kind === "silent-failure" && /api\/signup/.test(f.title)));
});
