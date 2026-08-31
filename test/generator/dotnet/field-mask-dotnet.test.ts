// .NET read-mask redaction (`mask unless`, authorization.md §5, M-T3.2 item 6).
// A masked field's response DTO param is nullable, and every read handler
// projects it through a fail-closed ambient-principal guard (redacted to null
// unless the caller satisfies the predicate).  Compile-verified separately in
// the dotnet SDK container; this pins the emit shape.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { generateDotnetForContexts } from "../../../src/generator/dotnet/index.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

const SRC = `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      aggregate P with crudish {
        name: string
        salary: decimal mask unless currentUser.permissions.contains(permissions.unmask)
      }
    }
  }
}`;

// Same masked aggregate, crossed with command audit: two masked fields (two
// wraps inside ONE projection), an `audited` operation (that projection
// rendered TWICE into one handler body), and a contained collection whose
// nested projection is inlined into the parent's, inside a lambda.  Each is a
// place C# would otherwise see the same pattern variable declared twice in one
// scope.  (A masked field ON the contained part is deliberately absent —
// `wireFieldsForPart` drops `maskUnless`, so no backend redacts one today.)
const AUDITED_SRC = `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      aggregate P audited with crudish {
        name: string
        salary: decimal mask unless currentUser.permissions.contains(permissions.unmask)
        nationalId: string mask unless currentUser.permissions.contains(permissions.unmask)
        grade: int = 1
        contains reviews: Review[]
        entity Review {
          period: string
          score: int
        }
        operation promote(newGrade: int) audited {
          precondition newGrade > 0
          grade := newGrade
        }
      }
    }
  }
}`;

async function filesFrom(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper<Model>(services.Ddd);
  const doc = await helper(src, { validation: true });
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value));
  const contexts = loom.systems.flatMap((s) => s.subdomains.flatMap((sd) => sd.contexts));
  return generateDotnetForContexts(contexts, "S");
}

const files = (): Promise<Map<string, string>> => filesFrom(SRC);

/** Every `is { } <name>` pattern variable the emitted C# binds, in order. */
function maskPatternVars(cs: string): string[] {
  return [...cs.matchAll(/is \{ \} (__maskUser\w*)/g)].map((m) => m[1]);
}

describe("mask unless — .NET read redaction", () => {
  it("makes the masked response param nullable", async () => {
    const out = await files();
    const resp = [...out.entries()].find(([k]) => k.endsWith("PResponses.cs"))?.[1] ?? "";
    // A wire `decimal` is a `double` on the .NET response (#2563) — the
    // float64 the other four backends send.  Masking makes it nullable.
    expect(resp).toMatch(/double\?\s+Salary/);
    // A non-masked field stays required.
    expect(resp).toMatch(/\[property: Required\] string Name/);
  });

  it("projects the masked field through a fail-closed ambient-principal guard", async () => {
    const out = await files();
    const handler = [...out.entries()].find(([k]) => k.endsWith("GetPByIdHandler.cs"))?.[1] ?? "";
    // fail-closed: null caller OR failed predicate → null.
    expect(handler).toMatch(/RequestContext\.Current\?\.CurrentUser is \{ \} __maskUser\d+/);
    expect(handler).toMatch(/\(__maskUser\d+\.Permissions\)\.Contains\("m\.unmask"\)/);
    // `(double?)((double)found.Salary)` — the mask's nullable cast composing
    // with the #2563 narrowing that makes a wire `decimal` a float64.
    expect(handler).toMatch(/\?\s*\(double\?\)\(\(double\)found\.Salary\)\s*:\s*null/);
    // the handler imports where RequestContext lives.
    expect(handler).toContain("using S.Domain.Common;");
  });
});

// ---------------------------------------------------------------------------
// `mask unless` × `audited` — the combination, which is where a FIXED pattern-
// variable name stops compiling.
//
// `x is { } name` declares `name` in the ENCLOSING BLOCK, so two masked
// projections in one method body are two declarations of the same local:
// CS0128, "a local variable named '__maskUser' is already defined in this
// scope".  These pin that every wrap in one scope binds its own name.
//
// The AUDITED handler used to be the sharpest case — it rendered the projection
// twice (before + after), so two masked fields meant four wraps in one body.
// It no longer renders ANY wrap: M-T3.9 made the audit snapshots project
// UNMASKED, because a trail whose content depends on the writer's read
// permission is not a trail.  The scope-collision invariant is unchanged and
// still live wherever one body renders two wraps (the read handler below), so
// the audited case now pins the OPPOSITE fact — that the snapshots carry the
// real value.  Reading the trail back still redacts (the history query).
// ---------------------------------------------------------------------------
describe("mask unless × audited — no duplicate pattern variable in one scope", () => {
  it("the audited operation's before/after snapshots are UNMASKED (M-T3.9)", async () => {
    const out = await filesFrom(AUDITED_SRC);
    const handler = [...out.entries()].find(([k]) => k.endsWith("PromoteHandler.cs"))?.[1] ?? "";
    // Sanity: this really is the audited handler with both snapshots.
    expect(handler).toContain("var __before = ");
    expect(handler).toContain("var __after = ");
    // No wrap at all — so no pattern variable, so nothing to collide.  The
    // stored trail is the same whoever performed the write.
    expect(
      maskPatternVars(handler),
      "the audit snapshot redacts by the WRITER's principal",
    ).toEqual([]);
    expect(handler).toContain(
      "var __before = System.Text.Json.JsonSerializer.SerializeToNode(new PResponse(",
    );
  });

  it("two masked fields in ONE projection bind distinct mask variables", async () => {
    const out = await filesFrom(AUDITED_SRC);
    const handler = [...out.entries()].find(([k]) => k.endsWith("GetPByIdHandler.cs"))?.[1] ?? "";
    const vars = maskPatternVars(handler);
    expect(vars.length).toBe(2);
    expect(new Set(vars).size, `duplicate mask pattern variables: ${vars.join(", ")}`).toBe(
      vars.length,
    );
  });

  it("no emitted C# file redeclares a mask pattern variable in one scope", async () => {
    const out = await filesFrom(AUDITED_SRC);
    const offenders = [...out.entries()]
      .filter(([k]) => k.endsWith(".cs"))
      .map(([k, v]) => [k, maskPatternVars(v)] as const)
      .filter(([, vars]) => new Set(vars).size !== vars.length)
      .map(([k, vars]) => `${k}: ${vars.join(", ")}`);
    expect(
      offenders,
      `files redeclaring a mask pattern variable: ${offenders.join(" | ")}`,
    ).toEqual([]);
  });
});
