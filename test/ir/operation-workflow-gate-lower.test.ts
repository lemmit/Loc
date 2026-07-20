// Lowering of the `requires <expr>` authorization gate (authorization.md §11.3):
// the header gate on an operation / workflow-create / workflow-handle lowers to
// a synthetic `requires` StmtIR prepended to the body, so every backend's
// existing `requires`->403 rendering fires with no new emitter code.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/index.js";

const SRC = `
  system Sys {
    user { id: string role: string }
    subdomain S {
      context Tickets {
        aggregate Ticket {
          subject: string  open: bool
          operation close() requires currentUser.role == "agent" { open := false }
        }
        repository Tickets for Ticket { }
        workflow Triage {
          create open(subject: string) requires currentUser.role == "admin" {
            precondition subject.length > 0
          }
          handle escalate(id: Ticket id) requires currentUser.role == "agent" {
            let t = Tickets.byId(id)
          }
        }
      }
    }
    storage primary { type: postgres }
    resource st { for: Tickets, kind: state, use: primary }
    api Api from S
    deployable api { platform: node  contexts: [Tickets]  serves: Api  dataSources: [st]  port: 3000  auth: required }
  }`;

describe("operation / workflow requires gate — lowering", () => {
  it("prepends a `requires` StmtIR carrying the gate expr + source to each body", async () => {
    const { model, errors } = await parseString(SRC, { validate: true });
    expect(errors).toEqual([]);
    const ir = lowerModel(model);
    const ctx = allContexts(ir)[0];

    // Operation: first statement is the gate, before the `open := false` assign.
    const agg = ctx.aggregates.find((a) => a.name === "Ticket")!;
    const op = agg.operations.find((o) => o.name === "close")!;
    expect(op.statements[0].kind).toBe("requires");
    expect((op.statements[0] as { source: string }).source).toContain(
      'currentUser.role == "agent"',
    );
    expect(op.statements[1].kind).toBe("assign");

    // Workflow create + handle: gate is the first body statement.
    const wf = ctx.workflows!.find((w) => w.name === "Triage")! as unknown as {
      creates: { statements: { kind: string }[] }[];
      handlers: { name: string; statements: { kind: string; source?: string }[] }[];
    };
    const create = wf.creates[0];
    expect(create.statements[0].kind).toBe("requires");
    expect(create.statements[1].kind).toBe("precondition");

    const handle = wf.handlers.find((h) => h.name === "escalate")!;
    expect(handle.statements[0].kind).toBe("requires");
    expect(handle.statements[0].source).toContain('currentUser.role == "agent"');
  });

  it("leaves an ungated operation body untouched", async () => {
    const { model } = await parseString(
      SRC.replace('requires currentUser.role == "agent" { open := false }', "{ open := false }"),
      { validate: true },
    );
    const ir = lowerModel(model);
    const ctx = allContexts(ir)[0];
    const op = ctx.aggregates
      .find((a) => a.name === "Ticket")!
      .operations.find((o) => o.name === "close")!;
    expect(op.statements[0].kind).toBe("assign");
  });
});
