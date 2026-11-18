import pc from "picocolors";
import type { Finding, JourneyStepResult, ScanResult } from "./types.js";

const SITE = "https://tryvibeok.site";
const sevLabel = { high: "HIGH", medium: "MEDIUM", low: "LOW" } as const;

function scoreColor(score: number) {
  return score >= 90 ? pc.green : score >= 75 ? pc.yellow : pc.red;
}
const sevColor = (f: Finding) => (f.severity === "high" ? pc.red : f.severity === "medium" ? pc.yellow : pc.dim);

/** One live line per journey step. */
export function printStep(st: JourneyStepResult, say?: string) {
  const mark = st.ok ? pc.green("✓") : pc.red("✗");
  const n = pc.dim(String(st.n).padStart(3));
  process.stderr.write(`  ${mark}${n}  ${st.text}${say ? pc.dim(`   ${say}`) : ""}\n`);
  if (st.detail) process.stderr.write(`        ${(st.ok ? pc.yellow : pc.red)(st.detail.length > 180 ? st.detail.slice(0, 180) + "…" : st.detail)}\n`);
}

export function terminalReport(r: ScanResult, fixPromptPath?: string): string {
  const lines: string[] = [];
  const sc = scoreColor(r.score);
  lines.push("");
  lines.push(`  ${pc.bold("VibeOK")} ${pc.dim("·")} ${r.url}`);
  const j = r.journey;
  if (j) {
    lines.push(
      j.passed
        ? `  ${pc.green(pc.bold("✔ Journey passed"))} ${pc.dim(`· ${j.steps.length} steps · ${(r.durationMs / 1000).toFixed(1)}s`)}`
        : `  ${pc.red(pc.bold("✖ Journey failed"))} ${pc.dim(`· after ${j.steps.length} steps · ${(r.durationMs / 1000).toFixed(1)}s`)}`,
    );
    lines.push(`  ${j.passed ? j.verdict : pc.red(j.verdict)}`);
    if (j.savedAs) lines.push(pc.dim(`  Saved to ${j.savedAs}. Replay it free (no AI): npx vibeok replay ${j.savedAs.split(/[\\/]/).pop()!.replace(/\.json$/, "")}`));
    lines.push("");
    if (r.findings.length) lines.push(pc.bold(`  ${r.findings.length} issue${r.findings.length > 1 ? "s" : ""} found along the way:`));
  } else {
    lines.push(
      `  ${sc(pc.bold(`Vibe Score ${r.score}/100`))} ${pc.dim("·")} ${sc(r.grade)} ${pc.dim(
        `· ${r.pagesVisited.length} pages · ${r.elementsClicked} clicks · ${(r.durationMs / 1000).toFixed(1)}s`,
      )}`,
    );
  }
  lines.push("");
  if (!r.findings.length && !j) {
    lines.push(`  ${pc.green("✔")} No issues found on the pages tested.`);
  }
  r.findings.forEach((f, i) => {
    const c = sevColor(f);
    lines.push(`  ${c(`${String(i + 1).padStart(2)}. [${sevLabel[f.severity]}]`)} ${f.title}`);
    if (f.page || f.action) lines.push(`      ${pc.dim(`${f.page ? `on ${f.page}` : ""}${f.page && f.action ? " · " : ""}${f.action ? `while ${f.action}` : ""}`)}`);
    for (const e of f.evidence.slice(0, 2)) lines.push(`      ${pc.dim(e.length > 140 ? e.slice(0, 140) + "…" : e)}`);
  });
  for (const n of r.notes) lines.push("", `  ${pc.cyan("ℹ")} ${n}`);
  if (r.skipped.length) {
    lines.push("");
    lines.push(pc.dim(`  Skipped ${r.skipped.length} element(s) on purpose, e.g. ${r.skipped.slice(0, 3).map((s) => `"${s.text}" (${s.reason})`).join(", ")}`));
  }
  lines.push("");
  if (fixPromptPath && r.findings.length) {
    lines.push(`  ${pc.green("✔")} Fix prompt written to ${pc.bold(fixPromptPath)}. Paste it into Cursor, Claude Code or Lovable.`);
  }
  lines.push(pc.dim(`  Keep this checked 24/7 after you deploy → ${SITE}/?utm_source=vibeok-cli`));
  lines.push("");
  return lines.join("\n");
}

/** Compact markdown for coding agents (MCP). Short on purpose: it lands in their context window. */
export function markdownReport(r: ScanResult, limit = 12): string {
  const out: string[] = [];
  const j = r.journey;
  if (j) {
    out.push(`## VibeOK journey ${j.passed ? "PASSED ✅" : "FAILED ❌"}`);
    out.push(`Journey: ${j.goal}`);
    out.push(`Verdict: ${j.verdict}`);
    out.push("", "Steps:");
    for (const st of j.steps.slice(-25)) out.push(`${st.ok ? "✓" : "✗"} ${st.n}. ${st.text}${st.detail ? ` (${st.detail.slice(0, 160)})` : ""}`);
    if (j.savedAs) out.push("", `Saved for free replays: ${j.savedAs} (npx vibeok replay)`);
    if (!r.findings.length) return out.join("\n");
    out.push("", "### Issues found");
  } else {
    out.push(`## VibeOK report: ${r.score}/100 (${r.grade})`);
    out.push(
      `${r.url} · pages: ${r.pagesVisited.join(", ")} · ${r.elementsClicked} clicks · ${r.findings.length} issue(s)`,
    );
  }
  const notes = r.notes.map((n) => `> Note: ${n}`);
  if (!r.findings.length) {
    out.push("", "No issues found on the pages tested.", ...(notes.length ? ["", ...notes] : []));
    return out.join("\n");
  }
  out.push("");
  r.findings.slice(0, limit).forEach((f, i) => {
    const where = [f.page && `on ${f.page}`, f.action && `while ${f.action}`].filter(Boolean).join(", ");
    out.push(`${i + 1}. **[${sevLabel[f.severity]}] ${f.title}**${where ? ` (${where})` : ""}`);
    for (const e of f.evidence.slice(0, 2)) out.push(`   - ${e}`);
    out.push(`   - Fix: ${f.fix}`);
  });
  if (r.findings.length > limit) out.push("", `…and ${r.findings.length - limit} more lower-priority issue(s).`);
  if (notes.length) out.push("", ...notes);
  if (r.skipped.length) out.push("", `Not clicked on purpose: ${r.skipped.slice(0, 5).map((s) => `"${s.text}" (${s.reason})`).join(", ")}.`);
  return out.join("\n");
}

export function fixPrompt(r: ScanResult): string {
  const out: string[] = [];
  out.push(`# Fix these issues (found by VibeOK)`);
  out.push("");
  out.push(
    r.journey
      ? `You are fixing a web app. VibeOK used it in a real browser at ${r.url}, following a user journey step by step, and found the ${r.findings.length} issue(s) below.`
      : `You are fixing a web app. VibeOK opened it in a real browser at ${r.url}, clicked through ${r.pagesVisited.length} page(s) like a user would, and found the ${r.findings.length} issue(s) below (Vibe Score ${r.score}/100).`,
  );
  out.push("");
  if (r.journey) {
    const j = r.journey;
    out.push(`## The journey that was tested`);
    out.push("");
    out.push(`"${j.goal}" ${j.passed ? "passed" : "FAILED"}: ${j.verdict}`);
    out.push("");
    for (const st of j.steps) out.push(`${st.n}. ${st.ok ? "✓" : "✗"} ${st.text}${st.detail ? ` — ${st.detail}` : ""}`);
    out.push("");
  }
  out.push("Fix them in order, highest severity first. For each one: find the code responsible, make the smallest change that fixes the root cause, and don't change unrelated behavior. If an issue is intentional, say so and skip it.");
  r.findings.forEach((f, i) => {
    out.push("");
    out.push(`## ${i + 1}. [${sevLabel[f.severity]}] ${f.title}`);
    if (f.page) out.push(`- Page: \`${f.page}\``);
    if (f.action) out.push(`- What VibeOK was doing: ${f.action}`);
    for (const e of f.evidence) out.push(`- Evidence: ${e}`);
    out.push(`- Fix: ${f.fix}`);
  });
  out.push("");
  out.push(
    r.journey
      ? `When you're done, run \`npx vibeok "${r.journey.goal.replace(/"/g, "'")}"\` again to confirm the journey passes.`
      : `When you're done, run \`npx vibeok ${r.url}\` again to confirm everything passes.`,
  );
  out.push("");
  return out.join("\n");
}
