import type { EnrichedAggregateIR, OperationIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { upperFirst } from "../../../util/naming.js";
import { renderJavaType } from "../render-expr.js";

// ---------------------------------------------------------------------------
// Extern operations — the user-supplied-handler escape hatch.  Per extern
// op: a handler interface (the business decision boundary) plus a
// dev-stub @Component that throws until the user provides their own
// @Primary bean.  The service runs check<Op> (preconditions) before and
// _assertInvariants + save after the handler.
// ---------------------------------------------------------------------------

export function renderExternHandlerInterface(
  agg: EnrichedAggregateIR,
  op: OperationIR,
  pkg: string,
  basePkg: string,
  entityPkg: string,
): string {
  const name = `${upperFirst(op.name)}${agg.name}Handler`;
  const params = ["", ...op.params.map((p) => `${renderJavaType(p.type)} ${p.name}`)]
    .join(", ")
    .replace(/^, /, ", ");
  return lines(
    `package ${pkg};`,
    ``,
    entityPkg !== pkg ? `import ${entityPkg}.${agg.name};` : null,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    ``,
    `/** User-supplied handler for the extern operation '${op.name}' on`,
    ` *  ${agg.name}.  Provide a @Primary bean implementing this to own the`,
    ` *  business decision; preconditions run before, invariants after. */`,
    `public interface ${name} {`,
    `    void handle(${agg.name} aggregate${params});`,
    `}`,
    ``,
  );
}

export function renderExternHandlerStub(
  agg: EnrichedAggregateIR,
  op: OperationIR,
  pkg: string,
  basePkg: string,
  entityPkg: string,
): string {
  const iface = `${upperFirst(op.name)}${agg.name}Handler`;
  const params = ["", ...op.params.map((p) => `${renderJavaType(p.type)} ${p.name}`)]
    .join(", ")
    .replace(/^, /, ", ");
  return lines(
    `package ${pkg};`,
    ``,
    `import org.springframework.stereotype.Component;`,
    ``,
    entityPkg !== pkg ? `import ${entityPkg}.${agg.name};` : null,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    ``,
    `/** Dev stub — REPLACE by providing your own @Primary ${iface} bean. */`,
    `@Component`,
    `public class DevStub${iface} implements ${iface} {`,
    `    @Override`,
    `    public void handle(${agg.name} aggregate${params}) {`,
    `        throw new UnsupportedOperationException(`,
    `            "Extern operation '${op.name}' on ${agg.name} has no handler - provide a @Primary ${iface} bean.");`,
    `    }`,
    `}`,
    ``,
  );
}
