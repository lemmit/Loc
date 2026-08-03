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
    expect(cs).toContain("@all_fields [:title, :done, :version]");
    // Only `title` is required INPUT: `done: bool` carries the language's
    // implicit `false` default and `version: int token = 1` an explicit one, so
    // both are omittable on the wire (as they already were on the other four
    // backends) and are supplied by `__default/3` instead.
    expect(cs).toContain("@required_fields [:title]");
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
    expect(repo).toContain(
      "def update(%Api.Tracker.Task{} = record, attrs, expected_version \\\\ nil)",
    );
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
    expect(ctx).toContain("defdelegate update_task(record, attrs, expected_version \\\\ nil)");
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
    expect(ctl).toContain("Tracker.update_task(record, attrs, expected_version)");
    expect(ctl).toContain("Tracker.delete_task(record)");
    // Status codes:
    expect(ctl).toContain("put_status(201)");
    expect(ctl).toContain("send_resp(conn, 204");
    // `update` answers 204 with NO BODY, like the other four backends and like
    // this backend's own OpenAPI (`204 => No Content`).  It used to answer
    // `200` + the serialized aggregate; that is a body no typed client reads,
    // because `update` is an ordinary void `operation` and the derivation types
    // it void.  Pinned negatively too — `serialize/1` is still emitted (show /
    // index / the finds use it), so only its absence from the update arm says
    // the contract holds.  The region is cut to the update action first: a
    // `[\s\S]*?` from `def update` would run on into `show` / the find actions,
    // which legitimately DO serialize, and the negative would then pass or fail
    // on where the emitter happens to order its functions.
    const updateAction = ctl.match(/\n {2}def update\(conn[\s\S]*?\n {2}end\n/)?.[0] ?? "";
    expect(updateAction, "update action found").not.toBe("");
    expect(updateAction).toContain('send_resp(conn, 204, "")');
    expect(updateAction).not.toContain("json(conn, serialize(");
    // Slice 4: validation errors delegate to shared
    // <App>Web.ProblemDetails (422 emitted by the helper, with the
    // RFC 7807 envelope byte-aligned with Ash / Hono / .NET).
    expect(ctl).toContain("ProblemDetails.validation_error_response(conn, changeset)");
  });

  it("router has POST/DELETE routes spliced into /api, matching its own spec", async () => {
    const files = await generateSystemFiles(VANILLA_SOURCE);
    const router = files.get([...files.keys()].find((k) => k.endsWith("/router.ex"))!)!;
    expect(router).toMatch(/scope "\/api"[\s\S]*post "\/tasks", TaskController, :create/);
    // `POST /tasks/:id/update`, not the generic `PATCH /tasks/:id` this used to
    // assert.  The old expectation pinned a route the backend's OWN emitted
    // OpenAPI never advertised — the `/tasks/{id}` PathItem carries only `get`
    // + `delete`, while `/tasks/{id}/update` is published with `post` and
    // `operationId: updateTask`.  So the spec promised an endpoint the router
    // did not serve, every client built from that contract 404'd, and this test
    // held the mismatch in place by asserting the router half of it.
    expect(router).toMatch(
      /scope "\/api"[\s\S]*post "\/tasks\/:id\/update", TaskController, :update/,
    );
    expect(router).not.toMatch(/patch "\/tasks\/:id"/);
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
