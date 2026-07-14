// Regression: a keyword-named field must be READABLE via postfix `.`, not just
// declarable (M-T5.18 Track C — BUG-004).
//
// BUG-004: a union-returning find (`find locate(): Project or ProjectNotFound`)
// mandates its absence error carry `resource: string`, but `resource` is the
// datasource-declaration keyword — so reading `e.resource` in a `match` arm
// failed to PARSE (`resource` was absent from `MemberName`).  The field was
// write-only: the framework filled it, domain code could never read it.  Same
// class as the `parent` fix in Track B (declarable but unreadable).
//
// Track C composed `CommonSoftKeywords` into `MemberName` / `LValueIdent` /
// `StateFieldName`, so every purely-defensive keyword is now an identifier in
// ALL six positions.  The coverage snapshot in
// `keyword-identifier-completeness.test.ts` is the exhaustive guard; this test
// pins the concrete BUG-004 shape as a readable regression.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";

describe("keyword-named fields are readable via postfix `.` (BUG-004)", () => {
  let parse: ReturnType<typeof parseHelper>;
  beforeAll(() => {
    parse = parseHelper(createDddServices(NodeFileSystem).Ddd);
  });

  const parsesClean = async (src: string) => {
    const doc = await parse(src);
    return {
      ok: doc.parseResult.lexerErrors.length === 0 && doc.parseResult.parserErrors.length === 0,
      err:
        doc.parseResult.parserErrors[0]?.message ?? doc.parseResult.lexerErrors[0]?.message ?? "",
    };
  };

  it("reads `this.resource` (the BUG-004 mandated field) in a derived", async () => {
    const { ok, err } = await parsesClean(`context C {
      aggregate Project {
        name: string
        resource: string
        derived tag: string = this.resource
      }
    }`);
    expect(ok, err).toBe(true);
  });

  it("reads several keyword-named fields via `.` (the whole class)", async () => {
    for (const kw of ["resource", "kind", "parent", "state", "query", "error"]) {
      const { ok, err } = await parsesClean(`context C {
        aggregate A {
          name: string
          ${kw}: string
          derived d: string = this.${kw}
        }
      }`);
      expect(ok, `this.${kw}: ${err}`).toBe(true);
    }
  });
});
