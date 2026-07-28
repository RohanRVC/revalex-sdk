import { z } from "zod";

/* ────────────────────────────────────────────────────────────────
 * Revalex wire contract — the trace format the SDK sends to the
 * Ingestion API. This is the public API surface (what a trace looks
 * like on the wire); it is intentionally self-contained so the SDK
 * has no dependency on any private Revalex package.
 *
 * The API re-validates every payload authoritatively; these schemas
 * are the SDK's best-effort local guard so we never send garbage.
 * ──────────────────────────────────────────────────────────────── */

/** Hard limits — enforced at both SDK (best-effort) and API (authoritative). */
export const LIMITS = {
  MAX_BATCH_TRACES: 100,
  MAX_STEPS_PER_TRACE: 200,
  MAX_STRING_BYTES: 100_000, // per input/output field (~100 KB)
  MAX_METADATA_KEYS: 50,
  MAX_NAME_LEN: 256,
} as const;

/** A bounded string: rejects absurdly large fields early. */
const boundedString = (max: number = LIMITS.MAX_STRING_BYTES) =>
  z.string().max(max, `string exceeds ${max} bytes`);

/** ISO-8601 timestamp string. */
const isoDate = z.string().datetime({ offset: true });

/** Status of a call/run. */
export const TraceStatusSchema = z.enum(["ok", "error"]);
export type TraceStatus = z.infer<typeof TraceStatusSchema>;

/** What kind of trace this is. */
export const TraceTypeSchema = z.enum(["llm_call", "agent_run"]);
export type TraceType = z.infer<typeof TraceTypeSchema>;

/** Kinds of steps inside an agent run. */
export const StepTypeSchema = z.enum(["llm_call", "tool_call", "retrieval", "custom"]);
export type StepType = z.infer<typeof StepTypeSchema>;

/** One step inside a multi-step agent run (the trajectory unit). */
export const StepSchema = z.object({
  index: z.number().int().min(0),
  type: StepTypeSchema,
  name: boundedString(LIMITS.MAX_NAME_LEN),
  input: boundedString().optional(),
  output: boundedString().optional(),
  /** Tool steps: which tool + whether it succeeded. */
  toolName: boundedString(LIMITS.MAX_NAME_LEN).optional(),
  /* ── Action Taxonomy (optional; the server can also classify via its
   *    per-project tool registry). Turns a tool call into a risk-aware
   *    action: what kind of access, can it be undone, what's the blast
   *    radius, does it touch sensitive data. ── */
  access: z.enum(["read", "write"]).optional(),
  reversibility: z.enum(["reversible", "irreversible"]).optional(),
  impact: z.enum(["money", "data", "external", "internal", "none"]).optional(),
  sensitive: z.boolean().optional(),
  status: TraceStatusSchema.default("ok"),
  errorMessage: boundedString(4_000).optional(),
  model: boundedString(LIMITS.MAX_NAME_LEN).optional(),
  tokensIn: z.number().int().min(0).optional(),
  tokensOut: z.number().int().min(0).optional(),
  latencyMs: z.number().min(0).optional(),
  startedAt: isoDate.optional(),
  endedAt: isoDate.optional(),
});
export type Step = z.infer<typeof StepSchema>;

/** Metadata: small, flat, string-keyed. Never trusted, never executed. */
export const MetadataSchema = z
  .record(z.string().max(128), z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]))
  .refine((m) => Object.keys(m).length <= LIMITS.MAX_METADATA_KEYS, {
    message: `metadata exceeds ${LIMITS.MAX_METADATA_KEYS} keys`,
  });

/** A single trace as sent by the SDK. */
export const TraceInputSchema = z.object({
  /** Client-generated UUID — the idempotency key. Retries dedupe on this. */
  clientTraceId: z.string().uuid(),
  type: TraceTypeSchema,
  /** Logical name, e.g. "support-agent" or "summarize-v2". */
  name: boundedString(LIMITS.MAX_NAME_LEN),
  input: boundedString().optional(),
  output: boundedString().optional(),
  /** For agent runs: the ordered trajectory. */
  steps: z.array(StepSchema).max(LIMITS.MAX_STEPS_PER_TRACE).optional(),
  /** For agent runs: what the user/agent was trying to achieve. */
  goal: boundedString(4_000).optional(),
  status: TraceStatusSchema.default("ok"),
  errorMessage: boundedString(4_000).optional(),
  model: boundedString(LIMITS.MAX_NAME_LEN).optional(),
  tokensIn: z.number().int().min(0).optional(),
  tokensOut: z.number().int().min(0).optional(),
  costUsd: z.number().min(0).optional(),
  latencyMs: z.number().min(0).optional(),
  /** Version label of the prompt/agent that produced this (links evals to releases). */
  version: boundedString(128).optional(),
  metadata: MetadataSchema.optional(),
  startedAt: isoDate.optional(),
  endedAt: isoDate.optional(),
});
export type TraceInput = z.infer<typeof TraceInputSchema>;

/** Ingestion payload: always a batch (single trace = batch of 1). */
export const IngestBatchSchema = z.object({
  traces: z.array(TraceInputSchema).min(1).max(LIMITS.MAX_BATCH_TRACES),
});
export type IngestBatch = z.infer<typeof IngestBatchSchema>;

/** Ingestion response. */
export const IngestResponseSchema = z.object({
  accepted: z.number().int().min(0),
  duplicates: z.number().int().min(0),
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;
