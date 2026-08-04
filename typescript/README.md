# @revalex/sdk

Fail-open tracing for LLM/agent apps + CI-gate harness helpers. TypeScript-first, works in Node ≥ 18.

## Install

```bash
pnpm add @revalex/sdk
```

## Trace (fail-open — can never crash or slow your app)

```ts
import { RevalexClient } from "@revalex/sdk";

const revalex = new RevalexClient({ apiKey: process.env.REVALEX_API_KEY! });

revalex.trace({
  type: "agent_run",
  name: "support-agent",
  goal: "resolve the customer's refund request",
  input: "refund my order",
  output: "refund issued",
  steps: [{ index: 0, type: "llm_call", name: "plan", status: "ok" }],
});
await revalex.flush();
```

## Auto-instrument Anthropic / OpenAI (one line)

```ts
import { instrumentAnthropic, instrumentOpenAI } from "@revalex/sdk";

instrumentAnthropic(anthropic, revalex); // every messages.create traced
instrumentOpenAI(openai, revalex);       // every chat.completions.create traced
// privacy: instrumentAnthropic(anthropic, revalex, { captureContent: false })
```

> **Auto-instrument records `llm_call` traces** — great for cost/latency
> observability, but the **action-safety checks grade `agent_run` traces** (with
> the tool `steps` your agent actually ran). Auto-instrument alone does NOT run
> the safety guards; emit an `agent_run` (see the trace example above) for
> action-safety and the Behavioral Diff Gate to grade your agent's behavior.

## CI harness (throws loudly — a broken pipeline must fail the build)

```ts
import { RevalexApi } from "@revalex/sdk";

const api = new RevalexApi({ apiKey: process.env.REVALEX_API_KEY! });
const check = await api.runExperiment({
  datasetId: "…",
  versionLabel: process.env.GITHUB_SHA!.slice(0, 7),
  run: async (item) => myAgent(item.input, item.goal),
  maxRegressionPp: 5,
});
if (!check.passed) process.exit(1);
```

MIT licensed.
