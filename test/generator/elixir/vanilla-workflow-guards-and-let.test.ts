import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice 5c body-lowering follow-up #2 — `precondition`, `requires`, and
// `expr-let` on a vanilla workflow.  Each kind lands as a `with`-clause
// in the lowered `run_inner/1` chain:
//
//   precondition <cond>  → `:ok <- (if <cond>, do: :ok, else: {:error, {:precondition_failed, detail}})`
//   requires <cond>      → `:ok <- (if <cond>, do: :ok, else: {:error, {:forbidden, detail}})`
//   let foo = <expr>     → `foo <- (<expr>)` (always succeeds)
//
// The failure tags propagate through the with-chain so the workflow's
// caller sees `{:error, {:precondition_failed, detail}}` / `{:error, {:forbidden, detail}}`,
// which the WorkflowsController maps to RFC 7807 responses (422 / 403).
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

      workflow guardedCreate transactional {
        create(initialTitle: string) {
          precondition initialTitle.length > 0
          requires true
          let normalised = initialTitle
          let t = Task.create({ title: normalised, done: false })
          t.markDone()
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

async function loadWorkflow() {
  const files = await generateSystemFiles(SOURCE);
  return files.get([...files.keys()].find((k) => k.endsWith("/workflows/guarded_create.ex"))!)!;
}

describe("vanilla — workflow body lowering (precondition / requires / expr-let)", () => {
  it("lowers `precondition <cond>` to an `:ok` with-clause that tags failure as :precondition_failed", async () => {
    const wf = await loadWorkflow();
    expect(wf).toMatch(
      /:ok <- \(if .+?, do: :ok, else: \{:error, \{:precondition_failed, .+?\}\}\)/,
    );
  });

  it("lowers `requires <cond>` to an `:ok` with-clause that tags failure as :forbidden", async () => {
    const wf = await loadWorkflow();
    expect(wf).toMatch(/:ok <- \(if .+?, do: :ok, else: \{:error, \{:forbidden, .+?\}\}\)/);
  });

  it("lowers `let normalised = <expr>` to a binding with-clause", async () => {
    const wf = await loadWorkflow();
    expect(wf).toMatch(/normalised <- \(/);
  });

  it("the precondition clause precedes the factory-let in the with-chain", async () => {
    const wf = await loadWorkflow();
    const preIdx = wf.indexOf(":precondition_failed");
    const factoryIdx = wf.indexOf("Context.create_task");
    expect(preIdx).toBeGreaterThan(0);
    expect(factoryIdx).toBeGreaterThan(0);
    expect(preIdx).toBeLessThan(factoryIdx);
  });

  it("a factory-let still wins the result slot when expr-let comes earlier", async () => {
    const wf = await loadWorkflow();
    // The with-chain returns `{:ok, t}` (the Task), NOT `{:ok, normalised}`
    // (the pure binding) — expr-let carries `bindName: undefined` so a
    // subsequent factory-let claims the success result.  The do-branch opens
    // with the woven `workflow_completed` log line (S3) before the result.
    expect(wf).toMatch(
      /with [\s\S]*do\n\s+Logger\.info\("workflow_completed"[\s\S]*?\n\s+\{:ok, t\}\n\s+end/,
    );
  });
});

// ---------------------------------------------------------------------------
// M-T6.21's underscore rule vs. the REF COLLECTOR that feeds it.
//
// A workflow `let` whose name is never read downstream is `_`-prefixed, or
// `mix compile --warnings-as-errors` trips on the unused variable.  The read
// test is `collectWorkflowStmtParamRefsAll`, and it used to be a hand-enumerated
// `WorkflowStmtIR.kind` switch whose `repo-run` arm walked only `retrievalArgs`
// — never the `page:` bounds, which the RENDERER does emit.  So a `let` used
// solely as an offset/limit read as unread, the bind became `_cap`, and the
// emitted `Repo.run(..., limit: cap)` next to it named a variable that no
// longer existed: `** (CompileError) undefined variable "cap"`, on every build.
//
// The durable fix is the shared, trailing-`never`-guarded walkers in
// `src/ir/util/walk.ts` — so a new statement kind (or a new child slot on an
// existing one) is a compile error there rather than a silent hole here.
const PAGE_BOUND_LET = `
system PageLet {
  subdomain Ops {
    context Fulfillment {
      enum Priority { Low High }
      aggregate Order with crudish {
        reference: string
        priority: Priority
        placedAt: datetime
        operation escalate() {
          priority := High
        }
      }
      criterion AtPriority(p: Priority) of Order = priority == p
      retrieval PendingByPriority(p: Priority) of Order {
        where: AtPriority(p)
        sort: [placedAt asc]
      }
      repository Orders for Order { }
      workflow escalateBacklog {
        create(p: Priority) {
          let cap = 50
          let batch = Orders.run(PendingByPriority(p), page: { offset: 0, limit: cap })
          for o in batch {
            o.escalate()
          }
        }
      }
    }
  }
  api OpsApi from Ops
  storage primary { type: postgres }
  resource fState { for: Fulfillment, kind: state, use: primary }
  deployable d {
    platform: elixir
    contexts: [Fulfillment]
    dataSources: [fState]
    serves: OpsApi
    port: 4000
  }
}
`;

describe("vanilla — a `let` read only by a `Repo.run` page bound keeps its name", () => {
  it("binds `cap`, not `_cap`, and the emitted page bound names it", async () => {
    const files = await generateSystemFiles(PAGE_BOUND_LET);
    const wf = files.get(
      [...files.keys()].find((k) => k.endsWith("/workflows/escalate_backlog.ex"))!,
    )!;
    // The bind keeps its real name …
    expect(wf).toContain("cap <- (50)");
    expect(wf, "the page-only `let` was discarded as unread").not.toContain("_cap <-");
    // … and the page bound the renderer emits references it.
    expect(wf).toContain("limit: cap");
    // The pair is what matters: an emitted `limit: cap` next to a `_cap` bind
    // is the CompileError, so assert they agree on ONE spelling.
    const underscored = /\b_cap\b/.test(wf);
    expect(underscored, "emitted `_cap` while the page bound reads `cap`").toBe(false);
  });
});

describe("vanilla — WorkflowsController maps precondition failure to 422", () => {
  it("emits a `:precondition_failed` → 422 case in the controller", async () => {
    const files = await generateSystemFiles(SOURCE);
    const ctrl = files.get(
      [...files.keys()].find((k) => k.endsWith("/controllers/workflows_controller.ex"))!,
    )!;
    expect(ctrl).toMatch(/def respond\(conn, \{:error, \{:precondition_failed, detail\}\}\)/);
    expect(ctrl).toMatch(/problem_response\(conn, 422,/);
  });
});
