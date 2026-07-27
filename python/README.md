# revalex (Python SDK)

Fail-open tracing for LLM/agent apps + CI-gate harness helpers. **Zero dependencies** (stdlib only), Python ≥ 3.9.

## Install

```bash
pip install -e python   # pre-release; PyPI publish planned
```

## Trace your agent (fail-open — can never crash your app)

```python
from revalex import RevalexClient

revalex = RevalexClient(api_key="rvx_live_...", base_url="http://localhost:4000")

revalex.trace(
    type="agent_run",
    name="support-agent",
    goal="resolve the customer's refund request",
    input="refund my order",
    output="refund issued",
    steps=[
        {"index": 0, "type": "llm_call", "name": "plan", "status": "ok"},
        {"index": 1, "type": "tool_call", "name": "issue_refund", "tool_name": "refunds_api", "status": "ok"},
    ],
    model="claude-sonnet-5",
    tokens_in=812, tokens_out=164, latency_ms=2350, version="v1",
)

revalex.flush()  # or use `with RevalexClient(...) as revalex:` for auto-shutdown
```

## CI harness (throws loudly — a broken pipeline must fail the build)

```python
from revalex import RevalexApi

api = RevalexApi(api_key="rvx_live_...", base_url="http://localhost:4000")

def my_agent(item):
    # run YOUR agent here
    return {"output": "...", "steps": [...]}

check = api.run_experiment(
    dataset_id="...", version_label="v42", run=my_agent, max_regression_pp=5,
)
assert check["passed"], f"regression gate failed: {check['verdicts']}"
```

Field names accept Python snake_case (`tool_name`, `latency_ms`, `dataset_item_id`) and are converted to the API's camelCase automatically.
