import type { BrowserSession } from "./browser-session.js";
import { RISKY } from "./checks.js";
import type { AuthPrompter } from "./types.js";

/**
 * Executes one action at a time on a real page and reports what happened, in words a
 * model (or a person) can act on. Shared by AI journeys, free replays and the MCP
 * agent-driven tools.
 */

export type ActionName =
  | "click" | "fill" | "select" | "check" | "uncheck" | "press"
  | "goto" | "reload" | "expect" | "expect_absent" | "wait" | "done";

export interface Action {
  action: ActionName;
  ref?: number;
  value?: string;
  /** done only */
  passed?: boolean;
  summary?: string;
  /** Short narration for the on-screen bubble. */
  say?: string;
}

export interface SnapItem {
  ref: number;
  role: string;
  name: string;
  type?: string;
  value?: string;
  options?: string[];
  checked?: boolean;
  required?: boolean;
  disabled?: boolean;
  inDialog?: boolean;
  href?: string;
}

export interface Snapshot {
  path: string;
  title: string;
  headings: string[];
  messages: string[];
  dialog: boolean;
  text: string;
  items: SnapItem[];
  total: number;
}

/** A replayable step: targets by role + visible name, never by a page-specific number. */
export interface SavedStep {
  action: "GOTO" | "CLICK" | "FILL" | "SELECT" | "CHECK" | "UNCHECK" | "PRESS" | "RELOAD" | "EXPECT" | "EXPECT_ABSENT" | "WAIT";
  target?: { role: string; name: string };
  value?: string;
}

export interface ActResult {
  ok: boolean;
  /** For the model: what happened, including errors. */
  summary: string;
  /** For people: what VibeOK did, e.g. 'Click "Save"'. Passwords masked. */
  display: string;
  /** Server errors, crashes, dialogs seen during this action. */
  problems: string[];
  /** A button or link was clicked and nothing at all happened. */
  deadClick?: { name: string; path: string };
  failedExpect?: boolean;
  /** Present when the step succeeded and can be replayed. */
  saved?: SavedStep;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripHash = (u: string) => u.split("#")[0];
const TOKEN = /\{\{\s*(run|new\.email|new\.password|login\.email|login\.password)\s*\}\}/g;

export class Runner {
  snap: Snapshot | null = null;
  readonly run = Math.random().toString(36).slice(2, 6);
  readonly newAccount: { email: string; password: string };
  private login: { email: string; password: string } | null = null;
  private usedNewAccount = false;
  manualLoginDone = false;
  /** Set when credentials were asked for and the user wants the session saved. */
  saveLogin = false;

  constructor(
    private s: BrowserSession,
    private opts: { cursor: boolean; headless: boolean; goal?: string; auth?: AuthPrompter },
  ) {
    const r = Math.random().toString(36).slice(2, 8);
    this.newAccount = { email: `vibeok.test+${r}@example.com`, password: `VibeOK-${r}-Test1!` };
    if (process.env.VIBEOK_EMAIL && process.env.VIBEOK_PASSWORD) {
      this.login = { email: process.env.VIBEOK_EMAIL, password: process.env.VIBEOK_PASSWORD };
    }
  }

  get page() {
    return this.s.page;
  }
  get path() {
    try {
      const u = new URL(this.page.url());
      return u.pathname + u.search;
    } catch {
      return "/";
    }
  }

  async snapshot(): Promise<Snapshot> {
    await this.page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    let snap: Snapshot | null = null;
    for (let i = 0; i < 3 && !snap; i++) {
      snap = await this.page.evaluate(() => (window as any).__vibeokH?.snapshot(80)).catch(() => null);
      if (!snap) await sleep(400);
    }
    this.snap = snap ?? { path: this.path, title: "", headings: [], messages: [], dialog: false, text: "", items: [], total: 0 };
    return this.snap;
  }

  /** The page as compact text for a model. */
  static format(snap: Snapshot): string {
    const lines: string[] = [];
    lines.push(`CURRENT PAGE: ${snap.path}${snap.title ? ` — "${snap.title}"` : ""}`);
    if (snap.headings.length) lines.push(`Headings: ${snap.headings.join(" | ")}`);
    if (snap.messages.length) lines.push(`Messages on screen: ${snap.messages.join(" | ")}`);
    if (snap.dialog) lines.push("A dialog is open (its elements are listed first).");
    lines.push(`Elements${snap.total > snap.items.length ? ` (first ${snap.items.length} of ${snap.total})` : ""}:`);
    for (const it of snap.items) lines.push("  " + Runner.describeItem(it));
    if (!snap.items.length) lines.push("  (none)");
    lines.push("Page text:");
    lines.push(snap.text ? snap.text.split("\n").map((l) => "  " + l).join("\n") : "  (empty)");
    return lines.join("\n");
  }

  static describeItem(it: SnapItem): string {
    let s = `[${it.ref}] ${it.role}${it.type && it.type !== "text" && it.role === "textbox" ? `(${it.type})` : ""} "${it.name}"`;
    if (it.value !== undefined && it.role !== "button" && it.role !== "link") s += ` = "${it.value}"`;
    if (it.options) s += ` options: ${it.options.join(", ")}`;
    if (it.checked !== undefined) s += it.checked ? " (checked)" : " (unchecked)";
    if (it.href) s += ` → ${it.href}`;
    if (it.required) s += " required";
    if (it.disabled) s += " disabled";
    if (it.inDialog) s += " [dialog]";
    return s;
  }

  /** Replaces {{tokens}} with real values. Login details may be asked for here, never sent to the model. */
  private async resolve(value: string): Promise<{ value: string; display: string } | { error: string }> {
    const needsLogin = /\{\{\s*login\./.test(value);
    if (needsLogin && !this.login) {
      const got = await this.getLogin();
      if ("error" in got) return got;
    }
    if (/\{\{\s*new\./.test(value)) this.usedNewAccount = true;
    const map: Record<string, string> = {
      run: this.run,
      "new.email": this.newAccount.email,
      "new.password": this.newAccount.password,
      "login.email": this.login?.email ?? "",
      "login.password": this.login?.password ?? "",
    };
    const real = value.replace(TOKEN, (_, k: string) => map[k]);
    const display = value.replace(TOKEN, (_, k: string) => (k.endsWith("password") ? "••••••••" : map[k]));
    return { value: real, display };
  }

  private async getLogin(): Promise<{ ok: true } | { error: string }> {
    if (this.opts.auth) {
      const choice = await this.opts.auth.choose({
        kind: "login",
        path: this.path,
        demoEmail: this.newAccount.email,
        haveDemoAccount: this.usedNewAccount,
        sessionExpired: false,
        canLoginManually: !this.opts.headless,
      });
      if (choice.mode === "credentials") {
        this.login = { email: choice.email, password: choice.password };
        this.saveLogin = Boolean(choice.save);
        return { ok: true };
      }
      if (choice.mode === "demo") {
        this.login = { ...this.newAccount };
        return { ok: true };
      }
      if (choice.mode === "manual") {
        await this.say("Your turn: log in in this window. I'll wait.");
        await this.opts.auth.waitForManualLogin(this.path);
        this.manualLoginDone = true;
        this.saveLogin = Boolean(choice.save);
        return { error: "The user logged in by hand instead. Don't fill the login form; look at the current page and continue." };
      }
      return { error: "The user chose not to log in. Pages behind login can't be tested: finish with passed=false." };
    }
    if (this.usedNewAccount) {
      this.login = { ...this.newAccount };
      return { ok: true };
    }
    return {
      error:
        "No login details are available. Finish with passed=false and say: run `npx vibeok login` or set VIBEOK_EMAIL and VIBEOK_PASSWORD for a test account.",
    };
  }

  private async overlay(fn: string, ...args: unknown[]) {
    if (!this.opts.cursor) return;
    await this.page
      .evaluate(([f, a]) => (window as any).__vibeok?.[f as string]?.(...(a as unknown[])), [fn, args] as const)
      .catch(() => {});
  }
  async say(text: string) {
    await this.overlay("say", text);
  }
  private get pause() {
    return this.opts.headless || !this.opts.cursor ? 0 : 450;
  }

  private async settle() {
    await this.page.waitForLoadState("load", { timeout: 6_000 }).catch(() => {});
    await this.page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => {});
    await sleep(this.opts.headless ? 250 : 500);
    await this.s.collector.flush();
  }

  /** Server errors, crashes and dialogs since t0, as short strings. */
  private problemsSince(t0: number, dlg0: number): string[] {
    const out: string[] = [];
    for (const n of this.s.collector.netSince(t0)) {
      if (!n.sameOrigin && n.status < 500) continue;
      const u = new URL(n.url);
      out.push(`${n.method} ${n.sameOrigin ? u.pathname : u.host + u.pathname} → ${n.status}${n.body ? ` ${n.body.slice(0, 120)}` : ""}`);
    }
    for (const e of this.s.collector.errorsSince(t0)) {
      if (e.type === "exception") out.push(`Uncaught ${e.message.slice(0, 160)}`);
    }
    for (const d of this.s.collector.dialogs.slice(dlg0)) out.push(`Browser dialog: "${d.slice(0, 120)}"`);
    return out;
  }

  private item(ref: number | undefined): SnapItem | undefined {
    return ref === undefined ? undefined : this.snap?.items.find((i) => i.ref === ref);
  }

  /** Allows a risky click only when the journey itself asks for that kind of action. */
  private riskyBlocked(name: string): boolean {
    const m = name.match(RISKY);
    if (!m) return false;
    return !(this.opts.goal ?? "").toLowerCase().includes(m[0].toLowerCase().split(" ")[0]);
  }

  async act(a: Action): Promise<ActResult> {
    const page = this.page;
    const fail = (summary: string, display: string): ActResult => ({ ok: false, summary, display, problems: [] });
    const t0 = Date.now();
    const dlg0 = this.s.collector.dialogs.length;
    const req0 = this.s.collector.requestCount;
    const pop0 = this.s.popups.count;
    const startUrl = page.url();
    const target0 = this.item(a.ref);
    this.s.collector.action =
      a.action === "goto" ? `opening ${a.value}` :
      a.action === "reload" ? `reloading ${this.path}` :
      target0 ? `${a.action === "click" ? "clicking" : a.action === "fill" ? "typing into" : a.action} "${target0.name}" on ${this.path}` :
      `${a.action} on ${this.path}`;
    if (a.say) await this.say(a.say);

    const needsRef = ["click", "fill", "select", "check", "uncheck"].includes(a.action);
    const it = this.item(a.ref);
    if (needsRef && (a.ref === undefined || !it)) {
      return fail(`There is no element [${a.ref ?? "?"}] on the current page. Use a number from the CURRENT page list.`, `${a.action} [${a.ref ?? "?"}]`);
    }
    const loc = needsRef ? page.locator(`[data-vibeok-ref="${a.ref}"]`).first() : null;
    if (loc && (await loc.count().catch(() => 0)) === 0) {
      return fail(`Element [${a.ref}] "${it!.name}" is no longer on the page. Look at the current page again.`, `${a.action} "${it!.name}"`);
    }
    if (it?.disabled && a.action !== "check") {
      return fail(`[${a.ref}] "${it.name}" is disabled.`, `${a.action} "${it.name}"`);
    }

    // Move the cursor to the target first, so the person watching can follow.
    if (loc) {
      await loc.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
      const box = await loc.boundingBox().catch(() => null);
      if (box) {
        await this.overlay("move", box.x + box.width / 2, box.y + box.height / 2);
        await this.overlay("mark", box, "green");
        await sleep(this.pause);
      }
    }

    let display = "";
    let saved: SavedStep | undefined;
    const target = it ? { role: it.role, name: it.name } : undefined;
    try {
      switch (a.action) {
        case "click": {
          display = `Click "${it!.name}"`;
          if (this.riskyBlocked(it!.name)) {
            return fail(`VibeOK won't click "${it!.name}" because the journey doesn't ask for it. Choose another way.`, display);
          }
          await page.evaluate(() => (window as any).__vibeokH.observe()).catch(() => {});
          const box = await loc!.boundingBox().catch(() => null);
          if (box) await this.overlay("ripple", box.x + box.width / 2, box.y + box.height / 2);
          await loc!.click({ timeout: 6_000 });
          saved = { action: "CLICK", target };
          break;
        }
        case "fill": {
          const r = await this.resolve(a.value ?? "");
          if ("error" in r) {
            return this.manualLoginDone
              ? { ok: true, summary: r.error, display: "You logged in yourself", problems: [] }
              : fail(r.error, `Type into "${it!.name}"`);
          }
          display = `Type "${r.display}" into "${it!.name}"`;
          await loc!.fill(r.value, { timeout: 5_000 });
          saved = { action: "FILL", target, value: a.value };
          break;
        }
        case "select": {
          display = `Choose "${a.value}" in "${it!.name}"`;
          await loc!.selectOption({ label: a.value ?? "" }, { timeout: 5_000 }).catch(() => loc!.selectOption(a.value ?? "", { timeout: 5_000 }));
          saved = { action: "SELECT", target, value: a.value };
          break;
        }
        case "check":
        case "uncheck": {
          display = `${a.action === "check" ? "Tick" : "Untick"} "${it!.name}"`;
          if (a.action === "check") await loc!.check({ timeout: 5_000 }).catch(() => loc!.click({ timeout: 5_000 }));
          else await loc!.uncheck({ timeout: 5_000 }).catch(() => loc!.click({ timeout: 5_000 }));
          saved = { action: a.action === "check" ? "CHECK" : "UNCHECK", target };
          break;
        }
        case "press": {
          const key = (a.value ?? "Enter").trim();
          if (!/^(Enter|Escape|Tab|ArrowDown|ArrowUp|Space|Backspace)$/i.test(key)) return fail(`Unsupported key "${key}". Use Enter, Escape or Tab.`, `Press ${key}`);
          display = `Press ${key}`;
          await page.evaluate(() => (window as any).__vibeokH.observe()).catch(() => {});
          await page.keyboard.press(key[0].toUpperCase() + key.slice(1));
          saved = { action: "PRESS", value: key };
          break;
        }
        case "goto": {
          const dest = new URL(a.value || "/", this.s.origin);
          if (dest.origin !== this.s.origin) return fail(`Only pages on this app can be opened (${this.s.origin}).`, `Open ${a.value}`);
          display = `Open ${dest.pathname}${dest.search}`;
          const res = await page.goto(dest.toString(), { waitUntil: "load", timeout: 30_000 });
          saved = { action: "GOTO", value: dest.pathname + dest.search };
          if (res && res.status() >= 400) {
            await this.settle();
            return { ok: false, summary: `Opened ${dest.pathname}: it returned ${res.status()}.`, display, problems: [`GET ${dest.pathname} → ${res.status()}`] };
          }
          break;
        }
        case "reload": {
          display = "Reload the page";
          await page.reload({ waitUntil: "load", timeout: 30_000 });
          saved = { action: "RELOAD" };
          break;
        }
        case "expect":
        case "expect_absent": {
          const r = await this.resolve(a.value ?? "");
          if ("error" in r) return fail(r.error, `Check "${a.value}"`);
          const want = a.action === "expect";
          display = want ? `See "${r.display}"` : `Don't see "${r.display}"`;
          let found = false;
          for (let i = 0; i < 8; i++) {
            found = await page.evaluate((t) => (window as any).__vibeokH.hasText(t), r.value).catch(() => false);
            if (found === want) break;
            await sleep(500);
          }
          if (found !== want) {
            const msg = want ? `"${r.display}" is NOT on ${this.path}.` : `"${r.display}" is still on ${this.path}.`;
            return { ok: false, summary: msg, display, problems: [], failedExpect: true };
          }
          return { ok: true, summary: want ? `Confirmed: "${r.display}" is on ${this.path}.` : `Confirmed: "${r.display}" is not on ${this.path}.`, display, problems: [], saved: { action: want ? "EXPECT" : "EXPECT_ABSENT", value: a.value } };
        }
        case "wait": {
          const ms = Math.min(Math.max(Number(a.value) || 1000, 200), 3_000);
          display = `Wait ${(ms / 1000).toFixed(1)}s`;
          await sleep(ms);
          return { ok: true, summary: "Waited.", display, problems: [] };
        }
        default:
          return fail(`Unknown action "${a.action}".`, a.action);
      }
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0].replace(/^locator\.\w+: /, "");
      await this.overlay("mark", null);
      return fail(`That didn't work: ${msg.slice(0, 200)}`, display || a.action);
    }

    // What changed?
    await this.settle();
    let res: { mutations: number; added: string; href: string; startHref: string | null } | null = null;
    if (a.action === "click" || a.action === "press") res = await page.evaluate(() => (window as any).__vibeokH.result()).catch(() => null);
    const navigated = stripHash(page.url()) !== stripHash(startUrl);
    const problems = this.problemsSince(t0, dlg0);
    const parts: string[] = [];
    if (navigated) parts.push(`now on ${this.path}`);
    if (res?.added) parts.push(`new text: "${res.added.slice(0, 160)}"`);
    if (problems.length) parts.push(`PROBLEMS: ${problems.join("; ")}`);

    let deadClick: ActResult["deadClick"];
    if (a.action === "click") {
      const reacted =
        navigated || !res || !res.startHref || res.mutations > 0 || this.s.collector.requestCount > req0 ||
        this.s.collector.dialogs.length > dlg0 || this.s.popups.count > pop0;
      if (!reacted && (it!.role === "button" || it!.role === "link")) {
        deadClick = { name: it!.name, path: this.path };
        parts.push("NOTHING HAPPENED: no page change, request or navigation");
      }
    }
    // A click or key press that triggers a server error or crash failed. Opening or reloading a page
    // still worked even if the page has its own errors: those show as warnings and in the report.
    const serverError = (a.action === "click" || a.action === "press") && problems.some((p) => /→ 5\d\d|Uncaught/.test(p));
    await this.overlay("mark", null);
    const summary = (display ? `${display}: ` : "") + (parts.length ? parts.join("; ") : "done, no visible change") + ".";
    return { ok: !deadClick && !serverError, summary, display, problems, deadClick, saved: !deadClick && !serverError ? saved : undefined };
  }
}
