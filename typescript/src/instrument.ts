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

  client.messages.create = ((params: any, ...rest: any[]) => {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let call: Promise<any>;
    try {
      call = original(params, ...rest);
    } catch (err) {
      recordFailure(err);
      throw err;
    }
    // Observe on a SEPARATE chain and return the ORIGINAL object: the
    // provider's create() returns an APIPromise whose .withResponse() /
    // .asResponse() callers broke when we replaced it with a plain async
    // function. Our .then never alters what the caller receives, and the
    // rejection stays theirs to handle (we observe, not consume).
    void Promise.resolve(call).then(recordSuccess, recordFailure);
    return call;

    function recordSuccess(result: any): void {
      try {
        const streaming = params?.stream === true;
        const blocks: any[] = streaming ? [] : (result?.content ?? []);
        const textOut = streaming
          ? undefined
          : blocks
              .filter((b: any) => b?.type === "text")
              .map((b: any) => b.text)
              .join("\n");
        // Capture the model's INTENDED tool calls. These blocks were being
        // dropped, so an auto-instrumented trace had no steps at all and the
        // dashboard's "what it planned" section never rendered. They are the
        // agent's intent, not observed evidence — the provenance check
        // deliberately ignores llm_call content for exactly that reason.
        const planned = blocks
          .filter((b: any) => b?.type === "tool_use")
          .slice(0, 50)
          .map((b: any, i: number) => ({
            index: i,
            type: "llm_call" as const,
            name: String(b?.name ?? "tool_use"),
            toolName: b?.name ? String(b.name) : undefined,
            input: capture ? short(b?.input) : undefined,
            status: "ok" as const,
          }));
        revalex.trace({
          type: "llm_call",
          name: opts.name ?? "anthropic.messages.create",
          model: result?.model ?? params?.model,
          input: capture ? short(params?.messages) : undefined,
          output: capture && textOut ? short(textOut) : undefined,
          steps: planned.length > 0 ? planned : undefined,
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
    }

    function recordFailure(err: unknown): void {
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
    }
  }) as T["messages"]["create"];
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

  client.chat.completions.create = ((params: any, ...rest: any[]) => {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let call: Promise<any>;
    try {
      call = original(params, ...rest);
    } catch (err) {
      recordFailure(err);
      throw err;
    }
    // See the Anthropic wrapper: observe, don't replace — the APIPromise
    // the caller gets back keeps .withResponse()/.asResponse().
    void Promise.resolve(call).then(recordSuccess, recordFailure);
    return call;

    function recordSuccess(result: any): void {
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
    }

    function recordFailure(err: unknown): void {
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
    }
  }) as T["chat"]["completions"]["create"];
  return client;
}
