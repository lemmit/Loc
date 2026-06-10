import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — project-shell emission (plan S2).
//
// A `platform: python` deployable emits a uv-managed FastAPI project:
// pyproject.toml (pins + ruff/mypy/pytest config), Dockerfile,
// app/main.py (CORS + /health + /ready), app/settings.py
// (DATABASE_URL), app/db/engine.py (async engine + session factory).
// Domain / persistence / HTTP emission grow in later slices.
// ---------------------------------------------------------------------------

const FIXTURE = `system PyShell {
  subdomain Ops {
    context Ops {
      aggregate Widget {
        label: string
        size: int
      }
      repository Widgets for Widget { }
    }
  }

  api OpsApi from Ops

  storage pg { type: postgres }
  resource opsState { for: Ops, kind: state, use: pg }

  deployable api {
    platform: python
    contexts: [Ops]
    dataSources: [opsState]
    serves: OpsApi
    port: 8000
  }
}
`;

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python project shell", () => {
  it("emits the uv project shell under the deployable slug", async () => {
    const files = await build();
    for (const path of [
      "api/pyproject.toml",
      "api/Dockerfile",
      "api/.dockerignore",
      "api/certs/.gitkeep",
      "api/app/__init__.py",
      "api/app/main.py",
      "api/app/settings.py",
      "api/app/db/__init__.py",
      "api/app/db/engine.py",
    ]) {
      expect(files.has(path), `missing ${path}`).toBe(true);
    }
  });

  it("pyproject carries the pinned dep set + strict tool config", async () => {
    const files = await build();
    const pyproject = files.get("api/pyproject.toml")!;
    expect(pyproject).toContain('name = "api"');
    expect(pyproject).toContain('requires-python = ">=3.12"');
    expect(pyproject).toContain('"fastapi>=');
    expect(pyproject).toContain('"sqlalchemy[asyncio]>=');
    expect(pyproject).toContain('"asyncpg>=');
    expect(pyproject).toContain('"mypy>=');
    expect(pyproject).toContain('"ruff>=');
    expect(pyproject).toContain("[tool.mypy]");
    expect(pyproject).toContain("strict = true");
    // App, not a distributable package.
    expect(pyproject).toContain("package = false");
  });

  it("main.py exposes the app with /health and a DB-aware /ready", async () => {
    const files = await build();
    const main = files.get("api/app/main.py")!;
    expect(main).toContain('app = FastAPI(title="PyShell", version="0.1.0", lifespan=lifespan)');
    expect(main).toContain("CORSMiddleware");
    expect(main).toContain('@app.get("/health")');
    expect(main).toContain('@app.get("/ready")');
    expect(main).toContain('await conn.execute(text("SELECT 1"))');
  });

  it("settings default the asyncpg DSN to the deployable slug database", async () => {
    const files = await build();
    const settings = files.get("api/app/settings.py")!;
    expect(settings).toContain('"DATABASE_URL"');
    expect(settings).toContain("postgresql+asyncpg://postgres:postgres@localhost:5432/api");
  });

  it("engine.py builds the async engine + session dependency", async () => {
    const files = await build();
    const engine = files.get("api/app/db/engine.py")!;
    expect(engine).toContain("create_async_engine(DATABASE_URL)");
    expect(engine).toContain("async_sessionmaker(engine, expire_on_commit=False)");
    expect(engine).toContain("async def get_session() -> AsyncIterator[AsyncSession]:");
  });

  it("Dockerfile serves via uvicorn from a uv-synced venv", async () => {
    const files = await build();
    const docker = files.get("api/Dockerfile")!;
    expect(docker).toContain("FROM python:3.12-slim");
    expect(docker).toContain("uv sync --no-dev");
    expect(docker).toContain('CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0"');
  });

  it("compose wires the service with the asyncpg DSN + /ready healthcheck", async () => {
    const files = await build();
    const compose = files.get("docker-compose.yml")!;
    expect(compose).toContain('DATABASE_URL: "postgresql+asyncpg://postgres:postgres@db:5432/api"');
    expect(compose).toContain("wget -qO- http://localhost:8000/ready");
  });

  it("camelCase deployable names fold to a snake slug in project name + DSN", async () => {
    const { model, errors } = await parseString(
      FIXTURE.replace(/deployable api/, "deployable opsApi").replace(
        /contexts: \[Ops\]/,
        "contexts: [Ops]",
      ),
    );
    expect(errors).toEqual([]);
    const files = generateSystems(model).files;
    expect(files.get("ops_api/pyproject.toml")!).toContain('name = "ops_api"');
    expect(files.get("ops_api/app/settings.py")!).toContain("5432/ops_api");
  });
});
