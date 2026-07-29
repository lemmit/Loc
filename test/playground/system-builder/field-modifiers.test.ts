// Property-modifier editing for the visual builder's field inspector.
//
// The `Property` rule fixes ONE order for the clauses that carry expression
// content — `TypeRef (flags)* ('=' default)? ('check' … ('message' …)?)?
// ('mask' 'unless' …)?` — and the flag group MUST precede the default (an
// access keyword doubles as an identifier, so `x: int = 1 secret` is a parse
// error).  Each mutator therefore splices at the anchor its own clause must
// follow, falling back to the previous anchor when that clause is absent; these
// suites pin that the anchors compose in any application order and that nothing
// outside the spliced span moves.
//
// Assertions go through `lineDiff` (the builder's own hunk differ) exactly as
// `lossless-edits.test.ts` does: asserting the precise removed/added lines
// proves no other line in the file shifted.

import { describe, expect, it } from "vitest";
import { lineDiff } from "../../../web/src/builder/edit-engine.js";
import {
  type FieldAccess,
  listFieldModifiers,
  listFields,
  setFieldAccess,
  setFieldCheck,
  setFieldDefault,
  setFieldMask,
  setFieldSensitivity,
} from "../../../web/src/builder/system/fields.js";
import { parseRaw as parse } from "../../_helpers/index.js";

// Every field shape the mutators have to cope with: bare, defaulted, fully
// decorated (flags + mask), check-with-message, and one carrying a same-line
// trailing comment.  Comments sit between them so a stray splice shows up as a
// moved line in the hunk.
const SRC = `system Shop {

  context Sales {

    // ── Order — the sales root ──────────────────────────────
    aggregate Order {
      /* the customer that placed this order */
      customerId: Customer id
      // how much, in the order's currency
      total: decimal = 0
      ssn: string sensitive(pii) secret mask unless currentUser.isAdmin
      status: string   // draft | placed | shipped
      qty: int check qty > 0 message "quantity must be positive"
      note: string

      // never let an order go negative
      invariant total >= 0 message "total must not be negative"
    }

    // placed on the wire
    event OrderPlaced { at: datetime, by: string }
  }
}`;

/** Every comment in the fixture — none of them may ever disappear. */
const COMMENTS = [
  "// ── Order — the sales root ──────────────────────────────",
  "/* the customer that placed this order */",
  "// how much, in the order's currency",
  "// draft | placed | shipped",
  "// never let an order go negative",
  "// placed on the wire",
];

const expectCommentsIntact = (out: string | null): void => {
  expect(out).not.toBeNull();
  for (const c of COMMENTS) expect(out).toContain(c);
};

/** Assert the edit is exactly this hunk — nothing else in the file moved. */
const expectHunk = (
  before: string,
  after: string | null,
  removed: string[],
  added: string[],
): void => {
  expect(after).not.toBeNull();
  const hunk = lineDiff(before, after as string);
  expect({ removed: hunk.removed, added: hunk.added }).toEqual({ removed, added });
};

// A source the parser rejects — every mutator must refuse it rather than splice
// at offsets the error-recovery parser invented.
const BROKEN = SRC.replace("aggregate Order {", "aggregate Order {{");

const constructOf = (source: string, type: string, name: string) => {
  const found = parse(source)
    .members.flatMap((m) => ("members" in m ? m.members : []))
    .flatMap((m) => ("members" in m ? m.members : []))
    .find((m) => m.$type === type && (m as { name?: string }).name === name);
  if (!found) throw new Error(`no ${type} ${name}`);
  return found;
};

const fieldIndex = (name: string): number => {
  const at = listFields(constructOf(SRC, "Aggregate", "Order")).findIndex((f) => f.name === name);
  if (at < 0) throw new Error(`no field ${name}`);
  return at;
};

/** The modifier state of one field of `Order`, read back out of `source`. */
const modsOf = (source: string, field: string) =>
  listFieldModifiers(constructOf(source, "Aggregate", "Order"))[fieldIndex(field)];

/** Every mutator, curried onto `Order` — for the shared negative cases. */
const ALL = {
  setFieldDefault: (src: string, i: number) => setFieldDefault(src, "aggregate", "Order", i, "1"),
  setFieldCheck: (src: string, i: number) => setFieldCheck(src, "aggregate", "Order", i, "true"),
  setFieldMask: (src: string, i: number) =>
    setFieldMask(src, "aggregate", "Order", i, "currentUser.isAdmin"),
  setFieldAccess: (src: string, i: number) =>
    setFieldAccess(src, "aggregate", "Order", i, "secret"),
  setFieldSensitivity: (src: string, i: number) =>
    setFieldSensitivity(src, "aggregate", "Order", i, ["pii"]),
};

describe("field modifiers — default", () => {
  it("adds `= expr` to a bare field, right after the type", () => {
    const out = setFieldDefault(SRC, "aggregate", "Order", fieldIndex("note"), '"n/a"');
    expectHunk(SRC, out, ["      note: string"], ['      note: string = "n/a"']);
    expectCommentsIntact(out);
  });

  it("replaces an existing default in place", () => {
    const out = setFieldDefault(SRC, "aggregate", "Order", fieldIndex("total"), "42");
    expectHunk(SRC, out, ["      total: decimal = 0"], ["      total: decimal = 42"]);
    expectCommentsIntact(out);
  });

  it("removes the default, keeping the separating space tidy", () => {
    const out = setFieldDefault(SRC, "aggregate", "Order", fieldIndex("total"), null);
    expectHunk(SRC, out, ["      total: decimal = 0"], ["      total: decimal"]);
    expect(modsOf(out as string, "total").default).toBeNull();
  });

  it("lands after the flag group, never after it (the `x: int = 1 secret` parse error)", () => {
    const out = setFieldDefault(SRC, "aggregate", "Order", fieldIndex("ssn"), '"redacted"');
    expectHunk(
      SRC,
      out,
      ["      ssn: string sensitive(pii) secret mask unless currentUser.isAdmin"],
      ['      ssn: string sensitive(pii) secret = "redacted" mask unless currentUser.isAdmin'],
    );
  });

  it("keeps a same-line trailing comment where it is", () => {
    const out = setFieldDefault(SRC, "aggregate", "Order", fieldIndex("status"), '"draft"');
    expectHunk(
      SRC,
      out,
      ["      status: string   // draft | placed | shipped"],
      ['      status: string = "draft"   // draft | placed | shipped'],
    );
  });

  it("removing an absent default is a no-op", () => {
    expect(setFieldDefault(SRC, "aggregate", "Order", fieldIndex("note"), null)).toBe(SRC);
    expect(setFieldDefault(SRC, "aggregate", "Order", fieldIndex("note"), "  ")).toBe(SRC);
  });
});

describe("field modifiers — check", () => {
  it("adds `check expr` to a bare field", () => {
    const out = setFieldCheck(SRC, "aggregate", "Order", fieldIndex("note"), 'note != ""');
    expectHunk(SRC, out, ["      note: string"], ['      note: string check note != ""']);
    expectCommentsIntact(out);
  });

  it("adds the check AFTER an existing default", () => {
    const out = setFieldCheck(SRC, "aggregate", "Order", fieldIndex("total"), "total >= 0");
    expectHunk(
      SRC,
      out,
      ["      total: decimal = 0"],
      ["      total: decimal = 0 check total >= 0"],
    );
  });

  it("replaces the predicate and keeps the existing message by default", () => {
    const out = setFieldCheck(SRC, "aggregate", "Order", fieldIndex("qty"), "qty > 1");
    expectHunk(
      SRC,
      out,
      ['      qty: int check qty > 0 message "quantity must be positive"'],
      ['      qty: int check qty > 1 message "quantity must be positive"'],
    );
  });

  it("sets a message on a check that had none", () => {
    const added = setFieldCheck(
      SRC,
      "aggregate",
      "Order",
      fieldIndex("note"),
      'note != ""',
    ) as string;
    const out = setFieldCheck(
      added,
      "aggregate",
      "Order",
      fieldIndex("note"),
      'note != ""',
      "note is required",
    );
    expectHunk(
      added,
      out,
      ['      note: string check note != ""'],
      ['      note: string check note != "" message "note is required"'],
    );
    expect(modsOf(out as string, "note").checkMessage).toBe("note is required");
  });

  it("drops only the message when it is cleared", () => {
    const out = setFieldCheck(SRC, "aggregate", "Order", fieldIndex("qty"), "qty > 0", null);
    expectHunk(
      SRC,
      out,
      ['      qty: int check qty > 0 message "quantity must be positive"'],
      ["      qty: int check qty > 0"],
    );
  });

  it("removes the check together with its message", () => {
    const out = setFieldCheck(SRC, "aggregate", "Order", fieldIndex("qty"), null);
    expectHunk(
      SRC,
      out,
      ['      qty: int check qty > 0 message "quantity must be positive"'],
      ["      qty: int"],
    );
    expect(modsOf(out as string, "qty")).toMatchObject({ check: null, checkMessage: null });
  });

  it("re-quotes the message rather than trusting the caller's text", () => {
    const out = setFieldCheck(
      SRC,
      "aggregate",
      "Order",
      fieldIndex("note"),
      "true",
      'a "quoted" word',
    );
    expect(out).toContain('message "a \\"quoted\\" word"');
    expect(modsOf(out as string, "note").checkMessage).toBe('a "quoted" word');
  });
});

describe("field modifiers — mask unless", () => {
  it("adds `mask unless expr` to a bare field", () => {
    const out = setFieldMask(SRC, "aggregate", "Order", fieldIndex("note"), "currentUser.isAdmin");
    expectHunk(
      SRC,
      out,
      ["      note: string"],
      ["      note: string mask unless currentUser.isAdmin"],
    );
    expectCommentsIntact(out);
  });

  it("lands after an existing check + message", () => {
    const out = setFieldMask(SRC, "aggregate", "Order", fieldIndex("qty"), "currentUser.isAdmin");
    expectHunk(
      SRC,
      out,
      ['      qty: int check qty > 0 message "quantity must be positive"'],
      [
        '      qty: int check qty > 0 message "quantity must be positive" mask unless currentUser.isAdmin',
      ],
    );
  });

  it("replaces an existing mask predicate", () => {
    const out = setFieldMask(SRC, "aggregate", "Order", fieldIndex("ssn"), "currentUser.isOwner");
    expectHunk(
      SRC,
      out,
      ["      ssn: string sensitive(pii) secret mask unless currentUser.isAdmin"],
      ["      ssn: string sensitive(pii) secret mask unless currentUser.isOwner"],
    );
  });

  it("removes the mask and leaves the flags alone", () => {
    const out = setFieldMask(SRC, "aggregate", "Order", fieldIndex("ssn"), null);
    expectHunk(
      SRC,
      out,
      ["      ssn: string sensitive(pii) secret mask unless currentUser.isAdmin"],
      ["      ssn: string sensitive(pii) secret"],
    );
    expect(modsOf(out as string, "ssn")).toMatchObject({ maskUnless: null, access: "secret" });
  });
});

describe("field modifiers — access", () => {
  it("adds an access keyword after the type", () => {
    const out = setFieldAccess(SRC, "aggregate", "Order", fieldIndex("note"), "internal");
    expectHunk(SRC, out, ["      note: string"], ["      note: string internal"]);
    expectCommentsIntact(out);
  });

  it("adds the keyword BEFORE an existing default", () => {
    const out = setFieldAccess(SRC, "aggregate", "Order", fieldIndex("total"), "managed");
    expectHunk(SRC, out, ["      total: decimal = 0"], ["      total: decimal managed = 0"]);
    expect(modsOf(out as string, "total")).toMatchObject({ access: "managed", default: "0" });
  });

  it("replaces the keyword in place", () => {
    const out = setFieldAccess(SRC, "aggregate", "Order", fieldIndex("ssn"), "token");
    expectHunk(
      SRC,
      out,
      ["      ssn: string sensitive(pii) secret mask unless currentUser.isAdmin"],
      ["      ssn: string sensitive(pii) token mask unless currentUser.isAdmin"],
    );
  });

  it("null removes the keyword (back to the `editable` default)", () => {
    const out = setFieldAccess(SRC, "aggregate", "Order", fieldIndex("ssn"), null);
    expectHunk(
      SRC,
      out,
      ["      ssn: string sensitive(pii) secret mask unless currentUser.isAdmin"],
      ["      ssn: string sensitive(pii) mask unless currentUser.isAdmin"],
    );
    expect(modsOf(out as string, "ssn").access).toBeNull();
  });

  it("removing an absent keyword is a no-op; a non-keyword is refused", () => {
    expect(setFieldAccess(SRC, "aggregate", "Order", fieldIndex("note"), null)).toBe(SRC);
    expect(
      setFieldAccess(SRC, "aggregate", "Order", fieldIndex("note"), "bogus" as FieldAccess),
    ).toBeNull();
  });
});

describe("field modifiers — sensitive", () => {
  it("adds a tag clause to a bare field", () => {
    const out = setFieldSensitivity(SRC, "aggregate", "Order", fieldIndex("note"), ["pii"]);
    expectHunk(SRC, out, ["      note: string"], ["      note: string sensitive(pii)"]);
    expectCommentsIntact(out);
  });

  it("replaces the tag list in place, multi-tag", () => {
    const out = setFieldSensitivity(SRC, "aggregate", "Order", fieldIndex("ssn"), ["pii", " phi "]);
    expectHunk(
      SRC,
      out,
      ["      ssn: string sensitive(pii) secret mask unless currentUser.isAdmin"],
      ["      ssn: string sensitive(pii, phi) secret mask unless currentUser.isAdmin"],
    );
    expect(modsOf(out as string, "ssn").sensitivity).toEqual(["pii", "phi"]);
  });

  it("null / an all-empty list removes the clause", () => {
    const out = setFieldSensitivity(SRC, "aggregate", "Order", fieldIndex("ssn"), null);
    expectHunk(
      SRC,
      out,
      ["      ssn: string sensitive(pii) secret mask unless currentUser.isAdmin"],
      ["      ssn: string secret mask unless currentUser.isAdmin"],
    );
    expect(setFieldSensitivity(out as string, "aggregate", "Order", fieldIndex("ssn"), [" "])).toBe(
      out,
    );
  });

  it("refuses a tag that is not a bare identifier", () => {
    // Would silently re-split into two tags (or fail to parse) on the way back.
    expect(
      setFieldSensitivity(SRC, "aggregate", "Order", fieldIndex("note"), ["pii, phi"]),
    ).toBeNull();
    expect(
      setFieldSensitivity(SRC, "aggregate", "Order", fieldIndex("note"), ["9lives"]),
    ).toBeNull();
  });

  it("coexists with an access keyword written first", () => {
    const withAccess = setFieldAccess(
      SRC,
      "aggregate",
      "Order",
      fieldIndex("note"),
      "secret",
    ) as string;
    const out = setFieldSensitivity(withAccess, "aggregate", "Order", fieldIndex("note"), ["pii"]);
    expectHunk(
      withAccess,
      out,
      ["      note: string secret"],
      ["      note: string secret sensitive(pii)"],
    );
    expect(modsOf(out as string, "note")).toMatchObject({ access: "secret", sensitivity: ["pii"] });
  });
});

describe("field modifiers — composition", () => {
  it("default → mask → check all coexist on one field, in any application order", () => {
    let src: string | null = SRC;
    src = setFieldDefault(src as string, "aggregate", "Order", fieldIndex("note"), '"n/a"');
    src = setFieldMask(
      src as string,
      "aggregate",
      "Order",
      fieldIndex("note"),
      "currentUser.isAdmin",
    );
    src = setFieldCheck(
      src as string,
      "aggregate",
      "Order",
      fieldIndex("note"),
      'note != ""',
      "required",
    );
    expectHunk(
      SRC,
      src,
      ["      note: string"],
      [
        '      note: string = "n/a" check note != "" message "required" mask unless currentUser.isAdmin',
      ],
    );
    expect(modsOf(src as string, "note")).toEqual({
      default: '"n/a"',
      check: 'note != ""',
      checkMessage: "required",
      maskUnless: "currentUser.isAdmin",
      access: null,
      provenanced: false,
      sensitivity: null,
    });
  });

  it("the flag modifiers slot in ahead of an already-written default", () => {
    let src: string | null = SRC;
    src = setFieldDefault(src as string, "aggregate", "Order", fieldIndex("note"), '"n/a"');
    src = setFieldAccess(src as string, "aggregate", "Order", fieldIndex("note"), "immutable");
    src = setFieldSensitivity(src as string, "aggregate", "Order", fieldIndex("note"), ["pii"]);
    expectHunk(
      SRC,
      src,
      ["      note: string"],
      ['      note: string immutable sensitive(pii) = "n/a"'],
    );
    expectCommentsIntact(src);
  });

  it("removing every modifier returns the field to its bare form", () => {
    let src: string | null = SRC;
    src = setFieldMask(src as string, "aggregate", "Order", fieldIndex("ssn"), null);
    src = setFieldAccess(src as string, "aggregate", "Order", fieldIndex("ssn"), null);
    src = setFieldSensitivity(src as string, "aggregate", "Order", fieldIndex("ssn"), null);
    expectHunk(
      SRC,
      src,
      ["      ssn: string sensitive(pii) secret mask unless currentUser.isAdmin"],
      ["      ssn: string"],
    );
    expectCommentsIntact(src);
  });

  it("the invariant's `message` survives every modifier edit", () => {
    const edits = [
      setFieldDefault(SRC, "aggregate", "Order", fieldIndex("note"), "1"),
      setFieldCheck(SRC, "aggregate", "Order", fieldIndex("note"), "true"),
      setFieldMask(SRC, "aggregate", "Order", fieldIndex("note"), "currentUser.isAdmin"),
      setFieldAccess(SRC, "aggregate", "Order", fieldIndex("note"), "secret"),
      setFieldSensitivity(SRC, "aggregate", "Order", fieldIndex("note"), ["pii"]),
    ];
    for (const out of edits) {
      expect(out).toContain('invariant total >= 0 message "total must not be negative"');
    }
  });
});

describe("field modifiers — events share the Property rule", () => {
  const EVT = `system S {\n  context C {\n    // placed\n    event OrderPlaced { at: datetime, by: string }\n  }\n}`;

  it("modifies a comma-separated event field without disturbing its neighbour", () => {
    const out = setFieldDefault(EVT, "event", "OrderPlaced", 1, '"system"');
    expectHunk(
      EVT,
      out,
      ["    event OrderPlaced { at: datetime, by: string }"],
      ['    event OrderPlaced { at: datetime, by: string = "system" }'],
    );
    expect(out).toContain("// placed");
  });

  it("keeps the separating comma when the FIRST field takes a clause", () => {
    const out = setFieldMask(EVT, "event", "OrderPlaced", 0, "currentUser.isAdmin");
    expectHunk(
      EVT,
      out,
      ["    event OrderPlaced { at: datetime, by: string }"],
      ["    event OrderPlaced { at: datetime mask unless currentUser.isAdmin, by: string }"],
    );
  });

  it("flags and a default compose on an event field too", () => {
    let src: string | null = EVT;
    src = setFieldSensitivity(src as string, "event", "OrderPlaced", 1, ["pii"]);
    src = setFieldDefault(src as string, "event", "OrderPlaced", 1, '"system"');
    expectHunk(
      EVT,
      src,
      ["    event OrderPlaced { at: datetime, by: string }"],
      ['    event OrderPlaced { at: datetime, by: string sensitive(pii) = "system" }'],
    );
  });
});

describe("field modifiers — guards", () => {
  it("the output re-parse rejects unparseable expression text", () => {
    const i = fieldIndex("note");
    expect(setFieldDefault(SRC, "aggregate", "Order", i, "= = =")).toBeNull();
    expect(setFieldCheck(SRC, "aggregate", "Order", i, "((")).toBeNull();
    expect(setFieldMask(SRC, "aggregate", "Order", i, "currentUser.")).toBeNull();
    // A default that would swallow the field ABOVE its insertion point is still
    // caught by the same guard — nothing here bypasses the re-parse.
    expect(setFieldDefault(SRC, "aggregate", "Order", i, '"unterminated')).toBeNull();
  });

  it("rejects multi-line clause text — these splices stay on the field's line", () => {
    const i = fieldIndex("note");
    expect(setFieldDefault(SRC, "aggregate", "Order", i, "1 +\n2")).toBeNull();
    expect(setFieldCheck(SRC, "aggregate", "Order", i, "true", "line\nbreak")).toBeNull();
    expect(setFieldMask(SRC, "aggregate", "Order", i, "a\nb")).toBeNull();
  });

  it("returns null on a source with parser errors", () => {
    for (const [name, op] of Object.entries(ALL)) {
      expect(op(BROKEN, 0), name).toBeNull();
    }
  });

  it("returns null for an unknown construct, an unknown kind, or a bad index", () => {
    for (const [name, op] of Object.entries(ALL)) {
      expect(op(SRC, 99), `${name} out-of-range`).toBeNull();
    }
    expect(setFieldDefault(SRC, "aggregate", "Nope", 0, "1")).toBeNull();
    expect(setFieldCheck(SRC, "aggregate", "Nope", 0, "true")).toBeNull();
    expect(setFieldMask(SRC, "aggregate", "Nope", 0, "true")).toBeNull();
    expect(setFieldAccess(SRC, "aggregate", "Nope", 0, "secret")).toBeNull();
    expect(setFieldSensitivity(SRC, "aggregate", "Nope", 0, ["pii"])).toBeNull();
    // `repository` is not a Property-bearing kind.
    expect(setFieldDefault(SRC, "repository", "Order", 0, "1")).toBeNull();
  });
});

describe("field modifiers — read-back", () => {
  it("reports each field's modifier state as written source", () => {
    const mods = listFieldModifiers(constructOf(SRC, "Aggregate", "Order"));
    expect(mods[fieldIndex("customerId")]).toEqual({
      default: null,
      check: null,
      checkMessage: null,
      maskUnless: null,
      access: null,
      provenanced: false,
      sensitivity: null,
    });
    expect(mods[fieldIndex("total")].default).toBe("0");
    expect(mods[fieldIndex("ssn")]).toMatchObject({
      access: "secret",
      sensitivity: ["pii"],
      maskUnless: "currentUser.isAdmin",
    });
    expect(mods[fieldIndex("qty")]).toMatchObject({
      check: "qty > 0",
      checkMessage: "quantity must be positive",
    });
  });

  it("is positionally parallel to `listFields`", () => {
    const order = constructOf(SRC, "Aggregate", "Order");
    expect(listFieldModifiers(order)).toHaveLength(listFields(order).length);
  });
});
