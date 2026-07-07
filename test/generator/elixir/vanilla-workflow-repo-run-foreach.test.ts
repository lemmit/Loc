import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice 5c body-lowering follow-up #7 — `repo-run` + `for-each`.
//
// Consumes the retrieval emission slice (#1118) — workflows now bind a
// named query bundle's result and iterate it with per-element saves:
//
//     let xs = Tasks.run(Pending(d), page: { offset: 0, limit: 100 })
//     for x in xs { x.markDone() }
//
// lowers to:
//
//     {:ok, xs} <- Context.run_pending_task(d, offset: 0, limit: 100),
//     {:ok, _} <- Enum.reduce_while(xs, {:ok, nil}, fn x, _acc ->
//        case Context.mark_done_task(x, %{}) do
//          {:ok, updated} -> {:cont, {:ok, updated}}
//          err -> {:halt, err}
//        end
//      end)
//
// `reduce_while`'s first-failure-halts contract bubbles the error tuple
// up the with-chain, so a per-element failure short-circuits the whole
// workflow (and rolls a transactional wrapper back).
//
// This closes the body-lowering sequence: every WorkflowStmtIR kind now
// lowers to real Elixir.  The `default:`/`# TODO` fallthrough is removed
// from `lowerStatement` (the switch is exhaustive over the IR union);
// only a non-getById `repo-let` (custom find) still falls back, gated by
// its own arm.
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
      retrieval Pending(d: bool) of Task {
        where: this.done == d
      }

      workflow finalizePending {
        create(d: bool) {
          let xs = Tasks.run(Pending(d), page: { offset: 0, limit: 100 })
          for x in xs {
            x.markDone()
          }
        }
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

async function loadWorkflow(): Promise<string> {
  const files = await generateSystemFiles(SOURCE);
  return files.get([...files.keys()].find((k) => k.endsWith("/workflows/finalize_pending.ex"))!)!;
}

describe("vanilla — workflow body lowering (repo-run)", () => {
  it("lowers `let xs = Tasks.run(Pending(d), page: ...)` to a Context.run_<ret>_<agg> with-clause", async () => {
    const wf = await loadWorkflow();
    expect(wf).toMatch(/\{:ok, xs\} <- Context\.run_pending_task\(d, offset: 0, limit: 100\)/);
  });

  it("surfaces the retrieval arg as a destructured create-param", async () => {
    const wf = await loadWorkflow();
    expect(wf).toContain(`%{"d" => d} = params`);
  });

  it("omits the page opts when no page clause is given", async () => {
    const files = await generateSystemFiles(`
      system Tasks {
        subdomain Productivity {
          context Tracker {
            aggregate Task with crudish { title: string, done: bool }
            repository Tasks for Task { }
            retrieval Pending(d: bool) of Task { where: this.done == d }
            workflow pageless {
              create(d: bool) {
                let xs = Tasks.run(Pending(d))
                for x in xs { }
              }
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
    `);
    const wf = files.get([...files.keys()].find((k) => k.endsWith("/workflows/pageless.ex"))!)!;
    expect(wf).toMatch(/Context\.run_pending_task\(d\)/);
    expect(wf).not.toContain("offset:");
    expect(wf).not.toContain("limit:");
  });
});

describe("vanilla — workflow body lowering (for-each over a repo-run binding)", () => {
  it("renders the loop as `Enum.reduce_while(xs, {:ok, nil}, fn x, _acc -> ... end)` inside the with-chain", async () => {
    const wf = await loadWorkflow();
    expect(wf).toMatch(/\{:ok, _\} <- Enum\.reduce_while\(xs, \{:ok, nil\}, fn x, _acc ->/);
  });

  it("each body op-call becomes a case match returning {:cont, _}/{:halt, err}", async () => {
    const wf = await loadWorkflow();
    expect(wf).toMatch(/case Context\.mark_done_task\(x, %\{\}\) do/);
    expect(wf).toContain("{:ok, updated} -> {:cont, {:ok, updated}}");
    expect(wf).toContain("err -> {:halt, err}");
  });

  it("the reduce_while clause sits inside the with-chain (failures bubble up)", async () => {
    const wf = await loadWorkflow();
    // The reduce_while is a with-clause, so its first-error-halts return
    // is unified with the rest of the with-chain's error short-circuit.
    expect(wf).toMatch(
      /with \{:ok, xs\} <- Context\.run_pending_task[\s\S]+\{:ok, _\} <- Enum\.reduce_while/,
    );
  });

  it("no Ash references appear (no Ash.Page.Offset.results, no Ash.transaction)", async () => {
    const wf = await loadWorkflow();
    expect(wf).not.toContain("Ash.");
    expect(wf).not.toContain(".results"); // vanilla retrieval returns a bare list, NOT a page struct
  });
});

describe("vanilla — switch over WorkflowStmtIR is now exhaustive", () => {
  it("no `# TODO: lower workflow statement kind` comment appears for repo-run or for-each", async () => {
    const wf = await loadWorkflow();
    expect(wf).not.toContain("# TODO: lower workflow statement kind 'repo-run'");
    expect(wf).not.toContain("# TODO: lower workflow statement kind 'for-each'");
  });
});
