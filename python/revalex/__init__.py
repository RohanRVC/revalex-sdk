"""Revalex Python SDK.

- RevalexClient: fail-open tracing (never crashes or slows your app).
- RevalexApi: CI harness helpers (throws loudly — a broken eval pipeline
  must fail the build, never silently pass).
"""

from .client import RevalexClient
from .api import RevalexApi, RevalexApiError
from .instrument import instrument_anthropic, instrument_openai

__all__ = ["RevalexClient", "RevalexApi", "RevalexApiError", "instrument_anthropic", "instrument_openai"]
__version__ = "0.1.0"
