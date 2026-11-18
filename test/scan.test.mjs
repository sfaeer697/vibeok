import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { scan, DEFAULTS, isLocalUrl, normalizeUrl, markdownReport, fixPrompt } from "../dist/index.js";

const PORT = 3917;
const BASE = `http://localhost:${PORT}`;
let server;

before(async () => {
  server = spawn(process.execPath, ["examples/broken-vibe-app/server.mjs"], { env: { ...process.env, PORT: String(PORT) } });
  await once(server.stdout, "data");
});
after(() => server?.kill());

const opts = (url, extra = {}) => ({ ...DEFAULTS, url, headless: true, cursor: false, waitMs: 800, ...extra });

test("finds every planted bug in the broken demo app", { timeout: 120_000 }, async () => {
  const r = await scan(opts(BASE + "/"));
  const has = (kind, re) => r.findings.some((f) => f.kind === kind && re.test(f.title + " " + f.evidence.join(" ")));

  assert.ok(has("exception", /analytics|track/), "1. uncaught TypeError on home");
  assert.ok(has("dead-button", /Watch demo/), "2. dead Watch demo button");
  assert.ok(has("mobile-overflow", /strip|1100/), "3. home overflows on phones");
  assert.ok(has("broken-link", /\/about/), "4. /about 404");
  assert.ok(has("silent-failure", /api\/signup/), "5. signup 500 shown as success");
  assert.ok(has("dead-button", /Export CSV/), "6. dead Export CSV button");
  assert.ok(has("placeholder", /Invite team/), "7. Invite team placeholder");
  assert.ok(has("client-error", /api\/checkout/), "8. /api/checkout 404");

  // Working buttons must not be reported, and destructive ones must not be clicked.
  for (const ok of ["Refresh", "Dark mode", "New project", "Get started"]) {
    assert.ok(!r.findings.some((f) => f.kind === "dead-button" && f.title.includes(ok)), `false positive: ${ok}`);
  }
  assert.ok(r.skipped.some((s) => s.text === "Delete workspace"), "Delete workspace must be skipped");
  assert.equal(r.findings.length, 8, "exactly the 8 planted bugs:\n" + r.findings.map((f) => f.title).join("\n"));
  assert.ok(r.score < 50);

  const md = markdownReport(r);
  assert.ok(md.length < 4000, "MCP report stays small");
  assert.match(fixPrompt(r), /## 1\. \[HIGH\]/);
});

test("reports nothing on a healthy page", { timeout: 60_000 }, async () => {
  const r = await scan(opts(BASE + "/healthy", { maxPages: 1 }));
  assert.deepEqual(r.findings.map((f) => f.title), []);
  assert.equal(r.score, 100);
  assert.ok(r.elementsClicked >= 2);
});

test("forms off: never submits", { timeout: 60_000 }, async () => {
  const r = await scan(opts(BASE + "/signup", { maxPages: 1, forms: false }));
  assert.ok(!r.findings.some((f) => f.kind === "silent-failure"));
  assert.ok(r.skipped.some((s) => /form submit|signup skipped/.test(s.reason)), JSON.stringify(r.skipped));
});

test("local URL detection", () => {
  for (const u of ["http://localhost:3000", "http://127.0.0.1:5173", "http://192.168.1.20:3000", "http://app.localhost", "http://[::1]:3000"]) {
    assert.ok(isLocalUrl(u), u);
  }
  for (const u of ["https://example.com", "https://myapp.vercel.app", "http://8.8.8.8"]) assert.ok(!isLocalUrl(u), u);
  assert.equal(normalizeUrl("3000"), "http://localhost:3000/");
  assert.equal(normalizeUrl("localhost:5173/app"), "http://localhost:5173/app");
  assert.equal(normalizeUrl("myapp.vercel.app"), "https://myapp.vercel.app/");
  assert.equal(normalizeUrl(undefined), "http://localhost:3000/");
});
