// ---------------------------------------------------------------------------
// python@v1 — dependency pins (the version-owned slice of the backend;
// mirrors `src/platform/hono/v4/pins.ts`).  PEP 508 requirement strings
// spliced into the generated `pyproject.toml`.
//
// All ranges are within-major.  The `LOOM_PYTHON_BUILD` gate
// (`uv sync` + `ruff check` + `mypy --strict` against an emitted
// project) is what proves these resolve + typecheck together.
// ---------------------------------------------------------------------------
export const PYTHON_PINS = {
  dependencies: [
    "fastapi>=0.115,<1",
    "uvicorn[standard]>=0.32,<1",
    "sqlalchemy[asyncio]>=2.0.36,<3",
    "asyncpg>=0.30,<1",
    "pydantic>=2.10,<3",
    // UUIDv7 (time-ordered ids) — stdlib `uuid.uuid7` only lands in 3.14;
    // `uuid6` backports it (`from uuid6 import uuid7`) and is typed.
    "uuid6>=2024.7.10",
    // Prometheus metrics (GET /metrics) — ships type stubs (py.typed).
    "prometheus-client>=0.21,<1",
  ],
  devDependencies: ["mypy>=1.13,<2", "ruff>=0.8,<1", "pytest>=8.3,<9", "pytest-asyncio>=0.24,<2"],
} as const;
