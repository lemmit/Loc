import { forCreateInput } from "../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  ExprIR,
  FieldIR,
  InvariantIR,
  OperationIR,
} from "../../ir/types/loom-ir.js";
import {
  type ClassifyContext,
  classifyForWire,
  pickErrorPath,
  type SingleFieldPattern,
  singleFieldShape,
} from "../../ir/validate/invariant-classify.js";
import { plural, upperFirst } from "../../util/naming.js";
import { collectCsExprUsings } from "./render-expr.js";

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
  agg: { name: string },
  op: OperationIR,
  ns: string,
): ValidatorEmission {
  const preconditions: InvariantIR[] = [];
  for (const s of op.statements) {
    if (s.kind === "precondition") {
      preconditions.push({ expr: s.expr, source: s.source });
    }
  }
  return renderValidatorFile({
    ns,
    aggName: agg.name,
    commandName: `${upperFirst(op.name)}Command`,
    invariants: preconditions,
    available: new Set(op.params.map((p) => p.name)),
  });
}

function renderValidatorFile(args: {
  ns: string;
  aggName: string;
  commandName: string;
  invariants: InvariantIR[];
  available: ReadonlySet<string>;
}): ValidatorEmission {
  const { ns, aggName, commandName, invariants, available } = args;
  const ctx: ClassifyContext = { available };
  const ruleLines: string[] = [];

  // Group recognised single-field patterns per field so multiple
  // invariants on the same field share one `RuleFor(x => x.F)` chain.
  const chainsByField = new Map<string, SingleFieldPattern[]>();
  const remaining: InvariantIR[] = [];
  for (const inv of invariants) {
    if (!classifyForWire(inv, ctx)) continue;
    const single = singleFieldShape(inv);
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
    collectCsExprUsings(inv.expr, usings);
    if (inv.guard) collectCsExprUsings(inv.guard, usings);
    const predicate = renderFluentPredicate(inv.expr);
    const guarded = inv.guard
      ? `!(${renderFluentPredicate(inv.guard)}) || (${predicate})`
      : predicate;
    const path = pickErrorPath(inv);
    const message = csStringLiteral(`Invariant violated: ${inv.source}`);
    const nameClause = path ? `\n            .WithName("${upperFirst(path)}")` : "";
    ruleLines.push(
      `        RuleFor(x => x).Must(x => ${guarded})${nameClause}\n            .WithMessage(${message});`,
    );
  }

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
// Single-field pattern → idiomatic FluentValidation chain.
// ---------------------------------------------------------------------------

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
    case "len-min":
      return `.MinimumLength(${p.n})`;
    case "len-max":
      return `.MaximumLength(${p.n})`;
    case "len-eq":
      return `.Length(${p.n}, ${p.n})`;
    case "len-range":
      return `.Length(${p.lo}, ${p.hi})`;
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
    case "this":
    case "id":
    case "call":
    case "new":
    case "convert":
    case "duration":
    case "match":
    case "list":
    case "action-ref":
      // `classifyForWire` excludes these — reaching the renderer is a
      // bug upstream.  Emit a syntactically-valid placeholder so a
      // failing build is louder than a silently-wrong rule.
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
    return `${recv}.Length`;
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
export function hasAnyWireValidator(agg: AggregateIR): boolean {
  // Cheap re-render under a sentinel namespace — `nonEmpty` is a
  // pure function of the IR, so the work is bounded by the actual
  // rule set.
  const fakeNs = "_";
  if (renderCreateValidator(agg, fakeNs).nonEmpty) return true;
  for (const op of agg.operations) {
    if (op.visibility !== "public") continue;
    if (renderOperationValidator(agg, op, fakeNs).nonEmpty) return true;
  }
  return false;
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
        CancellationToken cancellationToken,
        MessageHandlerDelegate<TRequest, TResponse> next)
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
