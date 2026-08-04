"""RevalexClient — fail-open tracing for LLM/agent apps.

Design contract (mirrors the TypeScript SDK):
  1. FAIL-OPEN. Never crashes, blocks, or slows the host app. Sends
     happen on a daemon thread; every error is swallowed (surfaced
     only via the on_error callback).
  2. IDEMPOTENT. Every trace carries a client-generated UUID; the
     server dedupes, so retries can never double-count.
  3. BOUNDED. Memory is capped; when full, oldest traces drop and a
     counter records it.
"""

from __future__ import annotations

import atexit
import json as _json
import os
import threading
import time
import uuid
from collections import deque
from typing import Any, Callable, Dict, List, Optional

from ._wire import http_json, to_wire_trace

_MAX_RETRIES = 3
_BACKOFF_BASE = 0.5
# Byte budget per request. The API bodyLimit is 1 MB; batching by COUNT
# alone could exceed it (100 KB/field x 200 steps), get 413, and — treated
# as an unretryable 4xx — drop the whole batch permanently. Sizing by bytes
# keeps every multi-trace batch under the limit. Mirrors the TS SDK.
_MAX_BATCH_BYTES = 900_000

# Intake validation (mirrors the shared TraceInputSchema). Stdlib only — no
# pydantic. One malformed trace used to 400 the whole batch and silently
# drop up to 49 valid neighbours; validating here drops only the bad one.
_VALID_TYPES = {"llm_call", "agent_run"}
_VALID_STATUS = {"ok", "error"}
_MAX_STRING_BYTES = 100_000
_MAX_NAME_LEN = 256
_MAX_STEPS = 200


def _validate_trace(raw: Dict[str, Any]) -> Optional[str]:
    """Return an error string if the trace is invalid, else None."""
    if raw.get("type") not in _VALID_TYPES:
        return f"type must be one of {sorted(_VALID_TYPES)}"
    name = raw.get("name")
    if not isinstance(name, str) or not (0 < len(name) <= _MAX_NAME_LEN):
        return f"name must be a non-empty string <= {_MAX_NAME_LEN} chars"
    if raw.get("status") not in _VALID_STATUS:
        return f"status must be one of {sorted(_VALID_STATUS)}"
    for field in ("input", "output", "goal", "error_message"):
        v = raw.get(field)
        if v is not None and (not isinstance(v, str) or len(v.encode("utf-8")) > _MAX_STRING_BYTES):
            return f"{field} must be a string <= {_MAX_STRING_BYTES} bytes"
    steps = raw.get("steps")
    if steps is not None:
        if not isinstance(steps, list) or len(steps) > _MAX_STEPS:
            return f"steps must be a list of <= {_MAX_STEPS} items"
    for tok in ("tokens_in", "tokens_out"):
        v = raw.get(tok)
        if v is not None and (not isinstance(v, int) or v < 0):
            return f"{tok} must be a non-negative integer"
    return None


DEFAULT_BASE_URL = "https://api.revalex.com"


def _env_base_url() -> Optional[str]:
    """Revalex address from the environment, when set."""
    v = os.environ.get("REVALEX_API_URL")
    return v.strip() if v and v.strip() else None


class RevalexClient:
    def __init__(
        self,
        api_key: str,
        base_url: Optional[str] = None,
        flush_interval: float = 2.0,
        max_batch_size: int = 50,
        max_queue_size: int = 10_000,
        redact: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
        disabled: bool = False,
    ) -> None:
        if not api_key:
            raise ValueError("RevalexClient: api_key is required")
        self._api_key = api_key
        self._base_url = (base_url or _env_base_url() or DEFAULT_BASE_URL).rstrip("/")
        self._max_batch = min(max_batch_size, 100)
        self._max_queue = max_queue_size
        self._redact = redact
        self._on_error = on_error or (lambda _e: None)
        self._disabled = disabled

        self._queue: deque = deque()
        self._lock = threading.Lock()
        self._flush_lock = threading.Lock()
        self._stop = threading.Event()
        self.stats = {"enqueued": 0, "sent": 0, "dropped": 0, "failed": 0}

        self._thread: Optional[threading.Thread] = None
        if not disabled:
            self._thread = threading.Thread(
                target=self._loop, args=(flush_interval,), daemon=True, name="revalex-flusher"
            )
            self._thread.start()
            # The flusher is a daemon thread, so a script that ends would drop
            # anything still queued — silently, because we fail open. Drain at
            # interpreter exit so "run it once and watch it appear" is true.
            atexit.register(self._drain_at_exit)
            # Threads do not survive os.fork(): under gunicorn --preload /
            # celery prefork, every worker inherited a client whose flusher
            # only ever ran in the master - traces enqueued in workers sat in
            # memory forever. Recreate the locks and thread in each child.
            if hasattr(os, "register_at_fork"):
                os.register_at_fork(after_in_child=self._restart_after_fork)

    # ── public API ────────────────────────────────────────────────

    def trace(
        self,
        *,
        type: str,  # noqa: A002 — mirrors the wire field
        name: str,
        input: Optional[str] = None,  # noqa: A002
        output: Optional[str] = None,
        steps: Optional[List[Dict[str, Any]]] = None,
        goal: Optional[str] = None,
        status: str = "ok",
        error_message: Optional[str] = None,
        model: Optional[str] = None,
        tokens_in: Optional[int] = None,
        tokens_out: Optional[int] = None,
        cost_usd: Optional[float] = None,
        latency_ms: Optional[float] = None,
        version: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        client_trace_id: Optional[str] = None,
    ) -> None:
        """Record a trace. Returns immediately; never raises."""
        # After shutdown() the flusher is stopped and the atexit drain is a
        # no-op, so anything enqueued now would be counted 'enqueued' and then
        # silently lost. Drop it loudly instead — a trace() after close() is a
        # caller bug worth surfacing, not a phantom success.
        if getattr(self, "_drained", False):
            with self._lock:
                self.stats["dropped"] += 1
            try:
                self._on_error(RuntimeError("Revalex: trace() called after shutdown() — client is closed; trace dropped"))
            except Exception:
                pass
            return
        try:
            raw = {
                "client_trace_id": client_trace_id or str(uuid.uuid4()),
                "type": type,
                "name": name,
                "input": input,
                "output": output,
                "steps": steps,
                "goal": goal,
                "status": status,
                "error_message": error_message,
                "model": model,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "cost_usd": cost_usd,
                "latency_ms": latency_ms,
                "version": version,
                "metadata": metadata,
            }
            # Redact BEFORE the camelCase wire conversion. The documented
            # Python surface is snake_case - a hook that popped
            # "error_message" after conversion silently no-opped against
            # "errorMessage", and the PII it meant to strip went out anyway.
            if self._redact:
                raw = self._redact(raw)
            # Validate the ONE trace here so a single malformed trace cannot
            # 400 the whole batch server-side and take its valid neighbours
            # down with it. Drop only this one; surface via on_error.
            err = _validate_trace(raw)
            if err is not None:
                with self._lock:
                    self.stats["dropped"] += 1
                try:
                    self._on_error(ValueError(f"Revalex: invalid trace dropped — {err}"))
                except Exception:
                    pass
                return
            payload = to_wire_trace(raw)
            body_bytes = len(_json.dumps(payload).encode("utf-8"))
            if self._disabled:
                with self._lock:
                    self.stats["enqueued"] += 1
                return
            with self._lock:
                # Counters live under the SAME lock as the queue: bare
                # read-modify-write from app threads + the flusher lost
                # updates and made the one diagnostic surface lie.
                self.stats["enqueued"] += 1
                if len(self._queue) >= self._max_queue:
                    self._queue.popleft()  # drop oldest — bounded memory beats OOM
                    self.stats["dropped"] += 1
                self._queue.append({"t": payload, "n": 0, "b": body_bytes})
        except Exception as e:  # fail-open: never leak into the host app
            with self._lock:
                self.stats["failed"] += 1
            try:
                self._on_error(e)
            except Exception:
                pass

    _MAX_SEND_CYCLES = 3

    def flush(self, deadline_s: Optional[float] = None) -> None:
        """Force-send everything queued. Safe to call any time; never raises.

        deadline_s bounds the WHOLE drain (used by the exit hook): the old
        unbounded drain could block a finishing script for ~2 minutes of
        retries against a black-holed endpoint - a fail-open SDK must never
        hold the interpreter hostage at exit."""
        if self._disabled:
            return
        deadline = (time.monotonic() + deadline_s) if deadline_s is not None else None
        with self._flush_lock:
            while True:
                if deadline is not None and time.monotonic() >= deadline:
                    return
                with self._lock:
                    if not self._queue:
                        return
                    # Batch by COUNT and BYTES (always at least one trace),
                    # so a batch can never exceed the server's 1 MB limit.
                    batch = []
                    bytes_so_far = 0
                    while self._queue and len(batch) < self._max_batch:
                        nxt = self._queue[0]
                        if batch and bytes_so_far + nxt.get("b", 0) > _MAX_BATCH_BYTES:
                            break
                        batch.append(self._queue.popleft())
                        bytes_so_far += nxt.get("b", 0)
                outcome = self._send([q["t"] for q in batch], deadline)
                if outcome == "split" and len(batch) > 1:
                    # 413 on a multi-trace batch: put it back and force one
                    # trace per request next pass by bumping each byte size.
                    with self._lock:
                        for q in batch:
                            q["b"] = _MAX_BATCH_BYTES
                        self._queue.extendleft(reversed(batch))
                    continue
                if outcome == "split":
                    # A single trace over the limit can never fit — drop it.
                    with self._lock:
                        self.stats["dropped"] += 1
                    self._on_error(Exception("Revalex: single trace exceeds the 1 MB body limit — dropped; trim input/output/steps"))
                    continue
                if outcome == "dropped":
                    # Terminal 4xx already counted in _send — do not requeue.
                    continue
                if outcome != "sent":
                    # Requeue at the FRONT - a transient outage must not eat
                    # the batch. After _MAX_SEND_CYCLES failed cycles a trace
                    # is dropped for real and counted.
                    kept = []
                    with self._lock:
                        for q in batch:
                            q["n"] += 1
                            if q["n"] >= self._MAX_SEND_CYCLES:
                                self.stats["failed"] += 1
                            else:
                                kept.append(q)
                        self._queue.extendleft(reversed(kept))
                    return  # stop draining this cycle; endpoint unhealthy

    def shutdown(self) -> None:
        """Stop the flusher thread and flush what's left."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        self.flush(deadline_s=10.0)
        # Registered handler is now redundant; make it a no-op.
        self._drained = True

    def _drain_at_exit(self) -> None:
        """atexit hook — send whatever is queued. Never raises (fail-open)."""
        if getattr(self, "_drained", False):
            return
        self._drained = True
        try:
            self._stop.set()
            self.flush(deadline_s=5.0)
        except Exception:  # noqa: BLE001 - exit-time drain must never raise
            pass

    def _restart_after_fork(self) -> None:
        """Child process after os.fork(): locks may be held by a thread that
        no longer exists, and the flusher thread is gone. Fresh primitives,
        fresh thread; the inherited queue snapshot flushes from the child."""
        try:
            self._lock = threading.Lock()
            self._flush_lock = threading.Lock()
            self._stop = threading.Event()
            if not self._disabled and not getattr(self, "_drained", False):
                self._thread = threading.Thread(
                    target=self._loop, args=(2.0,), daemon=True, name="revalex-flusher"
                )
                self._thread.start()
        except Exception:  # noqa: BLE001 - fork repair must never break the child
            pass

    def __enter__(self) -> "RevalexClient":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.shutdown()

    # ── internals ─────────────────────────────────────────────────

    def _loop(self, interval: float) -> None:
        while not self._stop.wait(interval):
            try:
                self.flush()
            except Exception:
                pass  # the flusher must never die

    def _send(self, traces: List[Dict[str, Any]], deadline: Optional[float] = None) -> str:
        """Deliver one batch. Returns an outcome the drain loop acts on:
          "sent"    - 2xx, counted delivered.
          "dropped" - terminal 4xx (bad key/payload); counted dropped, no requeue.
          "split"   - 413 Payload Too Large; caller re-sends one trace per request.
          "retry"   - transient (5xx/429/timeout/network/out-of-budget); requeue.
        """
        for attempt in range(_MAX_RETRIES + 1):
            timeout = 30.0
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0.5:
                    return "retry"  # out of budget - the requeue path keeps the batch
                timeout = min(timeout, remaining)
            try:
                status, _body = http_json(
                    "POST", f"{self._base_url}/v1/traces", self._api_key, {"traces": traces},
                    timeout=timeout,
                )
                if 200 <= status < 300:
                    with self._lock:
                        self.stats["sent"] += len(traces)
                    return "sent"
                if status == 413:
                    # Body too large. A multi-trace batch can be split; a lone
                    # trace over the limit is unfixable (handled by the caller).
                    return "split"
                if 400 <= status < 500 and status != 429:
                    # our payload/key is wrong - retrying won't help. Counted
                    # DROPPED, not sent: a rejected batch was not delivered.
                    with self._lock:
                        self.stats["dropped"] += len(traces)
                    self._on_error(Exception(f"Revalex server rejected batch ({status})"))
                    return "dropped"  # handled: don't loop forever
            except Exception as e:
                try:
                    self._on_error(e)
                except Exception:
                    pass
            # No sleep after the FINAL attempt - it only delayed exit drains.
            if attempt < _MAX_RETRIES:
                time.sleep(_BACKOFF_BASE * (2**attempt))
        return "retry"
