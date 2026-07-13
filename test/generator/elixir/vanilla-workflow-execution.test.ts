import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice 5c of docs/old/plans/vanilla-foundation-tdd-plan.md — workflow
// execution on vanilla.  Companion to slice 5b (workflow-instance read
// endpoints, #1054).  Together with 5b, this closes the vanilla
// workflow surface.
//
// What 5c emits:
//   1. NAMED-OPERATION CONTEXT FUNCTIONS (prerequisite) — for every
//      `agg.operations` entry not colliding with the CRUD seam, the
//      context module gets `<op>_<agg>(record, params)` routing through
//      the per-aggregate Changeset's `change_<op>/2` + the Repository's
//      `persist_change/1`.
//   2. WORKFLOW MODULE — `lib/<app>/<ctx>/workflows/<wf>.ex` with
//      `run/1` returning `{:ok, _} | {:error, _}`.  `transactional`
//      workflows wrap their body in `Repo.transaction/1`; non-
//      transactional ones just return the body's result.  Body
//      LOWERING (factory-let / op-call / emit / precondition /
//      requires / etc.) is intentionally incremental — Slice 5c ships
//      the SHAPE, with body stubbed to `{:ok, params}` so the route is
//      end-to-end exercisable from the controller.
//   3. WORKFLOWS CONTROLLER — `<App>Web.WorkflowsController` with one
//      action per command-triggered workflow, dispatching the typed
//      result via the shared vanilla `ProblemDetails` helper from
//      slice 4 (202 / 422 / 404 / 403 / 400).
//   4. ROUTES — POST `/api/workflows/<snake>` spliced into the `/api`
//      scope by `shell-emit.ts`.
// ---------------------------------------------------------------------------

const SOURCE = `
system Tasks {
  subdomain Productivity {
    context Tracker {
      aggregate Task with crudish {
        title: string
        done: bool

        operation markDone() {
          done := true
        }
      }
      repository Tasks for Task { }

      workflow markAllDone transactional {
        create() { }
      }
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

describe("vanilla — Slice 5c workflow execution", () => {
  it("context emits a named-operation function for `markDone` (the 5c prerequisite)", async () => {
    const files = await generateSystemFiles(SOURCE);
    const ctx = files.get([...files.keys()].find((k) => k.endsWith("lib/api/tracker.ex"))!)!;
    // The CRUD defdelegates remain:
    expect(ctx).toContain("defdelegate update_task(record, attrs)");
    // The named-op function for `markDone` (no CRUD collision) renders the
    // BODY (`done := true`) and persists the assigned column, rather than
    // casting params.
    expect(ctx).toContain("def mark_done_task(%Api.Tracker.Task{} = record, params)");
    expect(ctx).toContain("record = %{record | done: true}");
    expect(ctx).toContain("Ecto.Changeset.force_change(:done, record.done)");
    expect(ctx).toContain("Api.Tracker.TaskRepository.persist_change()");
    // CRUDish's `update` operation must NOT also emit a named-op
    // function — it would collide with the `update_task/2` defdelegate
    // and fail mix compile.  Only ONE `update_task` definition (the
    // defdelegate) should exist; no `def update_task(...)` from the
    // named-op emitter.
    expect(ctx).not.toMatch(/def update_task\(/);
  });

  it("repository emits `persist_change/1` (the named-op seam)", async () => {
    const files = await generateSystemFiles(SOURCE);
    const repo = files.get(
      [...files.keys()].find((k) => k.endsWith("/tracker/task_repository.ex"))!,
    )!;
    expect(repo).toContain("def persist_change(%Ecto.Changeset{data: %Api.Tracker.Task{}}");
    expect(repo).toContain("Repo.update(changeset)");
  });

  it("emits a workflow module with run/1 returning {:ok, _} | {:error, _}", async () => {
    const files = await generateSystemFiles(SOURCE);
    const wfKey = [...files.keys()].find((k) => k.endsWith("/workflows/mark_all_done.ex"));
    expect(wfKey).toBeDefined();
    const wf = files.get(wfKey!)!;
    expect(wf).toContain("defmodule Api.Tracker.Workflows.MarkAllDone");
    expect(wf).toContain("@spec run(map()) :: {:ok, term()} | {:error, term()}");
    expect(wf).toContain("def run(params)");
    expect(wf).not.toContain("Ash.Resource");
    expect(wf).not.toContain("Ash.transaction");
  });

  it("a `transactional` workflow wraps run_inner in Repo.transaction", async () => {
    const files = await generateSystemFiles(SOURCE);
    const wf = files.get(
      [...files.keys()].find((k) => k.endsWith("/workflows/mark_all_done.ex"))!,
    )!;
    expect(wf).toContain("alias Api.Repo");
    // A workflow is a per-dispatch boundary: run/1 opens a child execution frame
    // (parent_id <- the request's root scope) around the transaction.
    expect(wf).toContain("Api.RequestContext.with_child_frame(fn ->");
    expect(wf).toContain("Repo.transaction(fn ->");
    expect(wf).toContain("Repo.rollback(reason)");
    expect(wf).toContain("defp run_inner(params)");
  });

  it("emits a WorkflowsController with per-variant ProblemDetails dispatch", async () => {
    const files = await generateSystemFiles(SOURCE);
    const ctl = files.get(
      [...files.keys()].find((k) => k.endsWith("/controllers/workflows_controller.ex"))!,
    )!;
    expect(ctl).toContain("defmodule ApiWeb.WorkflowsController");
    expect(ctl).toContain("alias ApiWeb.ProblemDetails");
    expect(ctl).toContain("def mark_all_done(conn, params)");
    expect(ctl).toContain("Api.Tracker.Workflows.MarkAllDone.run(params)");
    expect(ctl).toContain("put_status(202)");
    expect(ctl).toContain("ProblemDetails.validation_error_response(conn, changeset)");
    expect(ctl).toContain('ProblemDetails.problem_response(conn, 404, "Not Found"');
    expect(ctl).toContain('ProblemDetails.problem_response(conn, 403, "Forbidden"');
    expect(ctl).toContain('ProblemDetails.problem_response(conn, 400, "Bad Request"');
  });

  it("splices POST /workflows/<snake> into the /api scope", async () => {
    const files = await generateSystemFiles(SOURCE);
    const router = files.get([...files.keys()].find((k) => k.endsWith("/router.ex"))!)!;
    expect(router).toMatch(
      /scope "\/api"[\s\S]*post "\/workflows\/mark_all_done", WorkflowsController, :mark_all_done/,
    );
  });

  it("the CRUD + view + workflow-instance routes from earlier slices still fire", async () => {
    const files = await generateSystemFiles(SOURCE);
    const router = files.get([...files.keys()].find((k) => k.endsWith("/router.ex"))!)!;
    // Slice 1+2: aggregate CRUD
    expect(router).toContain('get "/tasks", TaskController, :index');
    expect(router).toContain('post "/tasks", TaskController, :create');
  });
});
