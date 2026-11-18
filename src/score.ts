import type { Finding } from "./types.js";

const WEIGHT = { high: 15, medium: 7, low: 2 } as const;

/**
 * 100 minus a penalty per issue. Repeats of the same kind count half, so one systemic
 * problem doesn't sink the score as hard as many different ones.
 */
export function scoreFindings(findings: Finding[]): { score: number; grade: string } {
  const seenKinds = new Set<string>();
  let penalty = 0;
  for (const f of findings) {
    const repeat = seenKinds.has(f.kind);
    seenKinds.add(f.kind);
    penalty += WEIGHT[f.severity] * (repeat ? 0.5 : 1);
  }
  const score = Math.max(0, Math.round(100 - penalty));
  const grade = score >= 90 ? "Ship it" : score >= 75 ? "Almost there" : score >= 50 ? "Needs work" : "Not ready";
  return { score, grade };
}
