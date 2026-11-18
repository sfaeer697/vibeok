import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BrowserContext } from "playwright-core";

/**
 * A saved login: cookies plus local storage (and IndexedDB, where Firebase keeps its
 * session), for one app origin. It never contains a password.
 */
type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
interface SavedSession {
  origin: string;
  savedAt: string;
  state: StorageState;
}

export const DEFAULT_SESSION_PATH = ".vibeok/session.json";

export function loadSession(path: string, origin: string): StorageState | null {
  try {
    const s = JSON.parse(readFileSync(resolve(path), "utf8")) as SavedSession;
    return s.origin === origin ? s.state : null;
  } catch {
    return null;
  }
}

export async function saveSession(context: BrowserContext, path: string, origin: string): Promise<void> {
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true });
  const state = await context.storageState({ indexedDB: true }).catch(() => context.storageState());
  const data: SavedSession = { origin, savedAt: new Date().toISOString(), state };
  writeFileSync(full, JSON.stringify(data, null, 2));
  protectFromGit(dirname(full));
}

export function deleteSession(path: string): boolean {
  const full = resolve(path);
  if (!existsSync(full)) return false;
  unlinkSync(full);
  return true;
}

/**
 * Sessions are as good as a password while they last, so they must never be committed.
 * Puts a .gitignore inside the session folder (covers it wherever the repo root is) and
 * adds the folder to the project's .gitignore if there is one.
 */
function protectFromGit(dir: string) {
  // Only the login files: saved journeys (in journeys/) hold no secrets and are worth committing.
  writeFileSync(join(dir, ".gitignore"), "# Saved logins from VibeOK. Never commit these.\nsession*.json\n");
  const projectIgnore = resolve(dir, "..", ".gitignore");
  try {
    if (existsSync(projectIgnore)) {
      const name = dir.split(/[\\/]/).pop()!;
      const line = `${name}/session*.json`;
      const text = readFileSync(projectIgnore, "utf8");
      if (!text.split(/\r?\n/).some((l) => [line, `${name}/`, `/${name}/`, name].includes(l.trim()))) {
        appendFileSync(projectIgnore, `${text.endsWith("\n") ? "" : "\n"}${line}\n`);
      }
    }
  } catch {
    /* the folder's own .gitignore already protects it */
  }
}
