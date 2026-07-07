import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice 5c body-lowering follow-up #1 — factory-let + op-call.
//
// The two simplest mutating WorkflowStmtIR kinds, both consuming
// Slice 5c's context facade functions:
//
//   factory-let  → `{:ok, <name>} <- Context.create_<agg>(%{fields})`
//   op-call      → `{:ok, _}      <- Context.<op>_<agg>(target, %{args})`
//
// Unsupported kinds fall through to a `# TODO: lower <kind>` comment so
// the workflow module still compiles under --warnings-as-errors.  Each
// remaining kind (precondition / requires / emit / repo-let / expr-let /
// for-each / repo-run) lands as its own focused slice.
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

        operation toggle(flag: bool) {
          done := flag
        }
      }
      repository Tasks for Task { }

      workflow createAndComplete transactional {
        create() {
          let t = Task.create({ title: "Untitled", done: false })
          t.markDone()
          t.toggle(false)
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

describe("vanilla — workflow body lowering (factory-let + op-call)", () => {
  it("aliases the context module as Context for tidy rendering", async () => {
    const files = await generateSystemFiles(SOURCE);
    const wf = files.get(
      [...files.keys()].find((k) => k.endsWith("/workflows/create_and_complete.ex"))!,
    )!;
    expect(wf).toContain("alias Api.Tracker, as: Context");
  });

  it("lowers `let t = Task.create({...})` to a Context.create_task with-clause", async () => {
    const files = await generateSystemFiles(SOURCE);
    const wf = files.get(
      [...files.keys()].find((k) => k.endsWith("/workflows/create_and_complete.ex"))!,
    )!;
    expect(wf).toMatch(
      /with \{:ok, t\} <- Context\.create_task\(%\{title: "Untitled", done: false\}\)/,
    );
  });

  it("lowers `t.markDone()` to a Context.mark_done_task with-clause that pattern-matches success", async () => {
    const files = await generateSystemFiles(SOURCE);
    const wf = files.get(
      [...files.keys()].find((k) => k.endsWith("/workflows/create_and_complete.ex"))!,
    )!;
    expect(wf).toContain("{:ok, _} <- Context.mark_done_task(t, %{})");
  });

  it("keys an op-call's params map by the called op's REAL param name as a string key", async () => {
    // Regression: positional atom keys (`%{arg0: ...}`) silently resolved to
    // `nil` in the facade's `Map.get(params, "flag")` read.  The key must be the
    // operation's declared parameter name as a STRING key.
    const files = await generateSystemFiles(SOURCE);
    const wf = files.get(
      [...files.keys()].find((k) => k.endsWith("/workflows/create_and_complete.ex"))!,
    )!;
    expect(wf).toContain('{:ok, _} <- Context.toggle_task(t, %{"flag" => false})');
    expect(wf).not.toContain("arg0:");
  });

  it("the with-chain returns {:ok, <last-bound>} on success", async () => {
    const files = await generateSystemFiles(SOURCE);
    const wf = files.get(
      [...files.keys()].find((k) => k.endsWith("/workflows/create_and_complete.ex"))!,
    )!;
    // The do-branch now opens with the woven `workflow_completed` log line
    // (S3 lifecycle events) before the `{:ok, t}` success result.
    expect(wf).toMatch(
      /with [\s\S]*do\n\s+Logger\.info\("workflow_completed"[\s\S]*?\n\s+\{:ok, t\}\n\s+end/,
    );
  });

  it("the lowered body is wrapped in Repo.transaction for a `transactional` workflow", async () => {
    const files = await generateSystemFiles(SOURCE);
    const wf = files.get(
      [...files.keys()].find((k) => k.endsWith("/workflows/create_and_complete.ex"))!,
    )!;
    expect(wf).toContain("Repo.transaction(fn ->");
    expect(wf).toContain("Repo.rollback(reason)");
  });

  it("no Ash references appear in the lowered body", async () => {
    const files = await generateSystemFiles(SOURCE);
    const wf = files.get(
      [...files.keys()].find((k) => k.endsWith("/workflows/create_and_complete.ex"))!,
    )!;
    expect(wf).not.toContain("Ash.");
    expect(wf).not.toContain("Ash.Resource");
    expect(wf).not.toContain("Ash.transaction");
  });
});
