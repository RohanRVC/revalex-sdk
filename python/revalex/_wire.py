"""Wire-format helpers: snake_case (Python) -> camelCase (Revalex API)."""

from __future__ import annotations

from typing import Any, Dict, Optional

_TRACE_KEYS = {
    "client_trace_id": "clientTraceId",
    "error_message": "errorMessage",
    "tokens_in": "tokensIn",
    "tokens_out": "tokensOut",
    "cost_usd": "costUsd",
    "latency_ms": "latencyMs",
    "started_at": "startedAt",
    "ended_at": "endedAt",
}

_STEP_KEYS = {
    "tool_name": "toolName",
    "error_message": "errorMessage",
    "tokens_in": "tokensIn",
    "tokens_out": "tokensOut",
    "latency_ms": "latencyMs",
    "started_at": "startedAt",
    "ended_at": "endedAt",
}

_RESULT_KEYS = {"dataset_item_id": "datasetItemId"}


def _map_keys(d: Dict[str, Any], mapping: Dict[str, str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, v in d.items():
        if v is None:
            continue
        out[mapping.get(k, k)] = v
    return out


def to_wire_step(step: Dict[str, Any]) -> Dict[str, Any]:
    return _map_keys(step, _STEP_KEYS)


def to_wire_trace(trace: Dict[str, Any]) -> Dict[str, Any]:
    wire = _map_keys(trace, _TRACE_KEYS)
    if "steps" in wire and isinstance(wire["steps"], list):
        wire["steps"] = [to_wire_step(s) for s in wire["steps"]]
    return wire


def to_wire_result(result: Dict[str, Any]) -> Dict[str, Any]:
    wire = _map_keys(result, _RESULT_KEYS)
    if "steps" in wire and isinstance(wire["steps"], list):
        wire["steps"] = [to_wire_step(s) for s in wire["steps"]]
    return wire


def http_json(
    method: str,
    url: str,
    api_key: str,
    body: Optional[Dict[str, Any]] = None,
    timeout: float = 30.0,
):
    """Minimal stdlib JSON HTTP. Returns (status, parsed_json_or_None)."""
    import json as _json
    import urllib.error
    import urllib.request

    data = _json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("authorization", f"Bearer {api_key}")
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (https in prod)
            payload = resp.read()
            return resp.status, (_json.loads(payload) if payload else None)
    except urllib.error.HTTPError as e:  # non-2xx still carries a JSON body
        payload = e.read()
        try:
            return e.code, (_json.loads(payload) if payload else None)
        except Exception:
            return e.code, None
