import {
  IngestBatchSchema,
  LIMITS,
  TraceInputSchema,
  type IngestResponse,
  type TraceInput,
} from "./contract.js";

/* ────────────────────────────────────────────────────────────────
 * RevalexClient — the tracing client.
 *
 * Design contract (non-negotiable):
 *  1. FAIL-OPEN. Revalex must NEVER crash, block, or slow the host
 *     app. All sends are async + batched; every error is swallowed
 *     (surfaced via onError callback only).
 *  2. IDEMPOTENT. Every trace carries a client-generated UUID; the
 *     server dedupes, so retries can never double-count.
 *  3. BOUNDED. Memory is capped (maxQueueSize); when full, oldest
 *     traces drop and a counter records it — never unbounded growth.
 *  4. HONEST COUNTERS. stats.sent means the server accepted it.
 *     Rejected or invalid traces count as dropped, transient
 *     failures as failed — never as delivered.
 * ──────────────────────────────────────────────────────────────── */

/**
 * Node's `process`, when present. Reached through globalThis with a local
 * type rather than @types/node: this package ships to browsers too and must
 * stay dependency-free, so it can't assume Node globals exist.
 */
const nodeProcess = (
  globalThis as {
    process?: {
      env?: Record<string, string | undefined>;
      on?: (event: string, cb: () => void) => void;
      off?: (event: string, cb: () => void) => void;
    };
  }
).process;

/**
 * UUID v4 without assuming the webcrypto global exists: package.json says
 * `node >= 18`, but the global `crypto` object is only unflagged from Node
 * 19 — on Node 18 a bare crypto.randomUUID() throws, the fail-open catch
 * swallowed it, and EVERY trace was silently dropped. The idempotency key
 * needs uniqueness, not cryptographic strength, so a Math.random fallback
 * is acceptable when even getRandomValues is missing.
 */
function uuidv4(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (b: Uint8Array) => Uint8Array } })
    .crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10).join("")}`;
}

/** Revalex address from the environment, when running under Node. */
export function envBaseUrl(): string | undefined {
  const v = nodeProcess?.env?.REVALEX_API_URL;
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** Where traces go when no baseUrl is supplied. */
export const DEFAULT_BASE_URL = "https://api.revalex.com";

export interface RevalexClientOptions {
  /** Revalex API key (rvx_live_...). Required. */
  apiKey: string;
  /** API base URL. Defaults to REVALEX_API_URL, else https://api.revalex.com. */
  baseUrl?: string;
  /** How often the queue flushes (ms). Default 2000. */
  flushIntervalMs?: number;
  /** Max traces per request batch. Default 50 (server cap 100). */
  maxBatchSize?: number;
  /** Max traces held in memory before oldest are dropped. Default 10_000. */
  maxQueueSize?: number;
  /** Redact hook: transform a trace before it leaves the process (strip PII). */
  redact?: (trace: TraceInput) => TraceInput;
  /** Error observer (SDK never throws into your app). */
  onError?: (err: Error) => void;
  /** Disable sending (e.g. in unit tests). Traces are accepted and discarded. */
  disabled?: boolean;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

interface QueuedTrace {
  trace: TraceInput;
  /** Serialized size — batches are sized by BYTES as well as count. */
  bytes: number;
  /** Failed flush cycles so far; dropped after MAX_SEND_CYCLES. */
  attempts: number;
}

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
/** Flush cycles a batch survives before it is dropped as undeliverable. */
const MAX_SEND_CYCLES = 3;
/** Per-request hard timeout. Without it, a black-holed endpoint (TCP connects,
 *  never responds) makes the beforeExit drain re-arm the event loop and hang
 *  the host process for minutes (undici's ~300s headersTimeout × retries) —
 *  violating the "never block the host app" contract. */
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * Byte budget per request. The server's bodyLimit is 1 MB; batches sized by
 * count alone could legally reach many MB (100 KB per field × 200 steps), hit
 * 413, and be treated as an unretryable 4xx — the whole batch permanently
 * dropped. Sizing by bytes keeps every multi-trace batch under the limit.
 */
const MAX_BATCH_BYTES = 900_000;

type SendOutcome = "sent" | "dropped" | "retry" | "split";

export class RevalexClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly redact?: (t: TraceInput) => TraceInput;
  private readonly onError: (err: Error) => void;
  private readonly disabled: boolean;
  private readonly fetchFn: typeof fetch;

  private queue: QueuedTrace[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private warnedAfterShutdown = false;
  private exitHandler: (() => void) | null = null;

  /** Observability into the SDK itself. */
  public stats = { enqueued: 0, sent: 0, dropped: 0, failed: 0 };

  constructor(opts: RevalexClientOptions) {
    if (!opts.apiKey || typeof opts.apiKey !== "string") {
      throw new Error("RevalexClient: apiKey is required");
    }
    this.apiKey = opts.apiKey;
    // Default to PRODUCTION. Defaulting to localhost meant a correct-looking
    // integration silently posted traces into the void on any real server —
    // and because the client is fail-open, with no error to notice.
    // REVALEX_API_URL overrides for self-hosted/dev.
    this.baseUrl = (opts.baseUrl ?? envBaseUrl() ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.flushIntervalMs = opts.flushIntervalMs ?? 2_000;
    // Lower bound 1: maxBatchSize 0 used to make splice(0, 0) yield an empty
    // batch forever — an unyielding infinite loop pinning a core.
    this.maxBatchSize = Math.max(1, Math.min(opts.maxBatchSize ?? 50, LIMITS.MAX_BATCH_TRACES));
    this.maxQueueSize = opts.maxQueueSize ?? 10_000;
    this.redact = opts.redact;
    this.onError = opts.onError ?? (() => {});
    this.disabled = opts.disabled ?? false;
    this.fetchFn = opts.fetchFn ?? fetch;

    if (!this.disabled) {
      this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
      // Never keep the host process alive just for telemetry (Node only; no-op in browsers).
      (this.timer as unknown as { unref?: () => void }).unref?.();

      // Drain on exit. The timer is unref'd, so a script that runs an agent
      // and exits used to drop every queued trace — silently, because the
      // client is fail-open. "Run your agent once and watch it appear" was
      // therefore false for exactly the one-shot scripts people try first.
      if (typeof nodeProcess?.on === "function") {
        this.exitHandler = () => {
          void this.flush();
        };
        nodeProcess.on("beforeExit", this.exitHandler);
      }
    }
  }

  /** Record a trace. Returns immediately; sending is async. Never throws. */
  trace(input: Omit<TraceInput, "clientTraceId"> & { clientTraceId?: string }): void {
    try {
      // After shutdown() nothing will ever flush again — enqueueing would
      // grow a black hole that reports success. Count the drop instead.
      if (this.shuttingDown) {
        this.stats.dropped++;
        if (!this.warnedAfterShutdown) {
          this.warnedAfterShutdown = true;
          this.onError(new Error("RevalexClient: trace() called after shutdown() — traces are dropped"));
        }
        return;
      }
      const t: TraceInput = {
        ...input,
        status: input.status ?? "ok",
        clientTraceId: input.clientTraceId ?? uuidv4(),
      };
      const finalTrace = this.redact ? this.redact(t) : t;

      // Validate PER TRACE at intake. Batch-level validation meant one
      // malformed trace (e.g. a caller-supplied non-UUID clientTraceId)
      // poisoned the whole batch and silently dropped up to 49 valid ones.
      const valid = TraceInputSchema.safeParse(finalTrace);
      if (!valid.success) {
        this.stats.dropped++;
        const issue = valid.error.issues[0];
        this.onError(
          new Error(
            `RevalexClient: invalid trace dropped — ${issue ? `${issue.path.join(".")}: ${issue.message}` : "validation failed"}`,
          ),
        );
        return;
      }

      this.stats.enqueued++;
      if (this.disabled) return;
      if (this.queue.length >= this.maxQueueSize) {
        this.queue.shift(); // drop oldest — bounded memory beats OOM
        this.stats.dropped++;
      }
      this.queue.push({
        trace: valid.data,
        bytes: JSON.stringify(valid.data).length,
        attempts: 0,
      });
    } catch (err) {
      this.stats.failed++;
      this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Convenience: wrap an async LLM/agent call. Times it, captures
   * success/error, records the trace, and re-throws the original
   * error untouched (Revalex is invisible to your control flow).
   */
  async wrap<T>(
    meta: Omit<TraceInput, "clientTraceId" | "status" | "latencyMs" | "output" | "errorMessage">,
    fn: () => Promise<T>,
    extract?: (result: T) => { output?: string; tokensIn?: number; tokensOut?: number; model?: string },
  ): Promise<T> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      this.trace({
        ...meta,
        status: "error",
        errorMessage: err instanceof Error ? err.message.slice(0, 4_000) : String(err).slice(0, 4_000),
        latencyMs: Date.now() - t0,
        startedAt,
        endedAt: new Date().toISOString(),
      });
      throw err; // never swallow the app's own errors
    }
    // extract() runs OUTSIDE the call's try: a throwing extractor used to
    // land in the catch above, recording a successful LLM call as a false
    // ERROR trace with the extractor's message — poisoning error-rate
    // metrics. The call succeeded; record it as such, minus the extras.
    let extra: { output?: string; tokensIn?: number; tokensOut?: number; model?: string } = {};
    if (extract) {
      try {
        extra = extract(result);
      } catch (err) {
        this.onError(
          new Error(
            `RevalexClient.wrap: extract() threw (${err instanceof Error ? err.message : String(err)}) — trace recorded without extracted fields`,
          ),
        );
      }
    }
    this.trace({
      ...meta,
      ...extra,
      status: "ok",
      latencyMs: Date.now() - t0,
      startedAt,
      endedAt: new Date().toISOString(),
    });
    return result;
  }

  /**
   * Force-send everything queued. Safe to call any time — concurrent calls
   * coalesce onto the in-flight drain, and (crucially for shutdown) a call
   * that arrives mid-drain WAITS for that drain and then drains whatever is
   * left, rather than returning early with traces still queued.
   */
  async flush(): Promise<void> {
    if (this.disabled) return;
    while (this.flushPromise) await this.flushPromise;
    if (this.queue.length === 0) return;
    const p = this.drain().finally(() => {
      if (this.flushPromise === p) this.flushPromise = null;
    });
    this.flushPromise = p;
    await p;
  }

  /** Graceful shutdown: stop the timer and flush what's left. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.timer) clearInterval(this.timer);
    // Detach the exit hook so we don't leak a listener per client instance.
    if (this.exitHandler && typeof nodeProcess?.off === "function") {
      nodeProcess.off("beforeExit", this.exitHandler);
      this.exitHandler = null;
    }
    await this.flush();
    // Flag AFTER the final drain: flushing must still work during shutdown,
    // but anything traced after this point can never be delivered.
    this.shuttingDown = true;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      // Batch by count AND bytes (always at least one trace).
      const batch: QueuedTrace[] = [];
      let bytes = 0;
      while (this.queue.length > 0 && batch.length < this.maxBatchSize) {
        const next = this.queue[0]!;
        if (batch.length > 0 && bytes + next.bytes > MAX_BATCH_BYTES) break;
        batch.push(this.queue.shift()!);
        bytes += next.bytes;
      }

      const outcome = await this.sendBatch(batch.map((q) => q.trace));
      if (outcome === "sent") {
        this.stats.sent += batch.length;
        continue;
      }
      if (outcome === "dropped") {
        // Server said no (non-transient 4xx) or the payload was invalid —
        // retrying identical bytes cannot succeed.
        this.stats.dropped += batch.length;
        continue;
      }
      if (outcome === "split") {
        // 413 on a multi-trace batch: put everything back and force each
        // trace into its own request next pass. Halving terminates: a
        // single oversized trace comes back as "dropped", never "split".
        for (const q of batch) q.bytes = Math.max(q.bytes, MAX_BATCH_BYTES);
        this.queue.unshift(...batch);
        continue;
      }
      // "retry": transient failure after backoff. Re-queue at the FRONT so
      // nothing is lost — the old behaviour spliced the batch out and
      // dropped it on the floor while logging "retry next interval".
      const kept: QueuedTrace[] = [];
      let abandoned = 0;
      for (const q of batch) {
        q.attempts += 1;
        if (q.attempts >= MAX_SEND_CYCLES) {
          abandoned++;
          this.stats.failed++;
        } else {
          kept.push(q);
        }
      }
      if (kept.length > 0) this.queue.unshift(...kept);
      this.onError(
        new Error(
          `RevalexClient: flush failed after retries — ${kept.length} trace(s) requeued for the next interval${abandoned > 0 ? `, ${abandoned} dropped after ${MAX_SEND_CYCLES} cycles` : ""}`,
        ),
      );
      break; // stop draining this cycle; the endpoint is unhealthy
    }
  }

  private async sendBatch(traces: TraceInput[]): Promise<SendOutcome> {
    // Belt-and-braces: traces are validated at intake, so this should never
    // fire — but never send garbage (server re-validates authoritatively).
    const parsed = IngestBatchSchema.safeParse({ traces });
    if (!parsed.success) {
      this.onError(new Error(`RevalexClient: invalid batch dropped — ${parsed.error.message}`));
      return "dropped";
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Abort each attempt after REQUEST_TIMEOUT_MS. An abort surfaces in the
      // catch as a transient failure (retry/requeue), preserving fail-open —
      // it just bounds total exit-drain time instead of hanging indefinitely.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await this.fetchFn(`${this.baseUrl}/v1/traces`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(parsed.data),
          signal: controller.signal,
        });
        if (res.ok) {
          (await res.json().catch(() => null)) as IngestResponse | null;
          return "sent";
        }
        // 413: the batch exceeded the server's body limit. Multi-trace →
        // split and retry smaller; single trace → it can never fit.
        if (res.status === 413) {
          if (traces.length > 1) return "split";
          this.onError(
            new Error("RevalexClient: single trace exceeds the server body limit (1 MB) — dropped; trim input/output/steps"),
          );
          return "dropped";
        }
        // 4xx (except 429): our payload/auth is wrong — retrying won't help.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.onError(new Error(`RevalexClient: server rejected batch (${res.status})`));
          return "dropped";
        }
        // 429/5xx: back off and retry.
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        clearTimeout(timer);
      }
      // No sleep after the FINAL attempt — it delayed shutdown/exit drains
      // by ~4s per failing batch for nothing.
      if (attempt < MAX_RETRIES) {
        const jitter = Math.random() * 250;
        await new Promise((r) => setTimeout(r, BACKOFF_BASE_MS * 2 ** attempt + jitter));
      }
    }
    return "retry";
  }
}
