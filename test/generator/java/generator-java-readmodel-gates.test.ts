// ---------------------------------------------------------------------------
// Java read-model shapes (M-T6.4).  Shapes that used to CRASH java codegen with
// an ungated `throw new Error`, now IMPLEMENTED:
//
//   1. VO-typed workflow-instance / projection read-model fields — the
//      `<Vo>Response` record is co-located in the consuming package
//      (application.workflows) and the read-model DTO / Row references it
//      (parity with the aggregate response path).
//
// The entity (containment-part) variant used to carry two defensive
// `loom.java-*-field-unsupported` codes.  M-T6.36 asked for the refused shapes
// to be EMITTED; probing that premise showed there is nothing to emit, because
// the shape is UNREACHABLE — a part type resolves only inside its own aggregate
// (`src/language/ddd-scope.ts`), so `projection P { line: Line }` and
// `workflow W { line: Line }` both fail at phase ③ on EVERY platform, before
// any java-specific check runs.  Two backend-named codes for a shape the
// LANGUAGE refuses is the M-T5.21 §Symptom 1 lie: java read as uniquely
// limited, and the open-gap register carried two rows nothing could drain.
//
// Both codes were retired 2026-08-31.  The emitters keep their
// `guardInstanceField` / `guardProjectionField` throws as internal invariants,
// and the last two cases in this file pin the unreachability AT THE SCOPE
// LAYER — so if that rule ever widens, the gap reappears as a failing test
// rather than as a crash in `ddd generate system`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";
import { parseString } from "../../_helpers/parse.js";

async function codesFor(src: string): Promise<string[]> {
  const loom = await buildLoomModel(src);
  return validateLoomModel(loom)
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
}

// VO-typed saga instance-view field — the correlation-bearing workflow carries a
// valueobject state field, which lands on `instanceWireShape`.
const workflowVoDdd = (platform: string): string => `
system S {
  subdomain Sales {
    context Orders {
      valueobject Money {
        amount: int
        currency: string
      }
      aggregate Order {
        code: string
      }
      repository Orders for Order { }
      event OrderPlaced { order: Order id }
      workflow Fulfillment {
        orderId: Order id
        cost: Money
        create(p: OrderPlaced) by p.order { cost := Money { amount: 0, currency: "USD" } }
      }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: ${platform}, contexts: [Orders], dataSources: [st], serves: A, port: 4000 }
}`;

// VO-typed projection row field — the read-model row carries a valueobject
// field, which lands on the projection `wireShape`.
const projectionVoDdd = (platform: string): string => `
system S {
  subdomain Sales {
    context Orders {
      valueobject Money {
        amount: int
        currency: string
      }
      aggregate Order {
        code: string
      }
      repository Orders for Order { }
      event OrderPlaced { order: Order id }
      channel Lifecycle {
        carries: OrderPlaced
        delivery: broadcast
        retention: ephemeral
      }
      projection OrderBoard keyed by order {
        order: Order id
        cost: Money
        on(e: OrderPlaced) { order := e.order  cost := Money { amount: 0, currency: "USD" } }
      }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: ${platform}, contexts: [Orders], dataSources: [st], serves: A, port: 4000 }
}`;

const WF_ROOT = "d/src/main/java/com/loom/d/application/workflows";

describe("java read-model VO fields (M-T6.4 implementation)", () => {
  it("no longer gates a VO-typed saga instance field on java", async () => {
    expect(await codesFor(workflowVoDdd("java"))).not.toContain(
      "loom.java-workflow-instance-field-unsupported",
    );
  });

  it("emits MoneyResponse into application.workflows and the InstanceResponse references it", async () => {
    const files = await generateSystemFiles(workflowVoDdd("java"));
    const vo = files.get(`${WF_ROOT}/MoneyResponse.java`);
    expect(vo, "MoneyResponse.java co-located with the instance DTO").toBeDefined();
    expect(vo!).toContain("public static MoneyResponse from(Money value)");
    const dto = files.get(`${WF_ROOT}/FulfillmentInstanceResponse.java`)!;
    expect(dto).toContain("MoneyResponse cost");
  });

  it("no longer gates a VO-typed projection row field on java", async () => {
    expect(await codesFor(projectionVoDdd("java"))).not.toContain(
      "loom.java-projection-field-unsupported",
    );
  });

  it("emits MoneyResponse for a projection row and the ProjectionResponse references it", async () => {
    const files = await generateSystemFiles(projectionVoDdd("java"));
    expect(files.get(`${WF_ROOT}/MoneyResponse.java`)).toBeDefined();
    const dto = files.get(`${WF_ROOT}/OrderBoardResponse.java`)!;
    expect(dto).toContain("MoneyResponse cost");
  });
});

// ---------------------------------------------------------------------------
// The unreachability the two retired codes were standing in for (M-T6.36).
//
// These are the load-bearing cases: the java emitters' `guardInstanceField` /
// `guardProjectionField` throws are only allowed to be internal invariants
// while the ENTITY-typed read-model field cannot be written.  It cannot,
// because the scope provider refuses a containment part outside its own
// aggregate — and that is a LANGUAGE rule, not a java one, which is why the
// java-named codes were a lie.  If the scope rule ever widens, these two fail
// and the next agent knows the backstop has become a real gap.
// ---------------------------------------------------------------------------

const entityFieldDdd = (member: string): string => `
system S {
  subdomain Sales {
    context Orders {
      aggregate Order {
        entity Line { sku: string }
        code: string
        contains lines: Line[]
      }
      repository Orders for Order { }
      event OrderPlaced { order: Order id }
      channel Lifecycle {
        carries: OrderPlaced
        delivery: broadcast
        retention: ephemeral
      }
${member}
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: java, contexts: [Orders], dataSources: [st], serves: A, port: 4000 }
}`;

describe("entity-typed read-model fields are unreachable (M-T6.36)", () => {
  const cases: [string, string][] = [
    [
      "projection row",
      `      projection OrderBoard keyed by order {
        order: Order id
        line: Line
        on(e: OrderPlaced) { order := e.order }
      }`,
    ],
    [
      "workflow instance",
      `      workflow Fulfillment {
        orderId: Order id
        line: Line
        create(p: OrderPlaced) by p.order { }
      }`,
    ],
  ];

  for (const [what, member] of cases) {
    it(`an entity-typed ${what} field does not link — a part is private to its aggregate`, async () => {
      const { errors } = await parseString(entityFieldDdd(member), { validate: true });
      expect(
        errors.join("\n"),
        "the containment part must stay unresolvable outside its aggregate; if this " +
          "passes, the java emitters' entity-typed guard throws have become reachable " +
          "and need a real gate again (see M-T6.36)",
      ).toContain("Could not resolve reference to NamedDecl named 'Line'");
    });
  }
});
