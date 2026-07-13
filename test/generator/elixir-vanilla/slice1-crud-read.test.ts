import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice 1 of docs/old/plans/vanilla-foundation-tdd-plan.md — one CRUD
// aggregate end-to-end, read path, structurally parity-closed.
//
// Verifies that the vanilla emit subtree produces:
//   - Per-aggregate Ecto.Schema with column definitions
//   - Per-aggregate Repository module with find_by_id/1 + list/0
//   - Per-context module re-exporting Repository functions
//   - Per-aggregate controller with GET /<aggs> + GET /<aggs>/:id
//   - Router with routes spliced into /api scope
//
// The vanilla wire-spec / OpenAPI parity assertions live in a sibling
// test (slice1-wire-parity.test.ts) once the openapi-emit reuse path
// lands; Slice 1 here pins the file structure only.
// ---------------------------------------------------------------------------

const VANILLA_SOURCE = `
system Tasks {
  subdomain Productivity {
    context Tracker {
      aggregate Task with crudish {
        title: string
        done: bool
      }
      repository Tasks for Task { }
    }
  }
  api TrackerApi from Productivity
  storage primary { type: postgres }
  resource trackerState { for: Tracker, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Tracker]
    dataSources: [trackerState]
    serves: TrackerApi
    port: 4000
  }
}
`;

describe("vanilla — Slice 1 CRUD read path", () => {
  it("emits a per-aggregate Ecto.Schema with snake-cased columns", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const schemaKey = [...files.keys()].find((k) => k.endsWith("/tracker/task.ex"))!;
    expect(schemaKey).toBeDefined();
    const schema = files.get(schemaKey)!;
    expect(schema).toContain("use Ecto.Schema");
    expect(schema).not.toContain("use Ash.Resource");
    expect(schema).toContain('schema "tasks" do');
    expect(schema).toContain("field :title, :string");
    expect(schema).toContain("field :done, :boolean");
    expect(schema).toContain("@primary_key {:id, UUIDv7, autogenerate: true}");
  });

  it("emits a per-aggregate Repository with find_by_id + list returning {:ok, _}|{:error, _}", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const repoKey = [...files.keys()].find((k) => k.endsWith("/tracker/task_repository.ex"))!;
    expect(repoKey).toBeDefined();
    const repo = files.get(repoKey)!;
    expect(repo).toContain("alias Api.Repo");
    expect(repo).toContain("def list");
    expect(repo).toContain("def find_by_id(id)");
    expect(repo).toContain("{:ok, Repo.all(");
    expect(repo).toContain("{:error, :not_found}");
    expect(repo).not.toContain("Ash.read");
  });

  it("emits a context module with delegates for each aggregate", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const ctxKey = [...files.keys()].find((k) => k.endsWith("lib/api/tracker.ex"))!;
    expect(ctxKey).toBeDefined();
    const ctx = files.get(ctxKey)!;
    expect(ctx).toContain("defdelegate list_tasks()");
    expect(ctx).toContain("defdelegate get_task(id)");
    expect(ctx).toContain("Api.Tracker.TaskRepository");
    expect(ctx).not.toContain("use Ash.Domain");
  });

  it("emits a controller with index + show using with-block dispatch", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const ctlKey = [...files.keys()].find((k) => k.endsWith("/controllers/task_controller.ex"))!;
    expect(ctlKey).toBeDefined();
    const ctl = files.get(ctlKey)!;
    expect(ctl).toContain("def index(conn, _params)");
    expect(ctl).toContain('def show(conn, %{"id" => id})');
    expect(ctl).toContain("with {:ok, records} <- Tracker.list_tasks()");
    expect(ctl).toContain("case Tracker.get_task(id) do");
    expect(ctl).toContain("{:ok, record}");
    expect(ctl).toContain("{:error, :not_found}");
    // Slice 4: controller delegates to shared <App>Web.ProblemDetails
    // helper instead of inline `/errors/not-found` envelope.
    expect(ctl).toContain('ProblemDetails.not_found_response(conn, "Task", id)');
  });

  it("router has the per-aggregate routes spliced into the /api scope", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const routerKey = [...files.keys()].find((k) => k.endsWith("/router.ex"))!;
    const router = files.get(routerKey)!;
    expect(router).toMatch(/scope "\/api"[\s\S]*get "\/tasks", TaskController, :index/);
    expect(router).toMatch(/scope "\/api"[\s\S]*get "\/tasks\/:id", TaskController, :show/);
  });

  it("mix.exs still has zero Ash deps (Slice 0 baseline preserved)", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const mix = files.get([...files.keys()].find((k) => k.endsWith("mix.exs"))!)!;
    expect(mix).not.toContain(":ash,");
    expect(mix).not.toContain("ash_postgres");
  });
});
