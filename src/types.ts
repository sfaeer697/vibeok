export type Severity = "high" | "medium" | "low";

export type FindingKind =
  | "exception"
  | "server-error"
  | "client-error"
  | "console-error"
  | "silent-failure"
  | "dead-button"
  | "placeholder"
  | "mobile-overflow"
  | "broken-link"
  | "journey-failed";

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  /** One line, plain English. */
  title: string;
  /** Path of the page where it happened, e.g. "/dashboard". */
  page: string;
  /** What VibeOK was doing when it happened, e.g. 'clicking "Save"'. */
  action?: string;
  /** Short raw facts: status codes, error messages, response snippets. */
  evidence: string[];
  /** What to change, written so a coding agent can act on it. */
  fix: string;
}

export interface ScanOptions {
  url: string;
  maxPages: number;
  maxClicksPerPage: number;
  /** How long to wait for a reaction after each click, in ms. */
  waitMs: number;
  headless: boolean;
  cursor: boolean;
  forms: boolean;
  mobile: boolean;
  /** Decides what to do at login and signup forms. Without one, VibeOK uses env credentials or skips. */
  auth?: AuthPrompter;
  /** Where the logged-in session is kept (e.g. .vibeok/session.json). Loaded if present, saved after a login. */
  sessionPath?: string;
}

export type AuthKind = "login" | "signup";

export interface AuthInfo {
  kind: AuthKind;
  /** Page path where the form is, e.g. "/login". */
  path: string;
  /** The test email VibeOK would use for a demo account. */
  demoEmail: string;
  /** A login is possible with the demo account VibeOK created earlier in this run. */
  haveDemoAccount: boolean;
  /** The saved session stopped working. */
  sessionExpired: boolean;
  /** A visible browser is open, so the user can log in by hand. */
  canLoginManually: boolean;
}

export type AuthChoice =
  | { mode: "demo"; save?: boolean }
  | { mode: "credentials"; email: string; password: string; save?: boolean }
  | { mode: "manual"; save?: boolean }
  | { mode: "skip" };

export interface AuthPrompter {
  choose(info: AuthInfo): Promise<AuthChoice>;
  /** Manual mode: resolves when the user says they've logged in. */
  waitForManualLogin(path: string): Promise<void>;
}

export interface ScanResult {
  url: string;
  startedAt: string;
  durationMs: number;
  pagesVisited: string[];
  elementsClicked: number;
  skipped: { page: string; text: string; reason: string }[];
  findings: Finding[];
  /** Set when this result comes from a plain-English journey or a replay. */
  journey?: JourneySummary;
  /** Things the user should know that aren't bugs, e.g. "pages behind login weren't tested". */
  notes: string[];
  loggedIn: boolean;
  score: number;
  grade: string;
}

export interface Logger {
  step(message: string): void;
  detail(message: string): void;
}

export const silentLogger: Logger = { step() {}, detail() {} };

export interface JourneyStepResult {
  n: number;
  /** What VibeOK did, in plain words: 'Click "Create account"'. */
  text: string;
  ok: boolean;
  /** What happened, or why it failed. */
  detail?: string;
}

export interface JourneySummary {
  goal: string;
  passed: boolean;
  /** One sentence: what worked, or exactly what broke. */
  verdict: string;
  steps: JourneyStepResult[];
  mode: "ai" | "replay" | "explore";
  model?: string;
  /** Path of the saved journey file, if it was saved for free replays. */
  savedAs?: string;
}
