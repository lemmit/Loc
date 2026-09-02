import { forCreateInput } from "../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  ExprIR,
  FieldIR,
  InvariantIR,
  OperationIR,
  TypeIR,
  ValueObjectIR,
} from "../../ir/types/loom-ir.js";
import {
  type ClassifyContext,
  classifyForWire,
  pickErrorPath,
  type SingleFieldPattern,
  singleFieldShape,
} from "../../ir/validate/invariant-classify.js";
import { messageCode } from "../../util/message-code.js";
import { plural, upperFirst } from "../../util/naming.js";
import { csCodePointLength } from "../_expr/code-point.js";
import { collectCsExprUsings } from "./render-expr.js";
import { isNullableWireDefault } from "./wire-default.js";

// ---------------------------------------------------------------------------
// Per-command FluentValidation `AbstractValidator<TCommand>` emission.
//
// Wire-boundary validator on the .NET side.  The Mediator
// pipeline behavior (registered once in Program.cs) resolves
// `IEnumerable<IValidator<TCommand>>` from DI and runs each before
// the matching handler executes.  Failures throw
// `FluentValidation.ValidationException` which the
// `DomainExceptionFilter` arm catches and converts to a 400 envelope
// carrying `{ error, trace_id, failures: [{ field, message }] }`.
//
// Emission mirrors the TS-side `zod-refine.ts` two-phase split:
//
//   1. Recognised single-field shapes — emitted as idiomatic
//      `RuleFor(x => x.<Field>).<Chain>(...)` calls
//      (`.GreaterThanOrEqualTo`, `.MaximumLength`, `.InclusiveBetween`,
//      `.Length(N, N)` for exact length, etc.).
//
//   2. Cross-field / non-recognised shapes — emitted as
//      `RuleFor(x => x).Must(x => <predicate>).WithName("<Field>")
//      .WithMessage("Invariant violated: ...")` so the failure
//      attaches to the most-referenced field, matching the React
//      side's `path` attribution.
//
// The classifier (`src/ir/invariant-classify.ts`) is shared with 21.A,
// so an invariant that translated to a Zod refine on the frontend
// also translates to a FluentValidation rule here — same predicate,
// same coverage decision.
// ---------------------------------------------------------------------------

interface ValidatorEmission {
  /** Rendered file content; null when no rules apply (no file is
   *  emitted in that case). */
  content: string | null;
  /** True when at least one `RuleFor` line was produced.  Drives
   *  the FluentValidation package gate in Program.cs. */
  nonEmpty: boolean;
}

/** Render the validator file for a Create<Agg>Command. */
export function renderCreateValidator(
  agg: { name: string; invariants: InvariantIR[]; fields: FieldIR[] },
  ns: string,
): ValidatorEmission {
  return renderValidatorFile({
    ns,
    aggName: agg.name,
    commandName: `Create${agg.name}Command`,
    invariants: agg.invariants,
    // Only create-input fields can be validated on the CreateRequest —
    // an invariant over an excluded field (e.g. a `managed` collection)
    // is enforced in the domain layer, not here, so it must not reference
    // an absent request property.
    available: new Set(forCreateInput(agg.fields).map((f) => f.name)),
  });
}

/** Render the validator file for an <Op>Command. */
export function renderOperationValidator(
  agg: { name: string; invariants: InvariantIR[] },
  op: OperationIR,
  ns: string,
): ValidatorEmission {
  const preconditions: InvariantIR[] = [];
  for (const s of op.statements) {
    if (s.kind === "precondition") {
      // `message` rides along: a messaged precondition must reach the
      // `.Must(...).WithMessage(text).WithErrorCode(msg.<hash>)` carrier, exactly
      // as it does on Hono (`preconditionsAsInvariants`) and Java. Dropping it
      // here silently downgraded an authored precondition message to the
      // "Invariant violated: <src>" default — and cost it its wire `code`, so a
      // .NET client could not localise a rule every other backend keyed.
      preconditions.push({ expr: s.expr, source: s.source, message: s.message });
    }
  }
  return renderValidatorFile({
    ns,
    aggName: agg.name,
    commandName: `${upperFirst(op.name)}Command`,
    // Field-level invariants (SYS-1): a mutating op's command validator gets
    // the SAME wire constraints as Create<Agg>Command, plus the op's own
    // preconditions.  `available = op.params` drops invariants over fields the
    // op doesn't take (mirrors the create-input filter), so an invalid update
    // fails FluentValidation (400 ProblemDetails) instead of the domain floor.
    invariants: [...agg.invariants, ...preconditions],
    available: new Set(op.params.map((p) => p.name)),
  });
}

/** Namespace passed by the two call sites that only ask `ruleLines.length > 0`
 *  and throw the collected `usings` away.  It never reaches emitted source —
 *  `buildFluentRules`' third argument is required so a real emitter cannot
 *  silently drop a `using`, and this names the one case where there is no
 *  namespace to give. */
const RULE_COUNT_ONLY_NS = "<rule-count-only>";

/** Build the FluentValidation `RuleFor(...)` lines (single-field chains +
 *  cross-field `.Must` carriers) for a set of invariants over `available`.
 *  Shared by the command validators (root `x` = the command) AND the
 *  value-object request validators (root `x` = the `<VO>Request`), since a VO
 *  invariant reads its own fields exactly the way an aggregate invariant reads
 *  the command's — `RuleFor(x => x.<Field>)`. */
function buildFluentRules(
  invariants: InvariantIR[],
  available: ReadonlySet<string>,
  /** Project root namespace, for the `usings` half of the return — see
   *  `RULE_COUNT_ONLY_NS` for the callers that have none. */
  ns: string,
): { ruleLines: string[]; usings: Set<string> } {
  const ctx: ClassifyContext = { available };
  const ruleLines: string[] = [];
  // Group recognised single-field patterns per field so multiple
  // invariants on the same field share one `RuleFor(x => x.F)` chain.
  const chainsByField = new Map<string, SingleFieldPattern[]>();
  const remaining: InvariantIR[] = [];
  for (const inv of invariants) {
    if (!classifyForWire(inv, ctx)) continue;
    // A messaged invariant is kept OUT of the native single-field chain (whose
    // `.MinimumLength(N)` etc. carry FluentValidation's default message) so it
    // renders through the `.Must(...).WithMessage(<text>)` carrier below.
    const single = inv.message ? null : singleFieldShape(inv);
    if (single && available.has(single.field)) {
      const list = chainsByField.get(single.field) ?? [];
      list.push(single.pattern);
      chainsByField.set(single.field, list);
    } else {
      remaining.push(inv);
    }
  }
  for (const [field, patterns] of chainsByField) {
    let line = `        RuleFor(x => x.${upperFirst(field)})`;
    for (const p of patterns) line += chainSingleFieldFluent(p);
    ruleLines.push(`${line};`);
  }
  // Tracks namespaces this validator's `.Must(x => …)` predicates
  // reach into beyond the SDK's implicit-usings set (e.g.
  // System.Text.RegularExpressions for Regex.IsMatch).  The single-
  // field shapes use FluentValidation's own `.Matches(...)` so no
  // tracking is needed for those — only the `remaining` `.Must`
  // predicates rendered below contribute.
  const usings = new Set<string>();
  for (const inv of remaining) {
    collectCsExprUsings(inv.expr, usings, ns);
    if (inv.guard) collectCsExprUsings(inv.guard, usings, ns);
    const predicate = renderFluentPredicate(inv.expr);
    const guarded = inv.guard
      ? `!(${renderFluentPredicate(inv.guard)}) || (${predicate})`
      : predicate;
    const path = pickErrorPath(inv);
    const message = csStringLiteral(
      inv.message ? inv.message.text : `Invariant violated: ${inv.source}`,
    );
    const nameClause = path ? `\n            .WithName("${upperFirst(path)}")` : "";
    // A messaged rule also carries a stable content-hash wire `code`
    // (`errors[].code`, the i18n key) via FluentValidation's `.WithErrorCode`;
    // the exception filter surfaces `ErrorCode` when it's a `msg.` code. A
    // message-less rule adds no error code (byte-identical).
    const codeClause = inv.message
      ? `\n            .WithErrorCode(${csStringLiteral(messageCode(inv.message.text))})`
      : "";
    ruleLines.push(
      `        RuleFor(x => x).Must(x => ${guarded})${nameClause}\n            .WithMessage(${message})${codeClause};`,
    );
  }
  return { ruleLines, usings };
}

function renderValidatorFile(args: {
  ns: string;
  aggName: string;
  commandName: string;
  invariants: InvariantIR[];
  available: ReadonlySet<string>;
}): ValidatorEmission {
  const { ns, aggName, commandName, invariants, available } = args;
  const { ruleLines, usings } = buildFluentRules(invariants, available, ns);

  if (ruleLines.length === 0) {
    return { content: null, nonEmpty: false };
  }

  const extraUsings = [...usings]
    .sort()
    .map((n) => `using ${n};`)
    .join("\n");
  const content = `// Auto-generated.
using FluentValidation;${extraUsings ? "\n" + extraUsings : ""}
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;

namespace ${ns}.Application.${plural(aggName)}.Commands;

public sealed class ${commandName}Validator : AbstractValidator<${commandName}>
{
    public ${commandName}Validator()
    {
${ruleLines.join("\n")}
    }
}
`;
  return { content, nonEmpty: true };
}

// ---------------------------------------------------------------------------
// Value-object request validators (VO invariant → 422 at the wire).
//
// A command carries DOMAIN value objects (`new Quantity(request.Qty.Value)`),
// constructed in the controller BEFORE the Mediator validation pipeline runs —
// so a command validator can't catch a bad VO field (the domain ctor throws
// first → 400).  Instead we validate the WIRE request DTO (`QuantityRequest`,
// no throwing ctor) up front: each VO-typed request field SetValidator-refs a
// `<VO>RequestValidator`, and the controller runs the request validator before
// mapping, so a malformed VO field is a FluentValidation 422 (errors[]) —
// matching node/python/elixir instead of the domain-floor 400.
// ---------------------------------------------------------------------------

/** Resolve a (possibly array/optional-wrapped) type to the value object it
 *  bears, plus whether the field is a collection (RuleFor vs RuleForEach). */
function voBorne(type: TypeIR): { name: string; each: boolean } | null {
  switch (type.kind) {
    case "valueobject":
      return { name: type.name, each: false };
    case "array": {
      const e = voBorne(type.element);
      return e ? { name: e.name, each: true } : null;
    }
    case "optional":
      return voBorne(type.inner);
    default:
      return null;
  }
}

/** True when a value object carries at least one wire-boundary rule (so its
 *  `<VO>RequestValidator` is emitted and SetValidator-referenced). */
export function voHasWireRules(vo: ValueObjectIR): boolean {
  return (
    buildFluentRules(vo.invariants, new Set(vo.fields.map((f) => f.name)), RULE_COUNT_ONLY_NS)
      .ruleLines.length > 0
  );
}

/** The SetValidator directives for a request's VO-typed fields whose VO carries
 *  wire rules — empty when none, which is the signal to emit no request
 *  validator (and inject no controller call). */
function voRequestFields(
  params: { name: string; type: TypeIR; default?: ExprIR }[],
  voByName: ReadonlyMap<string, ValueObjectIR>,
): { field: string; voClass: string; each: boolean; nullable: boolean }[] {
  const out: { field: string; voClass: string; each: boolean; nullable: boolean }[] = [];
  for (const p of params) {
    const borne = voBorne(p.type);
    if (!borne) continue;
    const vo = voByName.get(borne.name);
    if (!vo || !voHasWireRules(vo)) continue;
    out.push({
      field: p.name,
      voClass: `${borne.name}RequestValidator`,
      each: borne.each,
      // A VO-typed field carrying a VO default is emitted NULLABLE on the
      // request record (`wire-default.ts`), and `IValidator<T>` is not
      // `IValidator<T?>` — CS8620.  The rule has to narrow and skip.
      nullable: isNullableWireDefault(p.default),
    });
  }
  return out;
}

/** The create-input + operation params of an aggregate, as `{name, type}`
 *  probes for VO detection.  Mirrors the command/validator param derivation. */
function requestParamSets(
  agg: AggregateIR,
): { name: string; params: { name: string; type: TypeIR; default?: ExprIR }[] }[] {
  const sets: { name: string; params: { name: string; type: TypeIR; default?: ExprIR }[] }[] = [];
  if (agg.persistedAs !== "eventLog") {
    sets.push({
      name: `Create${agg.name}Request`,
      params: forCreateInput(agg.fields).map((f) => ({
        name: f.name,
        type: f.type,
        default: f.default,
      })),
    });
  }
  for (const op of agg.operations) {
    if (op.visibility !== "public" || op.params.length === 0) continue;
    sets.push({
      name: `${upperFirst(op.name)}${agg.name}Request`,
      params: op.params.map((p) => ({ name: p.name, type: p.type })),
    });
  }
  return sets;
}

/** The name of the request validator to run in the controller for a given
 *  request, or null when the request has no VO field carrying wire rules. */
export function requestVoValidatorName(
  requestName: string,
  params: { name: string; type: TypeIR }[],
  vos: readonly ValueObjectIR[],
): string | null {
  const voByName = new Map(vos.map((v) => [v.name, v]));
  return voRequestFields(params, voByName).length > 0 ? `${requestName}Validator` : null;
}

/** Every value-object + request validator class for an aggregate, as one
 *  `<Agg>RequestValidators.cs` file — or null when nothing needs validating. */
export function renderRequestValidators(
  agg: AggregateIR,
  vos: readonly ValueObjectIR[],
  ns: string,
): string | null {
  const voByName = new Map(vos.map((v) => [v.name, v]));
  const classes: string[] = [];

  // 1) A `<VO>RequestValidator` for every VO (used by this agg) carrying rules.
  const emittedVo = new Set<string>();
  for (const set of requestParamSets(agg)) {
    for (const f of voRequestFields(set.params, voByName)) {
      const voName = f.voClass.slice(0, -"RequestValidator".length);
      if (emittedVo.has(voName)) continue;
      emittedVo.add(voName);
      const vo = voByName.get(voName);
      if (!vo) continue;
      const { ruleLines } = buildFluentRules(
        vo.invariants,
        new Set(vo.fields.map((x) => x.name)),
        ns,
      );
      classes.push(
        `public sealed class ${voName}RequestValidator : AbstractValidator<${voName}Request>\n` +
          `{\n    public ${voName}RequestValidator()\n    {\n${ruleLines.join("\n")}\n    }\n}`,
      );
    }
  }

  // 2) A `<Request>Validator` per request that SetValidator-refs its VO fields.
  for (const set of requestParamSets(agg)) {
    const fields = voRequestFields(set.params, voByName);
    if (fields.length === 0) continue;
    const rules = fields.map((f) => {
      const prop = upperFirst(f.field);
      if (f.each) return `        RuleForEach(x => x.${prop}).SetValidator(new ${f.voClass}());`;
      // A nullable VO field narrows (`x.<P>!`) and guards (`.When(… is not
      // null)`): the request omitted it, so the controller's coalesce supplies
      // the declared default — a value the author wrote, not client input, and
      // therefore not the validator's business.
      if (f.nullable) {
        return (
          `        RuleFor(x => x.${prop}!).SetValidator(new ${f.voClass}())` +
          `.When(x => x.${prop} is not null);`
        );
      }
      return `        RuleFor(x => x.${prop}).SetValidator(new ${f.voClass}());`;
    });
    classes.push(
      `public sealed class ${set.name}Validator : AbstractValidator<${set.name}>\n` +
        `{\n    public ${set.name}Validator()\n    {\n${rules.join("\n")}\n    }\n}`,
    );
  }

  if (classes.length === 0) return null;
  return `// Auto-generated.
using FluentValidation;

namespace ${ns}.Application.${plural(agg.name)}.Requests;

${classes.join("\n\n")}
`;
}

// ---------------------------------------------------------------------------
// Single-field pattern → idiomatic FluentValidation chain.
// ---------------------------------------------------------------------------

/** One code-point length rule: the `.Must` predicate plus a message in
 *  FluentValidation's own voice (a bare `.Must` would otherwise degrade every
 *  message-less length rule to "The specified condition was not met"). */
function lengthMust(check: string, phrase: string): string {
  return `.Must(v => v == null || ${check})\n            .WithMessage("'{PropertyName}' must be ${phrase}.")`;
}

function chainSingleFieldFluent(p: SingleFieldPattern): string {
  switch (p.kind) {
    case "min":
      // Exclusive bounds only arise on decimal/money fields (a strict `>` on a
      // non-integer field), so the property being ruled is a C# `decimal` —
      // suffix the literal with `m` so `.GreaterThan(0.5m)` type-checks (a bare
      // `0.5` is a `double` with no implicit decimal conversion).
      return p.exclusive ? `.GreaterThan(${p.n}m)` : `.GreaterThanOrEqualTo(${p.n})`;
    case "max":
      return p.exclusive ? `.LessThan(${p.n}m)` : `.LessThanOrEqualTo(${p.n})`;
    case "between":
      return `.InclusiveBetween(${p.lo}, ${p.hi})`;
    // FluentValidation's `.MinimumLength`/`.MaximumLength`/`.Length` count
    // `string.Length` — UTF-16 code units — while the constraint they came
    // from is defined in CODE POINTS (src/generator/_expr/code-point.ts), and
    // so is the `minLength`/`maxLength` the emitted OpenAPI publishes for the
    // same field.  `.Must` over the code-point count is the exact rendering;
    // `v == null ||` reproduces FluentValidation's own null-skip (its length
    // validators all return true for a null value) and keeps the lambda
    // null-safe on an optional (`string?`) property.
    case "len-min":
      return lengthMust(`${csCodePointLength("v")} >= ${p.n}`, `at least ${p.n} characters`);
    case "len-max":
      return lengthMust(`${csCodePointLength("v")} <= ${p.n}`, `at most ${p.n} characters`);
    case "len-eq":
      return lengthMust(`${csCodePointLength("v")} == ${p.n}`, `exactly ${p.n} characters`);
    case "len-range":
      return lengthMust(
        `${csCodePointLength("v")} >= ${p.lo} && ${csCodePointLength("v")} <= ${p.hi}`,
        `between ${p.lo} and ${p.hi} characters`,
      );
    case "regex":
      // FluentValidation's `.Matches` accepts a string regex; we
      // pass the literal verbatim (already validated as a valid
      // .NET-compatible regex at parse time).
      return `.Matches(${csStringLiteral(p.pattern)})`;
  }
}

// ---------------------------------------------------------------------------
// FluentValidation `Must` predicate body renderer.
//
// Walks ExprIR producing a C# expression that runs against the
// command record's strongly-typed properties via the lambda parameter
// `x`.  Refs to request-body fields (`this-prop`, `this-vo-prop`,
// `param`) all become `x.<PascalCase>` access — the command record
// PascalCases every parameter.  Doesn't reuse `renderCsExpr`
// because that renderer keeps `param` refs as bare names (correct
// for in-domain operation bodies, wrong for command properties).
// ---------------------------------------------------------------------------

function renderFluentPredicate(e: ExprIR): string {
  switch (e.kind) {
    case "literal":
      return renderLit(e.lit, e.value);
    case "ref":
      return renderRef(e);
    case "member":
      return renderMember(e);
    case "method-call":
      return renderMethodCall(e);
    case "paren":
      return `(${renderFluentPredicate(e.inner)})`;
    case "unary":
      return `${e.op}${renderFluentPredicate(e.operand)}`;
    case "binary":
      return `${renderFluentPredicate(e.left)} ${e.op} ${renderFluentPredicate(e.right)}`;
    case "ternary":
      return `${renderFluentPredicate(e.cond)} ? ${renderFluentPredicate(e.then)} : ${renderFluentPredicate(e.otherwise)}`;
    case "lambda":
      // Lambda body is now optional.  Wire-boundary refines
      // never see block-body lambdas (`classifyForWire` only admits
      // single-expression predicates), so falling back to the
      // unrenderable placeholder is correct.
      if (e.body) return `${e.param} => ${renderFluentPredicate(e.body)}`;
      return `false /* UNRENDERABLE:lambda-block */`;
    case "object":
      return `new { ${e.fields.map((f) => `${upperFirst(f.name)} = ${renderFluentPredicate(f.value)}`).join(", ")} }`;
    case "i18nFormat":
      // Transparent i18n wrapper — render the wrapped predicate operand.
      return renderFluentPredicate(e.inner);
    case "this":
    case "id":
    case "call":
    case "new":
    case "convert":
    case "duration":
    case "match":
    case "list":
    case "action-ref":
    case "authz-filter":
      // `classifyForWire` excludes these — reaching the renderer is a
      // bug upstream.  Emit a syntactically-valid placeholder so a
      // failing build is louder than a silently-wrong rule.  (An
      // `authz-filter` sentinel is a query-filter node, never a
      // wire-boundary invariant.)
      return `false /* UNRENDERABLE:${e.kind} */`;
  }
}

type Lit = ExprIR & { kind: "literal" };

function renderLit(lit: Lit["lit"], value: string): string {
  if (lit === "string") return csStringLiteral(value);
  if (lit === "now") return "DateTime.UtcNow";
  if (lit === "null") return "null";
  if (lit === "decimal") return `${value}m`;
  if (lit === "long") return `${value}L`;
  if (lit === "money") return `${value}m`;
  return value;
}

function renderRef(e: Extract<ExprIR, { kind: "ref" }>): string {
  switch (e.refKind) {
    case "param":
    case "this-prop":
    case "this-vo-prop":
      return `x.${upperFirst(e.name)}`;
    case "let":
    case "lambda":
      return e.name;
    case "enum-value":
      return `${e.enumName}.${e.name}`;
    default:
      return `false /* UNRENDERABLE-REF:${e.refKind} */`;
  }
}

function renderMember(e: Extract<ExprIR, { kind: "member" }>): string {
  const recv = renderFluentPredicate(e.receiver);
  if (e.receiverType.kind === "array" && e.member === "count") {
    return `${recv}.Count`;
  }
  if (
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string" &&
    e.member === "length"
  ) {
    // CODE POINTS, not `string.Length`'s UTF-16 code units — see
    // src/generator/_expr/code-point.ts.
    return csCodePointLength(recv);
  }
  return `${recv}.${upperFirst(e.member)}`;
}

function renderMethodCall(e: Extract<ExprIR, { kind: "method-call" }>): string {
  const recv = renderFluentPredicate(e.receiver);
  const args = e.args.map((a) => renderFluentPredicate(a));
  // `string.matches(literal)` — when it falls through to a
  // `.Must(x => ...)` predicate (e.g. inside a cross-field rule),
  // render as the same Regex.IsMatch call the domain layer uses.  The
  // System.Text.RegularExpressions using is declared via
  // collectCsExprUsings on the emitter side.
  if (
    e.member === "matches" &&
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string" &&
    args.length === 1
  ) {
    return `Regex.IsMatch(${recv}, ${args[0]})`;
  }
  if (e.isCollectionOp) {
    switch (e.member) {
      case "count":
        return `(${recv}).Count()`;
      case "all":
        return `(${recv}).All(${args[0] ?? "_ => true"})`;
      case "any":
        return `(${recv}).Any(${args[0] ?? "_ => true"})`;
      case "contains":
        return `(${recv}).Contains(${args[0] ?? "default!"})`;
      case "where":
        return `(${recv}).Where(${args[0] ?? "_ => true"}).ToList()`;
      case "first":
        return `(${recv}).First()`;
      case "firstOrNull":
        return `(${recv}).FirstOrDefault()`;
      default:
        return `(${recv}).${upperFirst(e.member)}(${args.join(", ")})`;
    }
  }
  return `${recv}.${upperFirst(e.member)}(${args.join(", ")})`;
}

function csStringLiteral(s: string): string {
  // C# string-literal escape: backslash + double-quote.  Same shape
  // JSON.stringify produces; we go through it for safety.
  return JSON.stringify(s);
}

// ---------------------------------------------------------------------------
// Pipeline behavior + Program.cs registration helpers
// ---------------------------------------------------------------------------

/** True when the aggregate produces at least one wire-translatable
 *  invariant or precondition — drives the FluentValidation +
 *  pipeline-behavior + csproj-package gate in `index.ts` so projects
 *  with no rules don't carry an unused dependency. */
export function hasAnyWireValidator(
  agg: AggregateIR,
  /** The context's value objects — a VO-typed request field carrying its own
   *  invariant now emits a wire request validator (VO→422), which also needs
   *  the FluentValidation package + the DomainExceptionFilter's 422 arm.  So a
   *  VO-only aggregate must count as "has a wire validator" too.  Defaults to
   *  none for callers that predate the VO path (behaviour-preserving). */
  vos: readonly ValueObjectIR[] = [],
): boolean {
  // Cheap re-render under a sentinel namespace — `nonEmpty` is a
  // pure function of the IR, so the work is bounded by the actual
  // rule set.
  const fakeNs = "_";
  if (renderCreateValidator(agg, fakeNs).nonEmpty) return true;
  for (const op of agg.operations) {
    if (op.visibility !== "public") continue;
    if (renderOperationValidator(agg, op, fakeNs).nonEmpty) return true;
  }
  return renderRequestValidators(agg, vos, fakeNs) != null;
}

/** Renders the generic Mediator pipeline behavior class.  One copy
 *  emitted per project under `Application/Common/ValidationBehavior.cs`. */
export function renderValidationBehavior(ns: string): string {
  return `// Auto-generated.
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using FluentValidation;
using Mediator;

namespace ${ns}.Application.Common;

/// <summary>
/// Mediator pipeline behavior that runs every <see cref="IValidator{TRequest}"/>
/// registered in DI before the handler executes.  On any failure the
/// aggregated <see cref="ValidationException"/> bubbles up to
/// <c>DomainExceptionFilter</c>, which converts it to a 400 envelope
/// carrying <c>{ error, trace_id, failures }</c>.
/// </summary>
public sealed class ValidationBehavior<TRequest, TResponse>
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull, IMessage
{
    private readonly IEnumerable<IValidator<TRequest>> _validators;

    public ValidationBehavior(IEnumerable<IValidator<TRequest>> validators)
    {
        _validators = validators;
    }

    public async ValueTask<TResponse> Handle(
        TRequest message,
        MessageHandlerDelegate<TRequest, TResponse> next,
        CancellationToken cancellationToken)
    {
        if (_validators.Any())
        {
            // A fresh ValidationContext per validator: FluentValidation's
            // context is not thread-safe, and the validators run concurrently
            // via Task.WhenAll — sharing one would be a data race.
            var results = await Task.WhenAll(
                _validators.Select(v => v.ValidateAsync(new ValidationContext<TRequest>(message), cancellationToken)));
            var failures = results
                .SelectMany(r => r.Errors)
                .Where(f => f != null)
                .ToList();
            if (failures.Count > 0) throw new ValidationException(failures);
        }
        return await next(message, cancellationToken);
    }
}
`;
}
