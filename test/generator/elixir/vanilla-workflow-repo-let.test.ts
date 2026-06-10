import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice 5c body-lowering follow-up #4 — `repo-let` (load an existing
// aggregate by id).
//
//   let t = Tasks.getById(taskId)  →  {:ok, t} <- Context.get_task(task_id)
//
// The auto-generated `getById` finder maps to the vanilla context's
// `get_<agg>/1` (find_by_id) facade — `{:ok, _} | {:error, :not_found}`,
// so it slots straight into the `with`-chain and a failed load surfaces
// `{:error, :not_found}` (controller → 404).  The arg is param-surfaced
// like any other create-param reference.
//
// Custom repository finds (`byEmail`, …) aren't yet exposed through the
// vanilla context, so a non-getById repo-let stays on the `# TODO`
// fallthrough — lowering it would emit a call to a fn that doesn't exist
// and fail `mix compile`.
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
      ${body}
    }
  }
  api TrackerApi from Productivity
  storage primary { type: postgres }
  resource trackerState { for: Tracker, kind: state, use: primary }
  deployable api {
    platform: elixir { foundation: vanilla }
    contexts: [Tracker]
    dataSources: [trackerState]
    serves: TrackerApi
    port: 4000
  }
}
`;
}

async function workflowFor(body: string, file: string): Promise<string> {
  const files = await generateSystemFiles(sys(body));
  return files.get([...files.keys()].find((k) => k.endsWith(`/workflows/${file}.ex`))!)!;
}

const GET_BY_ID = `repository Tasks for Task { }

      workflow completeExisting transactional {
        create(taskId: Task id) {
          let t = Tasks.getById(taskId)
          t.markDone()
        }
      }`;

describe("vanilla — workflow body lowering (repo-let / getById)", () => {
  it("lowers `Tasks.getById(taskId)` to a Context.get_task with-clause", async () => {
    const wf = await workflowFor(GET_BY_ID, "complete_existing");
    expect(wf).toContain("{:ok, t} <- Context.get_task(task_id)");
  });

  it("surfaces the id arg as a destructured create-param", async () => {
    const wf = await workflowFor(GET_BY_ID, "complete_existing");
    expect(wf).toContain(`%{"task_id" => task_id} = params`);
  });

  it("the loaded record flows into the subsequent op-call", async () => {
    const wf = await workflowFor(GET_BY_ID, "complete_existing");
    // get_task binds `t`; the op-call targets it.
    expect(wf).toMatch(
      /\{:ok, t\} <- Context\.get_task\(task_id\),\s*\n\s*\{:ok, _\} <- Context\.mark_done_task\(t, %\{\}\)/,
    );
  });

  it("a failed load short-circuits the with-chain (→ {:error, :not_found})", async () => {
    // Structural: the clause pattern-matches {:ok, t}; find_by_id returns
    // {:error, :not_found} on a miss, which the with-chain propagates and
    // the WorkflowsController maps to 404.
    const wf = await workflowFor(GET_BY_ID, "complete_existing");
    const ctrlFiles = await generateSystemFiles(sys(GET_BY_ID));
    const ctrl = ctrlFiles.get(
      [...ctrlFiles.keys()].find((k) => k.endsWith("/controllers/workflows_controller.ex"))!,
    )!;
    expect(wf).toContain("{:ok, t} <- Context.get_task(task_id)");
    expect(ctrl).toMatch(/\{:error, :not_found\} ->/);
  });
});

describe("vanilla — workflow body lowering (repo-let / custom find stays TODO)", () => {
  it("keeps a non-getById repo-let on the # TODO fallthrough", async () => {
    const wf = await workflowFor(
      `repository Tasks for Task {
        find byTitle(title: string): Task? where this.title == title
      }

      workflow findThenComplete transactional {
        create(wanted: string) {
          let t = Tasks.byTitle(wanted)
          t.markDone()
        }
      }`,
      "find_then_complete",
    );
    // The custom find isn't exposed via the vanilla context yet.
    expect(wf).toContain("# TODO: lower workflow statement kind 'repo-let'");
    expect(wf).not.toContain("by_title_task");
    // ...and its arg is NOT destructured (binding an unused local would
    // trip --warnings-as-errors).
    expect(wf).not.toContain("wanted");
  });
});
