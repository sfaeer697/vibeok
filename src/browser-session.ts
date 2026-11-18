import type { Browser, BrowserContext, Page } from "playwright-core";
import { launchBrowser } from "./browser.js";
import { Collector } from "./collector.js";
import { OVERLAY_SCRIPT } from "./overlay.js";
import { HELPERS_SCRIPT } from "./page-helpers.js";
import { loadSession } from "./session.js";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  collector: Collector;
  popups: { count: number };
  origin: string;
  /** A saved login was loaded into this browser. */
  hadSavedLogin: boolean;
  close(): Promise<void>;
}

/** One browser with VibeOK's helpers, cursor overlay, listeners and (if saved) the user's login. */
export async function openBrowserSession(opts: {
  url: string;
  headless: boolean;
  cursor: boolean;
  sessionPath?: string;
}): Promise<BrowserSession> {
  const origin = new URL(opts.url).origin;
  const saved = opts.sessionPath ? loadSession(opts.sessionPath, origin) : null;
  const browser = await launchBrowser(opts.headless);
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: new URL(opts.url).hostname === "localhost",
      ...(saved ? { storageState: saved } : {}),
    });
    await context.addInitScript(HELPERS_SCRIPT);
    if (opts.cursor) await context.addInitScript(OVERLAY_SCRIPT);
    const page = await context.newPage();
    const popups = { count: 0 };
    context.on("page", (p) => {
      if (p === page) return;
      popups.count++;
      p.close().catch(() => {});
    });
    const collector = new Collector(origin);
    collector.attach(page);
    return {
      browser, context, page, collector, popups, origin, hadSavedLogin: Boolean(saved),
      close: async () => {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      },
    };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}
