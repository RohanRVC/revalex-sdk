/**
 * Example CI harness: run YOUR agent over a Revalex dataset and
 * create an evaluated experiment. Prints the experiment id (stdout)
 * for the gate step. Replace `myAgent` with your real agent call.
 *
 * Env: REVALEX_API_KEY, REVALEX_DATASET_ID, REVALEX_API_URL (optional)
 */
import { RevalexApi } from "@revalex/sdk";

const api = new RevalexApi({
  apiKey: process.env.REVALEX_API_KEY,
  baseUrl: process.env.REVALEX_API_URL ?? "http://localhost:4000",
});

// ── Replace this with your actual agent ─────────────────────────
async function myAgent(input, goal) {
  // e.g. call your LLM/agent framework here and capture steps
  return {
    output: `stub answer for: ${input}`,
    steps: [{ index: 0, type: "llm_call", name: "answer", status: "ok" }],
  };
}
// ─────────────────────────────────────────────────────────────────

const datasetId = process.env.REVALEX_DATASET_ID;
const versionLabel = process.env.GITHUB_SHA?.slice(0, 7) ?? `local-${Date.now()}`;

const items = await api.getDatasetItems(datasetId);
const experiment = await api.createExperiment(datasetId, versionLabel);

const results = [];
for (const item of items) {
  const out = await myAgent(item.input, item.goal);
  results.push({ datasetItemId: item.id, output: out.output, steps: out.steps });
}

await api.submitResults(experiment.id, results);
const graded = await api.evaluate(experiment.id);
console.error(`evaluated ${graded.evaluated} results, ${graded.graded} grades`);

// stdout = experiment id only (consumed by the workflow)
console.log(experiment.id);
