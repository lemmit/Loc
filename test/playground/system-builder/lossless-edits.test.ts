// Lossless-edit gate for the visual builder's structural mutators.
//
// `web/src/builder/edit-engine.ts` promises that everything OUTSIDE the edited
// construct is byte-preserved.  These suites hold the stronger line the
// mutators now actually keep: everything outside the edited SPAN — including
// comments *inside* the construct, and every field modifier after the type —
// survives too.  The mutators used to reprint the whole construct through
// `printStructural`, which has no comment handling, so each of these edits
// silently deleted the surrounding comments.
//
// Assertions go through `lineDiff` (the builder's own hunk differ): asserting
// the exact removed/added lines proves nothing else in the file moved.

import { describe, expect, it } from "vitest";
import { lineDiff } from "../../../web/src/builder/edit-engine.js";
import {
  setDeployableContexts,
  setDeployableServes,
  setDeployableTargets,
  setDeployableUi,
} from "../../../web/src/builder/system/deployable-bindings.js";
import {
  addField,
  deleteField,
  listFields,
  type PrimitiveName,
  retypeField,
  type TypeSpec,
} from "../../../web/src/builder/system/fields.js";
import {
  addFindParam,
  deleteFindParam,
  renameFindParam,
  retypeFindParam,
  setFindReturnType,
} from "../../../web/src/builder/system/find-params.js";
import { parseRaw as parse } from "../../_helpers/index.js";

const prim = (name: PrimitiveName): TypeSpec => ({
  base: { kind: "primitive", name },
  array: false,
  optional: false,
});

// One fixture exercising every construct the mutators touch, deliberately
// littered with the formatting a reprint destroys: line comments, a block
// comment, a same-line trailing comment, a field default, a `mask unless`
// clause, and an invariant carrying an author-written `message`.
const SRC = `system Shop {

  context Sales {

    // ── Order — the sales root ──────────────────────────────
    aggregate Order {
      /* the customer that placed this order */
      customerId: Customer id
      // how much, in the order's currency
      total: decimal = 0
      ssn: string mask unless currentUser.isAdmin
      status: string   // draft | placed | shipped

      // never let an order go negative
      invariant total >= 0 message "total must not be negative"
    }

    // Reads over the order book.
    repository Orders for Order {
      // one customer's own orders
      find byCustomer(customerId: Customer id): Order[]
      /* the whole book */
      find all(): Order[]
      find drafts(forCustomer: Customer id): Order[]
        where this.customerId == forCustomer
    }
  }

  deployable api {
    platform: node
    // hosts the sales context
    contexts: [Sales]
    serves: SalesApi
    port: 8080
  }

  deployable web {
    platform: static
    targets: api
    // the compose binding carries per-param wiring the picker can't express
    ui: WebApp { Catalog: api, Sales: api }
    port: 3001
  }
}`;

/** Every comment in the fixture — none of them may ever disappear. */
const COMMENTS = [
  "// ── Order — the sales root ──────────────────────────────",
  "/* the customer that placed this order */",
  "// how much, in the order's currency",
  "// draft | placed | shipped",
  "// never let an order go negative",
  "// Reads over the order book.",
  "// one customer's own orders",
  "/* the whole book */",
  "// hosts the sales context",
  "// the compose binding carries per-param wiring the picker can't express",
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

// A source the parser rejects — every mutator must refuse it rather than
// splice at offsets the error-recovery parser invented.
const BROKEN = SRC.replace("aggregate Order {", "aggregate Order {{");

const fieldIndex = (name: string): number => {
  const order = parse(SRC)
    .members.flatMap((m) => ("members" in m ? m.members : []))
    .flatMap((m) => ("members" in m ? m.members : []))
    .find((m) => m.$type === "Aggregate" && (m as { name?: string }).name === "Order");
  if (!order) throw new Error("no Order aggregate");
  const at = listFields(order).findIndex((f) => f.name === name);
  if (at < 0) throw new Error(`no field ${name}`);
  return at;
};

describe("builder lossless edits — fields", () => {
  it("addField appends one member line and touches nothing else", () => {
    const out = addField(SRC, "aggregate", "Order", "note", prim("string"));
    // Appended after the last member (the invariant), at the members' indent.
    expectHunk(SRC, out, [], ["      note: string"]);
    expectCommentsIntact(out);
  });

  it("addField opens the first line of an empty construct", () => {
    const src = `system S {\n  context C {\n    valueobject Money {\n    }\n  }\n}`;
    const out = addField(src, "valueobject", "Money", "amount", prim("decimal"));
    expectHunk(src, out, [], ["      amount: decimal"]);
  });

  it("addField keeps an event's comma-separated fields well-formed", () => {
    const src = `system S {\n  context C {\n    // placed\n    event OrderPlaced { at: datetime, by: string }\n  }\n}`;
    const out = addField(src, "event", "OrderPlaced", "total", prim("decimal"));
    expect(out).not.toBeNull();
    expect(out).toContain("// placed");
    expect(out).toContain("at: datetime, by: string");
  });

  it("deleteField removes only the field's own line", () => {
    const out = deleteField(SRC, "aggregate", "Order", fieldIndex("total"));
    expectHunk(SRC, out, ["      total: decimal = 0"], []);
    expectCommentsIntact(out);
    // The comment that documented the deleted field stays — dropping it is a
    // judgement call the builder does not get to make silently.
    expect(out).toContain("// how much, in the order's currency");
  });

  it("deleteField takes the separating comma with an event field", () => {
    const src = `system S {\n  context C {\n    event E { a: int, b: string }\n  }\n}`;
    expect(deleteField(src, "event", "E", 0)).toContain("event E { b: string }");
    expect(deleteField(src, "event", "E", 1)).toContain("event E { a: int, }");
  });

  it("retypeField rewrites the TypeRef and keeps the field's default", () => {
    const out = retypeField(SRC, "aggregate", "Order", fieldIndex("total"), prim("money"));
    expectHunk(SRC, out, ["      total: decimal = 0"], ["      total: money = 0"]);
    expectCommentsIntact(out);
  });

  it("retypeField keeps a `mask unless` clause on the same field", () => {
    const optionalString: TypeSpec = {
      base: { kind: "primitive", name: "string" },
      array: false,
      optional: true,
    };
    const out = retypeField(SRC, "aggregate", "Order", fieldIndex("ssn"), optionalString);
    expectHunk(
      SRC,
      out,
      ["      ssn: string mask unless currentUser.isAdmin"],
      ["      ssn: string? mask unless currentUser.isAdmin"],
    );
    expectCommentsIntact(out);
  });

  it("retypeField to an `X id` / named type keeps the trailing comment", () => {
    const id: TypeSpec = {
      base: { kind: "id", target: "Customer" },
      array: false,
      optional: false,
    };
    const out = retypeField(SRC, "aggregate", "Order", fieldIndex("status"), id);
    expectHunk(
      SRC,
      out,
      ["      status: string   // draft | placed | shipped"],
      ["      status: Customer id   // draft | placed | shipped"],
    );
  });

  it("the invariant's `message` survives every field edit", () => {
    const edits = [
      addField(SRC, "aggregate", "Order", "note", prim("string")),
      deleteField(SRC, "aggregate", "Order", fieldIndex("total")),
      retypeField(SRC, "aggregate", "Order", fieldIndex("total"), prim("money")),
    ];
    for (const out of edits) {
      expect(out).toContain('invariant total >= 0 message "total must not be negative"');
    }
  });

  it("returns null on a source with parser errors", () => {
    expect(addField(BROKEN, "aggregate", "Order", "note", prim("string"))).toBeNull();
    expect(deleteField(BROKEN, "aggregate", "Order", 0)).toBeNull();
    expect(retypeField(BROKEN, "aggregate", "Order", 0, prim("int"))).toBeNull();
  });

  it("returns null for an unknown construct or out-of-range index", () => {
    expect(addField(SRC, "aggregate", "Nope", "x", prim("int"))).toBeNull();
    expect(deleteField(SRC, "aggregate", "Order", 99)).toBeNull();
    expect(retypeField(SRC, "aggregate", "Order", 99, prim("int"))).toBeNull();
  });
});

describe("builder lossless edits — repository find params", () => {
  it("addFindParam extends the param list in place", () => {
    const out = addFindParam(SRC, "Orders", "byCustomer", "since", prim("datetime"));
    expectHunk(
      SRC,
      out,
      ["      find byCustomer(customerId: Customer id): Order[]"],
      ["      find byCustomer(customerId: Customer id, since: datetime): Order[]"],
    );
    expectCommentsIntact(out);
  });

  it("addFindParam fills an empty param list", () => {
    const out = addFindParam(SRC, "Orders", "all", "limit", prim("int"));
    expectHunk(SRC, out, ["      find all(): Order[]"], ["      find all(limit: int): Order[]"]);
    expectCommentsIntact(out);
  });

  it("deleteFindParam empties the list without disturbing the repository", () => {
    const out = deleteFindParam(SRC, "Orders", "byCustomer", 0);
    expectHunk(
      SRC,
      out,
      ["      find byCustomer(customerId: Customer id): Order[]"],
      ["      find byCustomer(): Order[]"],
    );
    expectCommentsIntact(out);
  });

  it("deleteFindParam takes the separating comma with it", () => {
    const two = addFindParam(SRC, "Orders", "byCustomer", "since", prim("datetime")) as string;
    expect(deleteFindParam(two, "Orders", "byCustomer", 0)).toContain(
      "find byCustomer(since: datetime): Order[]",
    );
    expect(deleteFindParam(two, "Orders", "byCustomer", 1)).toContain(
      "find byCustomer(customerId: Customer id): Order[]",
    );
  });

  it("retypeFindParam / setFindReturnType rewrite only their own type", () => {
    expectHunk(
      SRC,
      retypeFindParam(SRC, "Orders", "byCustomer", 0, prim("string")),
      ["      find byCustomer(customerId: Customer id): Order[]"],
      ["      find byCustomer(customerId: string): Order[]"],
    );
    expectHunk(
      SRC,
      setFindReturnType(SRC, "Orders", "byCustomer", {
        base: { kind: "named", target: "Order" },
        array: false,
        optional: false,
      }),
      ["      find byCustomer(customerId: Customer id): Order[]"],
      ["      find byCustomer(customerId: Customer id): Order"],
    );
  });

  it("renameFindParam rewrites the token and its filter usage, verbatim elsewhere", () => {
    const out = renameFindParam(SRC, "Orders", "drafts", 0, "cust");
    expectHunk(
      SRC,
      out,
      [
        "      find drafts(forCustomer: Customer id): Order[]",
        "        where this.customerId == forCustomer",
      ],
      ["      find drafts(cust: Customer id): Order[]", "        where this.customerId == cust"],
    );
    expectCommentsIntact(out);
  });

  it("returns null on a source with parser errors", () => {
    expect(addFindParam(BROKEN, "Orders", "byCustomer", "since", prim("int"))).toBeNull();
    expect(deleteFindParam(BROKEN, "Orders", "byCustomer", 0)).toBeNull();
    expect(retypeFindParam(BROKEN, "Orders", "byCustomer", 0, prim("int"))).toBeNull();
    expect(renameFindParam(BROKEN, "Orders", "byCustomer", 0, "x")).toBeNull();
    expect(setFindReturnType(BROKEN, "Orders", "byCustomer", prim("int"))).toBeNull();
  });
});

describe("builder lossless edits — deployable bindings", () => {
  it("setDeployableUi retargets a compose binding without eating the block", () => {
    const out = setDeployableUi(SRC, "web", "Admin");
    expectHunk(
      SRC,
      out,
      ["    ui: WebApp { Catalog: api, Sales: api }"],
      ["    ui: Admin { Catalog: api, Sales: api }"],
    );
    expectCommentsIntact(out);
  });

  it("setDeployableUi refuses to clear a compose binding", () => {
    // Silently downgrading `ui: W { … }` to the sugar form (or dropping it)
    // would throw away param bindings the picker cannot re-enter.
    expect(setDeployableUi(SRC, "web", null)).toBeNull();
  });

  it("setDeployableUi appends a sugar binding to a deployable that has none", () => {
    const out = setDeployableUi(SRC, "api", "WebApp");
    expectHunk(SRC, out, [], ["    ui: WebApp"]);
    expectCommentsIntact(out);
  });

  it("setDeployableContexts / setDeployableServes rewrite only the ref tokens", () => {
    expectHunk(
      SRC,
      setDeployableContexts(SRC, "api", ["Sales", "Billing"]),
      ["    contexts: [Sales]"],
      ["    contexts: [Sales, Billing]"],
    );
    expectCommentsIntact(setDeployableContexts(SRC, "api", ["Sales", "Billing"]));
    expectHunk(
      SRC,
      setDeployableServes(SRC, "api", ["SalesApi", "AdminApi"]),
      ["    serves: SalesApi"],
      ["    serves: SalesApi, AdminApi"],
    );
  });

  it("emptying a ref list drops the whole clause line", () => {
    expectHunk(SRC, setDeployableContexts(SRC, "api", []), ["    contexts: [Sales]"], []);
    expectHunk(SRC, setDeployableServes(SRC, "api", []), ["    serves: SalesApi"], []);
    expectCommentsIntact(setDeployableContexts(SRC, "api", []));
  });

  it("setDeployableTargets rewrites / drops / inserts its own clause", () => {
    expectHunk(
      SRC,
      setDeployableTargets(SRC, "web", "other"),
      ["    targets: api"],
      ["    targets: other"],
    );
    expectHunk(SRC, setDeployableTargets(SRC, "web", null), ["    targets: api"], []);
    expectHunk(SRC, setDeployableTargets(SRC, "api", "web"), [], ["    targets: web"]);
    expectCommentsIntact(setDeployableTargets(SRC, "web", null));
  });

  it("returns null on a source with parser errors", () => {
    expect(setDeployableContexts(BROKEN, "api", ["Sales"])).toBeNull();
    expect(setDeployableServes(BROKEN, "api", ["SalesApi"])).toBeNull();
    expect(setDeployableTargets(BROKEN, "web", "api")).toBeNull();
    expect(setDeployableUi(BROKEN, "api", "WebApp")).toBeNull();
  });

  it("returns null for an unknown deployable", () => {
    expect(setDeployableContexts(SRC, "nope", ["Sales"])).toBeNull();
    expect(setDeployableUi(SRC, "nope", "WebApp")).toBeNull();
  });
});
