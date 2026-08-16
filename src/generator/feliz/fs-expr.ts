// F# expression rendering for the Feliz frontend target.
//
// Two consumers share ONE set of leaf formatters (`FS_LEAVES`):
//   1. The view path — `felizTarget`'s expr-leaf seam methods delegate here
//      (walker-core resolves refs/state/hooks and hands already-rendered
//      children to the leaf).
//   2. The MVU `update` path — `renderFsExpr` (below) owns its own dispatch +
//      ref resolution (state → `model.<Field>`) and delegates syntax to the
//      SAME leaves, so the two paths can never diverge on operator/literal/
//      list/lambda spelling.
//
// The leaf formatters are pure string→string: they receive already-rendered
// sub-expressions, exactly like the backend `ExprTarget` leaves in
// src/generator/_expr/target.ts.  This is the frontend's F# leaf table; the
// JS leaf table (React/Vue/Svelte/Angular) stays inline in walker-core until
// the seam extraction (slice 4) converts it.

import type { BinOp, ExprIR, LiteralKind, PrimitiveName, TypeIR } from "../../ir/types/loom-ir.js";
import { intrinsicFor, intrinsicKey } from "../../util/intrinsics.js";
import { upperFirst } from "../../util/naming.js";
import { DURATION_UNIT_MS } from "../../util/temporal.js";

/** F# spelling of a Loom binary operator. */
function fsBinOp(op: BinOp): string {
  switch (op) {
    case "==":
      return "=";
    case "!=":
      return "<>";
    default:
      return op; // + - * / % < <= > >= && || are spelled identically in F#
  }
}

/** F# string literal — double-quoted with the F#-significant escapes. */
export function fsString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

/** F# spelling of the `now()` literal — the current instant on the UTC clock.
 *  Fully qualified because the generated `App.fs` opens no `System`. */
export const FS_NOW = "System.DateTime.UtcNow";

/** Pure F# leaf formatters — one per divergent expression arm.  Sub-expressions
 *  arrive already rendered.  Signatures match the optional `WalkerTarget`
 *  expr-leaf seam so `felizTarget` can forward straight to these. */
export const FS_LEAVES = {
  literal(lit: LiteralKind, value: string): string {
    if (lit === "string") return fsString(value);
    if (lit === "bool") return value; // true/false spelled the same
    if (lit === "null") return "None"; // F# absence is the option None
    // `now()` is a LITERAL kind, not a number: its `value` is the word "now",
    // so the numeric-verbatim fallthrough below emitted a bare `now` — an
    // unbound identifier, and the only literal kind on this target that is not
    // already valid F# text.  A Loom `datetime` is a `System.DateTime` here
    // (`type-fs.ts`) decoded from the wire as UTC (`Decode.datetimeUtc`), so
    // the current instant is `System.DateTime.UtcNow` — the same UTC-clock
    // spelling the .NET backend emits for the same literal.
    if (lit === "now") return FS_NOW;
    // int / long / decimal / money → numeric literal verbatim
    return value;
  },
  binary(left: string, right: string, op: BinOp): string {
    return `(${left} ${fsBinOp(op)} ${right})`;
  },
  unary(op: "-" | "!", operand: string): string {
    return op === "!" ? `(not ${operand})` : `(-${operand})`;
  },
  ternary(cond: string, then: string, otherwise: string): string {
    return `(if ${cond} then ${then} else ${otherwise})`;
  },
  convert(value: string, target: PrimitiveName, from: PrimitiveName | undefined): string {
    void from;
    if (target === "string") return `(string ${value})`;
    if (target === "long" || target === "int") return `(int ${value})`;
    if (target === "decimal" || target === "money") return `(decimal ${value})`;
    return value;
  },
  list(elements: string[]): string {
    return `[ ${elements.join("; ")} ]`;
  },
  object(fields: { name: string; value: string }[]): string {
    // F# anonymous record — the closest analogue of a JS object literal.
    return `{| ${fields.map((f) => `${f.name} = ${f.value}`).join("; ")} |}`;
  },
  lambda(param: string, body: string | undefined): string {
    return `(fun ${param} -> ${body ?? "()"})`;
  },
  /** `days(7)` — a `System.TimeSpan`, the .NET duration type, NOT the bare
   *  millisecond number the JS frontends use: `System.DateTime` has no
   *  `+ int`, so a number here is a type error the moment it meets a datetime.
   *  The SPAN still comes from `DURATION_UNIT_MS`, so `7 days` is the same
   *  length of time here as on the wire and on every backend.
   *
   *  The multiplication is done in `float`, not `int`: F#'s `int` is 32-bit and
   *  `30 days` in milliseconds (2_592_000_000) overflows it. */
  duration(unit: keyof typeof DURATION_UNIT_MS, amount: string): string {
    return `(System.TimeSpan.FromMilliseconds(float (${amount}) * ${DURATION_UNIT_MS[unit]}.0))`;
  },
};

/** The datetime-involving `+`/`-` arms, or `null` to fall through to the plain
 *  operator leaf.  Dispatch is type-driven off the lowering's
 *  `leftType`/`resultType` stamps, exactly as the TypeScript backend's
 *  `renderTemporalBinary` does:
 *
 *    datetime ± duration → datetime   ⇒ `((l).Add(r))` / `((l).Subtract(r))`
 *    duration + datetime → datetime   ⇒ `((r).Add(l))`   (commuted form)
 *    datetime − datetime → duration   ⇒ falls through — F#'s `-` on two
 *                                       `System.DateTime`s already yields the
 *                                       `System.TimeSpan` a duration is.
 *
 *  Shared by both feliz paths: the view walker reaches it through
 *  `felizTarget.exprTemporalBinary`, the MVU update path through
 *  `renderFsExpr`'s binary arm. */
export function fsTemporalBinary(
  left: string,
  right: string,
  e: Extract<ExprIR, { kind: "binary" }>,
): string | null {
  if (e.op !== "+" && e.op !== "-") return null;
  const prim = (t: TypeIR | undefined): string | undefined =>
    t?.kind === "primitive" ? t.name : undefined;
  const lt = prim(e.leftType);
  const rt = prim(e.rightType);
  if (lt === "datetime" && rt === "duration") {
    return `((${left}).${e.op === "+" ? "Add" : "Subtract"}(${right}))`;
  }
  // `duration + datetime` — the commuted form (`duration - datetime` never
  // types), so the receiver is the RIGHT operand.
  if (lt === "duration" && rt === "datetime" && e.op === "+") {
    return `((${right}).Add(${left}))`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scalar-intrinsic snippet table for F# / Fable — the Feliz sibling of
// `_expr/js-intrinsics.ts` (JS family) and `dotnet/render-expr.ts`'s
// `CS_INTRINSIC_RENDERERS` (C#).  One arm per `INTRINSIC_SIGNATURES` row,
// keyed `<receiver>.<name>` via `intrinsicKey`.
//
// Without this table the walker fell through to a VERBATIM `recv.member(args)`,
// which on F# is:
//   - a compile error wherever .NET spells the op differently
//     (`toUpper` vs `ToUpper`, `abs` vs `abs`/`Math.Abs`) — every arm here, since
//     .NET members are PascalCase and Loom's are camelCase; and
//   - silently wrong for `substring`, where .NET's `Substring(start, length)`
//     agrees with Loom on the arg MEANING but THROWS on out-of-range where Loom
//     clamps.
//
// Representation on this target (`type-fs.ts`): `int`/`long` → F# `int`,
// `decimal`/`money` → F# `decimal` (money is a bare precise scalar, no
// currency), `datetime` → `System.DateTime`, and a Loom `T[]` is an F# `list`
// (see `FS_LEAVES.list` and the `List.*` collection arms below).
//
// Fable maps the .NET members used here onto their JS equivalents, so the
// generated app compiles under `dotnet fable` — which is what
// `generated-feliz-build.yml` proves.
// ---------------------------------------------------------------------------

export const FS_INTRINSIC_RENDERERS: Record<string, (recv: string, args: string[]) => string> = {
  "string.trim": (recv) => `(${recv}.Trim())`,
  "string.toUpper": (recv) => `(${recv}.ToUpper())`,
  "string.toLower": (recv) => `(${recv}.ToLower())`,
  // 0-based CLAMPING semantics (JS `slice` — the catalogue contract).  .NET's
  // Substring THROWS on an out-of-range start or length, so guard both edges.
  // Receiver/arg duplication is safe: Loom expressions are pure.
  "string.substring": (recv, args) =>
    args.length > 1
      ? `(if ${args[0]} >= ${recv}.Length then "" else ${recv}.Substring(${args[0]}, min (${args[1]}) (${recv}.Length - ${args[0]})))`
      : `(if ${args[0]} >= ${recv}.Length then "" else ${recv}.Substring(${args[0]}))`,
  // Fable compiles these to the JS String methods, which are ordinal — the
  // catalogue's culture-free contract, with no StringComparison overload
  // needed (and Fable's coverage of those overloads is thinner).
  "string.startsWith": (recv, args) => `(${recv}.StartsWith(${args[0]}))`,
  "string.endsWith": (recv, args) => `(${recv}.EndsWith(${args[0]}))`,
  "string.contains": (recv, args) => `(${recv}.Contains(${args[0]}))`,
  // .NET `Replace` already replaces ALL occurrences — the Loom contract.
  "string.replace": (recv, args) => `(${recv}.Replace(${args[0]}, ${args[1]}))`,
  // `Split` yields an ARRAY; a Loom `string[]` is an F# `list` on this target
  // (the collection arms below are `List.*`), so materialize it.  The
  // single-element separator array is the overload Fable maps reliably, and it
  // keeps empty segments — the catalogue's contract.
  "string.split": (recv, args) =>
    `(${recv}.Split([| ${args[0]} |], System.StringSplitOptions.None) |> List.ofArray)`,
  // ---- numerics -----------------------------------------------------------
  // F#'s `abs` / `min` / `max` are generic and resolve per receiver type
  // (`int` and `decimal` both), so no per-receiver spelling is needed — but the
  // rows stay explicit, one per catalogue entry, so a missing arm is visible.
  "int.abs": (recv) => `(abs ${recv})`,
  "long.abs": (recv) => `(abs ${recv})`,
  "decimal.abs": (recv) => `(abs ${recv})`,
  "money.abs": (recv) => `(abs ${recv})`,
  // Truncating integer division (toward zero) — F# `/` on `int` truncates
  // natively, matching the catalogue.
  "int.divTrunc": (recv, args) => `(${recv} / ${args[0]})`,
  "long.divTrunc": (recv, args) => `(${recv} / ${args[0]})`,
  // Two-value LEAST/GREATEST, not an aggregate.
  "int.min": (recv, args) => `(min ${recv} ${args[0]})`,
  "long.min": (recv, args) => `(min ${recv} ${args[0]})`,
  "decimal.min": (recv, args) => `(min ${recv} ${args[0]})`,
  "money.min": (recv, args) => `(min ${recv} ${args[0]})`,
  "int.max": (recv, args) => `(max ${recv} ${args[0]})`,
  "long.max": (recv, args) => `(max ${recv} ${args[0]})`,
  "decimal.max": (recv, args) => `(max ${recv} ${args[0]})`,
  "money.max": (recv, args) => `(max ${recv} ${args[0]})`,
  // HALF-AWAY-FROM-ZERO ("commercial") rounding per the catalogue — .NET's
  // native default is banker's half-even, so the mode is forced, exactly as the
  // C# table does.  `places` defaults to 0.
  "decimal.round": (recv, args) =>
    args.length > 0
      ? `(System.Math.Round(${recv}, ${args[0]}, System.MidpointRounding.AwayFromZero))`
      : `(System.Math.Round(${recv}, System.MidpointRounding.AwayFromZero))`,
  "money.round": (recv, args) =>
    args.length > 0
      ? `(System.Math.Round(${recv}, ${args[0]}, System.MidpointRounding.AwayFromZero))`
      : `(System.Math.Round(${recv}, System.MidpointRounding.AwayFromZero))`,
  // floor/ceil KEEP the receiver type (a whole-valued decimal, not an int) —
  // the decimal overloads of Math.Floor/Ceiling do exactly that.
  "decimal.floor": (recv) => `(System.Math.Floor(${recv}))`,
  "money.floor": (recv) => `(System.Math.Floor(${recv}))`,
  "decimal.ceil": (recv) => `(System.Math.Ceiling(${recv}))`,
  "money.ceil": (recv) => `(System.Math.Ceiling(${recv}))`,
  // ---- datetime -----------------------------------------------------------
  // MIDNIGHT UTC of the receiver's day (the catalogue contract).  `.Date` alone
  // would truncate in the value's own Kind, so normalize to UTC first and
  // rebuild with an explicit Kind — the same care the JS arm takes with its
  // `getUTC*` readers instead of `setHours`.
  "datetime.startOfDay": (recv) =>
    `(let d = (${recv}).ToUniversalTime() in System.DateTime(d.Year, d.Month, d.Day, 0, 0, 0, System.DateTimeKind.Utc))`,
};

/**
 * Render a scalar intrinsic to F#, or `undefined` when this member is not a
 * catalogue intrinsic on this receiver — the caller then falls through to its
 * ordinary member/method-call emission.
 *
 * Mirrors `renderJsIntrinsic`: intrinsics are RECEIVER-QUALIFIED, so a
 * `string.contains` (substring test) and a `T[].contains` (collection
 * membership) never collide — lowering keys `isCollectionOp` off the receiver
 * type, and a primitive receiver is never flagged as one.
 *
 * Unlike the JS table there is no declined-arm guard here: F# needs no import
 * for `System.Math` / `System.DateTime`, so every arm is emittable.
 */
export function renderFsIntrinsic(
  receiverType: TypeIR,
  member: string,
  recv: string,
  args: readonly string[],
): string | undefined {
  if (receiverType.kind !== "primitive") return undefined;
  if (!intrinsicFor(receiverType.name, member)) return undefined;
  const render = FS_INTRINSIC_RENDERERS[intrinsicKey(receiverType.name, member)];
  return render ? render(recv, [...args]) : undefined;
}

/** Resolution context for the standalone update-path renderer. */
export interface FsExprCtx {
  /** State field names — a ref resolves to `model.<Pascal(name)>`. */
  stateNames: ReadonlySet<string>;
  /** Lambda / action param names in scope — a ref resolves to the bare name. */
  locals: ReadonlySet<string>;
  /** When rendering a STORE action body, the store's own fields bind as `let`
   *  locals at lowering (`count := 0` → a bare `count`), so a bare ref to one
   *  resolves to the namespaced Model field `model.<Store><Field>` (stores
   *  compose into the single Elmish Model).  Absent for page/component bodies. */
  storeScope?: { store: string; fields: ReadonlySet<string> };
  /** The in-scope F# expression that yields the route `id` (an `ExprIR` of kind
   *  `"id"` — `Order.byId(id)`, `sel := string(id)`).  Every consumer of this
   *  renderer binds the route id DIFFERENTLY, which is why it is a context
   *  field rather than a fixed spelling: the page VIEW fn takes it as a
   *  parameter (`id`), while `update`/`init` run outside any view and have to
   *  read it back off the parsed route (`routeId model.CurrentPage`, the helper
   *  `renderRouting` emits beside `parseUrl`).  Absent on a NON-routed ui,
   *  where no page carries a route param and an `id` read has no value to
   *  resolve to — it renders as the empty string there, the F# analogue of
   *  React's absent `useParams()` entry. */
  routeId?: string;
}

/** The empty route id — what an `id` read resolves to on a ui with no routing
 *  table at all (see `FsExprCtx.routeId`). */
const NO_ROUTE_ID = '""';

/** Name of the module-level accessor `renderRouting` emits beside `parseUrl`:
 *  `let routeId (page: Page) : string`, the route param of the active page ("" when
 *  it carries none).  It is what lets the MVU paths — which run outside any page
 *  view fn — resolve an `id` read at all. */
export const ROUTE_ID_FN = "routeId";

/** The route id as read from the model, for an `update` arm (`CurrentPage` is
 *  already the parsed route). */
export const ROUTE_ID_FROM_MODEL = `(${ROUTE_ID_FN} model.CurrentPage)`;

/** The route id for `init`, which runs BEFORE the model exists — parse the
 *  current URL the same way `init` seeds `CurrentPage`. */
export const ROUTE_ID_FROM_URL = `(${ROUTE_ID_FN} (parseUrl (Router.currentPath ())))`;

/** True when rendered F# references the `routeId` accessor, so `renderRouting`
 *  emits it only where it is actually used (a ui whose bodies never read the
 *  route `id` keeps its `App.fs` byte-identical).  Asking the EMITTED text is
 *  exact — no separate IR scan to drift from what the renderers did. */
export function usesRouteIdFn(...emitted: readonly string[]): boolean {
  return emitted.some((s) => s.includes(`(${ROUTE_ID_FN} `));
}

/** The single-program Elmish Model field a store field folds into
 *  (`Cart` + `count` → `CartCount`).  Stores share the one `Model`; flat
 *  namespacing avoids a nested-record type and collisions with page state. */
export function storeModelField(store: string, field: string): string {
  return `${upperFirst(store)}${upperFirst(field)}`;
}

/** The Elmish `Msg` case a store action folds into (`Cart` + `clear` →
 *  `CartClear`). */
export function storeMsgCase(store: string, action: string): string {
  return `${upperFirst(store)}${upperFirst(action)}`;
}

/** Render a method-call to idiomatic F# for the update/action path.
 *
 *  Collection membership on the F# `list` (`List.contains`/`List.isEmpty`/
 *  `List.length`) is handled here; every SCALAR op routes through the shared
 *  `FS_INTRINSIC_RENDERERS` table above — the same table the VIEW path reaches
 *  via `felizTarget.renderIntrinsic`, so the two paths cannot diverge on what
 *  `s.replace(a, b)` means (this file's whole premise, and previously true of
 *  the leaves but NOT of the intrinsics: the view path had no table at all and
 *  emitted the Loom spelling verbatim, while this path knew seven ops and threw
 *  on the rest).
 *
 *  An unrecognised method still fails fast rather than emitting a
 *  `.member(args)` call that would not compile under Fable. */
function renderFsMethodCall(
  e: Extract<ExprIR, { kind: "method-call" }>,
  recv: string,
  args: string[],
): string {
  const a0 = args[0] ?? "";
  if (e.isCollectionOp || e.receiverType.kind === "array") {
    switch (e.member) {
      case "contains":
        return `(List.contains ${a0} ${recv})`;
      case "isEmpty":
        return `(List.isEmpty ${recv})`;
      case "count":
        return `(List.length ${recv})`;
    }
  }
  const intrinsic = renderFsIntrinsic(e.receiverType, e.member, recv, args);
  if (intrinsic !== undefined) return intrinsic;
  // `length` is a string PROPERTY in Loom, not a catalogue intrinsic, so it is
  // not in the table — but it does reach this path.
  if (e.member === "length") return `(${recv}.Length)`;
  throw new Error(
    `feliz: method '${e.member}' is not implemented on the F# action/update path — ` +
      `the Feliz frontend renders the scalar-intrinsic catalogue plus a bounded set of ` +
      `collection methods here. Add a '${e.member}' arm in fs-expr.ts ` +
      `(FS_INTRINSIC_RENDERERS for a catalogue intrinsic, renderFsMethodCall otherwise).`,
  );
}

/** Render an `ExprIR` to F# for a NON-view position (the MVU `update` arm
 *  bodies).  Resolves refs itself; delegates syntax to `FS_LEAVES`.  Covers
 *  scalar/collection state writes, `let` bindings, predicate `match`, single-
 *  expression lambdas, and a bounded collection/string method set. */
export function renderFsExpr(e: ExprIR, ctx: FsExprCtx): string {
  const r = (x: ExprIR): string => renderFsExpr(x, ctx);
  switch (e.kind) {
    case "literal":
      return FS_LEAVES.literal(e.lit, e.value);
    case "ref":
      // A dotted `<Store>.<field>` read (page/component body) — resolved to the
      // namespaced Model field regardless of scope.
      if (e.refKind === "store-field" && e.storeName) {
        return `model.${storeModelField(e.storeName, e.name)}`;
      }
      // Inside a store action body the store's own fields are `let` locals; a
      // bare ref to one resolves to its namespaced Model field.
      if (ctx.storeScope?.fields.has(e.name)) {
        return `model.${storeModelField(ctx.storeScope.store, e.name)}`;
      }
      if (ctx.locals.has(e.name)) return e.name;
      if (ctx.stateNames.has(e.name)) return `model.${upperFirst(e.name)}`;
      return e.name;
    case "binary": {
      const left = r(e.left);
      const right = r(e.right);
      // Datetime arithmetic is a method call in .NET, not an operator — the
      // same seam the view path consults through `felizTarget`.
      return fsTemporalBinary(left, right, e) ?? FS_LEAVES.binary(left, right, e.op);
    }
    case "unary":
      return FS_LEAVES.unary(e.op, r(e.operand));
    case "ternary":
      return FS_LEAVES.ternary(r(e.cond), r(e.then), r(e.otherwise));
    case "convert":
      return FS_LEAVES.convert(r(e.value), e.target, e.from);
    case "i18nFormat":
      // Transparent i18n wrapper (M-T1.11) — Feliz has no client i18n runtime,
      // so the format is dropped: render the wrapped operand verbatim.
      return r(e.inner);
    case "list":
      return FS_LEAVES.list(e.elements.map(r));
    case "object":
      return FS_LEAVES.object(e.fields.map((f) => ({ name: f.name, value: r(f.value) })));
    case "id":
      // The route `id` of a detail page (`/orders/:id`).  The VIEW path resolves
      // it through `felizTarget.renderRouteId` to the view fn's `id` parameter;
      // this path runs in `update`/`init`, where no such parameter exists — so
      // the ctx carries whatever spelling IS in scope there.
      return ctx.routeId ?? NO_ROUTE_ID;
    case "duration":
      // `7 days` — the SAME `System.TimeSpan` the VIEW path emits (through the
      // `exprDuration` walker seam), off the same `DURATION_UNIT_MS` span every
      // backend agrees on, so a duration means the same length of time on both
      // sides of the wire and on both feliz paths.
      return FS_LEAVES.duration(e.unit, r(e.amount));
    case "new":
      // Part construction (`Shipment { … }`).  A part is a plain record on the
      // wire exactly as a value object is, so it renders as the F# anonymous
      // record the VIEW path emits for it (walker-core's `new` arm → the
      // `exprObject` seam → this same leaf).
      return `(${FS_LEAVES.object(e.fields.map((f) => ({ name: f.name, value: r(f.value) })))})`;
    case "member":
      // Record-field access — the receiver is a wire record (an async-effect
      // success binding `p`, a read row) whose F# fields keep the EXACT lowercase
      // wire-shape names (`type Project = { name: string }`).  Render the field
      // VERBATIM — the shared view walker does the same (walker-core `p.name`), so
      // the MVU update path and the view path land on the same field with no
      // casing seam.  (`upperFirst` here was a latent bug — no member access
      // reached this arm until the async-effect renderer landed.)
      return `${r(e.receiver)}.${e.member}`;
    case "call":
      return `${e.name}(${e.args.map(r).join(", ")})`;
    case "method-call":
      return renderFsMethodCall(e, r(e.receiver), e.args.map(r));
    case "match": {
      // Predicate-arm form only (`match { cond => value }`) — an F#
      // `if/elif/else` chain.  A value-position match needs a total `else`;
      // the variant-discriminating form (`match subject { … }`) belongs to the
      // union/async subsystem and is gated at validation, not reached here.
      if (e.subject) {
        throw new Error(
          "feliz: variant-match expression in an F# action body is not rendered here — " +
            "it is gated at validation (loom.feliz-async-effect-unsupported).",
        );
      }
      if (e.otherwise === undefined) {
        throw new Error(
          "feliz: a `match` in a value position needs an `otherwise` arm to render a total " +
            "F# if/elif/else expression.",
        );
      }
      const chain = e.arms.map(
        (a, i) => `${i === 0 ? "if" : "elif"} ${r(a.cond)} then ${r(a.value)}`,
      );
      return chain.length === 0
        ? `(${r(e.otherwise)})`
        : `(${chain.join(" ")} else ${r(e.otherwise)})`;
    }
    case "lambda":
      // Single-expression form (`x => expr`) → the shared F# lambda leaf.  A
      // block-body lambda (`x => { … }`) carries statements, not a value, and
      // has no update-arm rendering — fail fast.
      if (e.block) {
        throw new Error(
          "feliz: block-body lambda (`x => { … }`) is not rendered in an F# action body.",
        );
      }
      return FS_LEAVES.lambda(e.param, e.body ? r(e.body) : undefined);
    case "paren":
      return `(${r(e.inner)})`;
    default:
      // Fail fast rather than silently substituting `(* unsupported *) ()`.
      // Three kinds reach here, none of them authored in a page body:
      // `this` (a domain-body receiver — a page has no aggregate instance),
      // `action-ref` (a handler reference the view walker binds as a dispatch
      // wrapper, never a value in an update arm), and `authz-filter` (a
      // synthesized query-filter sentinel that lives only on an aggregate's
      // `contextFilters`).  So this is a defensive fail-fast on an IR shape the
      // frontend pipeline does not produce — NOT a claim that every expression
      // a user can write is covered.  If it fires on real `.ddd`, the arm is
      // missing: add it here rather than widening the throw.
      throw new Error(
        `feliz: unsupported expression '${e.kind}' in an F# action/update body — ` +
          `no arm renders it on the MVU update path. If a valid page body reaches ` +
          `this, implement the '${e.kind}' arm in fs-expr.ts (the view path's ` +
          `treatment of the same kind is in _walker/walker-core.ts).`,
      );
  }
}
