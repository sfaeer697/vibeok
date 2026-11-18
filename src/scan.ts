import { launchBrowser } from "./browser.js";
import { checkButtons, checkMobile, say, type PageCtx } from "./checks.js";
import { Collector, type NetEvent } from "./collector.js";
import { OVERLAY_SCRIPT } from "./overlay.js";
import { HELPERS_SCRIPT } from "./page-helpers.js";
import { loadSession, saveSession } from "./session.js";
import { scoreFindings } from "./score.js";
import {
  silentLogger,
  type AuthChoice,
  type AuthKind,
  type Finding,
  type Logger,
  type ScanOptions,
  type ScanResult,
} from "./types.js";

const SKIP_LINK = /\.(pdf|zip|png|jpe?g|gif|webp|svg|mp4|mp3|dmg|exe|csv|xlsx?)$/i;
const RISKY_LINK = /(log-?out|sign-?out|delete|remove|unsubscribe|destroy)/i;
const MAX_LINK_CHECKS = 40;

export const DEFAULTS: Omit<ScanOptions, "url" | "headless"> = {
  maxPages: 5,
  maxClicksPerPage: 25,
  waitMs: 1500,
  cursor: true,
  forms: true,
  mobile: true,
};

function normalize(href: string, origin: string): string | null {
  try {
    const u = new URL(href);
    if (u.origin !== origin) return null;
    u.hash = "";
    u.search = "";
    if (SKIP_LINK.test(u.pathname) || RISKY_LINK.test(u.pathname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export async function scan(opts: ScanOptions, log: Logger = silentLogger): Promise<ScanResult> {
  const started = Date.now();
  const start = new URL(opts.url);
  const origin = start.origin;
  const browser = await launchBrowser(opts.headless);
  const findings: Finding[] = [];
  const skipped: ScanResult["skipped"] = [];
  const stats = { clicked: 0 };
  const visited: string[] = [];
  const linkSources = new Map<string, string>(); // url -> first page that links to it
  const pageStatus = new Map<string, number>();
  const notes: string[] = [];

  // Login state for this run.
  const saved = opts.sessionPath ? loadSession(opts.sessionPath, origin) : null;
  const rand = Math.random().toString(36).slice(2, 8);
  const identity = { email: `vibeok.test+${rand}@example.com`, password: `VibeOK-${rand}-Test1!` };
  const auth = {
    loggedIn: Boolean(saved),
    usingSaved: Boolean(saved),
    demoAccount: false,
    choices: new Map<AuthKind, AuthChoice>(),
    protectedPages: [] as string[],
    authPagesSeen: new Set<string>(),
  };

  const decide = async (kind: AuthKind, path: string, sessionExpired: boolean): Promise<AuthChoice> => {
    const cached = auth.choices.get(kind);
    if (cached && !sessionExpired) return cached;
    let choice: AuthChoice;
    if (opts.auth) {
      choice = await opts.auth.choose({
        kind, path, demoEmail: identity.email, haveDemoAccount: auth.demoAccount, sessionExpired,
        canLoginManually: !opts.headless,
      });
    } else if (kind === "login" && process.env.VIBEOK_EMAIL && process.env.VIBEOK_PASSWORD) {
      choice = { mode: "credentials", email: process.env.VIBEOK_EMAIL, password: process.env.VIBEOK_PASSWORD, save: true };
    } else if (kind === "login" && auth.demoAccount) {
      choice = { mode: "demo" };
    } else if (kind === "signup" && opts.forms) {
      choice = { mode: "demo" };
    } else {
      choice = { mode: "skip" };
    }
    auth.choices.set(kind, choice);
    return choice;
  };

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: start.hostname === "localhost",
      ...(saved ? { storageState: saved } : {}),
    });
    await context.addInitScript(HELPERS_SCRIPT);
    if (opts.cursor) await context.addInitScript(OVERLAY_SCRIPT);
    const popups = { count: 0 };
    const page = await context.newPage();
    context.on("page", (p) => {
      if (p === page) return;
      popups.count++;
      p.close().catch(() => {});
    });
    const collector = new Collector(origin);
    collector.attach(page);

    const hud = async () => {
      if (!opts.cursor) return;
      const issues =
        findings.length + collector.errors.length + collector.net.filter((n) => n.sameOrigin && !n.consumed).length;
      await page
        .evaluate((s) => (window as any).__vibeok?.hud(s), { pages: visited.length, clicked: stats.clicked, issues })
        .catch(() => {});
    };

    const queue: string[] = [normalize(start.toString(), origin) ?? start.toString()];
    // Keep the start URL's query string (e.g. ?demo=1) for the first page.
    queue[0] = start.toString().split("#")[0];
    const seen = new Set(queue.map((u) => normalize(u, origin) ?? u));

    while (queue.length && visited.length < opts.maxPages) {
      const url = queue.shift()!;
      const path = new URL(url).pathname || "/";
      visited.push(path);
      collector.pagePath = path;
      collector.action = `loading ${path}`;
      log.step(`Page ${visited.length}: ${path}`);

      const res = await page.goto(url, { waitUntil: "load", timeout: 30_000 }).catch((e: Error) => {
        // Nothing listening at the start URL: that's a setup problem, not a finding.
        if (visited.length === 1 && /ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE/.test(e.message)) {
          throw new Error(`ECONNREFUSED: nothing answered at ${url}`);
        }
        findings.push({
          kind: "broken-link",
          severity: "high",
          title: `${path} didn't load`,
          page: path,
          action: `loading ${path}`,
          evidence: [e.message.split("\n")[0]],
          fix: `${path} failed to load at all (${e.message.split("\n")[0]}). Check the dev server is running and the route doesn't hang or crash.`,
        });
        return null;
      });
      if (!res) continue;
      await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
      const status = res.status();
      pageStatus.set(normalize(url, origin) ?? url, status);
      if (status >= 400) {
        collector.net
          .filter((n) => n.resourceType === "document" && n.status === status && n.url.split("#")[0] === res.url().split("#")[0])
          .forEach((n) => (n.consumed = true));
        const from = linkSources.get(normalize(url, origin) ?? url);
        findings.push({
          kind: "broken-link",
          severity: status >= 500 ? "high" : "medium",
          title: `${path} returns ${status}`,
          page: from ? new URL(from).pathname : path,
          action: from ? `following a link to ${path}` : `loading ${path}`,
          evidence: [`GET ${path} → ${status}`],
          fix: from
            ? `A link on ${new URL(from).pathname} points to ${path}, which returns ${status}. Create that page or fix the link's href.`
            : `${path} returns ${status}. Fix the route or its server-side data loading.`,
        });
        await hud();
        continue;
      }
      // Did this page send us to a login form? Then it's behind login: test it after logging in.
      const authForm: { kind: AuthKind; submitKey: string | null; submitText: string } | null = await page
        .evaluate(() => (window as any).__vibeokH.authForm())
        .catch(() => null);
      const shownPath = new URL(page.url()).pathname || "/";
      const redirectedToAuth = Boolean(authForm) && shownPath !== path;
      if (redirectedToAuth) {
        if (!auth.protectedPages.includes(url)) auth.protectedPages.push(url);
        log.detail(`${path} needs login (sent to ${shownPath})`);
        if (auth.authPagesSeen.has(shownPath)) {
          visited.pop();
          continue;
        }
        visited[visited.length - 1] = shownPath; // what we actually test on this visit
      }
      if (authForm) auth.authPagesSeen.add(shownPath);
      const pageUrl = redirectedToAuth ? page.url() : url;
      const pagePath = redirectedToAuth ? shownPath : path;
      collector.pagePath = pagePath;

      await hud();
      await say({ opts, page } as PageCtx, `Reading ${pagePath}…`);

      const links: string[] = await page.evaluate(() => (window as any).__vibeokH.links()).catch(() => []);
      for (const l of links) {
        const n = normalize(l, origin);
        if (!n) continue;
        if (!linkSources.has(n)) linkSources.set(n, url);
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }

      const ctx: PageCtx = {
        page, collector, opts, log, pageUrl, path: pagePath, popups, findings, skipped, stats, hud,
        identity, skipKeys: new Map(),
      };

      let choice: AuthChoice | null = null;
      if (authForm?.submitKey) {
        if (auth.loggedIn && !redirectedToAuth) {
          ctx.skipKeys.set(authForm.submitKey, `${authForm.kind} form (already logged in)`);
        } else {
          const expired = auth.usingSaved && redirectedToAuth;
          if (expired) auth.usingSaved = false;
          choice = await decide(authForm.kind, pagePath, expired);
          if (choice.mode === "skip") {
            ctx.skipKeys.set(authForm.submitKey, authForm.kind === "login" ? "login skipped" : "signup skipped");
            if (authForm.kind === "login" && !notes.some((n) => n.startsWith("Pages behind login"))) {
              notes.push(
                "Pages behind login weren't tested. Run `npx vibeok login` to log in once, or set VIBEOK_EMAIL and VIBEOK_PASSWORD for a test account.",
              );
            }
          } else if (choice.mode === "manual") {
            ctx.skipKeys.set(authForm.submitKey, "you logged in by hand");
            await say(ctx, "Your turn: log in in this window. I'll wait.");
            await opts.auth?.waitForManualLogin(pagePath);
            await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
            const still = await page.evaluate(() => (window as any).__vibeokH.authForm()).catch(() => null);
            if (!still) {
              await afterLogin(choice, page.url());
              collector.action = `idle on ${pagePath}`;
              continue;
            }
            notes.push(`Still on the ${pagePath} form after the manual login, so pages behind login weren't tested.`);
          } else {
            const creds = choice.mode === "credentials" ? choice : identity;
            ctx.authSubmit = { key: authForm.submitKey, kind: authForm.kind, email: creds.email, password: creds.password };
          }
        }
      }

      await checkButtons(ctx);

      if (ctx.authSubmit && ctx.authOutcome && choice) {
        const o = ctx.authOutcome;
        const what = ctx.authSubmit.kind === "signup" ? "Signup" : "Login";
        if (o.needsVerification) {
          notes.push(
            `${what} on ${pagePath} asks for email confirmation, and VibeOK can't open the test inbox. Use your own test account (or log in yourself) to test pages behind login.`,
          );
        } else if (o.passwordFormGone && !o.serverFailed) {
          if (ctx.authSubmit.kind === "signup" && choice.mode === "demo") auth.demoAccount = true;
          log.step(`${what} worked as ${ctx.authSubmit.email}`);
          await afterLogin(choice, o.url);
        } else if (choice.mode === "credentials") {
          notes.push(`Logging in as ${ctx.authSubmit.email} on ${pagePath} didn't work (still on the form). Check the test account details.`);
          auth.choices.delete("login");
        }
      }

      if (opts.mobile) await checkMobile(ctx);
      collector.action = `idle on ${pagePath}`;
    }

    async function afterLogin(choice: AuthChoice, landedUrl: string) {
      auth.loggedIn = true;
      if (opts.sessionPath && "save" in choice && choice.save) {
        await saveSession(context, opts.sessionPath, origin).catch(() => {});
        log.detail(`Login saved to ${opts.sessionPath} for next time`);
      }
      // Visit the page we landed on, then everything that sent us to login.
      const next = [landedUrl, ...auth.protectedPages].map((u) => normalize(u, origin) ?? u);
      auth.protectedPages = [];
      for (const u of next.reverse()) {
        if (!queue.includes(u) && !visited.includes(new URL(u).pathname)) queue.unshift(u);
        seen.add(u);
      }
    }

    // Links found but not visited: one quick request each.
    const unchecked = [...linkSources.keys()].filter((u) => !pageStatus.has(u)).slice(0, MAX_LINK_CHECKS);
    if (unchecked.length) log.step(`Checking ${unchecked.length} more links`);
    for (const u of unchecked) {
      const r = await context.request.get(u, { timeout: 10_000, maxRedirects: 5, failOnStatusCode: false }).catch(() => null);
      if (r && r.status() >= 400) {
        const from = new URL(linkSources.get(u)!).pathname;
        const p = new URL(u).pathname;
        findings.push({
          kind: "broken-link",
          severity: r.status() >= 500 ? "high" : "medium",
          title: `Link to ${p} returns ${r.status()}`,
          page: from,
          evidence: [`GET ${p} → ${r.status()}`],
          fix: `A link on ${from} points to ${p}, which returns ${r.status()}. Create that page or fix the link's href.`,
        });
      }
    }

    await collector.flush();
    findings.push(...networkFindings(collector.net), ...errorFindings(collector));
    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }

  const merged = sortFindings(mergeAcrossPages(findings));
  const { score, grade } = scoreFindings(merged);
  return {
    url: opts.url,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    pagesVisited: visited,
    elementsClicked: stats.clicked,
    skipped,
    findings: merged,
    notes,
    loggedIn: auth.loggedIn,
    score,
    grade,
  };
}

/**
 * The same problem in a shared layout (nav, footer) shows up on every page. Report it once,
 * listing the pages, instead of once per page.
 */
export function mergeAcrossPages(list: Finding[]): Finding[] {
  const byKey = new Map<string, Finding & { pages: string[] }>();
  const out: (Finding & { pages?: string[] })[] = [];
  for (const f of list) {
    const key = f.kind === "mobile-overflow" ? `${f.kind}|${f.evidence.join("|")}` : `${f.kind}|${f.title}|${f.evidence[0] ?? ""}`;
    const prev = byKey.get(key);
    if (prev) {
      if (!prev.pages.includes(f.page)) prev.pages.push(f.page);
      continue;
    }
    const copy = { ...f, pages: [f.page] };
    byKey.set(key, copy);
    out.push(copy);
  }
  return out.map(({ pages, ...f }) => {
    if (!pages || pages.length < 2) return f;
    const where = pages.join(", ");
    return f.kind === "mobile-overflow"
      ? { ...f, page: where, title: `${pages.length} pages scroll sideways on phones (${where})`, fix: f.fix.replace(`On ${pages[0]},`, `On ${where} (probably a shared layout),`) }
      : { ...f, page: where, title: `${f.title} (on ${pages.length} pages)` };
  });
}

const SEV_ORDER = { high: 0, medium: 1, low: 2 } as const;
export function sortFindings(f: Finding[]) {
  return [...f].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
}

export function networkFindings(events: NetEvent[]): Finding[] {
  const groups = new Map<string, NetEvent[]>();
  for (const e of events) {
    if (e.consumed || e.resourceType === "document") continue;
    const u = new URL(e.url);
    const key = e.sameOrigin ? `${e.method} ${u.pathname} ${e.status}` : `3p ${u.host} ${e.status}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const out: Finding[] = [];
  for (const list of groups.values()) {
    const e = list[0];
    const u = new URL(e.url);
    const times = list.length > 1 ? ` (${list.length} times)` : "";
    const api = e.resourceType === "fetch" || e.resourceType === "xhr";
    const evidence = [`${e.method} ${e.sameOrigin ? u.pathname : u.href} → ${e.status}${times}`, ...(e.body ? [`Response: ${e.body.slice(0, 240)}`] : [])];

    if (!e.sameOrigin) {
      out.push({
        kind: "client-error", severity: "low", title: `Third-party request to ${u.host} fails with ${e.status}`,
        page: e.page, action: e.action, evidence,
        fix: `A request to ${u.host} returns ${e.status}. Check the API key, URL or plan for that service, or remove the call if it's unused.`,
      });
    } else if (e.status >= 500) {
      out.push({
        kind: "server-error", severity: "high", title: `${e.method} ${u.pathname} crashes with ${e.status}`,
        page: e.page, action: e.action, evidence,
        fix: `${e.method} ${u.pathname} returns ${e.status} while ${e.action}. Open the route handler or server action for ${u.pathname}, reproduce with the same request, and fix the root cause. Return a 4xx with a clear message for bad input instead of a 500, and make the UI show an error when this call fails.`,
      });
    } else if (api && (e.status === 401 || e.status === 403 || e.status === 400 || e.status === 422)) {
      out.push({
        kind: "client-error", severity: "low", title: `${e.method} ${u.pathname} rejected with ${e.status}`,
        page: e.page, action: e.action, evidence,
        fix: `${e.method} ${u.pathname} returns ${e.status} while ${e.action}. This may be expected (logged out or invalid test input); if not, check auth and validation for that route, and make sure the UI explains the rejection to the user.`,
      });
    } else {
      const favicon = u.pathname.endsWith("favicon.ico");
      out.push({
        kind: "client-error", severity: favicon ? "low" : "medium",
        title: api ? `${e.method} ${u.pathname} not found (${e.status})` : `Missing file ${u.pathname} (${e.status})`,
        page: e.page, action: e.action, evidence,
        fix: api
          ? `The app calls ${e.method} ${u.pathname} while ${e.action}, but that route returns ${e.status}. Create the route (or fix the URL/method in the fetch call).`
          : `${u.pathname} is referenced on ${e.page} but returns ${e.status}. Add the file or fix the path.`,
      });
    }
  }
  return out;
}

export function errorFindings(c: Collector): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const e of c.errors) {
    if (e.consumed) continue;
    const key = e.type + e.message.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    const where = e.location ? ` (${e.location})` : "";
    if (e.type === "exception") {
      out.push({
        kind: "exception", severity: "high", title: `Uncaught error: ${e.message.slice(0, 90)}`,
        page: e.page, action: e.action, evidence: [e.message + where],
        fix: `The page throws "${e.message}" while ${e.action}${where}. Find that code, fix the cause (often a value that is undefined at that moment), and guard it so one failure doesn't break the page.`,
      });
    } else {
      const devWarning = /^Warning:/.test(e.message);
      out.push({
        kind: "console-error", severity: devWarning ? "low" : "medium", title: `Console error: ${e.message.slice(0, 90)}`,
        page: e.page, action: e.action, evidence: [e.message + where],
        fix: `The browser console logs an error while ${e.action}: "${e.message.slice(0, 200)}"${where}. Fix the code that logs it.`,
      });
    }
  }
  return out;
}
