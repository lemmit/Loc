import { forCreateInput } from "../../../ir/enrich/wire-projection.js";
import type { EnrichedAggregateIR, InvariantIR, TypeIR } from "../../../ir/types/loom-ir.js";
import {
  type ClassifyContext,
  classifyForWire,
  pickErrorPath,
  type SingleFieldPattern,
  singleFieldShape,
} from "../../../ir/validate/invariant-classify.js";
import { lines } from "../../../util/code-builder.js";
import {
  collectJavaExprImports,
  collectJavaRegexLiterals,
  collectJavaTypeImports,
  renderJavaExpr,
  renderJavaType,
} from "../render-expr.js";

// ---------------------------------------------------------------------------
// Wire-boundary validators — the FluentValidation / zod-refine analog.
// One static `<Agg>Validators` class with a method per command shape
// (`create(...)`, `<op>(...)`) over TYPED values (post-parse, like the
// .NET command records).  Failures collect `{ pointer, message }` pairs
// and throw WireValidationException, which the controller advice maps to
// the cross-backend 422 problem envelope with the `errors[]` extension.
//
// Rule selection reuses the SHARED classifier
// (`src/ir/validate/invariant-classify.ts`): an invariant that became a
// FluentValidation rule on .NET / a Zod refine on Hono becomes the same
// check here — same predicate, same coverage decision.
// ---------------------------------------------------------------------------

interface MethodSpec {
  methodName: string;
  params: { name: string; type: TypeIR }[];
  invariants: InvariantIR[];
  available: ReadonlySet<string>;
}

export function renderJavaValidators(
  agg: EnrichedAggregateIR,
  pkg: string,
  basePkg: string,
): string | null {
  const specs: MethodSpec[] = [];
  const createInputs = forCreateInput(agg.fields);
  specs.push({
    methodName: "create",
    params: createInputs.map((f) => ({
      name: f.name,
      type: f.optional && f.type.kind !== "optional" ? { kind: "optional", inner: f.type } : f.type,
    })),
    invariants: agg.invariants,
    available: new Set(createInputs.map((f) => f.name)),
  });
  for (const op of agg.operations) {
    const preconditions: InvariantIR[] = [];
    for (const s of op.statements) {
      if (s.kind === "precondition")
        preconditions.push({ expr: s.expr, source: s.source, message: s.message });
    }
    specs.push({
      methodName: op.name,
      params: op.params,
      // Field-level invariants (SYS-1): the op's request validator gets the
      // SAME wire constraints as create, plus its own preconditions.  The
      // `available = op.params` set drops any invariant over a field this op
      // doesn't take (mirrors the create-input filter), so an invalid update
      // is rejected at the wire boundary instead of reaching the domain floor.
      invariants: [...agg.invariants, ...preconditions],
      available: new Set(op.params.map((p) => p.name)),
    });
  }

  const imports = new Set<string>(["java.util.ArrayList", "java.util.List"]);
  // Hoist each distinct single-field regex into a `private static final Pattern`
  // field (reused across calls) instead of recompiling on every validation.
  const regexFields = new Map<string, string>();
  const methods: string[] = [];
  for (const spec of specs) {
    const body = methodBody(spec, imports, regexFields);
    if (body === null) continue;
    const params = spec.params
      .map((p) => {
        collectJavaTypeImports(p.type, imports);
        return `${renderJavaType(p.type)} ${p.name}`;
      })
      .join(", ");
    methods.push(`    public static void ${spec.methodName}(${params}) {`, ...body, `    }`, ``);
  }
  if (methods.length === 0) return null;
  while (methods[methods.length - 1] === "") methods.pop();

  const patternFields =
    regexFields.size > 0
      ? [
          ...[...regexFields].map(
            ([pat, name]) =>
              `    private static final Pattern ${name} = Pattern.compile(${JSON.stringify(pat)});`,
          ),
          ``,
        ]
      : [];

  return lines(
    `package ${pkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    ``,
    `import ${basePkg}.domain.common.WireValidationException;`,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    ``,
    `/** Wire-boundary validation (422) — same coverage as the other`,
    ` *  backends' FluentValidation / Zod rules (shared classifier). */`,
    `public final class ${agg.name}Validators {`,
    ...patternFields,
    `    private ${agg.name}Validators() {`,
    `    }`,
    ``,
    ...methods,
    `}`,
    ``,
  );
}

/** The check lines for one method, or null when no invariant translates
 *  (the method is omitted entirely — callers skip the call). */
function methodBody(
  spec: MethodSpec,
  imports: Set<string>,
  regexFields: Map<string, string>,
): string[] | null {
  const ctx: ClassifyContext = { available: spec.available };
  const checks: string[] = [];
  const typeOf = (field: string): TypeIR | undefined =>
    spec.params.find((p) => p.name === field)?.type;

  for (const inv of spec.invariants) {
    if (!classifyForWire(inv, ctx)) continue;
    const single = singleFieldShape(inv);
    if (single && spec.available.has(single.field)) {
      checks.push(
        ...patternCheck(
          single.field,
          single.pattern,
          typeOf(single.field),
          inv.message ? inv.message.text : `Invariant violated: ${inv.source}`,
          imports,
          regexFields,
        ),
      );
      continue;
    }
    // Generic predicate over the command values — same fallback as the
    // .NET `.Must(...)` arm.  `bareProps` renders `this.x` refs as the
    // method's parameter names.
    const path = pickErrorPath(inv) ?? spec.params[0]?.name ?? "";
    collectJavaExprImports(inv.expr, imports);
    // Hoist any regex literals in this compound/generic predicate too (the
    // single-field `case "regex"` above only covers bare `x.matches(r)`).
    for (const p of collectJavaRegexLiterals(inv.expr)) {
      if (!regexFields.has(p)) {
        regexFields.set(p, `MATCHES_PATTERN_${regexFields.size}`);
        imports.add("java.util.regex.Pattern");
      }
    }
    const predicate = renderJavaExpr(inv.expr, { thisName: "this", bareProps: true, regexFields });
    checks.push(
      `        if (!(${predicate})) errors.add(WireValidationException.error("/${path}", ${JSON.stringify(inv.message ? inv.message.text : `Invariant violated: ${inv.source}`)}));`,
    );
  }
  if (checks.length === 0) return null;
  return [
    `        var errors = new ArrayList<WireValidationException.WireError>();`,
    ...checks,
    `        if (!errors.isEmpty()) throw new WireValidationException(errors);`,
  ];
}

function patternCheck(
  field: string,
  pattern: SingleFieldPattern,
  type: TypeIR | undefined,
  // The fully-resolved failure message — the author's `message "..."` text
  // when present, else the derived `Invariant violated: <source>` default.
  message: string,
  imports: Set<string>,
  regexFields: Map<string, string>,
): string[] {
  const moneyLike =
    type?.kind === "primitive" && (type.name === "money" || type.name === "decimal");
  const cmp = (op: string, n: number): string =>
    moneyLike
      ? `${field}.compareTo(new java.math.BigDecimal("${n}")) ${op} 0`
      : `${field} ${op} ${n}`;
  const fail = (cond: string): string =>
    `        if (!(${cond})) errors.add(WireValidationException.error("/${field}", ${JSON.stringify(message)}));`;
  switch (pattern.kind) {
    case "min":
      // Exclusive (`weight > 0.5` on a decimal/money field) → strict `>`; the
      // `cmp` helper already routes decimal/money through `BigDecimal.compareTo`.
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
      imports.add("java.util.regex.Pattern");
      let name = regexFields.get(pattern.pattern);
      if (!name) {
        name = `MATCHES_PATTERN_${regexFields.size}`;
        regexFields.set(pattern.pattern, name);
      }
      return [fail(`${name}.matcher(${field}).find()`)];
    }
  }
}

/** True when the `<Agg>Validators.create(...)` method is actually emitted —
 *  i.e. at least one aggregate invariant classifies for the wire over the
 *  create-input shape.  The service's `create(...)` call must gate on THIS:
 *  a global "has any validator" check is also true when only an op
 *  precondition translates, which leaves the create method omitted → a call
 *  to a symbol that doesn't exist (the crudish-without-invariants footgun). */
export function aggHasCreateWireValidator(agg: EnrichedAggregateIR): boolean {
  const createCtx: ClassifyContext = {
    available: new Set(forCreateInput(agg.fields).map((f) => f.name)),
  };
  return agg.invariants.some((i) => classifyForWire(i, createCtx));
}
