import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice 5c body-lowering follow-up #5 — `emit` (broadcast a domain event).
//
//   emit OrderConfirmed { order: id, at: now() }
//     → Phoenix.PubSub.broadcast(App.PubSub, "events",
//                                %App.Ctx.Events.OrderConfirmed{order: id, at: ...})
//
// Rendered INSIDE the with-chain's do-branch so a failed precondition /
// op short-circuits the chain and the broadcast is skipped.  The
// `Events.<EventName>` struct module is now emitted by the orchestrator's
// `emitVanillaEventModules` hook (foundation-agnostic; reuses the same
// `renderEventModule` the Ash path uses).
//
// Channels-on-vanilla (the in-process `Dispatcher` that fans the broadcast
// into per-context handler modules) is a separate, larger follow-up; this
// slice only wires the PubSub broadcast itself.
// ---------------------------------------------------------------------------

function sys(body: string): string {
  return `
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

      event TaskFinished { task: Task id, at: datetime }
      event TaskRenamed { task: Task id, oldTitle: string, newTitle: string }

      ${body}
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
}

async function generateAll(body: string): Promise<Map<string, string>> {
  return generateSystemFiles(sys(body));
}

async function workflowFor(body: string, file: string): Promise<string> {
  const files = await generateAll(body);
  return files.get([...files.keys()].find((k) => k.endsWith(`/workflows/${file}.ex`))!)!;
}

describe("vanilla — Events struct modules", () => {
  it("emits one struct module per event under lib/<app>/<ctx>/events/", async () => {
    const files = await generateAll(`workflow noop transactional { create() { } }`);
    const finished = [...files.keys()].find((k) => k.endsWith("/events/task_finished.ex"));
    const renamed = [...files.keys()].find((k) => k.endsWith("/events/task_renamed.ex"));
    expect(finished).toBeDefined();
    expect(renamed).toBeDefined();
    const body = files.get(finished!)!;
    expect(body).toContain("defmodule Api.Tracker.Events.TaskFinished do");
    expect(body).toContain("defstruct [:task, :at]");
    expect(body).toContain("@type t :: %__MODULE__{");
  });

  it("renders the event struct foundation-agnostically (no Ash references)", async () => {
    const files = await generateAll(`workflow noop transactional { create() { } }`);
    const body = files.get([...files.keys()].find((k) => k.endsWith("/events/task_renamed.ex"))!)!;
    expect(body).not.toContain("Ash");
    expect(body).not.toContain("use Ash.Resource");
  });
});

describe("vanilla — workflow body lowering (emit)", () => {
  it("lowers `emit Foo { ... }` to a Phoenix.PubSub.broadcast", async () => {
    const wf = await workflowFor(
      `workflow finish transactional {
        create(taskId: Task id) {
          let t = Tasks.getById(taskId)
          emit TaskFinished { task: taskId, at: now() }
        }
      }`,
      "finish",
    );
    expect(wf).toContain(
      `Phoenix.PubSub.broadcast(Api.PubSub, "events", %Context.Events.TaskFinished{task: task_id, at: DateTime.utc_now()})`,
    );
  });

  it("renders the broadcast INSIDE the with-chain's do-branch", async () => {
    const wf = await workflowFor(
      `workflow finish transactional {
        create(taskId: Task id) {
          let t = Tasks.getById(taskId)
          emit TaskFinished { task: taskId, at: now() }
        }
      }`,
      "finish",
    );
    // The broadcast line appears AFTER `with ... do` and BEFORE the
    // success `{:ok, _}` return — so a failed with-clause skips it.
    expect(wf).toMatch(
      /with \{:ok, t\} <- Context\.get_task\(task_id\) do\n\s+Phoenix\.PubSub\.broadcast[\s\S]+\n\s+\{:ok, t\}\n\s+end/,
    );
  });

  it("surfaces a param referenced only by the emit (emit is now lowered)", async () => {
    // A workflow with NO factory-let / op-call / repo-let — the only
    // place a param is referenced is the emit field.  Now that emit
    // is lowered, the param must be destructured.
    const wf = await workflowFor(
      `workflow rename transactional {
        create(taskId: Task id, oldTitle: string, newTitle: string) {
          emit TaskRenamed { task: taskId, oldTitle: oldTitle, newTitle: newTitle }
        }
      }`,
      "rename",
    );
    expect(wf).toContain(
      `%{"task_id" => task_id, "old_title" => old_title, "new_title" => new_title} = params`,
    );
    expect(wf).toContain("task: task_id");
    expect(wf).toContain("old_title: old_title");
  });

  it("emit-only body (no with-chain) renders broadcast then {:ok, :emitted}", async () => {
    const wf = await workflowFor(
      `workflow announce transactional {
        create(taskId: Task id) {
          emit TaskFinished { task: taskId, at: now() }
        }
      }`,
      "announce",
    );
    // No with-chain — broadcast runs unconditionally then return {:ok, :emitted}.
    expect(wf).toMatch(/Phoenix\.PubSub\.broadcast[\s\S]+\n\s+\{:ok, :emitted\}/);
    // ...and `with` is NOT present.
    expect(wf).not.toMatch(/\n\s+with /);
  });

  it("the broadcast uses the App-level PubSub, not the context module", async () => {
    const wf = await workflowFor(
      `workflow finish transactional {
        create(taskId: Task id) {
          let t = Tasks.getById(taskId)
          emit TaskFinished { task: taskId, at: now() }
        }
      }`,
      "finish",
    );
    expect(wf).toContain("Api.PubSub");
    // The struct module routes through the Context alias.
    expect(wf).toContain("%Context.Events.TaskFinished");
  });

  it("no Ash references appear in the lowered emit", async () => {
    const wf = await workflowFor(
      `workflow finish transactional {
        create(taskId: Task id) {
          let t = Tasks.getById(taskId)
          emit TaskFinished { task: taskId, at: now() }
        }
      }`,
      "finish",
    );
    expect(wf).not.toContain("Ash.");
    expect(wf).not.toContain("Dispatcher");
  });
});
