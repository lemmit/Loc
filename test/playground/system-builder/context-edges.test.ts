// Context-level relations: repository→aggregate, aggregate→
// event (lifted from per-aggregate emits), workflow→aggregate/event.

import { describe, expect, it } from "vitest";
import type { BoundedContext, Model, System } from "../../../src/language/generated/ast.js";
import { computeContextRelations } from "../../../web/src/builder/system-v2/context-edges.js";
import { parseRaw as parse } from "../../_helpers/index.js";

function findContext(ast: Model, name: string): BoundedContext {
  for (const m of ast.members) {
    if (m.$type === "BoundedContext" && (m as BoundedContext).name === name)
      return m as BoundedContext;
    if (m.$type === "System") {
      for (const sm of (m as System).members) {
        if (sm.$type === "BoundedContext" && (sm as BoundedContext).name === name)
          return sm as BoundedContext;
      }
    }
  }
  throw new Error(`no context ${name}`);
}

const SET = (vs: string[]) => new Set(vs);

describe("v2 — context-edges", () => {
  it("repository.for resolves to its aggregate", () => {
    const ast = parse(`context Sales {
  aggregate Order {
  }
  repository Orders for Order {
    find byId(id: int): Order? where this.id == id
  }
}`);
    const rel = computeContextRelations(findContext(ast, "Sales"));
    expect(rel.repoFor.get("Orders")).toBe("Order");
  });

  it("aggregate→event lifts the emits set from each aggregate's operations", () => {
    const ast = parse(`context Sales {
  event Placed {
  }
  event Cancelled {
  }
  aggregate Order {
    status: string
    operation confirm() {
      status := "ok"
      emit Placed {
      }
    }
    operation drop() {
      status := "no"
      emit Cancelled {
      }
    }
  }
}`);
    const rel = computeContextRelations(findContext(ast, "Sales"));
    expect(rel.emits.get("Order")).toEqual(SET(["Placed", "Cancelled"]));
  });

  it("workflows record `usesRepo` for repository receivers anywhere in the body (let RHS, call args, …)", () => {
    const ast = parse(`context Sales {
  aggregate Order {
    status: string
    operation confirm() {
      status := "ok"
    }
  }
  repository Orders for Order {
    find byId(id: int): Order? where this.id == id
  }
  workflow place {
      create(x: int) {
    let o = Orders.byId(x)
    o.confirm()
  }
    }
}`);
    const rel = computeContextRelations(findContext(ast, "Sales"));
    expect(rel.workflowUsesRepo.get("place")).toEqual(SET(["Orders"]));
  });

  it("workflows record uses + emits when bodies touch aggregates / events", () => {
    const ast = parse(`context Sales {
  event Placed {
  }
  aggregate Order {
    status: string
    operation confirm() {
      status := "ok"
    }
  }
  workflow place {
      create() {
    Order.confirm()
    emit Placed {
    }
  }
    }
}`);
    const rel = computeContextRelations(findContext(ast, "Sales"));
    expect(rel.workflowUses.get("place")).toEqual(SET(["Order"]));
    expect(rel.workflowEmits.get("place")).toEqual(SET(["Placed"]));
  });
});
