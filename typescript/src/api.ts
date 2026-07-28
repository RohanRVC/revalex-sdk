import type { Step } from "./contract.js";

/* ────────────────────────────────────────────────────────────────
 * RevalexApi — helpers for CI harnesses and scripts.
 *
 * Unlike RevalexClient (tracing: fail-open, never throws), this
 * class THROWS on errors — a CI harness must fail loudly when the
 * eval pipeline breaks, never silently pass.
 * ──────────────────────────────────────────────────────────────── */

export class RevalexApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RevalexApiOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface DatasetItem {
  id: string;
  input: string;
  reference_output: string | null;
  goal: string | null;
}

export interface ExperimentResultInput {
  datasetItemId: string;
  output: string;
  steps?: Step[];
}

export interface CheckOptions {
  experimentId: string;
  baselineExperimentId?: string;
  maxRegressionPp?: number;
  minPassRate?: number;
  /** The behavioral rule: fail on NEW risky tools vs baseline (default true server-side). */
  behavioralGate?: boolean;
  /** Strict mode: new unclassified tools also fail the gate. */
  failOnUnclassified?: boolean;
}

/** One behavioral finding from the Behavioral Diff Gate. */
export interface BehaviorFinding {
  kind: "new_risky_tool" | "new_unclassified_tool" | "risky_call_delta";
  tool: string;
  risk: string;
  baselineCalls: number;
  candidateCalls: number;
  failing: boolean;
  reason: string;
}

export interface CheckVerdict {
  evaluator: string;
  passRateBaseline: number | null;
  passRateCandidate: number | null;
  deltaPp: number | null;
  ok: boolean;
  reason: string;
}

export interface CheckResponse {
  passed: boolean;
  candidate: { id: string; versionLabel: string; resultCount: number };
  baseline: { id: string; versionLabel: string; resultCount: number } | null;
  policy: { maxRegressionPp: number; minPassRate: number | null; behavioralGate?: boolean };
  verdicts: CheckVerdict[];
  regressions: Array<{ datasetItemId: string; input: string; evaluator: string; before: string; after: string }>;
  /** Behavioral Diff Gate findings (null when behavioralGate is off). */
  behavior?: { newTools: string[]; findings: BehaviorFinding[] } | null;
}

export class RevalexApi {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: RevalexApiOptions) {
    if (!opts.apiKey) throw new RevalexApiError(401, "RevalexApi: apiKey is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "http://localhost:4000").replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as
      | (T & { error?: { message?: string } })
      | null;
    if (!res.ok) {
      throw new RevalexApiError(res.status, json?.error?.message ?? `request failed (${res.status})`);
    }
    if (json == null) throw new RevalexApiError(res.status, "empty response body");
    return json;
  }

  /** Fetch a dataset's items — the inputs your harness should run. */
  async getDatasetItems(datasetId: string): Promise<DatasetItem[]> {
    const r = await this.request<{ items: DatasetItem[] }>("GET", `/v1/datasets/${datasetId}`);
    return r.items;
  }

  /** Create an experiment for a version label. */
  async createExperiment(datasetId: string, versionLabel: string): Promise<{ id: string }> {
    const r = await this.request<{ experiment: { id: string } }>("POST", "/v1/experiments", {
      datasetId,
      versionLabel,
    });
    return r.experiment;
  }

  /** Submit your harness's outputs for dataset items. */
  async submitResults(experimentId: string, results: ExperimentResultInput[]): Promise<number> {
    const r = await this.request<{ submitted: number }>(
      "POST",
      `/v1/experiments/${experimentId}/results`,
      { results },
    );
    return r.submitted;
  }

  /** Grade all submitted results with the project's evaluators. */
  async evaluate(experimentId: string): Promise<{ evaluated: number; graded: number; skipped: string[] }> {
    return this.request("POST", `/v1/experiments/${experimentId}/evaluate`, {});
  }

  /** The CI gate: pass/fail vs baseline. Throws on transport errors only. */
  async check(opts: CheckOptions): Promise<CheckResponse> {
    return this.request("POST", "/v1/checks", opts);
  }

  /**
   * One-call harness flow: create experiment → run your function over
   * every dataset item → submit → evaluate → gate. Returns the check.
   */
  async runExperiment(opts: {
    datasetId: string;
    versionLabel: string;
    run: (item: DatasetItem) => Promise<{ output: string; steps?: Step[] }>;
    baselineExperimentId?: string;
    maxRegressionPp?: number;
    minPassRate?: number;
    behavioralGate?: boolean;
    failOnUnclassified?: boolean;
  }): Promise<CheckResponse> {
    const items = await this.getDatasetItems(opts.datasetId);
    if (items.length === 0) throw new RevalexApiError(400, "dataset has no items");
    const experiment = await this.createExperiment(opts.datasetId, opts.versionLabel);

    const results: ExperimentResultInput[] = [];
    for (const item of items) {
      const out = await opts.run(item);
      results.push({ datasetItemId: item.id, output: out.output, steps: out.steps });
    }

    await this.submitResults(experiment.id, results);
    await this.evaluate(experiment.id);
    return this.check({
      experimentId: experiment.id,
      baselineExperimentId: opts.baselineExperimentId,
      maxRegressionPp: opts.maxRegressionPp,
      minPassRate: opts.minPassRate,
      behavioralGate: opts.behavioralGate,
      failOnUnclassified: opts.failOnUnclassified,
    });
  }
}
