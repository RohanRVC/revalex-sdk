import {
  IngestBatchSchema,
  LIMITS,
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
 * ──────────────────────────────────────────────────────────────── */

export interface RevalexClientOptions {
  /** Revalex API key (ev_...). Required. */
  apiKey: string;
  /** API base URL. Defaults to local dev server. */
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
}

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;

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
  private flushing = false;
  private shuttingDown = false;

  /** Observability into the SDK itself. */
  public stats = { enqueued: 0, sent: 0, dropped: 0, failed: 0 };

  constructor(opts: RevalexClientOptions) {
    if (!opts.apiKey || typeof opts.apiKey !== "string") {
      throw new Error("RevalexClient: apiKey is required");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "http://localhost:4000").replace(/\/+$/, "");
    this.flushIntervalMs = opts.flushIntervalMs ?? 2_000;
    this.maxBatchSize = Math.min(opts.maxBatchSize ?? 50, LIMITS.MAX_BATCH_TRACES);
    this.maxQueueSize = opts.maxQueueSize ?? 10_000;
    this.redact = opts.redact;
    this.onError = opts.onError ?? (() => {});
    this.disabled = opts.disabled ?? false;
    this.fetchFn = opts.fetchFn ?? fetch;

    if (!this.disabled) {
      this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
      // Never keep the host process alive just for telemetry (Node only; no-op in browsers).
      (this.timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /** Record a trace. Returns immediately; sending is async. Never throws. */
  trace(input: Omit<TraceInput, "clientTraceId"> & { clientTraceId?: string }): void {
    try {
      const t: TraceInput = {
        ...input,
        status: input.status ?? "ok",
        clientTraceId: input.clientTraceId ?? crypto.randomUUID(),
      };
      const finalTrace = this.redact ? this.redact(t) : t;
      this.stats.enqueued++;
      if (this.disabled) return;
      if (this.queue.length >= this.maxQueueSize) {
        this.queue.shift(); // drop oldest — bounded memory beats OOM
        this.stats.dropped++;
      }
      this.queue.push({ trace: finalTrace });
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
    try {
      const result = await fn();
      const extra = extract ? extract(result) : {};
      this.trace({
        ...meta,
        ...extra,
        status: "ok",
        latencyMs: Date.now() - t0,
        startedAt,
        endedAt: new Date().toISOString(),
      });
      return result;
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
  }

  /** Force-send everything queued. Safe to call any time. */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0 || this.disabled) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.maxBatchSize).map((q) => q.trace);
        const ok = await this.sendBatch(batch);
        if (!ok) {
          this.stats.failed += batch.length;
          break; // stop draining on persistent failure; retry next interval
        }
        this.stats.sent += batch.length;
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Graceful shutdown: stop the timer and flush what's left. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  private async sendBatch(traces: TraceInput[]): Promise<boolean> {
    // Validate locally so we never send garbage (server re-validates).
    const parsed = IngestBatchSchema.safeParse({ traces });
    if (!parsed.success) {
      this.onError(new Error(`RevalexClient: invalid batch dropped — ${parsed.error.message}`));
      this.stats.dropped += traces.length;
      return true; // treated as handled; don't retry invalid data
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await this.fetchFn(`${this.baseUrl}/v1/traces`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(parsed.data),
        });
        if (res.ok) {
          (await res.json().catch(() => null)) as IngestResponse | null;
          return true;
        }
        // 4xx (except 429): our payload/auth is wrong — retrying won't help.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.onError(new Error(`RevalexClient: server rejected batch (${res.status})`));
          return true; // handled: don't loop forever on a bad key
        }
        // 429/5xx: back off and retry.
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
      }
      const jitter = Math.random() * 250;
      await new Promise((r) => setTimeout(r, BACKOFF_BASE_MS * 2 ** attempt + jitter));
    }
    return false;
  }
}
