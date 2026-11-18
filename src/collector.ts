import type { Page, Request, Response } from "playwright-core";

export interface NetEvent {
  id: number;
  at: number;
  action: string;
  page: string;
  method: string;
  url: string;
  status: number;
  resourceType: string;
  sameOrigin: boolean;
  body?: string;
  /** Set when a more specific finding (e.g. a silent form failure) already reports this. */
  consumed?: boolean;
}

export interface ErrorEvent {
  id: number;
  at: number;
  action: string;
  page: string;
  type: "exception" | "console";
  message: string;
  location?: string;
  consumed?: boolean;
}

const BODY_LIMIT = 400;

/**
 * Listens to everything the page does and tags each event with what VibeOK was doing at
 * the time ("loading /", 'clicking "Save" on /settings'), so every finding can say which
 * user action caused it.
 */
export class Collector {
  action = "loading the app";
  pagePath = "/";
  requestCount = 0;
  dialogs: string[] = [];
  net: NetEvent[] = [];
  errors: ErrorEvent[] = [];
  private nextId = 1;
  private pending: Promise<unknown>[] = [];

  constructor(private origin: string) {}

  attach(page: Page) {
    page.on("request", (req: Request) => {
      if (!req.url().startsWith("data:")) this.requestCount++;
    });
    page.on("response", (res: Response) => this.onResponse(res));
    page.on("pageerror", (err) => {
      const top = (err.stack ?? "").split("\n").find((l) => /^\s+at /.test(l))?.trim();
      this.errors.push({
        id: this.nextId++, at: Date.now(), action: this.action, page: this.pagePath,
        type: "exception", message: `${err.name}: ${err.message}`, location: top,
      });
    });
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      // The browser logs every failed resource load; those are reported from the network side.
      if (/^Failed to load resource/i.test(text)) return;
      const loc = msg.location();
      this.errors.push({
        id: this.nextId++, at: Date.now(), action: this.action, page: this.pagePath,
        type: "console", message: text.slice(0, 500),
        location: loc?.url ? `${loc.url}:${loc.lineNumber}` : undefined,
      });
    });
    page.on("dialog", (d) => {
      this.dialogs.push(d.message());
      d.dismiss().catch(() => {});
    });
  }

  private onResponse(res: Response) {
    const status = res.status();
    if (status < 400) return;
    const req = res.request();
    const url = req.url();
    const sameOrigin = url.startsWith(this.origin);
    const ev: NetEvent = {
      id: this.nextId++, at: Date.now(), action: this.action, page: this.pagePath,
      method: req.method(), url, status, resourceType: req.resourceType(), sameOrigin,
    };
    this.net.push(ev);
    if (sameOrigin && (ev.resourceType === "fetch" || ev.resourceType === "xhr" || ev.resourceType === "document")) {
      this.pending.push(
        res.text().then(
          (t) => { ev.body = t.replace(/\s+/g, " ").trim().slice(0, BODY_LIMIT); },
          () => {},
        ),
      );
    }
  }

  /** Waits for response bodies still being read. */
  async flush() {
    await Promise.allSettled(this.pending);
    this.pending = [];
  }

  netSince(t: number) {
    return this.net.filter((e) => e.at >= t);
  }
  errorsSince(t: number) {
    return this.errors.filter((e) => e.at >= t);
  }
}
