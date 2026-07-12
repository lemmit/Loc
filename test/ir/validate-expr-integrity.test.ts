// IR validator — expression-integrity pass.
//
// Catches un-expanded singleton index-page sentinels (`Home` /
// `WorkflowsIndex` / `ViewsIndex`) that escape the
// `walker-primitive-expander` (`src/ir/lower/walker-primitive-expander.ts`).
// The expander's documented contract is that downstream phases never see
// the un-expanded sentinel form.  Backends have no handler for it — left
// un-expanded they'd crash mid-codegen or emit something nonsensical.  The
// validator pass turns the failure into a clear error pointing at the
// offending page.  (The `scaffold*(of:)` body primitives were removed, so
// only the three singleton sentinels remain in the guarded set.)
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
import type { EnrichedLoomModel, ExprIR, TypeIR } from "../../src/ir/types/loom-ir.js";
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

describe("validate-expr-integrity — un-expanded sentinel rejection", () => {
  it("rejects a bare `Home` sentinel left over from expansion", async () => {
    const loom = await loadFixture();
    // Replace the page body with the shape the singleton expander
    // returns when it can't resolve the UI context — the sentinel
    // call node passes through unchanged.
    const page = loom.systems[0]!.uis[0]!.pages[0]!;
    page.body = { kind: "call", name: "Home", args: [] } as ExprIR;

    const diags = validateLoomModel(loom);
    const scaffoldDiags = diags.filter((d) => d.message.includes("un-expanded scaffold primitive"));
    expect(scaffoldDiags.length).toBeGreaterThanOrEqual(1);
    expect(scaffoldDiags[0]!.message).toContain("'Home'");
    expect(scaffoldDiags[0]!.source).toContain("Landing");
  });

  it("rejects each of the singleton sentinel names", async () => {
    // Iterates the full set — guards against silently dropping any
    // name from the SCAFFOLD_PRIMITIVE_NAMES list in validate.ts.
    const names = ["Home", "WorkflowsIndex", "ViewsIndex"];
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

  it("rejects a sentinel nested inside another expression", async () => {
    const loom = await loadFixture();
    // Wrap the un-expanded sentinel in a parent Stack — the walker
    // must recurse into nested positions, not just inspect the root.
    const page = loom.systems[0]!.uis[0]!.pages[0]!;
    page.body = {
      kind: "call",
      name: "Stack",
      args: [{ kind: "call", name: "WorkflowsIndex", args: [] }],
    } as ExprIR;

    const diags = validateLoomModel(loom);
    const scaffoldDiags = diags.filter(
      (d) =>
        d.message.includes("un-expanded scaffold primitive") &&
        d.message.includes("'WorkflowsIndex'"),
    );
    expect(scaffoldDiags.length).toBeGreaterThanOrEqual(1);
  });
});

// A4 — collection transformation-op correctness + UI-position gates.
async function irErrorCodes(source: string): Promise<string[]> {
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper<Model>(services.Ddd);
  const doc = await helper(source, { validation: false });
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value));
  return validateLoomModel(loom)
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
}

const wrapAgg = (aggBody: string) => `
  context Shop {
    aggregate Order {
      contains lines: OrderLine[]
      ${aggBody}
      entity OrderLine { qty: int }
    }
    repository Orders for Order { }
  }`;

describe("validate-expr-integrity — A4 collection-op correctness gates", () => {
  it("flags `.distinct` on an entity collection (loom.distinct-non-scalar)", async () => {
    const codes = await irErrorCodes(wrapAgg("derived dd: int = lines.distinct.count"));
    expect(codes).toContain("loom.distinct-non-scalar");
  });

  it("does NOT flag `.distinct` on a scalar (int) collection", async () => {
    const codes = await irErrorCodes(
      wrapAgg("derived dd: int = lines.map(l => l.qty).distinct.count"),
    );
    expect(codes).not.toContain("loom.distinct-non-scalar");
  });

  it("flags `.join` on a non-string (int) collection (loom.join-non-string)", async () => {
    const codes = await irErrorCodes(
      wrapAgg('derived j: int = lines.map(l => l.qty).join(", ").length'),
    );
    expect(codes).toContain("loom.join-non-string");
  });
});

describe("validate-expr-integrity — A4 collection-op-in-UI gate", () => {
  const arr: TypeIR = { kind: "array", element: { kind: "primitive", name: "string" } };
  const recv: ExprIR = { kind: "ref", name: "tags", refKind: "let" };
  const idLambda: ExprIR = {
    kind: "lambda",
    param: "x",
    body: { kind: "ref", name: "x", refKind: "lambda" },
  };
  const litInt = (v: string): ExprIR => ({ kind: "literal", lit: "int", value: v });
  const litStr = (v: string): ExprIR => ({ kind: "literal", lit: "string", value: v });
  const mc = (member: string, args: ExprIR[]): ExprIR => ({
    kind: "method-call",
    receiver: recv,
    member,
    args,
    receiverType: arr,
    isCollectionOp: true,
  });
  const distinctMember: ExprIR = {
    kind: "member",
    receiver: recv,
    member: "distinct",
    receiverType: arr,
    memberType: arr,
  };

  async function codesForPageBody(body: ExprIR): Promise<string[]> {
    const loom = await loadFixture();
    loom.systems[0]!.uis[0]!.pages[0]!.body = body;
    return validateLoomModel(loom)
      .filter((d) => d.severity === "error")
      .map((d) => d.code);
  }

  for (const [label, body] of [
    ["sortBy", mc("sortBy", [idLambda])],
    ["distinct", distinctMember],
    ["take", mc("take", [litInt("2")])],
    ["skip", mc("skip", [litInt("1")])],
  ] as [string, ExprIR][]) {
    it(`rejects '.${label}' in a UI page body (loom.collection-op-in-ui)`, async () => {
      const codes = await codesForPageBody(body);
      expect(codes).toContain("loom.collection-op-in-ui");
    });
  }

  it("does NOT reject 'map' / 'join' in a UI page body (they render on the frontend)", async () => {
    const mapCodes = await codesForPageBody(mc("map", [idLambda]));
    expect(mapCodes).not.toContain("loom.collection-op-in-ui");
    const joinCodes = await codesForPageBody(mc("join", [litStr(", ")]));
    expect(joinCodes).not.toContain("loom.collection-op-in-ui");
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
