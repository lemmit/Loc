import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// WHERE the `requires` authorization gate lands on the vanilla (plain
// Ecto/Phoenix) backend.
//
// The other four backends needed a hoist (`src/ir/util/op-gates.ts`): they
// emitted the 403 INSIDE the aggregate method, which forced a `currentUser`
// parameter onto the entity and made it uncallable from a saga / seed / timer
// without fabricating a principal.
//
// Elixir was already right, and by a better factoring than the hoist produces
// elsewhere.  `collectOpGuardClauses` lifts `requires` (and `precondition`, and
// the `when` gate) into a leading `with :ok <- ensure(…)` chain on the CONTEXT
// function — Phoenix's application layer — and `bodyStmts` explicitly drops
// those statements from the body.  The Ecto schema module stays a plain data
// struct.  Because every caller goes THROUGH the context function, enforcement
// is inherited rather than duplicated at each call site: a workflow that calls
// `Context.close_ticket(...)` cannot bypass the gate the way a direct entity
// call on the other backends could.
//
// This test pins that placement so a future refactor can't quietly relocate the
// 403 into the schema module and re-import the problem the hoist just removed.
// ---------------------------------------------------------------------------

const SRC = `
system WfGate {
  user { id: guid  role: string }
  subdomain S {
    context C {
      aggregate Ticket with crudish {
        subject: string
        open: bool
        operation close(note: string) requires currentUser.role == "agent" && note != "x" {
          open := false
        }
      }
      repository Tickets for Ticket { }
      workflow Sweep {
        create run(ticketId: Ticket id, note: string) requires currentUser.role == "ops" {
          let t = Tickets.getById(ticketId)
          t.close(note)
          Tickets.save(t)
        }
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  api A from S
  deployable d { platform: elixir contexts: [C] serves: A dataSources: [st] port: 4000 auth: required }
}
`;

describe("vanilla phoenix — `requires` gate placement", () => {
  it("the 403 lives on the context function, not the Ecto schema", async () => {
    const files = await generateSystemFiles(SRC);
    const context = files.get("d/lib/d/c.ex");
    const schema = files.get("d/lib/d/c/ticket.ex");
    expect(context, "the context module").toBeDefined();
    expect(schema, "the Ticket schema module").toBeDefined();

    // The gate is a leading `with :ok <- ensure(...)` clause on the context
    // function, denying with a `{:forbidden, msg}` tuple the controller maps
    // to 403 — before the mutation or the persist runs.
    expect(context).toMatch(/with :ok <- ensure\(.*\{:forbidden,/s);
    expect(context).toContain('current_user.role == "agent"');

    // Authorization is not an invariant: the schema module neither evaluates
    // the gate nor knows about a principal.
    expect(schema).not.toContain(":forbidden");
    expect(schema).not.toContain("current_user");
  });

  it("a workflow inherits the gate by routing through the context function", async () => {
    const files = await generateSystemFiles(SRC);
    const wf = files.get("d/lib/d/c/workflows/sweep.ex");
    expect(wf, "the workflow module").toBeDefined();

    // The workflow's OWN gate is inlined here...
    expect(wf).toContain('current_user.role == "ops"');
    // ...but it does NOT re-emit the operation's gate, because it calls the
    // context function that already carries it — one gate location, every
    // caller covered.
    expect(wf).toMatch(/Context\.close_ticket\(t, .*current_user\)/);
    expect(wf).not.toContain('current_user.role == "agent"');
  });
});
