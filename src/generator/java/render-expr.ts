import { unionInstanceName } from "../../ir/stdlib/unions.js";
import type { EnrichedAggregateIR, ExprIR, TypeIR } from "../../ir/types/loom-ir.js";
import { intrinsicKey } from "../../util/intrinsics.js";
import {
  escapeJavaIdent,
  lowerFirst,
  plural,
  upperFirst,
  workflowFnCamel,
} from "../../util/naming.js";
import {
  type BinaryExpr,
  type CallExpr,
  type ExprTarget,
  type MemberExpr,
  type MethodCallExpr,
  type NewExpr,
  type RefExpr,
  renderExprWith,
} from "../_expr/target.js";
import type { UnionMember } from "../_payload/union-wire.js";

// ---------------------------------------------------------------------------
// Expression renderer for the Java / Spring backend.
//
// Same shape as the TS / C# / Elixir renderers — consumes fully-resolved
// Loom ExprIR; the 17-arm dispatch + recursion live in `../_expr/target.ts`,
// this file is the Java leaf table (`JAVA_TARGET`).  Output is idiomatic
// Java 21.  The two leaf divergences unique to Java:
//
//   1. **Money / decimal arithmetic** — Loom `money`/`decimal` map to
//      `BigDecimal`, which has no operators: `+`→`.add`, `*`→`.multiply`,
//      comparisons →`.compareTo(…) <op> 0` (BigDecimal.equals is
//      scale-sensitive, so `==` also routes through compareTo).
//   2. **Equality is method-based** — `==` on String / UUID / Instant /
//      ids / value objects renders `Objects.equals(l, r)`; native `==`
//      stays for primitives and enum constants.
//
// Generated domain classes expose record-style accessors (`name()`), so
// member access renders `recv.member()`; within the owning class,
// `this.<field>` reads the (package-private) field directly.
// ---------------------------------------------------------------------------

export interface JavaRenderContext {
  /** Rendered name for the implicit receiver (`this` by default). */
  thisName: string;
  /** Aggregate whose bodies we're lowering — used by `new <Part>` to
   *  order the part's constructor arguments by declared field order. */
  agg?: EnrichedAggregateIR;
  /** Resource-op call routing: resourceName → static Java helper class. */
  resourceClasses?: Map<string, string>;
  /** Exception-less operation return: the domain union the enclosing
   *  method returns (name + variant field order for tagged returns). */
  returnUnion?: { name: string; members: UnionMember[] };
  /** Event name → declared field order.  Java events are records with
   *  positional constructors, so `emit` must order its arguments by the
   *  event declaration, not the emit-site spelling.  Set by the entity
   *  emitter; absent in contexts that never render an `emit`. */
  eventFields?: Map<string, readonly string[]>;
  /** Render `this`-rooted property refs as bare names.  Needed inside a
   *  record's compact constructor (value-object invariants), where the
   *  canonical-constructor parameters carry the values and `this` is not
   *  yet available. */
  bareProps?: boolean;
  /** Render `this`-rooted property / id refs through the public
   *  accessors (`a.name()`, `a.id()`).  Needed when the receiver is an
   *  aggregate read from OUTSIDE its package (view binds in the views
   *  service) — package-private fields are unreachable there. */
  accessorProps?: boolean;
  /** Tier resolver for a `domain-service` call (domain-services.md rev. 4,
   *  Slice 1 — the `reading` tier).  Returns `true` when `<service>.<op>` is a
   *  READING-tier operation (it runs read-only repository queries, so on Java it
   *  is a `@Service` bean), in which case the call renders as an INSTANCE call
   *  against the injected field (`registration.isEmailAvailable(holder)`).  A
   *  PURE op (no ports) returns `false`/absent → the call stays STATIC
   *  (`Registration.forAmount(amount)`), byte-identical to the pre-rev.4 shell.
   *  Only the workflow render path wires this; aggregate-op contexts leave it
   *  undefined (and the validator forbids them calling a non-pure service). */
  serviceReading?: (service: string, op: string) => boolean;
  /** Regex-literal → static-field name map for hoisted `string.matches("…")`
   *  patterns (so a `private static final Pattern` is reused instead of a fresh
   *  `Pattern.compile(...)` on every evaluation).  Set by the entity / validator
   *  emitters from `collectJavaRegexLiterals`; absent ⇒ inline compile (the
   *  byte-identical default, kept for contexts that don't hoist). */
  regexFields?: ReadonlyMap<string, string>;
}

/** The injected repository field a Java `@Service` references for an aggregate
 *  (domain-services.md rev. 4): `lowerFirst(plural(<Aggregate>)) + "Repository"`
 *  — the SAME field name the workflow `@Service` and dispatcher already use
 *  (`Account` → `accountsRepository`), so a `reading` service's `repo-read` arm
 *  and the orchestrating workflow agree on the handle without sharing state. */
export function javaRepoField(aggName: string): string {
  return `${lowerFirst(plural(aggName))}Repository`;
}

const DEFAULT: JavaRenderContext = { thisName: "this" };

/** Imports a rendered domain expression needs beyond `java.lang`.
 *  Pure mirror of the triggers in the leaf table below — file emitters
 *  call it over the same expressions they render to build the import
 *  header (the analog of `collectCsExprUsings`). */
export function collectJavaExprImports(e: ExprIR, into: Set<string> = new Set()): Set<string> {
  const visit = (x: ExprIR): void => {
    collectJavaExprImports(x, into);
  };
  switch (e.kind) {
    case "literal":
      if (e.lit === "now") into.add("java.time.Instant");
      if (e.lit === "decimal" || e.lit === "money") into.add("java.math.BigDecimal");
      return into;
    case "method-call":
      if (isStringMatches(e)) into.add("java.util.regex.Pattern");
      visit(e.receiver);
      for (const a of e.args) visit(a);
      return into;
    case "member":
      visit(e.receiver);
      return into;
    case "binary": {
      const lt = unwrapOptional(e.leftType);
      if (isMoneyLike(lt)) {
        into.add("java.math.BigDecimal");
        if (e.op === "/") into.add("java.math.MathContext");
      } else if ((e.op === "==" || e.op === "!=") && needsObjectsEquals(lt, e)) {
        into.add("java.util.Objects");
      }
      visit(e.left);
      visit(e.right);
      return into;
    }
    case "unary":
      visit(e.operand);
      return into;
    case "paren":
      visit(e.inner);
      return into;
    case "ternary":
      visit(e.cond);
      visit(e.then);
      visit(e.otherwise);
      return into;
    case "call":
      for (const a of e.args) visit(a);
      return into;
    case "lambda":
      if (e.body) visit(e.body);
      return into;
    case "new":
    case "object":
      if (e.kind === "object") into.add("java.util.Map");
      for (const f of e.fields) visit(f.value);
      return into;
    case "convert":
      if (e.target === "decimal" || e.target === "money") into.add("java.math.BigDecimal");
      visit(e.value);
      return into;
    case "match":
      for (const arm of e.arms) {
        visit(arm.cond);
        visit(arm.value);
      }
      if (e.otherwise) visit(e.otherwise);
      return into;
    case "list":
      into.add("java.util.List");
      for (const el of e.elements) visit(el);
      return into;
    default:
      // this | id | ref — leaves with no sub-expressions.
      return into;
  }
}

/** Collect the STRING-LITERAL regex patterns used by `string.matches("…")`
 *  anywhere in `e` (dynamic-arg matches can't be hoisted, so they're skipped).
 *  The entity / validator emitters use this to hoist each distinct pattern into
 *  a `private static final Pattern` field instead of recompiling per evaluation.
 *  Mirrors the traversal of `collectJavaExprImports`. */
export function collectJavaRegexLiterals(e: ExprIR, into: Set<string> = new Set()): Set<string> {
  const visit = (x: ExprIR): void => void collectJavaRegexLiterals(x, into);
  switch (e.kind) {
    case "method-call":
      if (isStringMatches(e) && e.args[0]?.kind === "literal" && e.args[0].lit === "string") {
        into.add(e.args[0].value);
      }
      visit(e.receiver);
      for (const a of e.args) visit(a);
      break;
    case "member":
      visit(e.receiver);
      break;
    case "binary":
      visit(e.left);
      visit(e.right);
      break;
    case "unary":
      visit(e.operand);
      break;
    case "paren":
      visit(e.inner);
      break;
    case "ternary":
      visit(e.cond);
      visit(e.then);
      visit(e.otherwise);
      break;
    case "call":
      for (const a of e.args) visit(a);
      break;
    case "lambda":
      if (e.body) visit(e.body);
      break;
    case "new":
    case "object":
      for (const f of e.fields) visit(f.value);
      break;
    case "convert":
      visit(e.value);
      break;
    case "match":
      for (const arm of e.arms) {
        visit(arm.cond);
        visit(arm.value);
      }
      if (e.otherwise) visit(e.otherwise);
      break;
    case "list":
      for (const el of e.elements) visit(el);
      break;
    default:
      break;
  }
  return into;
}

/** Build `private static final Pattern …` declarations + a pattern→field-name
 *  map for a set of regex literals.  Field names are deterministic by first-seen
 *  order (`MATCHES_PATTERN_<i>`); `decls` are bare statements (no indent) so each
 *  caller indents to its class body.  Returns empty when there are no patterns. */
export function buildJavaRegexFields(patterns: Iterable<string>): {
  fields: ReadonlyMap<string, string>;
  decls: string[];
} {
  const fields = new Map<string, string>();
  const decls: string[] = [];
  for (const p of patterns) {
    if (fields.has(p)) continue;
    const name = `MATCHES_PATTERN_${fields.size}`;
    fields.set(p, name);
    decls.push(`private static final Pattern ${name} = Pattern.compile(${JSON.stringify(p)});`);
  }
  return { fields, decls };
}

function isStringMatches(e: MethodCallExpr): boolean {
  return (
    e.member === "matches" &&
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string" &&
    e.args.length === 1
  );
}

function unwrapOptional(t: TypeIR | undefined): TypeIR | undefined {
  return t?.kind === "optional" ? t.inner : t;
}

function isMoneyLike(t: TypeIR | undefined): boolean {
  return t?.kind === "primitive" && (t.name === "money" || t.name === "decimal");
}

/** Reference types whose `==` must be `Objects.equals` in Java.  Enum
 *  constants keep native `==` (identity equality is the Java idiom and
 *  is null-safe); primitives (int/long/bool) keep native operators.
 *  Null-literal comparisons short-circuit to native `==`/`!=` before
 *  this is consulted. */
function needsObjectsEquals(t: TypeIR | undefined, e: BinaryExpr): boolean {
  if (comparesNullLiteral(e)) return false;
  if (!t) return false;
  if (t.kind === "primitive") {
    return t.name === "string" || t.name === "datetime" || t.name === "guid" || t.name === "json";
  }
  return t.kind === "id" || t.kind === "valueobject" || t.kind === "entity" || t.kind === "array";
}

function comparesNullLiteral(e: BinaryExpr): boolean {
  const isNull = (x: ExprIR): boolean => x.kind === "literal" && x.lit === "null";
  return isNull(e.left) || isNull(e.right);
}

const JAVA_TARGET: ExprTarget<JavaRenderContext> = {
  literal: renderLiteral,
  // Within the owning class the id is a direct field read; lambda-param
  // receivers (`x.id`) read the package-visible field the same way.
  // Cross-package contexts (view binds) go through the accessor.
  id: (ctx) => (ctx.accessorProps ? `${ctx.thisName}.id()` : `${ctx.thisName}.id`),
  ref: renderRef,
  member: renderMember,
  methodCall: renderMethodCall,
  call: renderCall,
  domainServiceCall(args, serviceRef) {
    // `Pricing.quote(cart, customer)` — generated static utility class.
    return `${upperFirst(serviceRef.service)}.${lowerFirst(serviceRef.op)}(${args.join(", ")})`;
  },
  lambda(param, body) {
    const p = escapeJavaIdent(param);
    if (body !== undefined) return `${p} -> ${body}`;
    return `${p} -> { /* block-body lambda — not Java-renderable */ }`;
  },
  newPart: renderNew,
  // Bare object literals only appear in e2e / walker contexts; keep total
  // with a Map literal so unexpected uses still compile.
  object: (fields) =>
    `Map.of(${fields.map((f) => `${JSON.stringify(f.name)}, ${f.value}`).join(", ")})`,
  unary: (op, operand) => `${op}${operand}`,
  binary: renderBinary,
  ternary: (cond, then, otherwise) => `${cond} ? ${then} : ${otherwise}`,
  convert: (value, e) => renderJavaConvert(e.target, e.from, value),
  match(arms, otherwise) {
    // Right-folded ternary chain, same semantics as the TS / C# leaves.
    let out = otherwise ?? "null";
    for (const arm of [...arms].reverse()) {
      out = `(${arm.cond} ? ${arm.value} : ${out})`;
    }
    return out;
  },
  // Variant-`match` (variant-match.md) — Java 21 switch expression over the
  // sealed union interface.  Each variant's domain carrier is the record
  // `${unionName}_${tag}` (java/emit/unions.ts), so a `case ${Union}_${tag} b`
  // pattern binds the narrowed record; `b.field()` reads a component.  A
  // `default` arm always trails so a non-exhaustive match (validator *warns*,
  // never errors) still compiles against the sealed type.
  matchVariant(m) {
    // A union-returning repository find reaches Java as its OPTIONAL TWIN (the
    // success entity, nullable): exactly one non-error success variant plus
    // error variant(s) that collapse to `null`.  The `<Union>_<Tag>` carrier
    // records are never emitted for a find, so a workflow `match` over such a
    // result switches on `null` vs the success type — `case null` for the
    // absent/error variant, a total type pattern for the success (no `default`,
    // which would be dominated).  A real polymorphic DU keeps the carrier form.
    const successArms = m.arms.filter((a) => !a.isError);
    const isOptionalTwin = successArms.length === 1 && m.arms.length > successArms.length;
    if (isOptionalTwin) {
      const success = successArms[0]!;
      const binder = success.binding ?? "__unused";
      const errorValue = m.arms.find((a) => a.isError)?.value ?? m.otherwise ?? "null";
      return `switch (${m.subject}) {\n      case null -> ${errorValue};\n      case ${success.variantTypeName} ${binder} -> ${success.value};\n    }`;
    }
    const arms = m.arms.map((a) => {
      const carrier = `${m.unionName}_${a.tag}`;
      // A pattern needs a binder even when the arm bound none.  NOT `_`:
      // unnamed pattern variables are preview-only on Java 21 (JEP 443;
      // finalized in 22), so a bare `_` fails the generated JDK-21 build.
      const binder = a.binding ?? "__unused";
      return `      case ${carrier} ${binder} -> ${a.value};`;
    });
    const tail = `      default -> ${m.otherwise ?? "null"};`;
    return `switch (${m.subject}) {\n${arms.join("\n")}\n${tail}\n    }`;
  },
  bindingRefText: (binding) => binding,
  // Union-find repos return a nullable aggregate (payloads.md §Union finds).
  absenceCheck: (subject) => `${subject} != null`,
  list: (elements) => `List.of(${elements.join(", ")})`,
};

export function renderJavaExpr(e: ExprIR, ctx: JavaRenderContext = DEFAULT): string {
  return renderExprWith(e, JAVA_TARGET, ctx);
}

function renderLiteral(lit: string, value: string): string {
  if (lit === "string") return JSON.stringify(value);
  if (lit === "now") return "Instant.now()";
  if (lit === "null") return "null";
  // money / decimal are BigDecimal — string-sourced construction keeps
  // the literal's precision exactly (BigDecimal("10.50") ≠ valueOf(10.5)).
  if (lit === "decimal" || lit === "money") return `new BigDecimal("${value}")`;
  if (lit === "long") return `${value}L`;
  return value;
}

function renderRef(e: RefExpr, ctx: JavaRenderContext): string {
  switch (e.refKind) {
    case "let":
    case "lambda":
      // Locals introduced inside the body; escape keyword collisions so the
      // use matches the (also-escaped) binding (`let class` → `class_`).
      return escapeJavaIdent(e.name);
    case "param":
      return e.name;
    case "this-prop":
    case "this-vo-prop":
      if (ctx.bareProps) return e.name;
      if (ctx.accessorProps) return `${ctx.thisName}.${e.name}()`;
      return `${ctx.thisName}.${e.name}`;
    case "this-derived":
      // Derived properties are methods on the Java side.
      return `${ctx.thisName}.${e.name}()`;
    case "helper-fn":
      // A bare helper reference is a value position (passed to a
      // collection op) — Java spells that as a method reference.
      return `${ctx.thisName}::${e.name}`;
    case "workflow-fn":
      // Bare reference to a workflow helper — a method reference on the
      // shared `<Ctx>Workflows` bean, scoped by workflow.
      return `${ctx.thisName}::${workflowFnCamel(e.wfScope!, e.name)}`;
    case "enum-value":
      return `${e.enumName}.${e.name}`;
    case "current-user":
      return "currentUser";
    default:
      return e.name;
  }
}

function renderMember(recv: string, e: MemberExpr): string {
  // Collections lower to `List<T>` (`.size()`); the DSL admits both
  // `.count` and `.length` on arrays.
  if (e.receiverType.kind === "array" && (e.member === "count" || e.member === "length")) {
    return `${recv}.size()`;
  }
  if (
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string" &&
    e.member === "length"
  ) {
    return `${recv}.length()`;
  }
  // Record-style accessor — every generated domain type (record or
  // class) exposes `member()` readers.
  return `${recv}.${e.member}()`;
}

// Scalar-intrinsic snippet table (src/util/intrinsics.ts) — one arm per
// catalogue row, keyed `<receiver>.<name>`.  Exported so the intrinsic
// completeness test can pin that every catalogue row has a Java arm.
export const JAVA_INTRINSIC_RENDERERS: Record<string, (recv: string, args: string[]) => string> = {
  "string.trim": (recv) => `${recv}.trim()`,
  // Locale.ROOT — the catalogue contract is culture-free case mapping
  // (the default-locale overloads diverge under e.g. tr-TR dotted-i).
  "string.toUpper": (recv) => `${recv}.toUpperCase(java.util.Locale.ROOT)`,
  "string.toLower": (recv) => `${recv}.toLowerCase(java.util.Locale.ROOT)`,
  // 0-based CLAMPING semantics (JS slice — see the catalogue contract):
  // Java's String.substring throws on out-of-range indices, so guard the
  // start and clamp the end.  Argument duplication is safe — Loom
  // expressions are pure.
  "string.substring": (recv, args) =>
    args.length > 1
      ? `(${args[0]} >= ${recv}.length() ? "" : ${recv}.substring(${args[0]}, Math.min((${args[0]}) + (${args[1]}), ${recv}.length())))`
      : `(${args[0]} >= ${recv}.length() ? "" : ${recv}.substring(${args[0]}))`,
  "string.startsWith": (recv, args) => `${recv}.startsWith(${args[0]})`,
  "string.endsWith": (recv, args) => `${recv}.endsWith(${args[0]})`,
  "string.contains": (recv, args) => `${recv}.contains(${args[0]})`,
  // Java's String.replace(CharSequence, CharSequence) already replaces ALL
  // occurrences with a LITERAL find — exactly the catalogue contract
  // (String.replaceAll would regex-interpret the pattern; wrong here).
  "string.replace": (recv, args) => `${recv}.replace(${args[0]}, ${args[1]})`,
  // Literal separator (Pattern.quote — String.split takes a regex), -1
  // keeps trailing empty segments (catalogue contract).  Fully-qualified
  // names avoid import wiring; wrapped in Arrays.asList because Loom
  // `string[]` is List<String> on Java (renderJavaType) and every
  // collection op renders the List API (.size()/.stream()/.contains()).
  "string.split": (recv, args) =>
    `java.util.Arrays.asList(${recv}.split(java.util.regex.Pattern.quote(${args[0]}), -1))`,
};

function renderMethodCall(
  recv: string,
  args: string[],
  e: MethodCallExpr,
  ctx: JavaRenderContext,
): string {
  if (e.isCollectionOp) {
    return renderCollectionOp(recv, e.member, args, e, ctx);
  }
  // In-memory membership over a reference collection (`List<XId>`):
  // plain `.contains`.  (Find-filter membership renders to JPQL via the
  // repository emitter, not through this leaf.)
  if (e.member === "contains" && e.receiverType.kind === "array" && e.args.length === 1) {
    return `${recv}.contains(${args[0]})`;
  }
  // `string.matches(pattern)` — Java's String.matches anchors the whole
  // string, but Loom's matches is find-anywhere (C# Regex.IsMatch / JS
  // RegExp.test semantics), so render through Pattern…find().
  if (isStringMatches(e)) {
    const arg0 = e.args[0];
    const field =
      arg0?.kind === "literal" && arg0.lit === "string"
        ? ctx.regexFields?.get(arg0.value)
        : undefined;
    return field
      ? `${field}.matcher(${recv}).find()`
      : `Pattern.compile(${args[0]}).matcher(${recv}).find()`;
  }
  if (e.receiverType.kind === "primitive") {
    const intrinsic = JAVA_INTRINSIC_RENDERERS[intrinsicKey(e.receiverType.name, e.member)];
    if (intrinsic) return intrinsic(recv, args);
  }
  return `${recv}.${e.member}(${args.join(", ")})`;
}

/** Element type a `sum` reduces over: the receiver's element type for a
 *  bare `sum()`, or the projected type for `sum(x -> …)`.  The lambda
 *  body's own `memberType` is NOT always populated by lowering (C#'s
 *  generic `Sum` never needed it), so a member projection over the
 *  receiver's element entity resolves the field / derived type from the
 *  aggregate IR first.  Falls back to `int` — the generated-project
 *  compile gate catches a wrong guess loudly. */
function sumElementType(e: MethodCallExpr, ctx: JavaRenderContext): TypeIR | undefined {
  if (e.args.length === 0) {
    return e.receiverType.kind === "array" ? e.receiverType.element : undefined;
  }
  const arg = e.args[0];
  if (arg?.kind !== "lambda" || !arg.body) return undefined;
  const body = arg.body;
  if (body.kind === "member") {
    // Authoritative path: the receiver collection's element entity is a
    // part of (or is) the rendering aggregate — read the projected
    // member's declared type straight off the IR.
    const elem = e.receiverType.kind === "array" ? e.receiverType.element : undefined;
    if (elem?.kind === "entity" && ctx.agg) {
      const owner =
        ctx.agg.name === elem.name ? ctx.agg : ctx.agg.parts.find((p) => p.name === elem.name);
      const declared =
        owner?.fields.find((f) => f.name === body.member)?.type ??
        owner?.derived.find((d) => d.name === body.member)?.type;
      if (declared) return declared;
    }
    return body.memberType;
  }
  if (body.kind === "binary") return body.leftType;
  if (body.kind === "convert") return { kind: "primitive", name: body.target };
  if (body.kind === "literal") {
    if (body.lit === "decimal" || body.lit === "money" || body.lit === "long" || body.lit === "int")
      return { kind: "primitive", name: body.lit };
  }
  return undefined;
}

function renderCollectionOp(
  recv: string,
  name: string,
  args: string[],
  e: MethodCallExpr,
  ctx: JavaRenderContext,
): string {
  switch (name) {
    case "count":
      return `${recv}.size()`;
    case "sum": {
      const elem = unwrapOptional(sumElementType(e, ctx));
      const stream = args.length === 1 ? `${recv}.stream().map(${args[0]})` : `${recv}.stream()`;
      if (isMoneyLike(elem)) {
        return `${stream}.reduce(BigDecimal.ZERO, BigDecimal::add)`;
      }
      if (elem?.kind === "primitive" && elem.name === "long") {
        return args.length === 1
          ? `${recv}.stream().mapToLong(${args[0]}).sum()`
          : `${recv}.stream().mapToLong(Long::longValue).sum()`;
      }
      return args.length === 1
        ? `${recv}.stream().mapToInt(${args[0]}).sum()`
        : `${recv}.stream().mapToInt(Integer::intValue).sum()`;
    }
    case "all":
      return `${recv}.stream().allMatch(${args[0] ?? "x -> true"})`;
    case "any":
      return args.length === 1 ? `${recv}.stream().anyMatch(${args[0]})` : `!${recv}.isEmpty()`;
    case "contains":
      return `${recv}.contains(${args[0] ?? "null"})`;
    case "where":
      return `${recv}.stream().filter(${args[0] ?? "x -> true"}).toList()`;
    case "first":
      return `${recv}.get(0)`;
    case "firstOrNull":
      return `${recv}.stream().findFirst().orElse(null)`;
    default:
      return `${recv}.${name}(${args.join(", ")})`;
  }
}

function renderCall(args: string[], e: CallExpr, ctx: JavaRenderContext): string {
  const argList = args.join(", ");
  switch (e.callKind) {
    case "value-object-ctor":
      return `new ${upperFirst(e.name)}(${argList})`;
    case "function":
    case "private-operation":
      return `${ctx.thisName}.${e.name}(${argList})`;
    case "workflow-fn":
      // A workflow's own helper — a `private` method on the shared
      // `<Ctx>Workflows` bean, scoped by workflow (two workflows share the class).
      return `${ctx.thisName}.${workflowFnCamel(e.wfScope!, e.name)}(${argList})`;
    case "resource-op": {
      const op = e.resourceOp!;
      const cls = ctx.resourceClasses?.get(op.resourceName);
      if (!cls) {
        throw new Error(
          `Resource operation '${op.resourceName}.${op.verb}' reached the Java renderer without a resource class mapping.`,
        );
      }
      return `${cls}.${op.resourceName}${upperFirst(op.verb)}(${argList})`;
    }
    case "domain-service": {
      // A `domainService` operation call (domain-services.md).  TIER decides the
      // call shape on Java (rev. 4, Slice 1):
      //  - PURE op → STATIC call into the generated utility class
      //    (`Pricing.quote(cart, customer)`); byte-identical to pre-rev.4.
      //  - READING op → INSTANCE call against the injected `@Service` bean field
      //    (`registration.isEmailAvailable(holder)`).  The field name is
      //    `lowerFirst(service)` — the same var the orchestrating workflow
      //    constructor-injects.  No read-port args are threaded on Java (the
      //    bean holds its own injected repositories), so the user `argList` is
      //    passed verbatim — the read handle lives on the bean, not the call.
      const ref = e.serviceRef!;
      const reading = ctx.serviceReading?.(ref.service, ref.op) ?? false;
      return reading
        ? `${lowerFirst(ref.service)}.${lowerFirst(ref.op)}(${argList})`
        : `${upperFirst(ref.service)}.${lowerFirst(ref.op)}(${argList})`;
    }
    case "repo-read": {
      // A read-only repository query in a `reading` domain-service body
      // (domain-services.md rev. 4, Slice 1).  Renders an INSTANCE call against
      // the bean's injected repository field — `accountsRepository.byHolder(holder)`
      // — mirroring how the workflow `@Service` reads repos (`getById`/named
      // finds).  `method` is the resolved repository method (the declared find,
      // or `getById`/`findAll`/`run…` for the criterion / retrieval shapes), so
      // no AST re-recognition is needed here.  A criterion / retrieval read
      // (`find`/`findAll`/`run`) renders against the synthesized `run<Retrieval>`
      // method (the same one the workflow `repo-run` uses), so the criterion
      // actually filters the query instead of dropping to the whole-table
      // `findAll`.  A single-result `find` takes the first row.
      const read = e.repoRead!;
      const field = javaRepoField(read.aggregate);
      if (read.readKind !== "named" && read.retrievalName) {
        const call = `${field}.run${upperFirst(read.retrievalName)}(${argList})`;
        return read.readKind === "find" ? `${call}.stream().findFirst().orElse(null)` : call;
      }
      return `${field}.${read.method}(${argList})`;
    }
    case "action":
    // Sibling action call (Proposal A Stage 1) — frontend-only; never lowered
    // into a backend domain expression.  Plain call keeps the switch total.
    case "store-action":
    // `<Store>.<action>()` call (Stage 5) — frontend-only; plain-call fall-through.
    case "free":
      return `${e.name}(${argList})`;
  }
}

function renderNew(
  fields: { name: string; value: string }[],
  e: NewExpr,
  ctx: JavaRenderContext,
): string {
  // Part records / classes have positional `_create` factories ordered by
  // the part's declared fields (the factory mints the part id itself and
  // takes the parent id first).  Order the rendered args by declaration,
  // filling omitted fields with null.
  const part = ctx.agg?.parts.find((p) => p.name === e.partName);
  if (!part) {
    throw new Error(
      `new ${e.partName}: part not found on the rendering aggregate (${ctx.agg?.name ?? "<none>"}) — JavaRenderContext.agg must be set where 'new <Part>' can occur.`,
    );
  }
  const byName = new Map(fields.map((f) => [f.name, f.value]));
  const ordered = part.fields.map((f) => byName.get(f.name) ?? "null");
  // Single-containment parts take the parent entity (their hidden
  // owning `_parent` @OneToOne needs the instance); collection parts
  // take the parent id.
  const isSingle = ctx.agg?.contains?.some((c) => !c.collection && c.partName === e.partName);
  const parentArg = isSingle ? ctx.thisName : `${ctx.thisName}.id`;
  return `${e.partName}._create(${[parentArg, ...ordered].join(", ")})`;
}

function renderBinary(l: string, r: string, e: BinaryExpr): string {
  const lt = unwrapOptional(e.leftType);
  // BigDecimal has no operators — arithmetic + comparisons dispatch
  // through methods.  `equals` is scale-sensitive (1.0 ≠ 1.00), so
  // equality routes through compareTo as well.
  if (isMoneyLike(lt)) {
    return renderMoneyBinary(e.op, l, r);
  }
  if (e.op === "==" || e.op === "!=") {
    if (comparesNullLiteral(e)) return `${l} ${e.op} ${r}`;
    if (needsObjectsEquals(lt, e)) {
      return e.op === "==" ? `Objects.equals(${l}, ${r})` : `!Objects.equals(${l}, ${r})`;
    }
    return `${l} ${e.op} ${r}`;
  }
  // Instant ordering goes through isBefore / isAfter.
  if (lt?.kind === "primitive" && lt.name === "datetime") {
    if (e.op === "<") return `${l}.isBefore(${r})`;
    if (e.op === ">") return `${l}.isAfter(${r})`;
    if (e.op === "<=") return `!${l}.isAfter(${r})`;
    if (e.op === ">=") return `!${l}.isBefore(${r})`;
  }
  return `${l} ${e.op} ${r}`;
}

function renderMoneyBinary(op: BinaryExpr["op"], l: string, r: string): string {
  switch (op) {
    case "+":
      return `${l}.add(${r})`;
    case "-":
      return `${l}.subtract(${r})`;
    case "*":
      return `${l}.multiply(${r})`;
    case "/":
      // DECIMAL128 mirrors C# decimal's ~28-digit precision; a bare
      // BigDecimal.divide throws on non-terminating expansions.
      return `${l}.divide(${r}, MathContext.DECIMAL128)`;
    case "==":
      return `${l}.compareTo(${r}) == 0`;
    case "!=":
      return `${l}.compareTo(${r}) != 0`;
    case "<":
      return `${l}.compareTo(${r}) < 0`;
    case "<=":
      return `${l}.compareTo(${r}) <= 0`;
    case ">":
      return `${l}.compareTo(${r}) > 0`;
    case ">=":
      return `${l}.compareTo(${r}) >= 0`;
    default:
      // &&/||/% on money — not type-correct upstream; surface verbatim.
      return `${l} ${op} ${r}`;
  }
}

/**
 * Render an explicit conversion (`string(age)`, `money(x)`, …):
 *   string(int|long|bool)   → `String.valueOf(x)`
 *   string(decimal|money)   → `x.toPlainString()`  (no scientific notation)
 *   string(datetime)        → `x.toString()`        (Instant is ISO-8601)
 *   long(int)               → `(long) x`
 *   decimal/money(int|long) → `BigDecimal.valueOf(x)`
 *   decimal(money) / money(decimal) → no-op (both are BigDecimal)
 */
function renderJavaConvert(target: string, from: string | undefined, v: string): string {
  if (target === "string") {
    if (from === "decimal" || from === "money") return `${v}.toPlainString()`;
    if (from === "datetime") return `${v}.toString()`;
    if (from === "int" || from === "long" || from === "bool") return `String.valueOf(${v})`;
    return `String.valueOf(${v})`;
  }
  if (target === "long") {
    return `(long) ${v}`;
  }
  if (target === "decimal" || target === "money") {
    if (from === "money" || from === "decimal") return v;
    return `BigDecimal.valueOf(${v})`;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Type printing
// ---------------------------------------------------------------------------

export function renderJavaType(t: TypeIR): string {
  switch (t.kind) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: inner switch on the primitive name union is exhaustive (every arm returns)
    case "primitive":
      switch (t.name) {
        case "int":
          return "int";
        case "long":
          return "long";
        case "decimal":
        case "money":
          // BigDecimal is the precise type; money differs from decimal
          // only at the JSON wire boundary (string encoding), handled
          // by the DTO emitter's Jackson config.
          return "BigDecimal";
        case "string":
          return "String";
        case "bool":
          return "boolean";
        case "datetime":
          return "Instant";
        case "guid":
          return "UUID";
        case "json":
          return "JsonNode";
      }
    case "id":
      return `${t.targetName}Id`;
    case "enum":
    case "valueobject":
    case "entity":
      return t.name;
    case "array":
      return `List<${boxedJavaType(t.element)}>`;
    case "optional":
      // Java has no `?` types — optionality is a nullable reference, so
      // primitives box (the emitter documents absence as null).
      return boxedJavaType(t.inner);
    case "action":
    case "slot":
      throw new Error("renderJavaType: 'slot' type is UI-only and should not reach the backend.");
    case "genericInstance":
      return `${upperFirst(t.ctor)}<${boxedJavaType(t.arg)}>`;
    case "union":
      return unionInstanceName(t.variants);
    case "none":
      return "Object";
  }
}

/** The boxed (reference) spelling of a type — for generic positions and
 *  nullable fields, where Java's primitives don't fit. */
export function boxedJavaType(t: TypeIR): string {
  if (t.kind === "primitive") {
    if (t.name === "int") return "Integer";
    if (t.name === "long") return "Long";
    if (t.name === "bool") return "Boolean";
  }
  if (t.kind === "optional") return boxedJavaType(t.inner);
  return renderJavaType(t);
}

/** Imports `renderJavaType` output needs, per type (the emitters merge
 *  these into the file's import header). */
export function collectJavaTypeImports(t: TypeIR, into: Set<string> = new Set()): Set<string> {
  switch (t.kind) {
    case "primitive":
      if (t.name === "decimal" || t.name === "money") into.add("java.math.BigDecimal");
      if (t.name === "datetime") into.add("java.time.Instant");
      if (t.name === "guid") into.add("java.util.UUID");
      if (t.name === "json") into.add("com.fasterxml.jackson.databind.JsonNode");
      return into;
    case "array":
      into.add("java.util.List");
      return collectJavaTypeImports(t.element, into);
    case "optional":
      return collectJavaTypeImports(t.inner, into);
    case "genericInstance":
      return collectJavaTypeImports(t.arg, into);
    default:
      return into;
  }
}

export function javaValueTypeForId(idValueType: string): string {
  switch (idValueType) {
    case "int":
      return "int";
    case "long":
      return "long";
    case "string":
      return "String";
    default:
      return "UUID";
  }
}

export function javaNewIdValue(idValueType: string): string {
  switch (idValueType) {
    case "int":
    case "long":
      return "0";
    case "string":
      return "UUID.randomUUID().toString()";
    default:
      return "UUID.randomUUID()";
  }
}
