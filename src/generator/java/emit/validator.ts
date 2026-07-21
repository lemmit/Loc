import { emitsRestCreate, forCreateInput } from "../../../ir/enrich/wire-projection.js";
import type { EnrichedAggregateIR, InvariantIR, TypeIR } from "../../../ir/types/loom-ir.js";
import {
  type ClassifyContext,
  classifyForWire,
  pickErrorPath,
  type SingleFieldPattern,
  singleFieldShape,
} from "../../../ir/validate/invariant-classify.js";
import { lines } from "../../../util/code-builder.js";
import { messageCode } from "../../../util/message-code.js";
import { upperFirst } from "../../../util/naming.js";
import {
  collectJavaExprImports,
  collectJavaRegexLiterals,
  renderJavaExpr,
} from "../render-expr.js";
import { collectWireToDomainImports, wireToDomain } from "./wire.js";

// ---------------------------------------------------------------------------
// Wire-boundary validators — ONE Spring `Validator` per command shape
// (`Create<Agg>Request`, `<Op><Agg>Request`), the .NET FluentValidation analog.
//
// FluentValidation is a PROGRAMMATIC, unified validator: a single
// `AbstractValidator<TCommand>` holds every rule — the single-field
// constraints AND the cross-field `.Must(...)` predicates — run at one seam (the
// Mediator pipeline behavior, before the handler).  The idiomatic Spring mirror
// is Spring's own `org.springframework.validation.Validator` SPI: one validator
// per command, all rules imperative via `errors.rejectValue(field, code, msg)`,
// registered on the controller's `WebDataBinder` (`@InitBinder`) and triggered
// by `@Valid @RequestBody` — surfaced as MethodArgumentNotValidException, mapped
// to the cross-backend 422 `{pointer,message,code?}` envelope by ApiExceptionAdvice.
//
// Rule selection reuses the SHARED classifier
// (`src/ir/validate/invariant-classify.ts`): an invariant that became a
// FluentValidation rule on .NET / a Zod refine on Hono becomes the same check
// here — same predicate, same coverage decision.
//
// The validator runs over the request DTO (WIRE types: money / datetime as
// `String`, ids as their value type), so referenced scalar fields are parsed to
// their domain value first (`wireToDomain`: `new BigDecimal(...)` /
// `Instant.parse(...)` / `new XId(...)`) exactly as the service does; value-
// object fields keep their wire record (nested accessors work directly), which
// is why they are never re-parsed here.
// ---------------------------------------------------------------------------

/** A messaged rule's error code is its content-hash i18n key (`msg.<hash>`); a
 *  message-less rule uses this sentinel so `rejectValue`'s (non-null) errorCode
 *  contract holds without surfacing a `code` in the 422 envelope — the advice
 *  emits `code` only when it starts with `msg.`. */
const NO_WIRE_CODE = "loom.invariant";

export interface JavaCommandValidator {
  /** e.g. `CreateOrderValidator` — the Spring `Validator` class. */
  className: string;
  /** the `@RequestBody` DTO it validates, e.g. `CreateOrderRequest`. */
  requestType: string;
  content: string;
}

interface CommandSpec {
  className: string;
  requestType: string;
  params: { name: string; type: TypeIR; optional?: boolean }[];
  invariants: InvariantIR[];
  available: ReadonlySet<string>;
}

function eff(t: TypeIR, optional: boolean): TypeIR {
  return optional && t.kind !== "optional" ? { kind: "optional", inner: t } : t;
}

function commandSpecs(agg: EnrichedAggregateIR): CommandSpec[] {
  const specs: CommandSpec[] = [];
  const createInputs = forCreateInput(agg.fields);
  // A create validator exists only when there's a field-derived Create<Agg>Request
  // to validate.  Skip when there's no REST create at all, and for event-sourced
  // aggregates (whose create request is keyed by the `create` action's params,
  // not the field set — the old service-floor create validator was skipped there
  // too, `!ctx.esCreateParams`).
  if (emitsRestCreate(agg) && agg.persistedAs !== "eventLog") {
    specs.push({
      className: `Create${agg.name}Validator`,
      requestType: `Create${agg.name}Request`,
      params: createInputs.map((f) => ({ name: f.name, type: f.type, optional: f.optional })),
      invariants: agg.invariants,
      available: new Set(createInputs.map((f) => f.name)),
    });
  }
  for (const op of agg.operations) {
    // A paramless op has no request body → nothing rides `@Valid`; its
    // preconditions (over aggregate state, not wire input) stay on the domain
    // floor, exactly as before (they never classified for the wire).
    if (op.params.length === 0) continue;
    const preconditions: InvariantIR[] = [];
    for (const s of op.statements) {
      if (s.kind === "precondition")
        preconditions.push({ expr: s.expr, source: s.source, message: s.message });
    }
    specs.push({
      className: `${upperFirst(op.name)}${agg.name}Validator`,
      requestType: `${upperFirst(op.name)}${agg.name}Request`,
      params: op.params.map((p) => ({ name: p.name, type: p.type })),
      // Field-level invariants (SYS-1): a mutating op's validator gets the SAME
      // wire constraints as create, plus its own preconditions; `available =
      // op.params` drops invariants over fields the op doesn't take.
      invariants: [...agg.invariants, ...preconditions],
      available: new Set(op.params.map((p) => p.name)),
    });
  }
  return specs;
}

export function renderJavaCommandValidators(
  agg: EnrichedAggregateIR,
  pkg: string,
  basePkg: string,
): JavaCommandValidator[] {
  const out: JavaCommandValidator[] = [];
  for (const spec of commandSpecs(agg)) {
    const content = renderValidatorClass(spec, pkg, basePkg);
    if (content) out.push({ className: spec.className, requestType: spec.requestType, content });
  }
  return out;
}

/** The (className, requestType) of every command validator actually emitted for
 *  the aggregate — the controller uses these to register them on its
 *  `WebDataBinder` (`@InitBinder`).  A cheap re-derivation (validators are tiny),
 *  mirroring the old `opHasWireValidator` render-and-check. */
export function javaCommandValidatorNames(
  agg: EnrichedAggregateIR,
): { className: string; requestType: string }[] {
  return renderJavaCommandValidators(agg, "_", "_").map(({ className, requestType }) => ({
    className,
    requestType,
  }));
}

function renderValidatorClass(spec: CommandSpec, pkg: string, basePkg: string): string | null {
  const imports = new Set<string>();
  const regexFields = new Map<string, string>();
  const checks = buildChecks(spec, imports, regexFields);
  if (checks.length === 0) return null;

  // Parse-locals only for fields the checks actually reference (bare names),
  // mirroring the service's wire→domain parse so predicates run over the domain
  // value (a money field becomes a `BigDecimal` local, etc.).
  const referenced = spec.params.filter((p) =>
    new RegExp(`\\b${p.name}\\b`).test(checks.join("\n")),
  );
  const lets = referenced.map((p) => {
    collectWireToDomainImports(eff(p.type, !!p.optional), imports);
    return `        var ${p.name} = ${validatorLocal(eff(p.type, !!p.optional), `request.${p.name}()`)};`;
  });

  const patternFields = [...regexFields].map(
    ([pat, name]) =>
      `    private static final Pattern ${name} = Pattern.compile(${JSON.stringify(pat)});`,
  );
  if (patternFields.length > 0) imports.add("java.util.regex.Pattern");

  return lines(
    `package ${pkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    imports.size > 0 ? `` : null,
    `import org.springframework.validation.Errors;`,
    `import org.springframework.validation.Validator;`,
    ``,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    ``,
    `/** Wire-boundary validator (422) — one Spring Validator holding every rule`,
    ` *  (single-field + cross-field) for this command, run at the \`@Valid\` seam.`,
    ` *  The .NET FluentValidation analog: one AbstractValidator, one seam. */`,
    `public final class ${spec.className} implements Validator {`,
    ...(patternFields.length > 0 ? [...patternFields, ``] : []),
    `    @Override`,
    `    public boolean supports(Class<?> clazz) {`,
    `        return ${spec.requestType}.class.equals(clazz);`,
    `    }`,
    ``,
    `    @Override`,
    `    public void validate(Object target, Errors errors) {`,
    `        var request = (${spec.requestType}) target;`,
    ...lets,
    ...checks,
    `    }`,
    `}`,
    ``,
  );
}

/** The parse expression for a referenced field's local.  Scalars/ids parse to
 *  their domain value (`wireToDomain`); a value-object-bearing field keeps its
 *  wire record (its `to<VO>` parser is service-private, and nested accessors
 *  read the same shape) so member predicates resolve without it. */
function validatorLocal(type: TypeIR, expr: string): string {
  return bearsValueObject(type) ? expr : wireToDomain(type, expr);
}

function bearsValueObject(type: TypeIR): boolean {
  switch (type.kind) {
    case "valueobject":
      return true;
    case "array":
      return bearsValueObject(type.element);
    case "optional":
      return bearsValueObject(type.inner);
    default:
      return false;
  }
}

/** The `if (!(predicate)) errors.rejectValue(...)` lines for one command's
 *  classified invariants — single-field shapes via `patternCheck`, everything
 *  else via a rendered generic predicate. */
function buildChecks(
  spec: CommandSpec,
  imports: Set<string>,
  regexFields: Map<string, string>,
): string[] {
  const ctx: ClassifyContext = { available: spec.available };
  const checks: string[] = [];
  const typeOf = (field: string): TypeIR | undefined =>
    spec.params.find((p) => p.name === field)?.type;

  for (const inv of spec.invariants) {
    if (!classifyForWire(inv, ctx)) continue;
    const message = inv.message ? inv.message.text : `Invariant violated: ${inv.source}`;
    const code = inv.message ? messageCode(inv.message.text) : NO_WIRE_CODE;
    const single = singleFieldShape(inv);
    if (single && spec.available.has(single.field)) {
      checks.push(
        ...patternCheck(
          single.field,
          single.pattern,
          typeOf(single.field),
          message,
          code,
          regexFields,
        ),
      );
      continue;
    }
    // Generic predicate over the command values — the .NET `.Must(...)` arm.
    // `bareProps` renders `this.x` refs as the parsed local names declared above.
    const path = pickErrorPath(inv) ?? spec.params[0]?.name ?? "";
    collectJavaExprImports(inv.expr, imports);
    for (const p of collectJavaRegexLiterals(inv.expr)) {
      if (!regexFields.has(p)) regexFields.set(p, `MATCHES_PATTERN_${regexFields.size}`);
    }
    const predicate = renderJavaExpr(inv.expr, { thisName: "this", bareProps: true, regexFields });
    checks.push(reject(path, code, message, predicate));
  }
  return checks;
}

/** `if (!(cond)) errors.rejectValue("field", "code", "message");` — the Spring
 *  `Errors` analog of FluentValidation's `.WithName(...).WithMessage(...)
 *  .WithErrorCode(...)`.  `field` is the property path (no leading slash; the
 *  advice re-prefixes `/`), `code` the wire code (or the message-less sentinel),
 *  `message` the resolved default text. */
function reject(field: string, code: string, message: string, cond: string): string {
  return `        if (!(${cond})) errors.rejectValue(${JSON.stringify(field)}, ${JSON.stringify(code)}, ${JSON.stringify(message)});`;
}

function patternCheck(
  field: string,
  pattern: SingleFieldPattern,
  type: TypeIR | undefined,
  message: string,
  code: string,
  regexFields: Map<string, string>,
): string[] {
  const moneyLike =
    type?.kind === "primitive" && (type.name === "money" || type.name === "decimal");
  const cmp = (op: string, n: number): string =>
    moneyLike
      ? `${field}.compareTo(new java.math.BigDecimal("${n}")) ${op} 0`
      : `${field} ${op} ${n}`;
  const fail = (cond: string): string => reject(field, code, message, cond);
  switch (pattern.kind) {
    case "min":
      // Exclusive (`weight > 0.5` on a decimal/money field) → strict `>`; the
      // `cmp` helper routes decimal/money through `BigDecimal.compareTo`.
      return [fail(cmp(pattern.exclusive ? ">" : ">=", pattern.n))];
    case "max":
      return [fail(cmp(pattern.exclusive ? "<" : "<=", pattern.n))];
    case "between":
      return [fail(`${cmp(">=", pattern.lo)} && ${cmp("<=", pattern.hi)}`)];
    case "len-min":
      return [fail(`${field}.length() >= ${pattern.n}`)];
    case "len-max":
      return [fail(`${field}.length() <= ${pattern.n}`)];
    case "len-eq":
      return [fail(`${field}.length() == ${pattern.n}`)];
    case "len-range":
      return [fail(`${field}.length() >= ${pattern.lo} && ${field}.length() <= ${pattern.hi}`)];
    case "regex": {
      let name = regexFields.get(pattern.pattern);
      if (!name) {
        name = `MATCHES_PATTERN_${regexFields.size}`;
        regexFields.set(pattern.pattern, name);
      }
      return [fail(`${name}.matcher(${field}).find()`)];
    }
  }
}
