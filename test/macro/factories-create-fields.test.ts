// `writableCreateFields` — companion to `writableUpdateFields`.
// Direct unit test (no macro consumer yet; `crudish` Phase 4 will
// use this when create/delete operations land).
//
// Semantics: keeps user-declared fields whose access ∈
// {editable (default), immutable, secret}; excludes everything else
// plus any field carrying a macro-origin tag.

import { describe, expect, it } from "vitest";
import type { Aggregate } from "../../src/language/generated/ast.js";
import { isAggregate } from "../../src/language/generated/ast.js";
import { writableCreateFields, writableUpdateFields } from "../../src/macros/api/factories.js";
import { parseString } from "../_helpers/index.js";

async function aggregate(src: string, name: string): Promise<Aggregate> {
  const { model, errors } = await parseString(`system Demo { subdomain M { context C {
    ${src}
  }}}`);
  if (errors.length) throw new Error(errors.join("; "));
  for (const sm of model.members ?? []) {
    if ((sm as any).$type !== "System") continue;
    for (const m of (sm as any).members ?? []) {
      if (m.$type !== "Subdomain") continue;
      for (const ctx of (m.contexts as BoundedContext[]) ?? []) {
        for (const cm of ctx.members ?? []) {
          if (isAggregate(cm) && cm.name === name) return cm;
        }
      }
    }
  }
  throw new Error(`aggregate ${name} not found`);
}

describe("writableCreateFields — modifier filter", () => {
  it.each([
    ["editable", true, "subject: string"],
    ["immutable", true, "slug: string immutable"],
    ["secret", true, "pwd: string secret"],
    ["managed", false, "createdAt: datetime managed"],
    ["token", false, "rev: int token"],
    ["internal", false, "flag: bool internal"],
  ])("field with access %s is %s in create input", async (modifier, expectIncluded, decl) => {
    const agg = await aggregate(`aggregate A { ${decl} }`, "A");
    const fieldName = decl.split(":")[0]!.trim();
    const includedNames = writableCreateFields(agg).map((f) => f.name);
    if (expectIncluded) {
      expect(includedNames, `${modifier} should be in create input`).toContain(fieldName);
    } else {
      expect(includedNames, `${modifier} should be excluded from create input`).not.toContain(
        fieldName,
      );
    }
  });

  it("differs from update only on `immutable`: kept on create, dropped on update", async () => {
    const agg = await aggregate(
      `aggregate Post {
        subject: string
        slug: string immutable
        passwordHash: string secret
        createdAt: datetime managed
        rev: int token
        flag: bool internal
      }`,
      "Post",
    );
    expect(writableCreateFields(agg).map((f) => f.name)).toEqual([
      "subject",
      "slug",
      "passwordHash",
    ]);
    expect(writableUpdateFields(agg).map((f) => f.name)).toEqual(["subject", "passwordHash"]);
  });
});

describe("stamp targets are server-owned — excluded from create AND update input (S1b)", () => {
  it("an aggregate-body `stamp onCreate` target drops out of both writable sets", async () => {
    const agg = await aggregate(
      `aggregate Doc {
        title: string
        createdByRole: string
        stamp onCreate { createdByRole := "x" }
      }`,
      "Doc",
    );
    expect(writableCreateFields(agg).map((f) => f.name)).toEqual(["title"]);
    expect(writableUpdateFields(agg).map((f) => f.name)).toEqual(["title"]);
  });

  it("a context-level stamp propagates: its target is excluded on every aggregate", async () => {
    const agg = await aggregate(
      `stamp onUpdate { touchedBy := "x" }
      aggregate Doc {
        title: string
        touchedBy: string
      }`,
      "Doc",
    );
    expect(writableCreateFields(agg).map((f) => f.name)).toEqual(["title"]);
    expect(writableUpdateFields(agg).map((f) => f.name)).toEqual(["title"]);
  });
});
