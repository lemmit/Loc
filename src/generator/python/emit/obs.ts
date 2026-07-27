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

import {
  HttpSpanAttr,
  OTEL_ENDPOINT_ENV,
  OTEL_SERVICE_NAME_ENV,
  SpanAttr,
} from "../../_obs/tracing.js";

/** `app/obs/tracing.py` — the OTel tracer provider (conditional OTLP export)
 *  + hex-id formatters the request middleware consumes.  A SERVER span opens
 *  on every request (so trace_id rides the logs); spans EXPORT via OTLP/HTTP
 *  only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. */
export function renderPythonTracingFile(serviceName: string): string {
  return `"""OpenTelemetry tracing (observability.md).  Auto-generated.

A SERVER span opens on every request so its trace_id / span_id ride the log
envelope (log<->trace correlation); spans are EXPORTED via OTLP/HTTP only when
OTEL_EXPORTER_OTLP_ENDPOINT is set.
"""

import os

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

_endpoint = os.environ.get("${OTEL_ENDPOINT_ENV}")
_provider = TracerProvider(
    resource=Resource.create(
        {"service.name": os.environ.get("${OTEL_SERVICE_NAME_ENV}", ${JSON.stringify(serviceName)})}
    )
)
if _endpoint:
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

    _provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{_endpoint.rstrip('/')}/v1/traces"))
    )
trace.set_tracer_provider(_provider)

#: The tracer every request seam opens its SERVER span from.
tracer = trace.get_tracer("loom")


def format_trace_id(trace_id: int) -> str:
    """OTel trace id (128-bit int) -> the canonical 32-char lowercase hex."""
    return format(trace_id, "032x")


def format_span_id(span_id: int) -> str:
    """OTel span id (64-bit int) -> the canonical 16-char lowercase hex."""
    return format(span_id, "016x")


def shutdown_tracing() -> None:
    """Flush + shut down the span exporter on drain (no-op without export)."""
    _provider.shutdown()
`;
}

export const OBS_LOG_PY = `"""Structured JSON logging + ambient request context (observability.md,
architecture/request-context.md).  Auto-generated.

One JSON object per line on stdout: the catalog envelope (ts / level /
event / request_id) plus the event's structured fields as top-level
keys.  The \`request_id\` field is the current request's correlation id,
read from the ambient RequestContext carrier below.
"""

import functools
import json
import logging
import os
import sys
import uuid
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, ParamSpec, TypeVar

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
    # OTel span/trace ids (hex) — the log<->trace join keys, stamped onto every
    # request-scoped line beside scope_id (observability.md).  Empty outside a
    # traced request.
    trace_id: str = ""
    span_id: str = ""


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


def trace_id() -> str | None:
    """The current request's OTel trace id (hex), or None outside a request."""
    ctx = request_context_var.get()
    return ctx.trace_id if ctx is not None and ctx.trace_id else None


def span_id() -> str | None:
    """The current request span's id (hex), or None outside a request."""
    ctx = request_context_var.get()
    return ctx.span_id if ctx is not None and ctx.span_id else None


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


@contextmanager
def child_context() -> Iterator[None]:
    """Open a CHILD execution-context frame under the current one for the
    duration of the block, restoring the parent on exit
    (architecture/request-context.md, per-dispatch boundary seam).  The child
    inherits the request-stable tier (correlation id, actor, locale, start
    time) but mints a fresh \`scope_id\` whose \`parent_id\` chains to the
    caller's \`scope_id\` — so audit / provenance rows and log lines emitted
    inside record their call-structure position (a workflow's lineage is
    distinguishable from a direct operation's).  Outside any request (no
    current frame) it is a no-op, so non-request callers pay nothing."""
    parent = request_context_var.get()
    if parent is None:
        yield
        return
    token = request_context_var.set(
        replace(parent, scope_id=new_id(), parent_id=parent.scope_id)
    )
    try:
        yield
    finally:
        request_context_var.reset(token)


_P = ParamSpec("_P")
_R = TypeVar("_R")


def in_child_context(fn: Callable[_P, Awaitable[_R]]) -> Callable[_P, Awaitable[_R]]:
    """Decorator: run an async dispatch boundary (a workflow route handler or
    an event reactor) inside a \`child_context()\` frame.  \`functools.wraps\`
    preserves the wrapped signature so FastAPI's dependency injection still
    resolves the route's parameters."""

    @functools.wraps(fn)
    async def _wrapped(*args: _P.args, **kwargs: _P.kwargs) -> _R:
        with child_context():
            return await fn(*args, **kwargs)

    return _wrapped


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
        # The carrier's frame / actor ids, read at format time so every line
        # joins to the audit / provenance rows of the same frame (scope_id) and
        # to the actor (actor_id, once auth has run).
        sid = scope_id()
        if sid is not None:
            body["scope_id"] = sid
        pid = parent_id()
        if pid is not None:
            body["parent_id"] = pid
        aid = actor_id()
        if aid is not None:
            body["actor_id"] = aid
        # trace_id / span_id join every request-scoped line to its OTel span
        # (log<->trace correlation), read at format time like scope_id above.
        tid = trace_id()
        if tid is not None:
            body["trace_id"] = tid
        spid = span_id()
        if spid is not None:
            body["span_id"] = spid
        fields = getattr(record, "loom_fields", None)
        if isinstance(fields, dict):
            body.update(fields)
        return json.dumps(body, default=str)


def _build_logger() -> logging.Logger:
    logger = logging.getLogger("loom")
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(CatalogFormatter())
    logger.addHandler(handler)
    # Runtime log-level knob — LOG_LEVEL (default "info"), mapped via the
    # catalog's _LEVELNO (trace/debug/info/warn/error).  Distinct from the
    # generate-time --trace switch.
    logger.setLevel(_LEVELNO.get(os.environ.get("LOG_LEVEL", "info").lower(), logging.INFO))
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

Pure-ASGI (NOT BaseHTTPMiddleware): BaseHTTPMiddleware runs the inner app
in a child task, which defers \`yield\`-dependency teardown — including the
per-request DB commit — until after the response is sent.  Pure ASGI keeps
the endpoint in the same task, so TransactionMiddleware's commit-before-send
holds and read-after-create doesn't race the commit.
"""

import time

from opentelemetry.trace import SpanKind, Status, StatusCode
from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.obs.log import RequestContext, actor_id, log, new_id, open_context, reset_context
from app.obs.metrics import record_http_request
from app.obs.tracing import format_span_id, format_trace_id, tracer


class ObservabilityMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        correlation = (
            request.headers.get("x-correlation-id")
            or request.headers.get("x-request-id")
            or new_id()
        )
        method = request.method
        path = request.url.path
        scope_id = new_id()
        # Open the request's OTel SERVER span.  Created on EVERY request so its
        # trace_id / span_id ride the logs; exported only when a collector
        # endpoint is set.  Renamed to the resolved route template on exit.
        span = tracer.start_span(
            f"{method} {path}",
            kind=SpanKind.SERVER,
            attributes={
                "${SpanAttr.correlationId}": correlation,
                "${SpanAttr.scopeId}": scope_id,
                "${HttpSpanAttr.method}": method,
                "${HttpSpanAttr.path}": path,
            },
        )
        span_ctx = span.get_span_context()
        token = open_context(
            RequestContext(
                correlation_id=correlation,
                scope_id=scope_id,
                locale=request.headers.get("accept-language") or "en",
                started_at=time.time(),
                trace_id=format_trace_id(span_ctx.trace_id),
                span_id=format_span_id(span_ctx.span_id),
            )
        )
        started = time.monotonic()
        log("info", "request_start", method=method, path=path)

        status_code = 500

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                nonlocal status_code
                status_code = message["status"]
                headers = MutableHeaders(scope=message)
                headers["x-request-id"] = correlation
                headers["x-correlation-id"] = correlation
            await send(message)

        def _end_span(status: int) -> None:
            # Close the SERVER span at the request_end seam: rename to the
            # resolved route template, stamp status + the actor id (attached by
            # auth mid-request), and mark 5xx as span errors.
            route = _route_template(scope, path)
            span.update_name(f"{method} {route}")
            span.set_attribute("${HttpSpanAttr.route}", route)
            span.set_attribute("${HttpSpanAttr.statusCode}", status)
            aid = actor_id()
            if aid is not None:
                span.set_attribute("${SpanAttr.actorId}", aid)
            span.set_status(Status(StatusCode.ERROR if status >= 500 else StatusCode.OK))
            span.end()

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            duration_ms = int((time.monotonic() - started) * 1000)
            log(
                "info",
                "request_end",
                method=method,
                path=path,
                status=500,
                duration_ms=duration_ms,
            )
            record_http_request(method, _route_template(scope, path), 500, duration_ms)
            _end_span(500)
            reset_context(token)
            raise
        duration_ms = int((time.monotonic() - started) * 1000)
        log(
            "info",
            "request_end",
            method=method,
            path=path,
            status=status_code,
            duration_ms=duration_ms,
        )
        # Record the same finished request against the Prometheus HTTP metrics
        # — same seam as request_end.  Labelled by the matched route TEMPLATE
        # (not the raw path) so cardinality stays bounded.
        record_http_request(method, _route_template(scope, path), status_code, duration_ms)
        _end_span(status_code)
        reset_context(token)


def _route_template(scope: Scope, fallback: str) -> str:
    """The matched route's path template (\`/api/carts/{cart_id}\`) for a
    bounded Prometheus \`route\` label.  Starlette stores the matched Route on
    the scope after routing; before a match (404) it falls back to the raw
    path, which for parameter-less probes (/health, /metrics) is already the
    template."""
    route = scope.get("route")
    template = getattr(route, "path", None)
    return template if isinstance(template, str) else fallback
`;
