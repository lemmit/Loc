import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice 2 of docs/old/plans/vanilla-foundation-tdd-plan.md — write path
// (create / update / destroy) + Changeset module.
//
// Verifies the vanilla emit produces:
//   - Per-aggregate Changeset module (cast/3 + validate_required +
//     per-action change_<op>/{1,2} helpers)
//   - Repository now exposes insert/update/delete returning
//     `{:ok, _} | {:error, Ecto.Changeset.t()}`
//   - Context module re-exports create_/update_/delete_ delegates
//   - Controller has create/update/delete actions with `with`-block
//     dispatch over `{:ok, _} | {:error, :not_found | %Ecto.Changeset{}}`
//   - Router has POST/PATCH/DELETE routes spliced into /api
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

describe("vanilla — Slice 2 CRUD write path + Changeset", () => {
  it("emits a per-aggregate Changeset module with cast/3 + validate_required", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const csKey = [...files.keys()].find((k) => k.endsWith("/tracker/task_changeset.ex"));
    expect(csKey).toBeDefined();
    const cs = files.get(csKey!)!;
    expect(cs).toContain("import Ecto.Changeset");
    expect(cs).toContain("alias Api.Tracker.Task");
    expect(cs).toContain("@all_fields [:title, :done]");
    expect(cs).toContain("@required_fields [:title, :done]");
    expect(cs).toContain("def base_changeset");
    expect(cs).toContain("|> cast(attrs, @all_fields)");
    expect(cs).toContain("|> validate_required(@required_fields)");
    expect(cs).not.toContain("Ash.Changeset");
  });

  it("emits per-action change_<op> helpers for create/destroy from crudish", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const cs = files.get([...files.keys()].find((k) => k.endsWith("/tracker/task_changeset.ex"))!)!;
    expect(cs).toContain("def change_create(attrs)");
    expect(cs).toContain("def change_destroy(struct)");
    // Named OPERATIONS (crudish `update`, custom ops) no longer get a
    // `change_<op>` helper — their `<op>_<agg>` context fn renders the body and
    // put_changes the assigned columns; the dead helper cast op *params*, which
    // raised `unknown field` at runtime when a param wasn't a column.
    expect(cs).not.toContain("def change_update(");
  });

  it("Repository now exposes insert/update/delete returning typed results", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const repo = files.get(
      [...files.keys()].find((k) => k.endsWith("/tracker/task_repository.ex"))!,
    )!;
    expect(repo).toContain("def insert(attrs)");
    expect(repo).toContain("def update(%Api.Tracker.Task{} = record, attrs)");
    expect(repo).toContain("def delete(%Api.Tracker.Task{} = record)");
    expect(repo).toContain("Api.Tracker.TaskChangeset.base_changeset");
    expect(repo).toContain("|> Repo.insert()");
    expect(repo).toContain("|> Repo.update()");
    expect(repo).toContain("Repo.delete(record)");
    expect(repo).toContain("{:error, Ecto.Changeset.t()}");
  });

  it("Context module re-exports create_/update_/delete_ delegates", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const ctx = files.get([...files.keys()].find((k) => k.endsWith("lib/api/tracker.ex"))!)!;
    expect(ctx).toContain("defdelegate create_task(attrs)");
    expect(ctx).toContain("defdelegate update_task(record, attrs)");
    expect(ctx).toContain("defdelegate delete_task(record)");
    expect(ctx).toContain("as: :insert");
    expect(ctx).toContain("as: :update");
    expect(ctx).toContain("as: :delete");
  });

  it("Controller emits create/update/delete actions with with-block dispatch", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const ctl = files.get(
      [...files.keys()].find((k) => k.endsWith("/controllers/task_controller.ex"))!,
    )!;
    expect(ctl).toContain("def create(conn, params)");
    expect(ctl).toContain('def update(conn, %{"id" => id} = params)');
    expect(ctl).toContain('def delete(conn, %{"id" => id})');
    // Write-path returns:
    expect(ctl).toContain("Tracker.create_task(params)");
    expect(ctl).toContain("Tracker.update_task(record, attrs)");
    expect(ctl).toContain("Tracker.delete_task(record)");
    // Status codes:
    expect(ctl).toContain("put_status(201)");
    expect(ctl).toContain("send_resp(conn, 204");
    // Slice 4: validation errors delegate to shared
    // <App>Web.ProblemDetails (422 emitted by the helper, with the
    // RFC 7807 envelope byte-aligned with Ash / Hono / .NET).
    expect(ctl).toContain("ProblemDetails.validation_error_response(conn, changeset)");
  });

  it("router has POST/PATCH/DELETE routes spliced into /api", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const router = files.get([...files.keys()].find((k) => k.endsWith("/router.ex"))!)!;
    expect(router).toMatch(/scope "\/api"[\s\S]*post "\/tasks", TaskController, :create/);
    expect(router).toMatch(/scope "\/api"[\s\S]*patch "\/tasks\/:id", TaskController, :update/);
    expect(router).toMatch(/scope "\/api"[\s\S]*delete "\/tasks\/:id", TaskController, :delete/);
  });

  it("Slice 1 read-path contract still holds", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const ctl = files.get(
      [...files.keys()].find((k) => k.endsWith("/controllers/task_controller.ex"))!,
    )!;
    expect(ctl).toContain("def index(conn, params)");
    expect(ctl).toContain('def show(conn, %{"id" => id})');
  });
});
