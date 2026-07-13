// Direct unit tests for Phoenix's `renderExpr` — exercises each
// `ExprIR.kind` arm against the live emitter to lock per-kind output
// without going through codegen/build.  Mirrors the dispatch table in
// `src/generator/elixir/render-expr.ts:55-102`.
//
// These tests run in the fast suite (no `LOOM_PHOENIX_BUILD`, no Elixir,
// no `mix`); Phoenix codegen is pure TS string emission.

import { describe, expect, it } from "vitest";
import { renderExpr } from "../../../src/generator/elixir/render-expr.js";
import type { ExprIR, TypeIR } from "../../../src/ir/types/loom-ir.js";

const ctx = { thisName: "record", contextModule: "MyApp" };

const prim = (name: TypeIR extends { kind: "primitive" } ? string : never): TypeIR =>
  ({ kind: "primitive", name }) as TypeIR;
const STRING: TypeIR = { kind: "primitive", name: "string" };
const INT: TypeIR = { kind: "primitive", name: "int" };
const MONEY: TypeIR = { kind: "primitive", name: "money" };
const BOOL: TypeIR = { kind: "primitive", name: "bool" };

const litInt = (v: string): ExprIR => ({ kind: "literal", lit: "int", value: v });
const litStr = (v: string): ExprIR => ({ kind: "literal", lit: "string", value: v });
const litMoney = (v: string): ExprIR => ({ kind: "literal", lit: "money", value: v });
const refParam = (name: string): ExprIR => ({ kind: "ref", name, refKind: "param" });
const thisProp = (name: string): ExprIR => ({ kind: "ref", name, refKind: "this-prop" });

describe("phoenix renderExpr — literals", () => {
  it("renders string literals as Elixir-quoted strings", () => {
    expect(renderExpr(litStr("hello"), ctx)).toBe('"hello"');
  });

  it("renders int literals verbatim", () => {
    expect(renderExpr(litInt("42"), ctx)).toBe("42");
  });

  it("renders bool literals as Elixir atoms (true/false)", () => {
    expect(renderExpr({ kind: "literal", lit: "bool", value: "true" }, ctx)).toBe("true");
    expect(renderExpr({ kind: "literal", lit: "bool", value: "false" }, ctx)).toBe("false");
  });

  it("renders null as nil", () => {
    expect(renderExpr({ kind: "literal", lit: "null", value: "" }, ctx)).toBe("nil");
  });

  it("renders `now` as DateTime.utc_now()", () => {
    expect(renderExpr({ kind: "literal", lit: "now", value: "" }, ctx)).toBe("DateTime.utc_now()");
  });

  it('wraps decimal literals in Decimal.new("…") (decimal is a Decimal struct on Elixir, like money)', () => {
    expect(renderExpr({ kind: "literal", lit: "decimal", value: "1.5" }, ctx)).toBe(
      'Decimal.new("1.5")',
    );
  });

  it('wraps money literals in Decimal.new("…")', () => {
    expect(renderExpr(litMoney("9.99"), ctx)).toBe('Decimal.new("9.99")');
  });

  it("negates a money/decimal operand via Decimal.negate (native `-` raises on a Decimal struct)", () => {
    expect(renderExpr({ kind: "unary", op: "-", operand: litMoney("1.0") }, ctx)).toBe(
      'Decimal.negate(Decimal.new("1.0"))',
    );
    expect(
      renderExpr(
        { kind: "unary", op: "-", operand: { kind: "literal", lit: "decimal", value: "2.5" } },
        ctx,
      ),
    ).toBe('Decimal.negate(Decimal.new("2.5"))');
  });

  it("negates a plain numeric operand with native `-`", () => {
    expect(renderExpr({ kind: "unary", op: "-", operand: litInt("3") }, ctx)).toBe("-3");
  });

  it("renders money/decimal natively inside an Ecto query filter (no Decimal.* — data-layer native)", () => {
    // Negative money literal in a `where` filter expr (filterArgs context).
    expect(
      renderExpr(
        { kind: "unary", op: "-", operand: litMoney("1.0") },
        { ...ctx, filterArgs: true },
      ),
    ).toBe("-1.0");
  });
});

describe("phoenix renderExpr — receivers", () => {
  it("renders `this` as ctx.thisName", () => {
    expect(renderExpr({ kind: "this" }, ctx)).toBe("record");
    expect(renderExpr({ kind: "this" }, { ...ctx, thisName: "changeset" })).toBe("changeset");
  });

  it("renders `id` as <thisName>.id", () => {
    expect(renderExpr({ kind: "id" }, ctx)).toBe("record.id");
  });

  it("snake-cases param refs", () => {
    expect(renderExpr(refParam("orderNumber"), ctx)).toBe("order_number");
  });

  it("renders this-prop refs as <thisName>.<snake_name>", () => {
    expect(renderExpr(thisProp("customerName"), ctx)).toBe("record.customer_name");
  });

  it("renders enum-value refs as the declared-case atom in-memory (loaded Ecto.Enum field)", () => {
    // No `filterArgs` here → in-memory context → the declared-case atom (matches
    // the loaded Ecto.Enum struct field).  A query context renders the string.
    expect(renderExpr({ kind: "ref", name: "Active", refKind: "enum-value" }, ctx)).toBe(":Active");
  });

  it("renders current-user refs verbatim", () => {
    expect(renderExpr({ kind: "ref", name: "currentUser", refKind: "current-user" }, ctx)).toBe(
      "current_user",
    );
  });
});

describe("phoenix renderExpr — binary operators", () => {
  it("renders `+` on ints as native plus", () => {
    expect(
      renderExpr(
        { kind: "binary", op: "+", left: litInt("1"), right: litInt("2"), leftType: INT },
        ctx,
      ),
    ).toBe("1 + 2");
  });

  it("renders `+` on money as Decimal.add", () => {
    expect(
      renderExpr(
        { kind: "binary", op: "+", left: litMoney("1"), right: litMoney("2"), leftType: MONEY },
        ctx,
      ),
    ).toBe('Decimal.add(Decimal.new("1"), Decimal.new("2"))');
  });

  it("renders `*` on money as Decimal.mult", () => {
    expect(
      renderExpr(
        { kind: "binary", op: "*", left: litMoney("3"), right: litInt("2"), leftType: MONEY },
        ctx,
      ),
    ).toBe('Decimal.mult(Decimal.new("3"), 2)');
  });

  it("renders money comparisons via Decimal.compare", () => {
    expect(
      renderExpr(
        { kind: "binary", op: ">", left: litMoney("5"), right: litMoney("3"), leftType: MONEY },
        ctx,
      ),
    ).toBe('Decimal.compare(Decimal.new("5"), Decimal.new("3")) == :gt');
  });

  it("renders `+` on string types as Elixir <>", () => {
    expect(
      renderExpr(
        { kind: "binary", op: "+", left: litStr("a"), right: litStr("b"), leftType: STRING },
        ctx,
      ),
    ).toBe('"a" <> "b"');
  });

  it("renders `&&` as Elixir `and`", () => {
    expect(
      renderExpr(
        {
          kind: "binary",
          op: "&&",
          left: { kind: "literal", lit: "bool", value: "true" },
          right: { kind: "literal", lit: "bool", value: "false" },
          leftType: BOOL,
        },
        ctx,
      ),
    ).toBe("true and false");
  });

  it("renders `||` as Elixir `or`", () => {
    expect(
      renderExpr(
        {
          kind: "binary",
          op: "||",
          left: { kind: "literal", lit: "bool", value: "true" },
          right: { kind: "literal", lit: "bool", value: "false" },
          leftType: BOOL,
        },
        ctx,
      ),
    ).toBe("true or false");
  });

  it("renders `%` as the `rem(...)` function", () => {
    expect(
      renderExpr(
        { kind: "binary", op: "%", left: litInt("7"), right: litInt("3"), leftType: INT },
        ctx,
      ),
    ).toBe("rem(7, 3)");
  });

  // Elixir warns ("Comparing values with nil will always return false. Use
  // is_nil/1 instead.") and `--warnings-as-errors` fails on `x == nil`.
  it("renders `x != null` as `not is_nil(x)`", () => {
    expect(
      renderExpr(
        {
          kind: "binary",
          op: "!=",
          left: thisProp("description"),
          right: { kind: "literal", lit: "null", value: "" },
        },
        ctx,
      ),
    ).toBe("not is_nil(record.description)");
  });

  it("renders `x == null` as `is_nil(x)`", () => {
    expect(
      renderExpr(
        {
          kind: "binary",
          op: "==",
          left: thisProp("description"),
          right: { kind: "literal", lit: "null", value: "" },
        },
        ctx,
      ),
    ).toBe("is_nil(record.description)");
  });

  it("renders `null == x` (null on the left) as `is_nil(x)` too", () => {
    expect(
      renderExpr(
        {
          kind: "binary",
          op: "==",
          left: { kind: "literal", lit: "null", value: "" },
          right: thisProp("description"),
        },
        ctx,
      ),
    ).toBe("is_nil(record.description)");
  });
});

describe("phoenix renderExpr — unary, paren, ternary", () => {
  it("renders `!` as Elixir `not`", () => {
    expect(renderExpr({ kind: "unary", op: "!", operand: thisProp("active") }, ctx)).toBe(
      "not record.active",
    );
  });

  it("renders unary minus as a prefix operator", () => {
    expect(renderExpr({ kind: "unary", op: "-", operand: litInt("3") }, ctx)).toBe("-3");
  });

  it("preserves paren as visual grouping in source", () => {
    expect(
      renderExpr({ kind: "paren", inner: { kind: "literal", lit: "bool", value: "true" } }, ctx),
    ).toBe("(true)");
  });

  it("lowers ternary to `if cond, do: x, else: y`", () => {
    expect(
      renderExpr(
        {
          kind: "ternary",
          cond: { kind: "literal", lit: "bool", value: "true" },
          // biome-ignore lint/suspicious/noThenProperty: the ternary IR node's branch field is named `then`
          then: litInt("1"),
          otherwise: litInt("2"),
        },
        ctx,
      ),
    ).toBe("if true, do: 1, else: 2");
  });
});

describe("phoenix renderExpr — convert", () => {
  it("converts string(money) via Decimal.to_string", () => {
    expect(
      renderExpr(
        { kind: "convert", target: "string", from: "money", value: thisProp("price") },
        ctx,
      ),
    ).toBe("Decimal.to_string(record.price)");
  });

  it("converts string(int) via to_string", () => {
    expect(
      renderExpr({ kind: "convert", target: "string", from: "int", value: litInt("3") }, ctx),
    ).toBe("to_string(3)");
  });

  it("converts money(int) via Decimal.new", () => {
    expect(
      renderExpr({ kind: "convert", target: "money", from: "int", value: litInt("5") }, ctx),
    ).toBe("Decimal.new(5)");
  });

  it("treats money→money convert as no-op", () => {
    expect(
      renderExpr(
        { kind: "convert", target: "money", from: "money", value: thisProp("amount") },
        ctx,
      ),
    ).toBe("record.amount");
  });
});

describe("phoenix renderExpr — match", () => {
  it("renders match → cond do … end with `true ->` fallthrough on no else", () => {
    expect(
      renderExpr(
        {
          kind: "match",
          arms: [{ cond: thisProp("active"), value: litStr("yes") }],
        },
        ctx,
      ),
    ).toBe('cond do\n    record.active -> "yes"\n    true -> nil\n  end');
  });

  it("renders match with else as the trailing `true ->` clause", () => {
    expect(
      renderExpr(
        {
          kind: "match",
          arms: [{ cond: thisProp("active"), value: litStr("yes") }],
          otherwise: litStr("no"),
        },
        ctx,
      ),
    ).toBe('cond do\n    record.active -> "yes"\n    true -> "no"\n  end');
  });
});

describe("phoenix renderExpr — member, method-call, call, new, list, lambda", () => {
  it("reads a value-object sub-field via a key-type-agnostic fallback (#1660 — a VO is a string- or atom-keyed map)", () => {
    // `record.address.postal_code` (struct-dot) KeyErrors on a string-keyed jsonb
    // VO map; the atom-then-string fallback is correct for map AND struct shapes.
    expect(
      renderExpr(
        {
          kind: "member",
          receiver: thisProp("address"),
          member: "postalCode",
          receiverType: { kind: "valueobject", name: "Address" },
          memberType: STRING,
        },
        ctx,
      ),
    ).toBe('Map.get(record.address, :postal_code, Map.get(record.address, "postal_code"))');
  });

  it("renders a non-VO member access as <recv>.<snake_member>", () => {
    expect(
      renderExpr(
        {
          kind: "member",
          receiver: thisProp("order"),
          member: "shippedAt",
          receiverType: { kind: "entity", name: "Order" },
          memberType: STRING,
        },
        ctx,
      ),
    ).toBe("record.order.shipped_at");
  });

  it("collapses string.length → String.length(...)", () => {
    expect(
      renderExpr(
        {
          kind: "member",
          receiver: thisProp("name"),
          member: "length",
          receiverType: STRING,
          memberType: INT,
        },
        ctx,
      ),
    ).toBe("String.length(record.name)");
  });

  it("collapses array.count → Enum.count(...)", () => {
    expect(
      renderExpr(
        {
          kind: "member",
          receiver: thisProp("items"),
          member: "count",
          receiverType: { kind: "array", element: STRING },
          memberType: INT,
        },
        ctx,
      ),
    ).toBe("Enum.count(record.items)");
  });

  it("collapses array.length → Enum.count(...) (not a `.length` field access)", () => {
    // The DSL admits both `.count` and `.length` on arrays; a missing
    // `.length` arm let it fall through to `record.items.length`, a map
    // field access that raises `BadMapError` on a list at runtime — the
    // root cause of guarded workflows returning 500 instead of 403.
    expect(
      renderExpr(
        {
          kind: "member",
          receiver: thisProp("items"),
          member: "length",
          receiverType: { kind: "array", element: STRING },
          memberType: INT,
        },
        ctx,
      ),
    ).toBe("Enum.count(record.items)");
  });

  it("renders string.matches(literal) as Regex.match?(~r/…/, …)", () => {
    expect(
      renderExpr(
        {
          kind: "method-call",
          receiver: thisProp("email"),
          member: "matches",
          args: [litStr("^[^@]+@.+$")],
          receiverType: STRING,
          isCollectionOp: false,
        },
        ctx,
      ),
    ).toBe("Regex.match?(~r/^[^@]+@.+$/, record.email)");
  });

  it("renders string.trim() intrinsic as String.trim(...) in-memory (stdlib A1)", () => {
    // Elixir strings have no methods — the pre-catalogue fallthrough emitted
    // `record.name.trim()`, invalid Elixir.  The catalogue row routes through
    // ELIXIR_INTRINSIC_RENDERERS in-memory.
    expect(
      renderExpr(
        {
          kind: "method-call",
          receiver: thisProp("name"),
          member: "trim",
          args: [],
          receiverType: STRING,
          isCollectionOp: false,
        },
        ctx,
      ),
    ).toBe("String.trim(record.name)");
  });

  it("renders string.trim() as an Ecto fragment in filter mode (stdlib A1)", () => {
    // Inside `from ... where: ...` a `String.*` call is not a valid Ecto query
    // expression — the catalogue row routes through ECTO_INTRINSIC_FRAGMENTS.
    expect(
      renderExpr(
        {
          kind: "method-call",
          receiver: thisProp("name"),
          member: "trim",
          args: [],
          receiverType: STRING,
          isCollectionOp: false,
        },
        { ...ctx, filterArgs: true },
      ),
    ).toBe('fragment("btrim(?)", record.name)');
  });

  it("renders string.toUpper()/toLower() in both modes (stdlib A2)", () => {
    const upper: ExprIR = {
      kind: "method-call",
      receiver: thisProp("name"),
      member: "toUpper",
      args: [],
      receiverType: STRING,
      isCollectionOp: false,
    };
    const lower: ExprIR = { ...upper, member: "toLower" } as ExprIR;
    // In-memory: the String.* stdlib calls.
    expect(renderExpr(upper, ctx)).toBe("String.upcase(record.name)");
    expect(renderExpr(lower, ctx)).toBe("String.downcase(record.name)");
    // Filter mode: SQL upper()/lower() fragments (String.* is invalid in Ecto queries).
    expect(renderExpr(upper, { ...ctx, filterArgs: true })).toBe(
      'fragment("upper(?)", record.name)',
    );
    expect(renderExpr(lower, { ...ctx, filterArgs: true })).toBe(
      'fragment("lower(?)", record.name)',
    );
  });

  it("renders string.substring in both arities via String.slice (stdlib A2)", () => {
    const twoArg: ExprIR = {
      kind: "method-call",
      receiver: thisProp("name"),
      member: "substring",
      args: [litInt("1"), litInt("3")],
      receiverType: STRING,
      isCollectionOp: false,
    };
    // Two-arg: `String.slice/3` takes start + LENGTH and clamps — the
    // catalogue's JS-slice contract.
    expect(renderExpr(twoArg, ctx)).toBe("String.slice(record.name, 1, 3)");
    // One-arg: run to the end via the stepped range (out-of-range start → "").
    const oneArg: ExprIR = { ...twoArg, args: [litInt("2")] } as ExprIR;
    expect(renderExpr(oneArg, ctx)).toBe("String.slice(record.name, 2..-1//1)");
  });

  it("renders string.contains as the String.contains? intrinsic — never Enum.member? (stdlib A2)", () => {
    // Since the A2 core, lowering keys `isCollectionOp` off the receiver type:
    // a primitive-string receiver's `contains` is the intrinsic, not the
    // collection membership op.
    expect(
      renderExpr(
        {
          kind: "method-call",
          receiver: thisProp("name"),
          member: "contains",
          args: [litStr("x")],
          receiverType: STRING,
          isCollectionOp: false,
        },
        ctx,
      ),
    ).toBe('String.contains?(record.name, "x")');
  });

  it("renders string.startsWith/endsWith via String.starts_with?/ends_with? (stdlib A2)", () => {
    const starts: ExprIR = {
      kind: "method-call",
      receiver: thisProp("name"),
      member: "startsWith",
      args: [litStr("pre")],
      receiverType: STRING,
      isCollectionOp: false,
    };
    expect(renderExpr(starts, ctx)).toBe('String.starts_with?(record.name, "pre")');
    const ends: ExprIR = { ...starts, member: "endsWith", args: [litStr("suf")] } as ExprIR;
    expect(renderExpr(ends, ctx)).toBe('String.ends_with?(record.name, "suf")');
  });

  it("renders string.replace via String.replace/3 (replaces ALL occurrences) (stdlib A2)", () => {
    expect(
      renderExpr(
        {
          kind: "method-call",
          receiver: thisProp("name"),
          member: "replace",
          args: [litStr("a"), litStr("b")],
          receiverType: STRING,
          isCollectionOp: false,
        },
        ctx,
      ),
    ).toBe('String.replace(record.name, "a", "b")');
  });

  it("renders string.split via String.split/2 (keeps empty segments) (stdlib A2)", () => {
    expect(
      renderExpr(
        {
          kind: "method-call",
          receiver: thisProp("name"),
          member: "split",
          args: [litStr(",")],
          receiverType: STRING,
          isCollectionOp: false,
        },
        ctx,
      ),
    ).toBe('String.split(record.name, ",")');
  });

  it("keeps refColl/array contains on the membership path (Enum.member?) — keyed off the array receiver type", () => {
    // The string intrinsic keys on `receiverType.kind === "primitive"`; an
    // array-receiver contains stays the collection op (`isCollectionOp: true`)
    // and never routes through the intrinsic table.
    expect(
      renderExpr(
        {
          kind: "method-call",
          receiver: thisProp("tags"),
          member: "contains",
          args: [litStr("x")],
          receiverType: { kind: "array", element: STRING },
          isCollectionOp: true,
        },
        ctx,
      ),
    ).toBe('Enum.member?(record.tags, "x")');
  });

  it("renders collection-op `count` as Enum.count", () => {
    expect(
      renderExpr(
        {
          kind: "method-call",
          receiver: thisProp("items"),
          member: "count",
          args: [],
          receiverType: { kind: "array", element: STRING },
          isCollectionOp: true,
        },
        ctx,
      ),
    ).toBe("Enum.count(record.items)");
  });

  it("renders the A4 collection transformation ops via Enum", () => {
    const arr: TypeIR = { kind: "array", element: STRING };
    const idLambda: ExprIR = {
      kind: "lambda",
      param: "x",
      body: { kind: "ref", name: "x", refKind: "lambda" },
    };
    const mc = (member: string, args: ExprIR[]): ExprIR => ({
      kind: "method-call",
      receiver: thisProp("items"),
      member,
      args,
      receiverType: arr,
      isCollectionOp: true,
    });
    expect(renderExpr(mc("map", [idLambda]), ctx)).toBe("Enum.map(record.items, fn x -> x end)");
    expect(renderExpr(mc("sortBy", [idLambda]), ctx)).toBe(
      "Enum.sort_by(record.items, fn x -> x end)",
    );
    expect(
      renderExpr(mc("sortBy", [idLambda, { kind: "literal", lit: "bool", value: "true" }]), ctx),
    ).toBe("Enum.sort_by(record.items, fn x -> x end, :desc)");
    // `distinct` is property-style — a member node, not a method-call.
    expect(
      renderExpr(
        {
          kind: "member",
          receiver: thisProp("items"),
          member: "distinct",
          receiverType: arr,
          memberType: arr,
        },
        ctx,
      ),
    ).toBe("Enum.uniq(record.items)");
    expect(renderExpr(mc("take", [litInt("2")]), ctx)).toBe("Enum.take(record.items, 2)");
    expect(renderExpr(mc("skip", [litInt("1")]), ctx)).toBe("Enum.drop(record.items, 1)");
    expect(renderExpr(mc("join", [litStr(", ")]), ctx)).toBe('Enum.join(record.items, ", ")');
  });

  it("renders the A4 reductions min(λ)/max(λ) with a type-aware Enum sorter", () => {
    const arr: TypeIR = { kind: "array", element: STRING };
    const mc = (member: string, args: ExprIR[]): ExprIR => ({
      kind: "method-call",
      receiver: thisProp("items"),
      member,
      args,
      receiverType: arr,
      isCollectionOp: true,
    });
    // λ-body projection typed via `member.memberType` (bodyTypeOf reads it).
    const proj = (member: string, memberType: TypeIR): ExprIR => ({
      kind: "lambda",
      param: "x",
      body: {
        kind: "member",
        receiver: { kind: "ref", name: "x", refKind: "lambda" },
        member,
        receiverType: { kind: "entity", name: "Line" },
        memberType,
      },
    });
    const idLambda: ExprIR = {
      kind: "lambda",
      param: "x",
      body: { kind: "ref", name: "x", refKind: "lambda" },
    };

    // int/long/string (and untyped) → native `&<=/2` (min) / `&>=/2` (max);
    // empty → nil via the `fn -> nil end` fallback.
    expect(renderExpr(mc("min", [idLambda]), ctx)).toBe(
      "Enum.min(Enum.map(record.items, fn x -> x end), &<=/2, fn -> nil end)",
    );
    expect(renderExpr(mc("max", [idLambda]), ctx)).toBe(
      "Enum.max(Enum.map(record.items, fn x -> x end), &>=/2, fn -> nil end)",
    );
    expect(renderExpr(mc("min", [proj("qty", INT)]), ctx)).toBe(
      "Enum.min(Enum.map(record.items, fn x -> x.qty end), &<=/2, fn -> nil end)",
    );

    // money/decimal → Decimal.compare (native `<=`/`>=` is STRUCTURAL on a
    // Decimal struct, not numeric): min `!= :gt`, max `!= :lt`.
    expect(renderExpr(mc("min", [proj("price", MONEY)]), ctx)).toBe(
      "Enum.min(Enum.map(record.items, fn x -> x.price end), &(Decimal.compare(&1, &2) != :gt), fn -> nil end)",
    );
    expect(renderExpr(mc("max", [proj("price", MONEY)]), ctx)).toBe(
      "Enum.max(Enum.map(record.items, fn x -> x.price end), &(Decimal.compare(&1, &2) != :lt), fn -> nil end)",
    );

    // datetime → DateTime.compare (native compare is chronological only via
    // the helper): min `!= :gt`, max `!= :lt`.
    const DATETIME: TypeIR = { kind: "primitive", name: "datetime" };
    expect(renderExpr(mc("min", [proj("createdAt", DATETIME)]), ctx)).toBe(
      "Enum.min(Enum.map(record.items, fn x -> x.created_at end), &(DateTime.compare(&1, &2) != :gt), fn -> nil end)",
    );
    expect(renderExpr(mc("max", [proj("createdAt", DATETIME)]), ctx)).toBe(
      "Enum.max(Enum.map(record.items, fn x -> x.created_at end), &(DateTime.compare(&1, &2) != :lt), fn -> nil end)",
    );
  });

  it("renders function call with receiver prepended (passed first arg)", () => {
    expect(
      renderExpr(
        { kind: "call", callKind: "function", name: "computeTotal", args: [litInt("3")] },
        ctx,
      ),
    ).toBe("compute_total(record, 3)");
  });

  it("omits the trailing receiver-comma when a function takes no extra args", () => {
    expect(renderExpr({ kind: "call", callKind: "function", name: "refresh", args: [] }, ctx)).toBe(
      "refresh(record)",
    );
  });

  it("renders value-object constructor as %ContextModule.Name{…}", () => {
    expect(
      renderExpr(
        {
          kind: "call",
          callKind: "value-object-ctor",
          name: "Money",
          args: [litInt("3")],
        },
        ctx,
      ),
    ).toBe("%MyApp.Money{3}");
  });

  it("renders a value-object constructor with named map fields (snake) when argNames are present", () => {
    // Real lowered IR carries the VO's field order in `argNames`, so the
    // value is built with named fields.  Vanilla stores value objects as plain
    // JSON maps (no `%Ctx.VO{}` struct module is emitted), so the constructor
    // builds a map; names are snake-cased to match the Ecto column names.
    expect(
      renderExpr(
        {
          kind: "call",
          callKind: "value-object-ctor",
          name: "Money",
          args: [{ kind: "literal", lit: "decimal", value: "9.99" }, litStr("USD")],
          argNames: ["amount", "currencyCode"],
        },
        ctx,
      ),
    ).toBe('%{amount: Decimal.new("9.99"), currency_code: "USD"}');
  });

  it("renders entity-part constructor (kind: new) with snake field keys", () => {
    expect(
      renderExpr(
        {
          kind: "new",
          partName: "LineItem",
          fields: [
            { name: "sku", value: litStr("ABC") },
            { name: "qtyOrdered", value: litInt("2") },
          ],
        },
        ctx,
      ),
    ).toBe('%MyApp.LineItem{sku: "ABC", qty_ordered: 2}');
  });

  it("renders single-expression lambda as fn x -> expr end", () => {
    expect(renderExpr({ kind: "lambda", param: "item", body: thisProp("active") }, ctx)).toBe(
      "fn item -> record.active end",
    );
  });

  it("renders block-body lambda as a TODO comment (Elixir disallows inline blocks)", () => {
    expect(renderExpr({ kind: "lambda", param: "x", block: [] }, ctx)).toBe(
      "fn x -> # block-body-lambda end",
    );
  });

  it("renders list literal as Elixir [a, b, c]", () => {
    expect(
      renderExpr({ kind: "list", elements: [litInt("1"), litInt("2"), litInt("3")] }, ctx),
    ).toBe("[1, 2, 3]");
  });

  it("renders object literal as %{k: v, …} with snake keys", () => {
    expect(
      renderExpr(
        {
          kind: "object",
          fields: [
            { name: "firstName", value: litStr("Ada") },
            { name: "age", value: litInt("36") },
          ],
        },
        ctx,
      ),
    ).toBe('%{first_name: "Ada", age: 36}');
  });
});

// Keep the type-import only used by the test helpers from being elided.
void prim;
