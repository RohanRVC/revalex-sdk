"""RevalexApi — helpers for CI harnesses and scripts.

Unlike RevalexClient (tracing: fail-open, never raises), this class
RAISES on errors — a CI harness must fail loudly when the eval
pipeline breaks, never silently pass.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from ._wire import http_json, to_wire_result
from .client import DEFAULT_BASE_URL, _env_base_url


class RevalexApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"[{status}] {message}")
        self.status = status
        self.message = message


class RevalexApi:
    def __init__(self, api_key: str, base_url: Optional[str] = None, timeout: float = 30.0) -> None:
        if not api_key:
            raise RevalexApiError(401, "RevalexApi: api_key is required")
        self._api_key = api_key
        self._base_url = (base_url or _env_base_url() or DEFAULT_BASE_URL).rstrip("/")
        self._timeout = timeout

    def _request(
        self, method: str, path: str, body: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        status, parsed = http_json(
            method, f"{self._base_url}{path}", self._api_key, body,
            timeout=timeout if timeout is not None else self._timeout,
        )
        if status >= 400:
            message = "request failed"
            if isinstance(parsed, dict):
                message = ((parsed.get("error") or {}).get("message")) or message
            raise RevalexApiError(status, message)
        if parsed is None:
            raise RevalexApiError(status, "empty response body")
        return parsed

    # ── the harness surface ───────────────────────────────────────

    def get_dataset_items(self, dataset_id: str, limit: int = 1000) -> List[Dict[str, Any]]:
        """Fetch a dataset's items - the inputs your harness should run.

        Raises when the dataset is bigger than what came back: a CI gate that
        silently ran on the newest subset reads as full coverage."""
        r = self._request("GET", f"/v1/datasets/{dataset_id}?limit={max(1, min(limit, 1000))}")
        items = r["items"]
        total = r.get("totalItems")
        if isinstance(total, int) and total > len(items):
            raise RevalexApiError(
                400,
                f"dataset has {total} items but only {len(items)} were returned - the CI gate must run on the full set",
            )
        return items

    def create_experiment(self, dataset_id: str, version_label: str) -> Dict[str, Any]:
        return self._request(
            "POST", "/v1/experiments", {"datasetId": dataset_id, "versionLabel": version_label}
        )["experiment"]

    def submit_results(self, experiment_id: str, results: List[Dict[str, Any]]) -> int:
        """Submit outputs. Each result: {dataset_item_id, output, steps?} (snake or camel).

        Chunked by the server's 100-result cap, so 101+-item datasets work
        instead of failing AFTER the harness paid for every agent run."""
        wire = [to_wire_result(r) for r in results]
        submitted = 0
        for i in range(0, len(wire), 100):
            submitted += self._request(
                "POST", f"/v1/experiments/{experiment_id}/results", {"results": wire[i : i + 100]}
            )["submitted"]
        return submitted

    def evaluate(self, experiment_id: str, timeout: float = 600.0) -> Dict[str, Any]:
        """Grade all submitted results with the project's evaluators.

        Synchronous on the server: it grades every (result x evaluator) pair
        before answering, and model-graded pairs take seconds each. The old
        fixed 30s wire timeout aborted every realistic CI dataset CLIENT-side
        while the server kept grading - then the retry double-billed."""
        return self._request("POST", f"/v1/experiments/{experiment_id}/evaluate", {}, timeout=timeout)

    def check(
        self,
        experiment_id: str,
        baseline_experiment_id: Optional[str] = None,
        max_regression_pp: Optional[float] = None,
        min_pass_rate: Optional[float] = None,
    ) -> Dict[str, Any]:
        """The CI gate: pass/fail vs baseline. Inspect result["passed"]."""
        body: Dict[str, Any] = {"experimentId": experiment_id}
        if baseline_experiment_id is not None:
            body["baselineExperimentId"] = baseline_experiment_id
        if max_regression_pp is not None:
            body["maxRegressionPp"] = max_regression_pp
        if min_pass_rate is not None:
            body["minPassRate"] = min_pass_rate
        return self._request("POST", "/v1/checks", body)

    def run_experiment(
        self,
        dataset_id: str,
        version_label: str,
        run: Callable[[Dict[str, Any]], Dict[str, Any]],
        baseline_experiment_id: Optional[str] = None,
        max_regression_pp: Optional[float] = None,
        min_pass_rate: Optional[float] = None,
    ) -> Dict[str, Any]:
        """One-call harness flow: create -> run your fn per item -> submit -> evaluate -> gate.

        `run(item)` receives {"id", "input", "goal", "reference_output"} and must
        return {"output": str, "steps": optional list of step dicts}.
        Returns the check response; raise-free only if the pipeline itself worked.
        """
        items = self.get_dataset_items(dataset_id)
        if not items:
            raise RevalexApiError(400, "dataset has no items")
        experiment = self.create_experiment(dataset_id, version_label)

        results: List[Dict[str, Any]] = []
        for item in items:
            out = run(item)
            results.append(
                {"dataset_item_id": item["id"], "output": out["output"], "steps": out.get("steps")}
            )

        self.submit_results(experiment["id"], results)
        self.evaluate(experiment["id"])
        return self.check(
            experiment["id"],
            baseline_experiment_id=baseline_experiment_id,
            max_regression_pp=max_regression_pp,
            min_pass_rate=min_pass_rate,
        )
