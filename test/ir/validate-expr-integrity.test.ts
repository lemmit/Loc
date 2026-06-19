// IR validator — expression-integrity pass.
//
// Catches un-expanded scaffold primitives that escape the
// `walker-primitive-expander` (`src/ir/lower/walker-primitive-expander.ts`).
// The expander's documented contract is that downstream phases never see
// the un-expanded form; its early-exit branches at lines 104, 117, 127
// silently violate that when the target aggregate/workflow/view can't be
// resolved.  Backends have no handler for the un-expanded shape — pre-fix
// they either crashed mid-codegen or emitted something nonsensical.  The
// new validator pass turns the failure into a clear error pointing at the
// offending page.
//
// What this file does NOT cover: `refKind: "unknown"` ref handling.  That
// shape is INTENTIONAL for e2e test bodies and member-chain receivers
// (see `src/ir/lower/lower-expr.ts:606-608` comment); the existing
// workflow-scope check at `validate/validate.ts:1098` already catches
// the position where it IS a bug.  An earlier draft of this validator
// extended that check globally and broke 61 legitimate codegen paths —
// see commit message for the lesson.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { EnrichedLoomModel, ExprIR } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

const FIXTURE = `system Mini {
  subdomain M {
    context C {
      event OrderPlaced { name: string }
      aggregate Order {
        name: string
        derived display: string = name
        invariant name.length > 0
      }
      repository Orders for Order { }
      workflow placeOrder {
      create(customerName: string) {
        precondition customerName.length > 0
        emit OrderPlaced { name: customerName }
      }
    }
    }
  }
  api MiniApi from M
  ui Admin {
    page Landing {
      route: "/"
      body: Heading("Hello")
    }
  }
  deployable api {
    platform: node
    contexts: [C]
    serves: MiniApi
    port: 3000
  }
  deployable web {
    platform: static
    targets: api
    ui: Admin
    port: 5173
  }
}`;

async function loadFixture(): Promise<EnrichedLoomModel> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-validate-integrity-"));
  const file = path.join(dir, "mini.ddd");
  fs.writeFileSync(file, FIXTURE);
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(file));
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length > 0) {
    throw new Error(`fixture parse errors:\n${errors.map((e) => e.message).join("\n")}`);
  }
  return enrichLoomModel(lowerModel(doc.parseResult.value as Model));
}

describe("validate-expr-integrity — clean fixture passes", () => {
  it("the baseline fixture has no un-expanded-scaffold diagnostics", async () => {
    const loom = await loadFixture();
    const diags = validateLoomModel(loom);
    const scaffoldDiags = diags.filter((d) => d.message.includes("un-expanded scaffold primitive"));
    expect(scaffoldDiags).toEqual([]);
  });
});

describe("validate-expr-integrity — un-expanded scaffold-primitive rejection", () => {
  it("rejects a `scaffoldDetails` call left over from expansion", async () => {
    const loom = await loadFixture();
    // Replace the page body with the shape the scaffold expander
    // returns when it can't resolve the target aggregate — the call
    // node passes through unchanged.
    const page = loom.systems[0]!.uis[0]!.pages[0]!;
    page.body = {
      kind: "call",
      name: "scaffoldDetails",
      args: [{ kind: "ref", name: "Unknown", refKind: "param", type: { kind: "any" } }],
      argNames: ["of"],
    } as ExprIR;

    const diags = validateLoomModel(loom);
    const scaffoldDiags = diags.filter((d) => d.message.includes("un-expanded scaffold primitive"));
    expect(scaffoldDiags.length).toBeGreaterThanOrEqual(1);
    expect(scaffoldDiags[0]!.message).toContain("'scaffoldDetails'");
    expect(scaffoldDiags[0]!.source).toContain("Landing");
  });

  it("rejects each of the documented scaffold-primitive names", async () => {
    // Iterates the full set — guards against silently dropping any
    // name from the SCAFFOLD_PRIMITIVE_NAMES list in validate.ts.
    const names = [
      "scaffoldDetails",
      "scaffoldOperations",
      "scaffoldList",
      "scaffoldNewForm",
      "scaffoldWorkflowForm",
      "scaffoldViewList",
      "Home",
      "WorkflowsIndex",
      "ViewsIndex",
    ];
    for (const name of names) {
      const loom = await loadFixture();
      const page = loom.systems[0]!.uis[0]!.pages[0]!;
      page.body = { kind: "call", name, args: [] } as ExprIR;
      const diags = validateLoomModel(loom);
      const flagged = diags.some(
        (d) =>
          d.message.includes("un-expanded scaffold primitive") && d.message.includes(`'${name}'`),
      );
      expect(flagged, `expected validator to reject un-expanded '${name}'`).toBe(true);
    }
  });

  it("rejects a scaffold primitive nested inside another expression", async () => {
    const loom = await loadFixture();
    // Wrap the un-expanded scaffold in a parent Stack — the walker
    // must recurse into nested positions, not just inspect the root.
    const page = loom.systems[0]!.uis[0]!.pages[0]!;
    page.body = {
      kind: "call",
      name: "Stack",
      args: [{ kind: "call", name: "scaffoldList", args: [] }],
    } as ExprIR;

    const diags = validateLoomModel(loom);
    const scaffoldDiags = diags.filter(
      (d) =>
        d.message.includes("un-expanded scaffold primitive") &&
        d.message.includes("'scaffoldList'"),
    );
    expect(scaffoldDiags.length).toBeGreaterThanOrEqual(1);
  });
});

describe("validate-expr-integrity — non-scaffold calls are not flagged", () => {
  it("regular primitive calls (Heading, Stack, etc.) pass clean", async () => {
    // Anti-regression: the SCAFFOLD_PRIMITIVE_NAMES set must not
    // collide with the regular walker primitives.  The baseline
    // fixture uses Heading("Hello") in its page body — that should
    // never trip the scaffold guard.
    const loom = await loadFixture();
    const diags = validateLoomModel(loom);
    const scaffoldFalsePositive = diags.filter(
      (d) =>
        d.message.includes("un-expanded scaffold primitive") &&
        (d.message.includes("'Heading'") ||
          d.message.includes("'Stack'") ||
          d.message.includes("'Card'")),
    );
    expect(scaffoldFalsePositive).toEqual([]);
  });
});
