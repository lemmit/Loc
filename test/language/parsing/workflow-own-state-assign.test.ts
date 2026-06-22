// Workflow own-state mutation (workflow.md, "handle = own-state mutation"):
// a `field := value` statement inside a workflow `create`/`handle`/`on` body
// that writes one of the workflow's OWN state `Property` fields parses to a
// plain `AssignOrCallStmt` with `op = ':='` — the same statement node an
// aggregate operation's `status := …` produces.  Parse-only: this asserts the
// surface AST, not the lowered `assign` IR (that's test/ir/).

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import {
  type AssignOrCallStmt,
  isAssignOrCallStmt,
  isWorkflowCreateDecl,
} from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/index.js";

const SRC = `
  system S {
    subdomain M {
      context C {
        aggregate Order { total: int }
        event OrderPlaced { order: Order id, at: datetime }
        channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
        workflow OrderFulfillment {
          orderId: Order id
          attempts: int
          create(p: OrderPlaced) by p.order { attempts := 1 }
        }
        repository Orders for Order {}
      }
    }
  }
`;

describe("workflow own-state assignment — parsing", () => {
  it("parses `attempts := 1` in a create body to an AssignOrCallStmt with op ':='", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);

    const create = [...AstUtils.streamAst(model)].find(isWorkflowCreateDecl);
    expect(create, "create decl not parsed").toBeDefined();

    const stmt = create!.body[0];
    expect(isAssignOrCallStmt(stmt)).toBe(true);
    const assign = stmt as AssignOrCallStmt;
    expect(assign.op).toBe(":=");
    expect(assign.target.head).toBe("attempts");
    expect(assign.target.tail).toEqual([]);
    expect(assign.target.call).toBe(false);
    expect(assign.value?.$type).toBe("IntLit");
  });
});
