import { isIP } from "node:net";

/**
 * VibeOK clicks buttons and submits forms, so by default it only runs against apps on
 * your own machine or local network. Testing anything else needs an explicit statement
 * that you own the app or have permission to test it.
 */
const V4_PRIVATE: [string, number][] = [
  ["10.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16],
];
const toInt = (ip: string) => ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = toInt(ip);
    return V4_PRIVATE.some(([base, bits]) => {
      const mask = (~0 << (32 - bits)) >>> 0;
      return ((n & mask) >>> 0) === toInt(base);
    });
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

export function isLocalUrl(raw: string): boolean {
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "0.0.0.0") return true;
  return isIP(host) ? isPrivateIp(host) : false;
}

/** Accepts "localhost:3000", "3000" or a full URL. */
export function normalizeUrl(input: string | undefined): string {
  let s = (input ?? "").trim();
  if (!s) s = "3000";
  if (/^\d+$/.test(s)) s = `http://localhost:${s}`;
  if (!/^https?:\/\//i.test(s)) s = (/^(localhost|127\.|\[?::1|0\.0\.0\.0|192\.168\.|10\.)/.test(s) ? "http://" : "https://") + s;
  const u = new URL(s);
  return u.toString();
}

/** CLI arguments → app URL + plain-English journey. "localhost:3000", "3000" and "myapp.dev" are URLs; anything with spaces is the journey. */
export function splitTargets(targets: string[]): { url: string; goal?: string } {
  const looksLikeUrl = (t: string) =>
    /^\d{2,5}$/.test(t) ||
    /^(https?:\/\/|localhost|127\.|\[::1\]|0\.0\.0\.0|192\.168\.|10\.)/i.test(t) ||
    (!/\s/.test(t) && /^[\w.-]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(t));
  let url: string | undefined;
  const words: string[] = [];
  for (const t of targets) {
    if (!url && looksLikeUrl(t)) url = t;
    else words.push(t);
  }
  const goal = words.join(" ").trim();
  return { url: normalizeUrl(url), goal: goal || undefined };
}
