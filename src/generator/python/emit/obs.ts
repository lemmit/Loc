// ---------------------------------------------------------------------------
// Observability (docs/observability.md) — `app/obs/` for the Python
// backend.  One JSON object per log line on stdout with the catalog
// envelope (`ts` / `level` / `event` / `request_id`); structured fields
// ride as additional top-level snake_case keys — the same flat shape
// the Hono backend's pino stream produces, so the per-backend obs e2e
// suites assert one contract.
//
//   app/obs/log.py        — CatalogFormatter + the `log(level, event,
//                           **fields)` facade + the contextvar carrying
//                           the request id (usable from any layer).
//   app/obs/middleware.py — request bracket: request_start/request_end
//                           with method/path/status/duration_ms, honors
//                           an inbound x-request-id, echoes it back.
//
// Event identities come from `src/generator/_obs/log-events.ts` — the
// single cross-backend catalog.
// ---------------------------------------------------------------------------

export const OBS_LOG_PY = `"""Structured JSON logging (observability.md).  Auto-generated.

One JSON object per line on stdout: the catalog envelope (ts / level /
event / request_id) plus the event's structured fields as top-level
keys.
"""

import json
import logging
import sys
from contextvars import ContextVar
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

request_id_var: ContextVar[str | None] = ContextVar("loom_request_id", default=None)


class CatalogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        body: dict[str, Any] = {
            "ts": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": _LEVEL_NAME.get(record.levelno, "info"),
            "event": record.getMessage(),
        }
        rid = request_id_var.get()
        if rid is not None:
            body["request_id"] = rid
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

export const OBS_MIDDLEWARE_PY = `"""Request bracket middleware (observability.md).  Auto-generated.

Brackets every request with request_start / request_end, correlated by
a request id (inbound x-request-id honored, else minted) that every log
line inside the request scope inherits via the contextvar.
"""

import time
import uuid

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from app.obs.log import log, request_id_var


class ObservabilityMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        token = request_id_var.set(rid)
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
            request_id_var.reset(token)
            raise
        log(
            "info",
            "request_end",
            method=request.method,
            path=request.url.path,
            status=response.status_code,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        response.headers["x-request-id"] = rid
        request_id_var.reset(token)
        return response
`;
