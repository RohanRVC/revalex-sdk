"""Auto-instrumentation for Anthropic and OpenAI clients.

Duck-typed (zero dependencies): pass the provider client in, its
create() method gets wrapped so every call is traced. Behavior is
never changed — results and errors pass through untouched; capture
failures are swallowed (fail-open).

    from revalex import RevalexClient, instrument_anthropic
    import anthropic

    revalex = RevalexClient(api_key="rvx_live_...")
    client = instrument_anthropic(anthropic.Anthropic(), revalex)
    # every client.messages.create(...) is now traced
"""

from __future__ import annotations

import json
import time
from typing import Any, Optional

from .client import RevalexClient

_MAX_CAPTURE = 20_000


def _short(v: Any) -> Optional[str]:
    try:
        s = v if isinstance(v, str) else json.dumps(v, default=str)
        return s[:_MAX_CAPTURE] + "…" if len(s) > _MAX_CAPTURE else s
    except Exception:
        return None


def instrument_anthropic(client: Any, revalex: RevalexClient, name: Optional[str] = None, capture_content: bool = True) -> Any:
    """Wrap an Anthropic SDK client's messages.create with tracing."""
    original = client.messages.create
    trace_name = name or "anthropic.messages.create"

    def wrapped(*args: Any, **kwargs: Any) -> Any:
        started = time.time()
        try:
            result = original(*args, **kwargs)
        except Exception as e:
            _safe_trace(
                revalex,
                name=trace_name,
                model=kwargs.get("model"),
                input=_short(kwargs.get("messages")) if capture_content else None,
                status="error",
                error_message=str(e)[:4000],
                latency_ms=(time.time() - started) * 1000,
            )
            raise
        try:
            streaming = kwargs.get("stream") is True
            text_out = None
            if not streaming:
                blocks = getattr(result, "content", None) or []
                parts = [getattr(b, "text", None) for b in blocks if getattr(b, "type", None) == "text"]
                text_out = "\n".join(p for p in parts if p) or None
            usage = getattr(result, "usage", None)
            _safe_trace(
                revalex,
                name=trace_name,
                model=getattr(result, "model", None) or kwargs.get("model"),
                input=_short(kwargs.get("messages")) if capture_content else None,
                output=_short(text_out) if (capture_content and text_out) else None,
                tokens_in=getattr(usage, "input_tokens", None),
                tokens_out=getattr(usage, "output_tokens", None),
                status="ok",
                metadata={"streaming": True} if streaming else None,
                latency_ms=(time.time() - started) * 1000,
            )
        except Exception:
            pass  # capture must never break the app
        return result

    client.messages.create = wrapped
    return client


def instrument_openai(client: Any, revalex: RevalexClient, name: Optional[str] = None, capture_content: bool = True) -> Any:
    """Wrap an OpenAI SDK client's chat.completions.create with tracing."""
    original = client.chat.completions.create
    trace_name = name or "openai.chat.completions.create"

    def wrapped(*args: Any, **kwargs: Any) -> Any:
        started = time.time()
        try:
            result = original(*args, **kwargs)
        except Exception as e:
            _safe_trace(
                revalex,
                name=trace_name,
                model=kwargs.get("model"),
                input=_short(kwargs.get("messages")) if capture_content else None,
                status="error",
                error_message=str(e)[:4000],
                latency_ms=(time.time() - started) * 1000,
            )
            raise
        try:
            streaming = kwargs.get("stream") is True
            text_out = None
            if not streaming:
                choices = getattr(result, "choices", None) or []
                if choices:
                    message = getattr(choices[0], "message", None)
                    text_out = getattr(message, "content", None)
            usage = getattr(result, "usage", None)
            _safe_trace(
                revalex,
                name=trace_name,
                model=getattr(result, "model", None) or kwargs.get("model"),
                input=_short(kwargs.get("messages")) if capture_content else None,
                output=_short(text_out) if (capture_content and text_out) else None,
                tokens_in=getattr(usage, "prompt_tokens", None),
                tokens_out=getattr(usage, "completion_tokens", None),
                status="ok",
                metadata={"streaming": True} if streaming else None,
                latency_ms=(time.time() - started) * 1000,
            )
        except Exception:
            pass
        return result

    client.chat.completions.create = wrapped
    return client


def _safe_trace(revalex: RevalexClient, **kwargs: Any) -> None:
    try:
        revalex.trace(type="llm_call", **{k: v for k, v in kwargs.items() if v is not None})
    except Exception:
        pass
