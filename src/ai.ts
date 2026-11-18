/**
 * Bring-your-own-model. Nothing here talks to a VibeOK server: the key is read from the
 * environment (or pasted for one run) and sent only to the provider.
 *
 *   ANTHROPIC_API_KEY | OPENAI_API_KEY | GEMINI_API_KEY | OLLAMA_HOST (or VIBEOK_AI_PROVIDER=ollama)
 *   VIBEOK_MODEL overrides the default model.
 */
import type { ScanResult } from "./types.js";

export type Provider = "anthropic" | "openai" | "gemini" | "ollama";

export interface ModelConfig {
  provider: Provider;
  model: string;
  key?: string;
  baseUrl?: string;
}

/** A function the journey engine calls: system prompt + user message in, text out. */
export type ChatFn = (system: string, user: string) => Promise<string>;

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-4.1-mini",
  gemini: "gemini-2.5-flash",
  ollama: "llama3.1",
};

export function detectModel(env: NodeJS.ProcessEnv = process.env): ModelConfig | null {
  const forced = env.VIBEOK_AI_PROVIDER?.toLowerCase() as Provider | undefined;
  const pick = (provider: Provider, key?: string): ModelConfig => ({
    provider,
    key,
    model: env.VIBEOK_MODEL || DEFAULT_MODEL[provider],
    baseUrl: provider === "ollama" ? (env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "") : undefined,
  });
  if (forced === "ollama") return pick("ollama");
  if (forced === "anthropic" && env.ANTHROPIC_API_KEY) return pick("anthropic", env.ANTHROPIC_API_KEY);
  if (forced === "openai" && env.OPENAI_API_KEY) return pick("openai", env.OPENAI_API_KEY);
  if (forced === "gemini" && env.GEMINI_API_KEY) return pick("gemini", env.GEMINI_API_KEY);
  if (env.ANTHROPIC_API_KEY) return pick("anthropic", env.ANTHROPIC_API_KEY);
  if (env.OPENAI_API_KEY) return pick("openai", env.OPENAI_API_KEY);
  if (env.GEMINI_API_KEY) return pick("gemini", env.GEMINI_API_KEY);
  if (env.OLLAMA_HOST) return pick("ollama");
  return null;
}

/** Recognizes a pasted key by its prefix. */
export function modelFromKey(key: string, env: NodeJS.ProcessEnv = process.env): ModelConfig | null {
  const k = key.trim();
  const provider: Provider | null = k.startsWith("sk-ant-") ? "anthropic" : k.startsWith("AIza") ? "gemini" : k.startsWith("sk-") ? "openai" : null;
  return provider ? { provider, key: k, model: env.VIBEOK_MODEL || DEFAULT_MODEL[provider] } : null;
}

export function describeModel(m: ModelConfig) {
  return `${m.provider} · ${m.model}`;
}

export function makeChat(m: ModelConfig, opts: { maxTokens?: number; temperature?: number } = {}): ChatFn {
  const maxTokens = opts.maxTokens ?? 1024;
  const temperature = opts.temperature ?? 0;
  return async (system, user) => {
    if (m.provider === "anthropic") {
      const res = await fetchRetry("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": m.key!, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: m.model, max_tokens: maxTokens, temperature, system, messages: [{ role: "user", content: user }] }),
      });
      const data = (await res.json()) as { content: { type: string; text?: string }[] };
      return data.content.map((c) => c.text ?? "").join("");
    }
    const endpoint =
      m.provider === "openai"
        ? "https://api.openai.com/v1/chat/completions"
        : m.provider === "gemini"
          ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
          : `${m.baseUrl}/v1/chat/completions`;
    const res = await fetchRetry(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${m.key ?? "ollama"}` },
      body: JSON.stringify({
        model: m.model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? "";
  };
}

/** Retries rate limits and 5xx with backoff; turns other errors into readable messages. */
async function fetchRetry(url: string, init: RequestInit, tries = 4): Promise<Response> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      last = (e as Error).message;
      if (/localhost|127\.0\.0\.1/.test(url)) throw new Error(`Couldn't reach Ollama at ${new URL(url).origin}. Is it running? (${last})`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      continue;
    }
    if (res.ok) return res;
    last = `${res.status}: ${(await res.text()).slice(0, 300)}`;
    if (res.status === 401 || res.status === 403) throw new Error(`The AI provider rejected the key (${last})`);
    if (res.status !== 429 && res.status < 500) throw new Error(`AI request failed (${last})`);
    await new Promise((r) => setTimeout(r, 1500 * 2 ** i));
  }
  throw new Error(`AI request failed after ${tries} tries (${last})`);
}

const FIX_SYSTEM = `You turn automated QA findings into a fix prompt for an AI coding agent (Cursor, Claude Code, Lovable).
Write markdown. Be specific and short. For each issue: a heading with severity, the likely root cause in the code,
and concrete steps to fix it. Group issues that share a root cause. Do not invent findings or file names that are not
implied by the evidence. End with: run \`npx vibeok <url>\` again to confirm.`;

export async function aiFixPrompt(result: ScanResult, m: ModelConfig): Promise<string> {
  const chat = makeChat(m, { maxTokens: 2000 });
  return chat(
    FIX_SYSTEM,
    JSON.stringify({ url: result.url, score: result.score, pages: result.pagesVisited, journey: result.journey, findings: result.findings }),
  );
}
