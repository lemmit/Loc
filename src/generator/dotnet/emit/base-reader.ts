import type { EnrichedAggregateIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural } from "../../../util/naming.js";

// Polymorphic base reader for a TPC (`ownTable`) hierarchy
// (aggregate-inheritance.md).
//
// An abstract `ownTable` base has no table and no user repository, but TPC's
// whole point is polymorphic access: "query all Parties".  This emits a
// read-only `I<Base>Repository` / `<Base>Repository` pair that DELEGATES to the
// per-concrete EF repositories and concatenates — `FindAllAsync()` is the union
// of each concrete's auto-`All()` — so every aggregate loads its full tree
// through the loader that already knows how, returning the abstract-base union
// (`IReadOnlyList<Party>`).  Read-only: writes go through the per-concrete
// repositories.  Mirrors the Hono `buildTpcBaseReaderFile` delegation.
//
// `findById` is intentionally absent: identity stays per-concrete (each
// concrete keeps its own `<Concrete>Id`), there is no shared `<Base>Id`, and a
// polymorphic `<Base> id` reference is rejected by the language validator
// (`loom.polymorphic-id-ref-unsupported`) — so there is no caller for it.

/** The read-only `I<Base>Repository` interface (Domain layer). */
export function renderBaseReaderInterface(base: EnrichedAggregateIR, ns: string): string {
  return (
    lines(
      "// Auto-generated.",
      "using System.Collections.Generic;",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      "",
      `namespace ${ns}.Domain.${plural(base.name)};`,
      "",
      `// Read-only polymorphic reader for the abstract TPC base ${base.name}.`,
      `public interface I${base.name}Repository`,
      "{",
      `    Task<IReadOnlyList<${base.name}>> FindAllAsync(CancellationToken ct = default);`,
      "}",
    ) + "\n"
  );
}

/** The `<Base>Repository` implementation (Infrastructure layer) — delegates to
 *  each concrete repository's auto-`All()` and concatenates. */
export function renderBaseReaderImpl(
  base: EnrichedAggregateIR,
  concretes: readonly EnrichedAggregateIR[],
  ns: string,
): string {
  const field = (c: EnrichedAggregateIR): string => `_${lowerFirst(c.name)}Repo`;
  const ctorParam = (c: EnrichedAggregateIR): string => `${lowerFirst(c.name)}Repo`;
  const concreteUsings = [
    ...new Set(concretes.map((c) => `using ${ns}.Domain.${plural(c.name)};`)),
  ].sort();
  return (
    lines(
      "// Auto-generated.",
      "using System.Collections.Generic;",
      "using System.Threading;",
      "using System.Threading.Tasks;",
      `using ${ns}.Domain.${plural(base.name)};`,
      ...concreteUsings,
      "",
      `namespace ${ns}.Infrastructure.Repositories;`,
      "",
      `public sealed class ${base.name}Repository : I${base.name}Repository`,
      "{",
      ...concretes.map((c) => `    private readonly I${c.name}Repository ${field(c)};`),
      "",
      `    public ${base.name}Repository(${concretes
        .map((c) => `I${c.name}Repository ${ctorParam(c)}`)
        .join(", ")})`,
      "    {",
      ...concretes.map((c) => `        ${field(c)} = ${ctorParam(c)};`),
      "    }",
      "",
      `    public async Task<IReadOnlyList<${base.name}>> FindAllAsync(CancellationToken ct = default)`,
      "    {",
      `        var result = new List<${base.name}>();`,
      ...concretes.map((c) => `        result.AddRange(await ${field(c)}.All(ct));`),
      "        return result;",
      "    }",
      "}",
    ) + "\n"
  );
}
