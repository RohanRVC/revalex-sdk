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

import threading
import time
import uuid
from collections import deque
from typing import Any, Callable, Dict, List, Optional

from ._wire import http_json, to_wire_trace

_MAX_RETRIES = 3
_BACKOFF_BASE = 0.5


class RevalexClient:
    def __init__(
        self,
        api_key: str,
        base_url: str = "http://localhost:4000",
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
        self._base_url = base_url.rstrip("/")
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
        try:
            payload = to_wire_trace(
                {
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
            )
            if self._redact:
                payload = self._redact(payload)
            self.stats["enqueued"] += 1
            if self._disabled:
                return
            with self._lock:
                if len(self._queue) >= self._max_queue:
                    self._queue.popleft()  # drop oldest — bounded memory beats OOM
                    self.stats["dropped"] += 1
                self._queue.append(payload)
        except Exception as e:  # fail-open: never leak into the host app
            self.stats["failed"] += 1
            try:
                self._on_error(e)
            except Exception:
                pass

    def flush(self) -> None:
        """Force-send everything queued. Safe to call any time; never raises."""
        if self._disabled:
            return
        with self._flush_lock:
            while True:
                with self._lock:
                    if not self._queue:
                        return
                    take = min(self._max_batch, len(self._queue))
                    batch = [self._queue.popleft() for _ in range(take)]
                if not self._send(batch):
                    self.stats["failed"] += len(batch)
                    return  # stop draining on persistent failure; retry next interval

    def shutdown(self) -> None:
        """Stop the flusher thread and flush what's left."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        self.flush()

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

    def _send(self, traces: List[Dict[str, Any]]) -> bool:
        for attempt in range(_MAX_RETRIES + 1):
            try:
                status, _body = http_json(
                    "POST", f"{self._base_url}/v1/traces", self._api_key, {"traces": traces}
                )
                if 200 <= status < 300:
                    self.stats["sent"] += len(traces)
                    return True
                if 400 <= status < 500 and status != 429:
                    # our payload/key is wrong — retrying won't help
                    self._on_error(Exception(f"Revalex server rejected batch ({status})"))
                    return True  # handled: don't loop forever
            except Exception as e:
                try:
                    self._on_error(e)
                except Exception:
                    pass
            time.sleep(_BACKOFF_BASE * (2**attempt))
        return False
