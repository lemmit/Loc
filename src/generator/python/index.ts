import { pagedReturn } from "../../ir/stdlib/generics.js";
import type {
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  SystemIR,
} from "../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../ir/types/migrations-ir.js";
import { resolveDataSourceConfig } from "../../ir/util/resolve-datasource.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import {
  abstractBasesOf,
  buildPyBaseReaderFile,
  buildPyBaseUnionFile,
  concretesOf,
} from "./base-reader-builder.js";
import { renderPyAggregate } from "./emit/aggregate.js";
import { ERRORS_PY } from "./emit/errors.js";
import { renderPyEvents } from "./emit/events.js";
import { renderPyWireModels } from "./emit/http-models.js";
import { renderPyIds } from "./emit/ids.js";
import { emitPythonMigrations, MIGRATE_PY } from "./emit/migrations.js";
import { renderPySchema } from "./emit/schema.js";
import { renderPyTestsFile } from "./emit/tests.js";
import { renderPyEnumsAndValueObjects } from "./emit/value-objects.js";
import { PYTHON_PINS } from "./pins.js";
import { buildPyRepositoryFile } from "./repository-builder.js";
import { buildPyEventSourcedRepositoryFile } from "./repository-eventsourced-builder.js";
import { buildPyRoutesFile } from "./routes-builder.js";
import { buildPyViewsFile } from "./views-builder.js";
import { buildPyWorkflowsFile, commandWorkflowsOf } from "./workflows-builder.js";

// ---------------------------------------------------------------------------
// Python / FastAPI generator orchestrator.
//
// `generatePythonForContexts` is the single entry point called by the
// platform's `emitProject` (src/platform/python.ts).  It mirrors
// dotnet/index.ts's shape: iterate contexts → call per-emitter
// functions → add the project shell.
//
// File layout (grows slice by slice — docs/plans/python-backend-plan.md):
//   pyproject.toml                  — uv-managed project + tool config
//   Dockerfile, .dockerignore       — python:3.12-slim + uv image
//   certs/.gitkeep                  — proxy-CA escape hatch
//   app/main.py                     — FastAPI app: CORS, /health, /ready
//   app/settings.py                 — DATABASE_URL from env
//   app/db/engine.py                — async engine + session factory
//   app/domain/…                    — ids / VOs / events / aggregates (S3+)
//   app/db/schema.py, repositories/ — SQLAlchemy models + repos (S6)
//   app/http/…                      — Pydantic DTOs + APIRouters (S7)
//   migrations/…                    — Alembic over MigrationsIR (S9)
// ---------------------------------------------------------------------------

export interface GeneratePythonArgs {
  contexts: EnrichedBoundedContextIR[];
  deployable: DeployableIR;
  sys: SystemIR;
  /** Per-deployable slice of `buildMigrations(sys, snapshots)`.
   *  Consumed by the Alembic emitter (S9); ignored until then. */
  migrations?: MigrationsIR[];
  /** Generate-time observability switch (S17). */
  emitTrace?: boolean;
}

export function generatePythonForContexts(args: GeneratePythonArgs): Map<string, string> {
  const out = new Map<string, string>();
  const slug = pythonProjectName(args.deployable.name);
  const merged = mergeContexts(args.contexts);

  out.set("pyproject.toml", renderPyproject(slug));
  out.set("Dockerfile", DOCKERFILE_PY);
  out.set(".dockerignore", DOCKERIGNORE_PY);
  out.set("certs/.gitkeep", "");
  out.set("app/__init__.py", "");
  out.set("app/settings.py", renderSettings(slug));
  out.set("app/db/__init__.py", "");
  out.set("app/db/engine.py", ENGINE_PY);
  const routedAggs = args.contexts.flatMap((c) =>
    c.aggregates.filter((a) => !a.isAbstract).map((a) => a.name),
  );
  const hasViews = merged.views.some((v) => v.source.kind === "aggregate");
  const hasWorkflows = commandWorkflowsOf(merged).length > 0;
  out.set("app/main.py", renderMain(args.sys.name, routedAggs, hasViews, hasWorkflows));

  out.set("app/domain/__init__.py", "");
  out.set("app/domain/ids.py", renderPyIds(merged));
  out.set("app/domain/errors.py", ERRORS_PY);
  out.set("app/domain/value_objects.py", renderPyEnumsAndValueObjects(merged));
  out.set("app/domain/events.py", renderPyEvents(merged));

  const resolveDs = (agg: import("../../ir/types/loom-ir.js").AggregateIR) => {
    const owning = args.contexts.find((c) => c.aggregates.some((a) => a.name === agg.name));
    return owning
      ? resolveDataSourceConfig(agg as EnrichedAggregateIR, owning, args.sys)
      : undefined;
  };
  out.set("app/db/schema.py", renderPySchema(merged, resolveDs));
  out.set("app/db/wire.py", WIRE_PY);
  out.set("app/db/migrate.py", MIGRATE_PY);
  const hasPaged = merged.repositories.some((r) =>
    r.finds.some((f) => pagedReturn(f.returnType) != null),
  );
  if (hasPaged) out.set("app/db/paging.py", PAGING_PY);
  out.set("app/db/repositories/__init__.py", "");
  // The runner globs migrations/ at boot; .gitkeep keeps the Docker
  // COPY valid on systems whose snapshot is already up to date.
  out.set("migrations/.gitkeep", "");
  emitPythonMigrations(args.migrations ?? [], out);

  out.set("app/http/__init__.py", "");
  out.set("app/http/problem.py", PROBLEM_PY);
  out.set("app/http/wire_models.py", renderPyWireModels(merged));
  const viewsFile = buildPyViewsFile(merged);
  if (viewsFile != null) out.set("app/http/views_routes.py", viewsFile);
  const workflowsFile = buildPyWorkflowsFile(merged);
  if (workflowsFile != null) out.set("app/http/workflows_routes.py", workflowsFile);

  // Per-aggregate emission stays per-context — each aggregate module is
  // emitted in the context that owns it.  An abstract base owns no
  // instantiable domain module; it gets the polymorphic union alias +
  // read-only reader instead.
  for (const ctx of args.contexts) {
    for (const base of abstractBasesOf(ctx)) {
      const concretes = concretesOf(base, ctx);
      if (concretes.length === 0) continue;
      out.set(`app/domain/${snake(base.name)}.py`, buildPyBaseUnionFile(base, concretes));
      out.set(
        `app/db/repositories/${snake(base.name)}_repository.py`,
        buildPyBaseReaderFile(base, concretes, ctx),
      );
    }
    for (const agg of ctx.aggregates) {
      if (agg.isAbstract) continue;
      out.set(`app/domain/${snake(agg.name)}.py`, renderPyAggregate(agg, ctx));
      const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
      out.set(
        `app/db/repositories/${snake(agg.name)}_repository.py`,
        agg.persistedAs === "eventLog"
          ? buildPyEventSourcedRepositoryFile(agg, repo, ctx)
          : buildPyRepositoryFile(agg, repo, ctx),
      );
      out.set(`app/http/${snake(agg.name)}_routes.py`, buildPyRoutesFile(agg, repo, ctx));
      const tests = renderPyTestsFile(agg, ctx);
      if (tests != null) out.set(`tests/test_${snake(agg.name)}.py`, tests);
    }
  }
  return out;
}

/** Multi-context deployables need the shared domain modules to UNION
 *  every context's content rather than overwrite per-context — same
 *  synthetic-merged-context pattern the Hono/.NET orchestrators use.
 *  Ambient root-level enums / VOs are folded into every context by
 *  enrichment, so those dedupe by name. */
function mergeContexts(contexts: EnrichedBoundedContextIR[]): EnrichedBoundedContextIR {
  return {
    name: contexts[0]?.name ?? "merged",
    enums: dedupeByName(contexts.flatMap((c) => c.enums)),
    valueObjects: dedupeByName(contexts.flatMap((c) => c.valueObjects)),
    events: contexts.flatMap((c) => c.events),
    payloads: contexts.flatMap((c) => c.payloads),
    aggregates: contexts.flatMap((c) => c.aggregates),
    repositories: contexts.flatMap((c) => c.repositories),
    workflows: contexts.flatMap((c) => c.workflows),
    views: contexts.flatMap((c) => c.views),
    criteria: contexts.flatMap((c) => c.criteria),
    channels: contexts.flatMap((c) => c.channels),
    retrievals: contexts.flatMap((c) => c.retrievals),
    seeds: contexts.flatMap((c) => c.seeds),
    // Re-derived over the merged union when event-triggered workflows
    // land (S15) — mirrors the Hono orchestrator.
    eventSubscriptions: contexts.flatMap((c) => c.eventSubscriptions),
  };
}

function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    if (seen.has(x.name)) return false;
    seen.add(x.name);
    return true;
  });
}

/** PEP 508-safe project name — same camelCase→snake folding the system
 *  orchestrator's `serviceSlug` applies to the deployable folder /
 *  database name, so the three stay aligned. */
export function pythonProjectName(deployableName: string): string {
  return deployableName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function renderPyproject(slug: string): string {
  const dep = (r: string) => `  "${r}",`;
  return lines(
    "# Auto-generated by Loom.  Pin via .loomignore to customise.",
    "[project]",
    `name = "${slug}"`,
    `version = "0.1.0"`,
    `requires-python = ">=3.12"`,
    "dependencies = [",
    PYTHON_PINS.dependencies.map(dep),
    "]",
    "",
    "[dependency-groups]",
    "dev = [",
    PYTHON_PINS.devDependencies.map(dep),
    "]",
    "",
    "# Application project, not a distributable package — uv installs the",
    "# dependency set without building/installing the project itself.",
    "[tool.uv]",
    "package = false",
    "",
    "[tool.ruff]",
    "line-length = 100",
    `target-version = "py312"`,
    "",
    "# E741: DSL-authored lambda params (idiomatically `l` for lines)",
    "# flow into the generated source verbatim.",
    "[tool.ruff.lint]",
    `ignore = ["E741"]`,
    "",
    "[tool.mypy]",
    `python_version = "3.12"`,
    "strict = true",
    "",
    "[tool.pytest.ini_options]",
    `asyncio_mode = "auto"`,
    `pythonpath = ["."]`,
    "",
  );
}

function renderSettings(slug: string): string {
  return lines(
    `"""Application settings, sourced from the environment.`,
    "",
    "Auto-generated by Loom.  Pin via .loomignore to customise.",
    `"""`,
    "",
    "import os",
    "",
    "DATABASE_URL = os.environ.get(",
    `    "DATABASE_URL",`,
    `    "postgresql+asyncpg://postgres:postgres@localhost:5432/${slug}",`,
    ")",
    "",
  );
}

const ENGINE_PY = lines(
  `"""Async SQLAlchemy engine + per-request session factory."""`,
  "",
  "from collections.abc import AsyncIterator",
  "",
  "from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine",
  "",
  "from app.settings import DATABASE_URL",
  "",
  "engine = create_async_engine(DATABASE_URL)",
  "session_factory = async_sessionmaker(engine, expire_on_commit=False)",
  "",
  "",
  "async def get_session() -> AsyncIterator[AsyncSession]:",
  `    """One session — and exactly one transaction — per request.`,
  "",
  "    Repositories flush; the commit happens here once the handler",
  "    returns, so multi-save workflows stay atomic.",
  `    """`,
  "    async with session_factory() as session:",
  "        yield session",
  "        await session.commit()",
  "",
);

function renderMain(
  systemName: string,
  routerAggs: string[],
  hasViews = false,
  hasWorkflows = false,
): string {
  return lines(
    `"""FastAPI application entrypoint.`,
    "",
    "Auto-generated by Loom.  Pin via .loomignore to customise.",
    `"""`,
    "",
    "from collections.abc import AsyncIterator",
    "from contextlib import asynccontextmanager",
    "",
    "from fastapi import FastAPI",
    "from fastapi.middleware.cors import CORSMiddleware",
    "from sqlalchemy import text",
    "",
    "from app.db.engine import engine",
    "from app.db.migrate import run_migrations",
    ...routerAggs.map(
      (name) => `from app.http.${snake(name)}_routes import router as ${snake(name)}_router`,
    ),
    "from app.http.problem import install_error_handlers",
    hasViews ? "from app.http.views_routes import router as views_router" : null,
    hasWorkflows ? "from app.http.workflows_routes import router as workflows_router" : null,
    "",
    "",
    "",
    "@asynccontextmanager",
    "async def lifespan(_: FastAPI) -> AsyncIterator[None]:",
    "    await run_migrations()",
    "    yield",
    "",
    "",
    `app = FastAPI(title=${JSON.stringify(systemName)}, version="0.1.0", lifespan=lifespan)`,
    "install_error_handlers(app)",
    "",
    "# Permissive CORS for development — pin via .loomignore to tighten.",
    "app.add_middleware(",
    "    CORSMiddleware,",
    `    allow_origins=["*"],`,
    `    allow_methods=["*"],`,
    `    allow_headers=["*"],`,
    ")",
    ...routerAggs.map((name) => `app.include_router(${snake(name)}_router)`),
    hasViews ? "app.include_router(views_router)" : null,
    hasWorkflows ? "app.include_router(workflows_router)" : null,
    "",
    "",
    `@app.get("/health")`,
    "async def health() -> dict[str, bool]:",
    `    """Liveness probe — no dependencies."""`,
    `    return {"ok": True}`,
    "",
    "",
    `@app.get("/ready")`,
    "async def ready() -> dict[str, bool]:",
    `    """Readiness probe — verifies database connectivity."""`,
    "    async with engine.connect() as conn:",
    `        await conn.execute(text("SELECT 1"))`,
    `    return {"ok": True}`,
    "",
  );
}

// Single-stage image: uv installs the pinned dependency set into a
// project venv, uvicorn serves.  `uv sync` (not `pip install`): the
// pyproject is the manifest, and uv resolves fast enough that a
// lockfile-less build stays deterministic via the within-major pins.
const DOCKERFILE_PY = `# syntax=docker/dockerfile:1
# Auto-generated.

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app
# wget backs the compose healthcheck (debian-slim ships neither wget
# nor curl); ca-certificates backs the proxy-CA escape hatch below.
RUN apt-get update \\
    && apt-get install -y --no-install-recommends wget ca-certificates \\
    && rm -rf /var/lib/apt/lists/*
# Optional proxy CAs — drop *.crt files into ./certs/ to make uv/pip
# trust them.  The directory always exists (with a .gitkeep), so this
# COPY is a no-op when no CAs are configured.
COPY certs/ /usr/local/share/ca-certificates/
RUN update-ca-certificates 2>/dev/null || true
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \\
    UV_PROJECT_ENVIRONMENT=/app/.venv
COPY pyproject.toml ./
RUN uv sync --no-dev
COPY app/ ./app/
COPY migrations/ ./migrations/
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
`;

const DOCKERIGNORE_PY = `# Auto-generated.
.venv
__pycache__
*.pyc
.git
.env
.env.*
*.log
.pytest_cache
.mypy_cache
.ruff_cache
`;

// Shared wire-format helpers consumed by every repository's
// `to_wire` projection.
const WIRE_PY = `"""Wire-format helpers shared by repositories.  Auto-generated."""

from datetime import UTC, datetime


def iso(dt: datetime) -> str:
    """ISO-8601 UTC with a Z suffix — wire parity with the other backends."""
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")
`;

// RFC 7807 problem responder + exception handlers — DomainError → 400,
// ForbiddenError → 403, AggregateNotFoundError → 404, and FastAPI's
// RequestValidationError → 422 with the §3.2 `errors[]` extension
// (RFC 6901 pointers), matching the other backends' ProblemDetails.
const PROBLEM_PY = `"""RFC 7807 problem responses + exception handlers.  Auto-generated."""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.domain.errors import AggregateNotFoundError, DomainError, ForbiddenError


def problem(
    request: Request,
    status: int,
    title: str,
    detail: str,
    errors: list[dict[str, str]] | None = None,
) -> JSONResponse:
    body: dict[str, object] = {
        "type": "about:blank",
        "title": title,
        "status": status,
        "detail": detail,
        "instance": request.url.path,
    }
    if errors is not None:
        body["errors"] = errors
    return JSONResponse(body, status_code=status, media_type="application/problem+json")


def _pointer(loc: tuple[object, ...]) -> str:
    """RFC 6901 pointer from a validation-error location (the leading
    source segment — body/query/path — is dropped)."""
    segments = [str(p).replace("~", "~0").replace("/", "~1") for p in loc[1:]]
    return "/" + "/".join(segments) if segments else ""


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ForbiddenError)
    async def _forbidden(request: Request, err: ForbiddenError) -> JSONResponse:
        return problem(request, 403, "Forbidden", str(err))

    @app.exception_handler(DomainError)
    async def _domain(request: Request, err: DomainError) -> JSONResponse:
        return problem(request, 400, "Bad Request", str(err))

    @app.exception_handler(AggregateNotFoundError)
    async def _not_found(request: Request, err: AggregateNotFoundError) -> JSONResponse:
        return problem(request, 404, "Not Found", str(err))

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, err: RequestValidationError) -> JSONResponse:
        errors = [
            {"pointer": _pointer(tuple(e["loc"])), "message": str(e["msg"])}
            for e in err.errors()
        ]
        return problem(request, 422, "Unprocessable Entity", "Request validation failed.", errors)
`;

// Shared paged-result carrier (P3b) — the domain-side mirror of the
// wire `<Arg>Paged` payload, generic over the item type (PEP 695).
const PAGING_PY = `"""Paged-result carrier shared by repositories.  Auto-generated."""

from dataclasses import dataclass


@dataclass(frozen=True)
class PagedResult[T]:
    items: list[T]
    page: int
    page_size: int
    total: int
    total_pages: int
`;
