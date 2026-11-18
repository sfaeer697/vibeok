import { chromium, type Browser, type LaunchOptions } from "playwright-core";

/**
 * Uses a browser the user already has, so `npx vibeok` works without a 150 MB download:
 * Playwright's own Chromium if installed, then Google Chrome, then Microsoft Edge
 * (always present on Windows). VIBEOK_BROWSER_PATH overrides everything.
 */
export async function launchBrowser(headless: boolean): Promise<Browser> {
  const base: LaunchOptions = { headless, args: ["--disable-features=Translate"] };
  const attempts: LaunchOptions[] = [];
  if (process.env.VIBEOK_BROWSER_PATH) attempts.push({ ...base, executablePath: process.env.VIBEOK_BROWSER_PATH });
  attempts.push(base, { ...base, channel: "chrome" }, { ...base, channel: "msedge" });

  const errors: string[] = [];
  for (const opts of attempts) {
    try {
      return await chromium.launch(opts);
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      // A headed launch with no display: retry the same browser headless.
      if (!opts.headless && /display|XServer|headed/i.test((e as Error).message)) {
        try {
          return await chromium.launch({ ...opts, headless: true });
        } catch {}
      }
      errors.push(`${opts.channel ?? opts.executablePath ?? "playwright chromium"}: ${msg}`);
    }
  }
  throw new Error(
    "No browser found. Install Google Chrome or Microsoft Edge, or run:\n  npx playwright install chromium\n\nDetails:\n  " +
      errors.join("\n  "),
  );
}

/** Headed by default on a desktop, headless in CI or on a Linux box with no display. */
export function defaultHeadless(): boolean {
  if (process.env.CI) return true;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return true;
  return false;
}
