// Parsing: the optional `requires <expr>` authorization gate (authorization.md
// §11.3) on an aggregate `operation`, a workflow `create` starter, and a
// workflow `handle` command — the write-side twin of the find / view gate.
// On `operation` it sits after the return type, before `when`.

import { describe, expect, it } from "vitest";
import type {
  HandleDecl,
  Model,
  Operation,
  WorkflowCreateDecl,
} from "../../../src/language/generated/ast.js";
import {
  isAggregate,
  isHandleDecl,
  isOperation,
  isSubdomain,
  isWorkflow,
  isWorkflowCreateDecl,
} from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/index.js";

function contextMembers(model: Model) {
  const out: unknown[] = [];
  for (const sys of model.members) {
    for (const sm of sys.members) {
      if (!isSubdomain(sm)) continue;
      for (const c of sm.contexts) out.push(...c.members);
    }
  }
  return out;
}

function firstOperation(model: Model): Operation {
  for (const m of contextMembers(model)) {
    if (isAggregate(m)) {
      const op = m.members.find(isOperation);
      if (op) return op;
    }
  }
  throw new Error("no operation");
}

function firstCreate(model: Model): WorkflowCreateDecl {
  for (const m of contextMembers(model)) {
    if (isWorkflow(m)) {
      const c = m.members.find(isWorkflowCreateDecl);
      if (c) return c;
    }
  }
  throw new Error("no workflow create");
}

function firstHandle(model: Model): HandleDecl {
  for (const m of contextMembers(model)) {
    if (isWorkflow(m)) {
      const h = m.members.find(isHandleDecl);
      if (h) return h;
    }
  }
  throw new Error("no workflow handle");
}

const wrap = (body: string) => `system Sys {
  user { id: string  role: string }
  subdomain S {
    context Tickets {
      aggregate Ticket {
        subject: string  open: bool
        ${body}
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
}`;

describe("operation / workflow requires gate parsing", () => {
  it("parses a `requires` gate on an operation (before the body)", async () => {
    const { model, errors } = await parseString(
      wrap('operation close() requires currentUser.role == "agent" { open := false }'),
    );
    expect(errors).toEqual([]);
    const op = firstOperation(model);
    expect(op.name).toBe("close");
    expect(op.gate).toBeDefined();
  });

  it("parses `requires` alongside `when` on the same operation (requires then when)", async () => {
    const { model, errors } = await parseString(
      wrap('operation close() requires currentUser.role == "agent" when open { open := false }'),
    );
    expect(errors).toEqual([]);
    const op = firstOperation(model);
    expect(op.gate).toBeDefined();
    expect(op.when).toBeDefined();
  });

  it("an ungated operation has no gate (back-compat)", async () => {
    const { model, errors } = await parseString(wrap("operation close() { open := false }"));
    expect(errors).toEqual([]);
    expect(firstOperation(model).gate).toBeUndefined();
  });

  it("parses a `requires` gate on a workflow create starter", async () => {
    const { model, errors } = await parseString(wrap("operation close() { open := false }"));
    expect(errors).toEqual([]);
    expect(firstCreate(model).gate).toBeDefined();
  });

  it("parses a `requires` gate on a workflow handle command", async () => {
    const { model, errors } = await parseString(wrap("operation close() { open := false }"));
    expect(errors).toEqual([]);
    expect(firstHandle(model).gate).toBeDefined();
  });
});
