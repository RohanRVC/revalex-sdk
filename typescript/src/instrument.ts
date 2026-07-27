import type { RevalexClient } from "./client.js";

/* ────────────────────────────────────────────────────────────────
 * Auto-instrumentation — wrap an Anthropic or OpenAI client so
 * every LLM call is traced automatically. Zero dependencies:
 * duck-typed against the providers' stable response shapes.
 *
 * Contract: tracing NEVER changes behavior — the underlying call's
 * result/error passes through untouched; capture failures are
 * swallowed (fail-open, same as RevalexClient).
 * ──────────────────────────────────────────────────────────────── */

export interface InstrumentOptions {
  /** Trace name; defaults to the provider method name. */
  name?: string;
  /** Capture message content (input/output). Default true — disable for privacy. */
  captureContent?: boolean;
}

const MAX_CAPTURE = 20_000;

function short(v: unknown): string | undefined {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > MAX_CAPTURE ? `${s.slice(0, MAX_CAPTURE)}…` : s;
  } catch {
    return undefined;
  }
}

/* ── Anthropic ─────────────────────────────────────────────────── */

interface AnthropicLike {
  messages: { create: (params: any, ...rest: any[]) => Promise<any> };
}

/**
 * Wrap an Anthropic SDK client: `instrumentAnthropic(anthropic, revalex)`.
 * Every `messages.create` call is traced (model, tokens, latency,
 * optionally content). Streaming calls are traced with latency +
 * model only (no output capture). Returns the same client.
 */
export function instrumentAnthropic<T extends AnthropicLike>(
  client: T,
  revalex: RevalexClient,
  opts: InstrumentOptions = {},
): T {
  const original = client.messages.create.bind(client.messages);
  const capture = opts.captureContent ?? true;

  client.messages.create = async (params: any, ...rest: any[]) => {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    try {
      const result = await original(params, ...rest);
      try {
        const streaming = params?.stream === true;
        const textOut = streaming
          ? undefined
          : (result?.content ?? [])
              .filter((b: any) => b?.type === "text")
              .map((b: any) => b.text)
              .join("\n");
        revalex.trace({
          type: "llm_call",
          name: opts.name ?? "anthropic.messages.create",
          model: result?.model ?? params?.model,
          input: capture ? short(params?.messages) : undefined,
          output: capture && textOut ? short(textOut) : undefined,
          tokensIn: result?.usage?.input_tokens,
          tokensOut: result?.usage?.output_tokens,
          latencyMs: Date.now() - t0,
          status: "ok",
          metadata: streaming ? { streaming: true } : undefined,
          startedAt,
          endedAt: new Date().toISOString(),
        });
      } catch {
        /* capture must never break the app */
      }
      return result;
    } catch (err) {
      try {
        revalex.trace({
          type: "llm_call",
          name: opts.name ?? "anthropic.messages.create",
          model: params?.model,
          input: capture ? short(params?.messages) : undefined,
          status: "error",
          errorMessage: err instanceof Error ? err.message.slice(0, 4_000) : String(err).slice(0, 4_000),
          latencyMs: Date.now() - t0,
          startedAt,
          endedAt: new Date().toISOString(),
        });
      } catch {
        /* fail-open */
      }
      throw err; // the app's error handling is untouched
    }
  };
  return client;
}

/* ── OpenAI ────────────────────────────────────────────────────── */

interface OpenAILike {
  chat: { completions: { create: (params: any, ...rest: any[]) => Promise<any> } };
}

/**
 * Wrap an OpenAI SDK client: `instrumentOpenAI(openai, revalex)`.
 * Every `chat.completions.create` call is traced.
 */
export function instrumentOpenAI<T extends OpenAILike>(
  client: T,
  revalex: RevalexClient,
  opts: InstrumentOptions = {},
): T {
  const original = client.chat.completions.create.bind(client.chat.completions);
  const capture = opts.captureContent ?? true;

  client.chat.completions.create = async (params: any, ...rest: any[]) => {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    try {
      const result = await original(params, ...rest);
      try {
        const streaming = params?.stream === true;
        const textOut = streaming ? undefined : result?.choices?.[0]?.message?.content ?? undefined;
        revalex.trace({
          type: "llm_call",
          name: opts.name ?? "openai.chat.completions.create",
          model: result?.model ?? params?.model,
          input: capture ? short(params?.messages) : undefined,
          output: capture && textOut ? short(textOut) : undefined,
          tokensIn: result?.usage?.prompt_tokens,
          tokensOut: result?.usage?.completion_tokens,
          latencyMs: Date.now() - t0,
          status: "ok",
          metadata: streaming ? { streaming: true } : undefined,
          startedAt,
          endedAt: new Date().toISOString(),
        });
      } catch {
        /* fail-open */
      }
      return result;
    } catch (err) {
      try {
        revalex.trace({
          type: "llm_call",
          name: opts.name ?? "openai.chat.completions.create",
          model: params?.model,
          input: capture ? short(params?.messages) : undefined,
          status: "error",
          errorMessage: err instanceof Error ? err.message.slice(0, 4_000) : String(err).slice(0, 4_000),
          latencyMs: Date.now() - t0,
          startedAt,
          endedAt: new Date().toISOString(),
        });
      } catch {
        /* fail-open */
      }
      throw err;
    }
  };
  return client;
}
