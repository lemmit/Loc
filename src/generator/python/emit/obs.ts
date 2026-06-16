// ---------------------------------------------------------------------------
// Observability (docs/observability.md) + the ambient execution-context
// carrier (docs/architecture/request-context.md) — `app/obs/` for the
// Python backend.  One JSON object per log line on stdout with the catalog
// envelope (`ts` / `level` / `event` / `request_id`); structured fields
// ride as additional top-level snake_case keys — the same flat shape
// the Hono backend's pino stream produces, so the per-backend obs e2e
// suites assert one contract.
//
//   app/obs/log.py        — CatalogFormatter + the `log(level, event,
//                           **fields)` facade + the RequestContext carrier
//                           (a ContextVar usable from any layer).  The
//                           carrier SUBSUMES the old request-id contextvar:
//                           one ambient channel, not two (request-context.md
//                           "subsume, don't add a second channel") — the
//                           log line's `request_id` is the carrier's
//                           correlation_id.
//   app/obs/middleware.py — request bracket: opens the carrier (correlation
//                           id from x-correlation-id || x-request-id ||
//                           minted, root scope id, locale, start time),
//                           logs request_start/request_end, echoes the
//                           correlation id on both headers.
//
// Event identities come from `src/generator/_obs/log-events.ts` — the
// single cross-backend catalog.
// ---------------------------------------------------------------------------

export const OBS_LOG_PY = `"""Structured JSON logging + ambient request context (observability.md,
architecture/request-context.md).  Auto-generated.

One JSON object per line on stdout: the catalog envelope (ts / level /
event / request_id) plus the event's structured fields as top-level
keys.  The \`request_id\` field is the current request's correlation id,
read from the ambient RequestContext carrier below.
"""

import json
import logging
import sys
import uuid
from contextvars import ContextVar, Token
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any

TRACE = 5  # below DEBUG — the catalog's domain-trace level
logging.addLevelName(TRACE, "TRACE")

_LEVELNO = {
    "trace": TRACE,
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "error": logging.ERROR,
}
_LEVEL_NAME = {v: k for k, v in _LEVELNO.items()}


@dataclass(frozen=True)
class RequestContext:
    """Ambient per-request execution context (architecture/request-context.md).

    Opened at the HTTP edge by ObservabilityMiddleware; read anywhere via the
    accessors below without threading a request handle.
    """

    correlation_id: str
    scope_id: str
    parent_id: str | None = None
    actor_id: str | None = None
    locale: str = "en"
    started_at: float = 0.0


request_context_var: ContextVar[RequestContext | None] = ContextVar(
    "loom_request_context", default=None
)


def new_id() -> str:
    """Mint a fresh id (correlation / scope)."""
    return uuid.uuid4().hex


def current_context() -> RequestContext | None:
    """The ambient context for the current request, or None outside one."""
    return request_context_var.get()


def correlation_id() -> str | None:
    ctx = request_context_var.get()
    return ctx.correlation_id if ctx is not None else None


def scope_id() -> str | None:
    ctx = request_context_var.get()
    return ctx.scope_id if ctx is not None else None


def parent_id() -> str | None:
    ctx = request_context_var.get()
    return ctx.parent_id if ctx is not None else None


def actor_id() -> str | None:
    """The principal id, or None before auth runs / under no-auth."""
    ctx = request_context_var.get()
    return ctx.actor_id if ctx is not None else None


def locale() -> str:
    ctx = request_context_var.get()
    return ctx.locale if ctx is not None else "en"


def started_at() -> float:
    ctx = request_context_var.get()
    return ctx.started_at if ctx is not None else 0.0


def set_actor_id(value: str) -> None:
    """Stamp the principal id once auth resolves it.  Only the id rides the
    carrier; the full principal stays on request.state.current_user."""
    ctx = request_context_var.get()
    if ctx is not None:
        request_context_var.set(replace(ctx, actor_id=value))


def open_context(ctx: RequestContext) -> Token[RequestContext | None]:
    """Open the carrier for the current request; returns a reset token."""
    return request_context_var.set(ctx)


def reset_context(token: Token[RequestContext | None]) -> None:
    request_context_var.reset(token)


class CatalogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        body: dict[str, Any] = {
            "ts": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": _LEVEL_NAME.get(record.levelno, "info"),
            "event": record.getMessage(),
        }
        cid = correlation_id()
        if cid is not None:
            body["request_id"] = cid
        fields = getattr(record, "loom_fields", None)
        if isinstance(fields, dict):
            body.update(fields)
        return json.dumps(body, default=str)


def _build_logger() -> logging.Logger:
    logger = logging.getLogger("loom")
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(CatalogFormatter())
    logger.addHandler(handler)
    logger.setLevel(TRACE)
    logger.propagate = False
    return logger


_logger = _build_logger()


def log(level: str, event: str, **fields: object) -> None:
    """Emit one catalog line.  \`event\` is the catalog identity; fields
    ride as top-level keys next to the envelope."""
    _logger.log(_LEVELNO.get(level, logging.INFO), event, extra={"loom_fields": fields})
`;

export const OBS_MIDDLEWARE_PY = `"""Request bracket middleware (observability.md) + execution-context
carrier boundary (architecture/request-context.md).  Auto-generated.

Opens the ambient RequestContext at the HTTP edge — correlation id from
x-correlation-id || x-request-id || minted, a fresh root scope id, the
request locale, and the start time — brackets the request with
request_start / request_end, and echoes the correlation id back on both
x-correlation-id and x-request-id.  Added last in app/main.py so it runs
outermost: the context is open before auth (which stamps actor_id) runs.
"""

import time

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from app.obs.log import RequestContext, log, new_id, open_context, reset_context


class ObservabilityMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        correlation = (
            request.headers.get("x-correlation-id")
            or request.headers.get("x-request-id")
            or new_id()
        )
        token = open_context(
            RequestContext(
                correlation_id=correlation,
                scope_id=new_id(),
                locale=request.headers.get("accept-language") or "en",
                started_at=time.time(),
            )
        )
        started = time.monotonic()
        log("info", "request_start", method=request.method, path=request.url.path)
        try:
            response = await call_next(request)
        except Exception:
            log(
                "info",
                "request_end",
                method=request.method,
                path=request.url.path,
                status=500,
                duration_ms=int((time.monotonic() - started) * 1000),
            )
            reset_context(token)
            raise
        log(
            "info",
            "request_end",
            method=request.method,
            path=request.url.path,
            status=response.status_code,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        response.headers["x-request-id"] = correlation
        response.headers["x-correlation-id"] = correlation
        reset_context(token)
        return response
`;
