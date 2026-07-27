# Revalex SDKs

Open-source client SDKs for **[Revalex](https://github.com/RohanRVC/revalex-sdk)** — ship AI agents with confidence. Trace LLM calls and agent runs, then gate your CI on eval regressions.

> **Status: pre-release.** These SDKs are not on npm / PyPI yet — install from source (below). Publishing is coming.

Revalex is an **open-core** product: these client SDKs are open source (MIT); the evaluation backend (graders, LLM judges, trajectory analysis, regression gate, dashboard) is a hosted service. The SDKs are thin, fail-open clients — they capture traces and call the API, nothing more, so they can never crash or slow your app.

## What's in this repo

| Path | What it is |
|---|---|
| [`typescript/`](typescript) | `@revalex/sdk` — TypeScript/Node tracer + CI-gate harness + Anthropic/OpenAI auto-instrumentation |
| [`python/`](python) | `revalex` — Python tracer + CI-gate harness (**zero dependencies**, stdlib only) |
| [`action/`](action) | GitHub Action that fails a PR when eval pass-rates regress |
| [`examples/`](examples) | A ready-to-copy CI workflow + harness script |

## Quickstart — TypeScript

```bash
# pre-release: install from source (npm publish coming)
cd typescript && npm install && npm run build
```

```ts
import { RevalexClient, instrumentAnthropic } from "@revalex/sdk";

const revalex = new RevalexClient({ apiKey: process.env.REVALEX_API_KEY! });

// Option A: auto-instrument your LLM client (one line)
instrumentAnthropic(anthropic, revalex);

// Option B: trace an agent run yourself
revalex.trace({
  type: "agent_run",
  name: "support-agent",
  goal: "resolve the customer's refund request",
  output: "refund issued",
  steps: [{ index: 0, type: "llm_call", name: "plan", status: "ok" }],
});
await revalex.flush();
```

## Quickstart — Python

```bash
pip install -e python   # pre-release; PyPI publish coming
```

```python
from revalex import RevalexClient

with RevalexClient(api_key="rvx_live_...") as revalex:
    revalex.trace(
        type="agent_run",
        name="support-agent",
        goal="resolve the customer's refund request",
        output="refund issued",
        steps=[{"index": 0, "type": "llm_call", "name": "plan", "status": "ok"}],
    )
```

## Gate your CI on regressions

Add the Action to a workflow so a pull request fails when your agent gets worse. See [`examples/revalex-gate.yml`](examples/revalex-gate.yml).

```yaml
- uses: RohanRVC/revalex-sdk/action@main
  with:
    api-key: ${{ secrets.REVALEX_API_KEY }}
    experiment-id: ${{ steps.experiment.outputs.id }}
    max-regression-pp: "5"
```

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, self-host it. The hosted evaluation backend is a separate commercial service.
