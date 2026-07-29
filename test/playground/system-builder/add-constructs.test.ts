import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import { addSystemExtraSource, type SystemExtraKind } from "../../../web/src/builder/system/add.js";
import {
  addContextExtraSource,
  addPermissionsSource,
  type ContextExtraKind,
} from "../../../web/src/builder/system-v2/add-extra.js";
import { buildViewGraph } from "../../../web/src/builder/system-v2/view-graph.js";
import { parseRaw as parse, parseRawOk } from "../../_helpers/index.js";

// FULL: carries an event, a channel, and a storage so every mandatory-ref
// template (channel/resource/channelSource/timerSource) has a real target to
// pick up. The leading comment pins that appended splices don't disturb it.
const FULL = `// full builder fixture — comments must survive splices
system Shop {
  storage Db {
    type: postgres
  }
  subdomain Selling {
    context Sales {
      aggregate Order {
      }
      event Placed {
      }
      channel OrderEvents {
        carries: Placed
      }
    }
  }
}`;

// MINIMAL: no event / storage / channel anywhere, so every mandatory-ref
// template has nothing to reference and must return null.
const MINIMAL = `// minimal builder fixture — no event, storage or channel
system Shop {
  subdomain Selling {
    context Sales {
      aggregate Order {
      }
    }
  }
}`;

const COMMENT_FULL = "// full builder fixture — comments must survive splices";
const COMMENT_MINIMAL = "// minimal builder fixture — no event, storage or channel";

/** Every `n.name === name` node of `$type === type` findable in `src`. */
function findByTypeAndName(src: string, type: string, name: string): boolean {
  const ast = parse(src);
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === type && (n as { name?: string }).name === name) return true;
  }
  return false;
}

describe("addContextExtraSource — context-level construct kinds", () => {
  const CASES: { kind: ContextExtraKind; astType: string; renderKind: string }[] = [
    { kind: "projection", astType: "Projection", renderKind: "projection" },
    { kind: "domainService", astType: "DomainService", renderKind: "domainservice" },
    { kind: "channel", astType: "Channel", renderKind: "channel" },
    { kind: "criterion", astType: "Criterion", renderKind: "criterion" },
    { kind: "retrieval", astType: "Retrieval", renderKind: "retrieval" },
    { kind: "payload", astType: "PayloadDecl", renderKind: "payload" },
    { kind: "enum", astType: "EnumDecl", renderKind: "enum" },
    { kind: "policy", astType: "PolicyDecl", renderKind: "policy" },
  ];

  it.each(
    CASES,
  )("$kind: adds, parses, is findable by name, renders in the v2 view-graph, and preserves comments", ({
    kind,
    astType,
    renderKind,
  }) => {
    const next = addContextExtraSource(FULL, "Sales", kind);
    expect(next).not.toBeNull();
    const src = next as string;

    expect(parseRawOk(src)).toBe(true);

    const base = kind === "domainService" ? "DomainService" : kind[0].toUpperCase() + kind.slice(1);
    const expectedName = `${base}1`;
    expect(findByTypeAndName(src, astType, expectedName)).toBe(true);

    const ast = parse(src);
    const g = buildViewGraph(ast, [{ kind: "context", name: "Sales" }]);
    expect(g.nodes.some((n) => n.kind === renderKind && n.name === expectedName)).toBe(true);

    // Comment on the file survives an append-only splice.
    expect(src).toContain(COMMENT_FULL);
  });

  it.each(CASES)("$kind: a second add generates a fresh name", ({ kind, astType }) => {
    const first = addContextExtraSource(FULL, "Sales", kind);
    expect(first).not.toBeNull();
    const second = addContextExtraSource(first as string, "Sales", kind);
    expect(second).not.toBeNull();
    const src = second as string;
    expect(parseRawOk(src)).toBe(true);

    const base = kind === "domainService" ? "DomainService" : kind[0].toUpperCase() + kind.slice(1);
    expect(findByTypeAndName(src, astType, `${base}1`)).toBe(true);
    expect(findByTypeAndName(src, astType, `${base}2`)).toBe(true);
  });

  it("returns null for an unknown context", () => {
    expect(addContextExtraSource(FULL, "Nope", "projection")).toBeNull();
  });

  it("channel: returns null when the context has no event to carry", () => {
    expect(addContextExtraSource(MINIMAL, "Sales", "channel")).toBeNull();
  });

  it("channel: references the context's own event, and that event survives untouched", () => {
    const next = addContextExtraSource(FULL, "Sales", "channel") as string;
    expect(next).toContain("carries: Placed");
    expect(next).toContain("event Placed {");
  });
});

describe("addPermissionsSource — subdomain-level permissions block", () => {
  it("adds a permissions block with one fresh permission, parses, is findable, and renders", () => {
    const next = addPermissionsSource(FULL, "Selling");
    expect(next).not.toBeNull();
    const src = next as string;

    expect(parseRawOk(src)).toBe(true);
    expect(findByTypeAndName(src, "PermissionDecl", "permission1")).toBe(true);

    const ast = parse(src);
    const g = buildViewGraph(ast, [{ kind: "subdomain", name: "Selling" }]);
    expect(g.nodes.some((n) => n.kind === "permissions")).toBe(true);

    expect(src).toContain(COMMENT_FULL);
  });

  it("a second add generates a fresh permission name", () => {
    const first = addPermissionsSource(FULL, "Selling") as string;
    const second = addPermissionsSource(first, "Selling") as string;
    expect(parseRawOk(second)).toBe(true);
    expect(findByTypeAndName(second, "PermissionDecl", "permission1")).toBe(true);
    expect(findByTypeAndName(second, "PermissionDecl", "permission2")).toBe(true);
  });

  it("returns null for an unknown subdomain", () => {
    expect(addPermissionsSource(FULL, "Nope")).toBeNull();
  });
});

describe("addSystemExtraSource — system-level construct kinds", () => {
  const NAMED_CASES: { kind: SystemExtraKind; astType: string; renderKind: string }[] = [
    { kind: "resource", astType: "Resource", renderKind: "resource" },
    { kind: "channelSource", astType: "ChannelSource", renderKind: "channelsource" },
    { kind: "timerSource", astType: "TimerSource", renderKind: "timer" },
    { kind: "capability", astType: "Capability", renderKind: "capability" },
  ];

  it.each(
    NAMED_CASES,
  )("$kind: adds, parses, is findable by name, renders in the v2 view-graph, and preserves comments", ({
    kind,
    astType,
    renderKind,
  }) => {
    const next = addSystemExtraSource(FULL, kind);
    expect(next).not.toBeNull();
    const src = next as string;

    expect(parseRawOk(src)).toBe(true);

    const base =
      kind === "channelSource" || kind === "timerSource"
        ? `${kind[0].toUpperCase()}${kind.slice(1)}`
        : kind[0].toUpperCase() + kind.slice(1);
    const expectedName = `${base}1`;
    expect(findByTypeAndName(src, astType, expectedName)).toBe(true);

    const ast = parse(src);
    const g = buildViewGraph(ast, [{ kind: "system", name: "Shop" }]);
    expect(g.nodes.some((n) => n.kind === renderKind && n.name === expectedName)).toBe(true);

    expect(src).toContain(COMMENT_FULL);
  });

  it.each(NAMED_CASES)("$kind: a second add generates a fresh name", ({ kind, astType }) => {
    const first = addSystemExtraSource(FULL, kind);
    expect(first).not.toBeNull();
    const second = addSystemExtraSource(first as string, kind);
    expect(second).not.toBeNull();
    const src = second as string;
    expect(parseRawOk(src)).toBe(true);

    const base = kind[0].toUpperCase() + kind.slice(1);
    expect(findByTypeAndName(src, astType, `${base}1`)).toBe(true);
    expect(findByTypeAndName(src, astType, `${base}2`)).toBe(true);
  });

  it("returns null when there is no system", () => {
    expect(addSystemExtraSource("subdomain S { context C { } }", "capability")).toBeNull();
  });

  it("resource: returns null when there is no storage to bind (mandatory ref absent)", () => {
    expect(addSystemExtraSource(MINIMAL, "resource")).toBeNull();
  });

  it("channelSource: returns null when there is no channel to bind (mandatory ref absent)", () => {
    expect(addSystemExtraSource(MINIMAL, "channelSource")).toBeNull();
  });

  it("timerSource: returns null when there is no event to bind (mandatory ref absent)", () => {
    expect(addSystemExtraSource(MINIMAL, "timerSource")).toBeNull();
  });

  it("resource references an existing context and storage", () => {
    const next = addSystemExtraSource(FULL, "resource") as string;
    expect(next).toContain("for: Sales");
    expect(next).toContain("use: Db");
  });

  it("channelSource references an existing channel", () => {
    const next = addSystemExtraSource(FULL, "channelSource") as string;
    expect(next).toContain("for: OrderEvents");
  });

  it("timerSource references an existing event", () => {
    const next = addSystemExtraSource(FULL, "timerSource") as string;
    expect(next).toContain("for: Placed");
  });

  it("preserves the minimal fixture's comment too (no false positive from FULL only)", () => {
    // capability has no mandatory ref, so it succeeds against MINIMAL.
    const next = addSystemExtraSource(MINIMAL, "capability") as string;
    expect(next).toContain(COMMENT_MINIMAL);
    expect(parseRawOk(next)).toBe(true);
  });
});
