import { describe, expect, it } from "vitest";
import {
  buildExportReadme,
  composeServices,
  EXPORT_README_PATH,
} from "../../web/src/util/export-readme.js";

// The README the exported ZIP carries at its root (M-T8.23 slice 3).  It is
// DERIVED from the tree — the service list and its ports are read out of the
// generated `docker-compose.yml` — so it cannot promise a service or a port the
// export does not actually contain.

// The shape `src/system/index.ts` emits: two-space service keys under
// `services:`, `- "HOST:CONTAINER"` port entries, a trailing `volumes:` block.
const COMPOSE = `# Auto-generated.
services:
  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: postgres
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]

  api:
    build:
      context: ./api
    ports:
      - "3000:3000"
    depends_on:
      db:
        condition: service_healthy

  web-app:
    build:
      context: ./webApp
    ports:
      - "3001:3000"

volumes:
  pgdata: {}
`;

describe("composeServices", () => {
  it("reads every service and its published host ports", () => {
    expect(composeServices(COMPOSE)).toEqual([
      { name: "db", hostPorts: [] },
      { name: "api", hostPorts: ["3000"] },
      { name: "web-app", hostPorts: ["3001"] },
    ]);
  });

  it("stops at the next top-level key, so `volumes:` entries are not services", () => {
    expect(composeServices(COMPOSE).map((s) => s.name)).not.toContain("pgdata");
  });

  it("does not mistake a nested key for a port entry", () => {
    // `depends_on:`'s nested `condition:` sits under the same service; a naive
    // scanner that stayed "in ports" would swallow it.
    const api = composeServices(COMPOSE).find((s) => s.name === "api");
    expect(api?.hostPorts).toEqual(["3000"]);
  });

  it("returns nothing for a file with no services block", () => {
    expect(composeServices("volumes:\n  pgdata: {}\n")).toEqual([]);
  });
});

describe("buildExportReadme", () => {
  const paths = [
    "docker-compose.yml",
    "api/package.json",
    "api/src/index.ts",
    "webApp/package.json",
    ".loom/wire-spec.json",
  ];

  it("leads with the project name and the one command that runs it", () => {
    const md = buildExportReadme({ name: "sales-system", paths, compose: COMPOSE });
    expect(md.startsWith("# sales-system\n")).toBe(true);
    expect(md).toContain("docker compose up --build");
    expect(md).toContain("docker compose down -v");
  });

  it("names each service and where it answers, from the compose file", () => {
    const md = buildExportReadme({ name: "sales-system", paths, compose: COMPOSE });
    expect(md).toContain("| `api` | http://localhost:3000 |");
    expect(md).toContain("| `web-app` | http://localhost:3001 |");
    // `db` publishes nothing, and the README says that rather than inventing a port.
    expect(md).toContain("| `db` | internal to the stack |");
  });

  it("lists the top-level projects, and does not list `.loom` as one", () => {
    const md = buildExportReadme({ name: "sales-system", paths, compose: COMPOSE });
    expect(md).toContain("- `api/`");
    expect(md).toContain("- `webApp/`");
    expect(md).not.toContain("- `.loom/`");
    // …but it does explain what `.loom/` is.
    expect(md).toContain("`.loom/` holds the model's derived views");
  });

  it("says so instead of promising compose when the export has none", () => {
    const md = buildExportReadme({
      name: "single",
      paths: ["src/index.ts", "package.json"],
      compose: null,
    });
    expect(md).toContain("no `docker-compose.yml`");
    expect(md).not.toContain("docker compose up");
  });

  it("names the file the archive puts it at", () => {
    expect(EXPORT_README_PATH).toBe("README.md");
  });
});
