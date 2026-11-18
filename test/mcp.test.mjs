import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = 3918;
let server, client;
const work = mkdtempSync(join(tmpdir(), "vibeok-mcp-"));

before(async () => {
  server = spawn(process.execPath, ["examples/broken-vibe-app/server.mjs"], { env: { ...process.env, PORT: String(PORT) } });
  await once(server.stdout, "data");
  client = new Client({ name: "test", version: "0.0.0" });
  const env = { ...process.env };
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OLLAMA_HOST", "VIBEOK_AI_PROVIDER"]) delete env[k];
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [resolve("dist/cli.js"), "mcp"], cwd: work, env, stderr: "ignore" }),
  );
});
after(async () => {
  await client?.close();
  server?.kill();
});

test("MCP: lists the tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["vibeok_act", "vibeok_check", "vibeok_finish", "vibeok_journey", "vibeok_open_app"]);
});

test("MCP: the agent drives a journey step by step, no key needed, and it's saved for replay", { timeout: 120_000 }, async () => {
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  const refOf = (page, re) => Number(page.split("\n").find((l) => /^\s+\[\d+\]/.test(l) && re.test(l)).match(/\[(\d+)\]/)[1]);

  let page = await call("vibeok_open_app", { url: `http://localhost:${PORT}/notes`, journey: "add a note and check it's saved", show_browser: false });
  assert.match(page, /textbox "New note"/);
  page = await call("vibeok_act", { action: "fill", ref: refOf(page, /textbox "New note"/), value: "From agent {{run}}" });
  assert.match(page, /^OK/);
  page = await call("vibeok_act", { action: "click", ref: refOf(page, /button "Add note"/) });
  page = await call("vibeok_act", { action: "reload" });
  page = await call("vibeok_act", { action: "expect", value: "From agent {{run}}" });
  assert.match(page, /^OK: Confirmed/);
  const report = await call("vibeok_finish", { passed: true, summary: "The note was saved and survives a reload." });
  assert.match(report, /PASSED/);
  assert.match(report, /Saved for free replays/);
  assert.equal(readdirSync(join(work, ".vibeok", "journeys")).length, 1);
});

test("MCP: vibeok_journey without a key points the agent to the step tools", async () => {
  const res = await client.callTool({ name: "vibeok_journey", arguments: { url: `http://localhost:${PORT}/`, journey: "sign up" } });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /vibeok_open_app/);
});

test("MCP: returns a compact report with fixes", { timeout: 120_000 }, async () => {
  const res = await client.callTool({
    name: "vibeok_check",
    arguments: { url: `http://localhost:${PORT}/dashboard`, pages: 1, show_browser: false },
  });
  const text = res.content[0].text;
  assert.ok(!res.isError, text);
  assert.match(text, /VibeOK report: \d+\/100/);
  assert.match(text, /Export CSV/);
  assert.match(text, /Fix:/);
});

test("MCP: refuses a non-local URL without confirmed ownership", async () => {
  const res = await client.callTool({ name: "vibeok_check", arguments: { url: "https://example.com" } });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /user_confirmed_ownership/);
});
