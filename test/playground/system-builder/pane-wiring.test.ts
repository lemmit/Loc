// Wiring pins for the v2 model-builder panes.
//
// The pure modules under `web/src/builder/` are behaviour-tested elsewhere
// (`add-constructs`, `op-surface`, `aggregate-bodies`, …).  What those suites
// CANNOT see is whether the panes actually reach them — a mutator that ships
// green and is never called from a button is exactly the failure mode this
// integration slice exists to close.  The panes are React components with no
// component-test harness in this repo (there is no precedent for rendering
// one), so — like `web-bundle-boundary.test.ts` does for the build worker —
// these assertions read the pane sources and pin the seams:
//
//  * every `SystemExtraKind` / `ContextExtraKind` has a palette entry, and the
//    entry's `data-testid` is DERIVED from the kind (so the two can't drift);
//  * the pane imports and calls each `op-surface` mutator behind a stable
//    `c4system-v2-op-*` / `c4system-v2-find-*` test id;
//  * statement-slot keys route through `encodeStmtPath`, so nested rows get
//    their own key instead of colliding with their top-level statement;
//  * `BodyEditor`'s nested list threads the path-addressed `ƒx` bundle down.
//
// They are deliberately shallow — presence-and-derivation, not layout.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const PALETTE = read("web/src/builder/system-v2/AddPalette.tsx");
const PANE = read("web/src/builder/system-v2/SystemBuilderV2Pane.tsx");
const BODY_EDITOR = read("web/src/builder/system/BodyEditor.tsx");
const STMT_NODE = read("web/src/builder/system-v2/StmtNode.tsx");

/** The `kind:` values of a `const <name> = [ … ]` palette menu, in order. */
function menuKinds(src: string, constName: string): string[] {
  const block = new RegExp(`const ${constName}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`).exec(src);
  if (!block) return [];
  return [...block[1]!.matchAll(/kind:\s*"([A-Za-z]+)"/g)].map((m) => m[1] as string);
}

// The two v2-only add menus, kept in lockstep with the kind unions in
// `system/add.ts` (SystemExtraKind) and `system-v2/add-extra.ts`
// (ContextExtraKind).  A kind added there without a palette entry is a
// construct the graph renders and the user can never create.
const SYSTEM_EXTRA_KINDS = ["resource", "channelSource", "timerSource", "capability"];
const CONTEXT_EXTRA_KINDS = [
  "projection",
  "domainService",
  "channel",
  "criterion",
  "retrieval",
  "payload",
  "enum",
  "policy",
];

describe("AddPalette — every v2-only construct kind is creatable", () => {
  it("offers all four system-scope extras", () => {
    expect(menuKinds(PALETTE, "SYSTEM_EXTRAS").sort()).toEqual([...SYSTEM_EXTRA_KINDS].sort());
  });

  it("offers all eight context-scope extras", () => {
    expect(menuKinds(PALETTE, "CONTEXT_EXTRAS").sort()).toEqual([...CONTEXT_EXTRA_KINDS].sort());
  });

  it("derives each extra's test id from its kind (ids can't drift from the menu)", () => {
    // Both menus render through the same `c4system-v2-add-${e.kind}` template
    // (the `Entry` component's `testid` prop lands as the button's data-testid).
    const derived = [...PALETTE.matchAll(/testid=\{`c4system-v2-add-\$\{e\.kind\}`\}/g)];
    expect(derived.length).toBe(2);
  });

  it("routes the extras through their pure add functions", () => {
    expect(PALETTE).toContain("addSystemExtraSource(source, e.kind)");
    expect(PALETTE).toContain("addContextExtraSource(source, ctxName, e.kind)");
  });

  it("adds a permissions block from the subdomain view", () => {
    expect(PALETTE).toContain('testid="c4system-v2-add-permissions"');
    expect(PALETTE).toContain("addPermissionsSource(source, last.name)");
  });

  it("targets the aggregate member the path leaf names when adding a statement", () => {
    // `+ Stmt` on a lifecycle `body` leaf must address THAT body — the step
    // carries the `listBodies` key — not the operation a sibling step names.
    expect(PALETTE).toContain('last.kind === "body"');
    expect(PALETTE).toContain('aggregateBody(agg?.name ?? "", last.name)');
  });
});

describe("SystemBuilderV2Pane — operation header inspector", () => {
  const MUTATORS = [
    "addOpParam",
    "deleteOpParam",
    "retypeOpParam",
    "renameOpParam",
    "freshOpParamName",
    "setOpReturnType",
    "setOpGate",
    "setOpModifier",
    "opSurface",
  ];

  it.each(MUTATORS)("calls %s", (name) => {
    expect(PANE).toContain(`${name}(`);
  });

  const TEST_IDS = [
    "c4system-v2-op-inspector",
    "c4system-v2-op-param-row",
    "c4system-v2-op-param-name",
    "c4system-v2-op-param-type",
    "c4system-v2-op-param-del",
    "c4system-v2-op-param-add",
    "c4system-v2-op-return",
    "c4system-v2-op-requires",
    "c4system-v2-op-when",
    "c4system-v2-op-private",
    "c4system-v2-op-extern",
    "c4system-v2-op-audited",
  ];

  it.each(TEST_IDS)("exposes %s", (id) => {
    expect(PANE).toContain(`"${id}"`);
  });

  it("treats an emptied gate / return field as the removal request", () => {
    for (const call of ['"requires", v.trim() || null', '"when", v.trim() || null']) {
      expect(PANE).toContain(call);
    }
    expect(PANE).toContain("setOpReturnType(ctx.getSource(), agg, op, v.trim() || null)");
  });
});

describe("SystemBuilderV2Pane — find header inspector", () => {
  it("reads the find surface and writes both header clauses", () => {
    expect(PANE).toContain("findSurface(parsed.ast, repoName, n.name)");
    expect(PANE).toContain("setFindGate(ctx.getSource(), repoName, findName");
    expect(PANE).toContain("setFindIgnoring(ctx.getSource(), repoName, findName, spec)");
  });

  it.each(["c4system-v2-find-requires", "c4system-v2-find-ignoring"])("exposes %s", (id) => {
    expect(PANE).toContain(`"${id}"`);
  });
});

describe("SystemBuilderV2Pane — body picker + nested slots", () => {
  it("lists every statement-bearing member of the aggregate at an operation / body leaf", () => {
    expect(PANE).toContain("listBodies(agg)");
    expect(PANE).toContain("aggregateBody(agg.name, last.name)");
    expect(PANE).toContain("AGG_BODY_LEAF");
  });

  it("keeps one picker component for workflows and aggregates", () => {
    expect(PANE).toContain("function BodyPicker(");
    // The workflow ids predate the aggregate reach and must stay put.
    expect(PANE).toContain('"c4system-v2-wf-member"');
    expect(PANE).toContain('"c4system-v2-body-member"');
  });

  it("gives an aggregate lifecycle body the flow view, not a panel of its own", () => {
    // The interim `BodyEditor` panel is gone — every aggregate member now
    // renders as the same React Flow statement flow, so there is exactly one
    // canvas branch below the palette.
    expect(PANE).not.toContain("c4system-v2-body-panel");
    expect(PANE).not.toContain("<BodyEditor");
    expect(PANE).toContain('data-testid="c4system-v2-pane"');
    // Picking a lifecycle member is navigation: the leaf step is swapped for a
    // `body` step carrying the member key.
    expect(PANE).toContain('{ kind: "body", name: key }');
  });

  it("gives the flow rows the list editor's move / delete commands", () => {
    // Dropping the panel would otherwise lose reorder + delete, which the
    // shared list editor had and the flow node did not.
    expect(PANE).toContain("deleteStatement(ctx.getSource(), leafLoc, i)");
    expect(PANE).toContain("moveStatement(ctx.getSource(), leafLoc, i, dir)");
    for (const id of ["c4system-v2-stmt-up", "c4system-v2-stmt-down", "c4system-v2-stmt-delete"]) {
      expect(STMT_NODE).toContain(`"${id}"`);
    }
  });

  it("keys structured-editor slots by descent path", () => {
    expect(PANE).toContain('${base}:${index}${encodeStmtPath(path)}:${field ?? ""}');
  });

  it("hands nested rows a path-addressed ƒx bundle", () => {
    expect(PANE).toContain("nestedFor");
    expect(PANE).toContain("nested: nestedFor(i)");
    expect(STMT_NODE).toContain("nested={d.nested}");
  });
});

describe("BodyEditor — nested statement rows reach the structured editor", () => {
  it("builds each child's descent path from the enclosing one plus its list step", () => {
    expect(BODY_EDITOR).toContain("[...(path ?? []), { index: i, list: step }]");
  });

  it("passes the bundle down every container's sub-lists", () => {
    // for → body; if let → then/else; match → one per arm, plus else.
    for (const step of ['step="body"', 'step="then"', 'step="else"', "step={{ arm: i }}"]) {
      expect(BODY_EDITOR).toContain(step);
    }
  });

  it("recurses — a nested container row keeps threading path + bundle", () => {
    expect(BODY_EDITOR).toContain("path={p}");
    expect(BODY_EDITOR).toContain("nested={nested}");
  });
});
