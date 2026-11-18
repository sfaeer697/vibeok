import type { Page } from "playwright-core";
import type { Collector } from "./collector.js";
import type { Finding, Logger, ScanOptions } from "./types.js";

export interface PageCtx {
  page: Page;
  collector: Collector;
  opts: ScanOptions;
  log: Logger;
  pageUrl: string;
  path: string;
  popups: { count: number };
  findings: Finding[];
  skipped: { page: string; text: string; reason: string }[];
  stats: { clicked: number };
  hud: () => Promise<void>;
  /** Test identity for this run: used for every form, so a demo signup can be followed by a demo login. */
  identity: { email: string; password: string };
  /** Buttons not to click on this page, with the reason shown in the report. */
  skipKeys: Map<string, string>;
  /** The login/signup submit button on this page, if VibeOK should submit it with these values. */
  authSubmit?: { key: string; kind: "login" | "signup"; email: string; password: string };
  /** Filled in after the auth submit is clicked. */
  authOutcome?: { passwordFormGone: boolean; serverFailed: boolean; needsVerification: boolean; url: string };
}

/** Buttons VibeOK never clicks on its own: they could delete data, log you out or charge a card. */
export const RISKY =
  /\b(delete|remove|destroy|erase|log ?out|sign ?out|deactivate|unsubscribe|cancel (my )?(subscription|plan|account|membership)|pay|buy|purchase|place order|checkout|confirm order|reset|wipe|revoke|ban|archive all)\b/i;
const PLACEHOLDER = /\b(coming soon|not (yet )?implemented|under construction|todo|feature (is )?(not available|unavailable)|work in progress)\b/i;
const SUCCESS = /\b(success|successful(ly)?|saved|thank(s| you)|welcome|created|sent|submitted|done|you'?re in|all set)\b/i;
const ERROR_SHOWN = /\b(error|failed|failure|wrong|try again|invalid|could ?n[o']t|unable|problem)\b/i;

const stripHash = (u: string) => u.split("#")[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function overlay(ctx: PageCtx, fn: string, ...args: unknown[]) {
  if (!ctx.opts.cursor) return;
  await ctx.page
    .evaluate(([f, a]) => (window as any).__vibeok?.[f as string]?.(...(a as unknown[])), [fn, args] as const)
    .catch(() => {});
}

export const say = (ctx: PageCtx, text: string) => overlay(ctx, "say", text);

async function goHome(ctx: PageCtx) {
  await ctx.page.goto(ctx.pageUrl, { waitUntil: "load", timeout: 30_000 }).catch(() => {});
  await ctx.page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => {});
  await ctx.hud();
}

function valueFor(type: string, hint: string, id: { email: string; password: string }): string {
  if (type === "email" || /e-?mail/.test(hint)) return id.email;
  if (type === "password" || /password/.test(hint)) return id.password;
  if (/user ?name|login/.test(hint)) return id.email;
  if (type === "tel" || /phone|mobile|tel/.test(hint)) return "5555550123";
  if (type === "url" || /website|url/.test(hint)) return "https://example.com";
  if (type === "number" || type === "range") return "1";
  if (type === "date") return "2026-01-15";
  if (/name/.test(hint)) return "Vibe Tester";
  return "VibeOK test";
}

async function fillForm(ctx: PageCtx, key: string, id: { email: string; password: string } = ctx.identity) {
  const fields: { sel: string; type: string; hint: string; required: boolean; filled: boolean; checked: boolean }[] =
    await ctx.page.evaluate((k) => (window as any).__vibeokH.fields(k), key);
  for (const f of fields) {
    const loc = ctx.page.locator(f.sel).first();
    try {
      if (f.type === "checkbox") {
        if (f.required || /terms|agree|accept|consent/.test(f.hint)) await loc.check({ timeout: 1_500 });
      } else if (f.type === "radio") {
        if (f.required && !f.checked) await loc.check({ timeout: 1_500 });
      } else if (f.type === "select") {
        const values = await loc.evaluate((s: HTMLSelectElement) => Array.from(s.options).map((o) => o.value).filter(Boolean));
        if (values.length) await loc.selectOption(values[0], { timeout: 1_500 });
      } else if (f.type === "password" || f.type === "email" || /e-?mail|user ?name/.test(f.hint)) {
        // Always overwrite login fields: the browser may have autofilled something else.
        await loc.fill(valueFor(f.type, f.hint, id), { timeout: 1_500 });
      } else if (!f.filled) {
        await loc.fill(valueFor(f.type, f.hint, id), { timeout: 1_500 });
      }
    } catch {
      /* a field we can't fill is reported through the form-validity check */
    }
  }
}

export async function checkButtons(ctx: PageCtx) {
  const { page, collector, opts, path } = ctx;
  const list: { key: string; text: string; isSubmit: boolean }[] = await page.evaluate(() => (window as any).__vibeokH.list());
  const auth = ctx.authSubmit;
  const todo = list.filter((c) => {
    const reason = ctx.skipKeys.get(c.key);
    if (reason) {
      ctx.skipped.push({ page: path, text: c.text, reason });
      return false;
    }
    if (auth && c.key === auth.key) return true;
    if (RISKY.test(c.text)) {
      ctx.skipped.push({ page: path, text: c.text, reason: "looks destructive or charges money" });
      return false;
    }
    if (c.isSubmit && !opts.forms) {
      ctx.skipped.push({ page: path, text: c.text, reason: "form submit (forms are off)" });
      return false;
    }
    return true;
  }).slice(0, opts.maxClicksPerPage);
  // Log in last: once logged in, this page usually redirects away.
  todo.sort((a, b) => Number(a.key === auth?.key) - Number(b.key === auth?.key));

  ctx.log.detail(`${list.length} clickable elements, testing ${todo.length}`);
  await say(ctx, `Scanning ${todo.length} buttons on ${path}…`);
  await sleep(opts.headless ? 0 : 700);

  let dirty = false;
  for (const c of todo) {
    if (dirty || stripHash(page.url()) !== stripHash(ctx.pageUrl)) await goHome(ctx);
    dirty = false;

    const found = await page.evaluate((k) => (window as any).__vibeokH.prepare(k), c.key).catch(() => false);
    if (!found) {
      ctx.skipped.push({ page: path, text: c.text, reason: "not on the page after reload" });
      continue;
    }
    await sleep(150);
    const isAuth = auth?.key === c.key;
    if (c.isSubmit) {
      await say(ctx, isAuth ? (auth!.kind === "login" ? `Logging in as ${auth!.email}…` : `Signing up as ${auth!.email}…`) : `Filling the form before clicking "${c.text}"…`);
      await fillForm(ctx, c.key, isAuth ? auth! : ctx.identity);
      await sleep(250);
    }
    const r = await page.evaluate((k) => (window as any).__vibeokH.rect(k), c.key).catch(() => null);
    if (!r) continue;
    if (r.covered) {
      ctx.skipped.push({ page: path, text: c.text, reason: "covered by another element (banner or modal?)" });
      continue;
    }
    if (r.formInvalid) {
      ctx.skipped.push({ page: path, text: c.text, reason: "couldn't fill every required field" });
      continue;
    }

    const label = `"${c.text}"`;
    await overlay(ctx, "move", r.cx, r.cy);
    await overlay(ctx, "mark", r, "green");
    await say(ctx, c.isSubmit ? `Submitting the form with ${label}…` : `Clicking ${label}…`);
    await sleep(opts.headless || !opts.cursor ? 0 : 550);

    await page.evaluate(() => (window as any).__vibeokH.observe());
    const t0 = Date.now();
    const req0 = collector.requestCount;
    const dlg0 = collector.dialogs.length;
    const pop0 = ctx.popups.count;
    collector.action = `clicking ${label} on ${path}`;
    await overlay(ctx, "ripple", r.cx, r.cy);
    await page.mouse.click(r.cx, r.cy);
    await sleep(opts.waitMs);
    ctx.stats.clicked++;

    let res: { mutations: number; added: string; href: string; startHref: string | null } | null = null;
    try {
      res = await page.evaluate(() => (window as any).__vibeokH.result());
    } catch {
      /* the page navigated away mid-check: that counts as a reaction */
    }
    await collector.flush();
    collector.action = `idle on ${path}`;

    const navigated = !res || !res.startHref || stripHash(res.href) !== stripHash(res.startHref) || stripHash(page.url()) !== stripHash(ctx.pageUrl);
    const dialogs = collector.dialogs.slice(dlg0);
    const reacted =
      navigated || (res?.mutations ?? 0) > 0 || collector.requestCount > req0 || dialogs.length > 0 || ctx.popups.count > pop0;
    const shown = `${res?.added ?? ""} ${dialogs.join(" ")}`;
    const net = collector.netSince(t0);
    const errs = collector.errorsSince(t0);
    let color: "green" | "amber" | "red" = errs.length || net.some((n) => n.sameOrigin) ? "red" : "green";

    if (!reacted) {
      color = "amber";
      ctx.findings.push({
        kind: "dead-button",
        severity: "medium",
        title: `${label} button does nothing`,
        page: path,
        action: `clicking ${label}`,
        evidence: [`No DOM change, network request, navigation or dialog within ${opts.waitMs} ms of the click`],
        fix:
          `The ${label} button on ${path} has no working click handler. Find the component that renders it and wire ` +
          `onClick to the intended action. If the feature isn't built yet, disable the button and label it "Coming soon" instead of leaving it silent.`,
      });
      await say(ctx, `${label} did nothing. Dead button.`);
    } else if (PLACEHOLDER.test(shown)) {
      color = "amber";
      const msg = shown.match(PLACEHOLDER)?.[0] ?? "coming soon";
      ctx.findings.push({
        kind: "placeholder",
        severity: "low",
        title: `${label} is a placeholder ("${msg}")`,
        page: path,
        action: `clicking ${label}`,
        evidence: [`After the click the page showed: ${shown.trim().slice(0, 160)}`],
        fix: `${label} on ${path} only shows a "${msg}" message. Build the feature, or hide the button until it exists so users don't hit a dead end.`,
      });
    }

    if (c.isSubmit) {
      const failed = net.filter(
        (n) => n.sameOrigin && n.status >= 500 && ["fetch", "xhr", "document"].includes(n.resourceType),
      );
      if (failed.length) {
        const f = failed[0];
        const claimedSuccess = SUCCESS.test(shown) && !ERROR_SHOWN.test(shown);
        const showedNothing = !ERROR_SHOWN.test(shown);
        if (claimedSuccess || showedNothing) {
          failed.forEach((n) => (n.consumed = true));
          const pathname = new URL(f.url).pathname;
          ctx.findings.push({
            kind: "silent-failure",
            severity: "high",
            title: claimedSuccess
              ? `Form says success but ${f.method} ${pathname} returned ${f.status}`
              : `Form fails silently: ${f.method} ${pathname} returned ${f.status} with no error shown`,
            page: path,
            action: `submitting the form with ${label}`,
            evidence: [
              `${f.method} ${pathname} → ${f.status}`,
              ...(f.body ? [`Response: ${f.body.slice(0, 240)}`] : []),
              claimedSuccess ? `UI showed: ${shown.match(SUCCESS)?.[0]}` : "UI showed no error message",
            ],
            fix:
              `1) Fix the server error in the handler for ${f.method} ${pathname} (see the response above; validate input and return a 4xx with a clear message instead of a 500). ` +
              `2) In the form's submit handler, check response.ok before showing success. On failure show an error message (e.g. a toast) and keep what the user typed.`,
          });
          color = "red";
          await say(ctx, `Caught it: server returned ${f.status} but the UI ${claimedSuccess ? "said success" : "stayed quiet"}.`);
        }
      }
    }

    if (isAuth) {
      await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
      const form = await page.evaluate(() => (window as any).__vibeokH.authForm()).catch(() => null);
      const text: string = await page.evaluate(() => (window as any).__vibeokH.pageText()).catch(() => "");
      ctx.authOutcome = {
        passwordFormGone: !form,
        serverFailed: net.some((n) => n.sameOrigin && n.status >= 500),
        needsVerification: /verify|confirm your email|check your (e-?mail|inbox)|confirmation (link|email)/i.test(text + " " + shown),
        url: page.url(),
      };
    }

    await overlay(ctx, "mark", r, color);
    await ctx.hud();
    await sleep(opts.headless || !opts.cursor ? 0 : 400);
    if (reacted) dirty = true;
  }
  await overlay(ctx, "mark", null);
}

export async function checkMobile(ctx: PageCtx) {
  const { page, path } = ctx;
  const original = page.viewportSize() ?? { width: 1280, height: 800 };
  await say(ctx, `Squeezing ${path} to a 375px phone screen…`);
  await page.setViewportSize({ width: 375, height: 667 });
  await goHome(ctx);
  await sleep(ctx.opts.headless ? 200 : 900);
  const o: { viewport: number; pageWidth: number; elements: string[] } | null = await page
    .evaluate(() => (window as any).__vibeokH.overflow())
    .catch(() => null);
  if (o) {
    ctx.findings.push({
      kind: "mobile-overflow",
      severity: "medium",
      title: `${path} scrolls sideways on phones (${o.pageWidth}px content on a ${o.viewport}px screen)`,
      page: path,
      action: "viewing at 375×667 (iPhone SE size)",
      evidence: o.elements,
      fix:
        `On ${path}, these elements are wider than a 375px screen: ${o.elements.join("; ")}. ` +
        `Replace fixed widths with responsive ones (max-width: 100%, w-full / max-w-full in Tailwind), let rows wrap (flex-wrap) or stack on small screens, ` +
        `and put wide tables in a container with overflow-x: auto.`,
    });
    await say(ctx, `This page scrolls sideways on phones.`);
    await sleep(ctx.opts.headless ? 0 : 700);
  }
  await page.setViewportSize(original);
}
