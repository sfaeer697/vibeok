import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import type { AuthChoice, AuthInfo, AuthPrompter } from "./types.js";

/**
 * Asks the person at the terminal what to do when VibeOK reaches a login or signup form.
 * Passwords are typed hidden, used for this run only, and never written to disk; only the
 * resulting session is saved (if they say yes).
 */
export function terminalPrompter(opts: { canSave: boolean }): AuthPrompter {
  return {
    async choose(info: AuthInfo): Promise<AuthChoice> {
      const out = process.stderr;
      out.write("\n");
      if (info.sessionExpired) out.write(`  ${pc.yellow("!")} Your saved login has expired.\n`);

      type Option = { label: string; pick: () => Promise<AuthChoice> };
      const options: Option[] = [];
      if (info.kind === "signup") {
        out.write(`  ${pc.bold("📝 Found a signup form")} on ${pc.bold(info.path)}\n`);
        options.push(
          { label: `Create a demo account with test details ${pc.dim(`(${info.demoEmail})`)}`, pick: async () => ({ mode: "demo", save: await askSave() }) },
          { label: "Use details I type", pick: async () => ({ mode: "credentials", ...(await askCredentials()), save: await askSave() }) },
          { label: "Don't submit it", pick: async () => ({ mode: "skip" }) },
        );
      } else {
        out.write(`  ${pc.bold("🔐 Found a login form")} on ${pc.bold(info.path)}. How should VibeOK get in?\n`);
        options.push({ label: "Use my test account (I'll type the email and password)", pick: async () => ({ mode: "credentials", ...(await askCredentials()), save: await askSave() }) });
        if (info.canLoginManually) {
          options.push({ label: `Let me log in myself in the browser ${pc.dim("(Google, magic link, 2FA all work)")}`, pick: async () => ({ mode: "manual", save: await askSave() }) });
        }
        if (info.haveDemoAccount) {
          options.push({ label: `Log in with the demo account VibeOK just created ${pc.dim(`(${info.demoEmail})`)}`, pick: async () => ({ mode: "demo", save: await askSave() }) });
        }
        options.push({ label: "Skip pages behind login", pick: async () => ({ mode: "skip" }) });
      }
      options.forEach((o, i) => out.write(`     ${pc.green(String(i + 1))}) ${o.label}\n`));

      const answer = await ask(`  Choose 1-${options.length} ${pc.dim("[1]")}: `);
      const n = Number.parseInt(answer || "1", 10);
      const picked = options[(n >= 1 && n <= options.length ? n : 1) - 1];
      const choice = await picked.pick();
      out.write("\n");
      return choice;

      async function askSave(): Promise<boolean> {
        if (!opts.canSave) return false;
        const a = await ask(`  Remember this login for next runs? ${pc.dim("(saved in .vibeok/, never committed)")} ${pc.dim("[Y/n]")}: `);
        return !/^n/i.test(a);
      }
    },

    async waitForManualLogin(path: string) {
      await ask(`\n  ${pc.bold("👉 Log in")} in the browser window (on ${path}), then press ${pc.bold("Enter")} here… `);
    },
  };
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function askCredentials(): Promise<{ email: string; password: string }> {
  const email = await ask(`  Test account email: `);
  const password = await askHidden(`  Password ${pc.dim("(hidden)")}: `);
  return { email, password };
}

/** Reads a line without echoing it. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    if (!stdin.isTTY) {
      ask("").then(resolve);
      return;
    }
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length) {
            value = value.slice(0, -1);
            process.stderr.write("\b \b");
          }
          continue;
        }
        value += ch;
        process.stderr.write("•");
      }
    };
    stdin.on("data", onData);
  });
}
