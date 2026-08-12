// A word followed by `:` is a DECLARATION, never the previous member's
// trailing modifier (pairwise finding F4).
//
// The bug: `Property` is `name ':' type (modifier)*` and the grammar is
// newline-insensitive, so a modifier-less property followed by a property
// NAMED one of the trailing-modifier keywords was swallowed —
//
//     title: string
//     secret: string     // → `title: string secret`, then "Expecting '}'
//                        //   but found ':'" reported on the WRONG line
//
// — even though `ddd.langium` deliberately admits all five `FieldAccess`
// names as property names "so pre-existing files that named a field `money`
// / `secret` / etc. keep parsing".  Reordering the two fields, or putting a
// `= default` on the first, made it disappear, which is why no fixture ever
// hit it.
//
// The same swallow reached three clause families, not one — the fix and this
// test cover all of them:
//
//   • `FieldAccess`  — `immutable` / `internal` / `managed` / `secret` / `token`
//   • `TypeRef`      — `envelope` / `option` / `or` / `paged`
//   • the `message "…"` clause on `check` / `invariant` / `precondition`
//
// Closed in the LEXER (`soft-keyword-colon-guard.ts`), because the decision
// is a repetition-exit the Chevrotain lookahead cannot make — see that file's
// header for why no grammar formulation expresses it.  The exhaustive guard
// is the `fieldNameAfterField` position added to the keyword-identifier
// coverage snapshot; this file pins the concrete shapes and, crucially, that
// LEGITIMATE modifier usage still parses (the guard must not buy the fix by
// disabling the keyword).

import { AstUtils } from "langium";
import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Property } from "../../../src/language/generated/ast.js";
import { DddGrammar } from "../../../src/language/generated/grammar.js";
import {
  GUARDED_SOFT_KEYWORDS,
  guardedKeywordsUsedBeforeColon,
} from "../../../src/language/soft-keyword-colon-guard.js";

describe("soft keyword before `:` is an identifier, not a trailing modifier (F4)", () => {
  let parse: ReturnType<typeof parseHelper>;
  beforeAll(() => {
    parse = parseHelper(createDddServices(NodeFileSystem).Ddd);
  });

  /** Parse and return the errors + every AUTHOR-WRITTEN `Property` node, so a
   *  test can assert on the SHAPE that came out and not merely on "it parsed".
   *
   *  `parseHelper` runs the full document build, so the macro layer has already
   *  mixed in its synthesised members (every aggregate gets an optimistic-lock
   *  `version`).  Those carry no `$cstNode` — they were built, not parsed —
   *  which is exactly the discriminator we want here. */
  const props = async (src: string) => {
    const doc = await parse(src);
    const err =
      doc.parseResult.parserErrors[0]?.message ?? doc.parseResult.lexerErrors[0]?.message ?? "";
    const properties = [...AstUtils.streamAllContents(doc.parseResult.value)]
      .filter((n): n is Property => n.$type === "Property")
      .filter((p) => p.$cstNode !== undefined);
    return { err, properties };
  };

  it("the F4 repro: a line-leading `secret` is a second FIELD", async () => {
    const { err, properties } = await props(`context C {
      aggregate Doc {
        title: string
        secret: string
      }
    }`);
    expect(err).toBe("");
    expect(properties.map((p) => p.name)).toEqual(["title", "secret"]);
    // The whole bug in one assertion: `title` must carry NO access modifier —
    // pre-fix it silently carried `secret`, and the second field vanished.
    expect(properties[0]?.access).toBeUndefined();
  });

  it.each(
    GUARDED_SOFT_KEYWORDS,
  )("`%s` is declarable as a field after a modifier-less property", async (keyword) => {
    const { err, properties } = await props(`context C {
        aggregate Doc {
          title: string
          ${keyword}: string
        }
      }`);
    expect(err).toBe("");
    expect(properties.map((p) => p.name)).toEqual(["title", keyword]);
  });

  it("the access modifier still attaches where it is meant to", async () => {
    const { err, properties } = await props(`context C {
      aggregate Doc {
        password: string secret
        legacyId: string immutable
        version: int token
      }
    }`);
    expect(err).toBe("");
    expect(properties.map((p) => [p.name, p.access])).toEqual([
      ["password", "secret"],
      ["legacyId", "immutable"],
      ["version", "token"],
    ]);
  });

  it("a modifier still parses in free order with `provenanced` / `sensitive`", async () => {
    const { err, properties } = await props(`context C {
      aggregate Doc {
        a: string provenanced secret
        b: string secret provenanced
        c: string sensitive(pii) secret
      }
    }`);
    expect(err).toBe("");
    expect(properties.map((p) => [p.name, p.access, p.provenanced])).toEqual([
      ["a", "secret", true],
      ["b", "secret", true],
      ["c", "secret", false],
    ]);
  });

  it("a modifier at end-of-body, followed by `}`, still parses", async () => {
    const { err, properties } = await props(`context C {
      aggregate Doc { password: string secret }
    }`);
    expect(err).toBe("");
    expect(properties.map((p) => p.access)).toEqual(["secret"]);
  });

  it("`secret` still reads as an identifier in expression position", async () => {
    const { err, properties } = await props(`context C {
      aggregate Doc {
        secret: string
        derived shown: string = this.secret
      }
    }`);
    expect(err).toBe("");
    expect(properties.map((p) => p.name)).toEqual(["secret"]);
  });

  // --- the `message "…"` clause -------------------------------------------

  it("`message` after a field `check` is a field, not the check's message", async () => {
    const { err, properties } = await props(`context C {
      aggregate Doc {
        title: string check title != ""
        message: string
      }
    }`);
    expect(err).toBe("");
    expect(properties.map((p) => p.name)).toEqual(["title", "message"]);
    expect(properties[0]?.message).toBeUndefined();
  });

  it("`message` after an invariant is a field, not the invariant's message", async () => {
    const { err, properties } = await props(`context C {
      aggregate Doc {
        title: string
        invariant title != ""
        message: string
      }
    }`);
    expect(err).toBe("");
    expect(properties.map((p) => p.name)).toEqual(["title", "message"]);
  });

  it('the `check … message "…"` clause itself still parses', async () => {
    const { err, properties } = await props(`context C {
      aggregate Doc {
        title: string check title != "" message "Title is required"
      }
    }`);
    expect(err).toBe("");
    expect(properties[0]?.message).toBe("Title is required");
  });

  // --- negatives: the guard must not turn errors into silent acceptance ----

  it("`message` with no string after it is STILL a parse error", async () => {
    const { err } = await props(`context C {
      aggregate Doc {
        title: string check title != "" message
      }
    }`);
    expect(err).not.toBe("");
  });

  it("a non-keyword trailing word is STILL a parse error", async () => {
    const { err } = await props(`context C {
      aggregate Doc {
        title: string bogusModifier
      }
    }`);
    expect(err).not.toBe("");
  });

  // --- the membership rule, re-derived from the grammar --------------------

  it("no guarded keyword is written immediately before `:` by the grammar", () => {
    // Membership rule (2) in `soft-keyword-colon-guard.ts`: guarding a word the
    // grammar reads as `'kw' ':' …` (like `kind:` / `route:` / `shape:`) would
    // silently un-parse that block syntax.  Re-derived from the grammar AST so
    // a future rule that starts doing so fails HERE rather than in some
    // unrelated example.
    expect(guardedKeywordsUsedBeforeColon(DddGrammar())).toEqual([]);
  });
});
