import type { AggregateIR, BoundedContextIR } from "../../ir/types/loom-ir.js";
import { operationUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { lowerFirst } from "../../util/naming.js";
import { SCAFFOLD_ONCE_MARKER } from "../../util/scaffold-once.js";
import { renderOperationReturnType } from "./emit/aggregate.js";
import { renderTsType } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Extern operation seam — the TS/Hono domain extension point
// (extern-domain-extension-point.md §3a, decision (b), Phase 2).
//
// An `operation X(...) extern` declares case-1 business logic the DSL can't
// express: preconditions in the body, the mutation hand-written by the user.
// Phase 2 re-homes it from the old injected per-op handler REGISTRY to a domain
// extension point that is a MEMBER of the aggregate — a `protected abstract
// <op>Extern(...)` hook (emitted on the abstract `<Agg>Base` by
// `emit/aggregate.ts`) that the operation method calls between preconditions
// and invariants.
//
// This module emits the co-located, USER-OWNED implementation: a SCAFFOLD-ONCE
// concrete subclass `class <Agg> extends <Agg>Base` (`domain/<agg>.ts`) whose
// default `<op>Extern` bodies `raise` loudly.  It carries the
// `loom:scaffold-once` marker so `ddd generate` re-runs PRESERVE the user's
// filled-in implementation (see `src/util/scaffold-once.ts`).  A missing impl
// is BOTH a compile error (unimplemented abstract) and a loud runtime throw; a
// newly-added extern op fails the build until its hook is written — mirrors the
// Elixir analog (`src/generator/elixir/vanilla/extern-emit.ts`, #1841).
//
// Everyone still imports the concrete `<Agg>` from `domain/<agg>`, so nothing
// downstream changes.
// ---------------------------------------------------------------------------

/** Emit the scaffold-once concrete subclass for an aggregate with ≥1 extern op.
 *  Returns "" when the aggregate has no extern op (caller skips it). */
export function buildExternSubclassFile(agg: AggregateIR, ctx: BoundedContextIR): string {
  const externOps = agg.operations.filter((o) => o.extern);
  if (externOps.length === 0) return "";

  const slug = lowerFirst(agg.name);
  const methods: string[] = [];
  const sigScanParts: string[] = [];
  for (const op of externOps) {
    const usesUser = operationUsesCurrentUser(op);
    // Params are `_`-prefixed (unused in the throwing stub — keeps the emitted
    // file's Biome lint clean); the user renames them when filling in the body.
    const params = [
      ...op.params.map((p) => `_${p.name}: ${renderTsType(p.type)}`),
      usesUser ? "_currentUser: User" : "",
    ]
      .filter(Boolean)
      .join(", ");
    const ret = op.returnType ? renderOperationReturnType(op.returnType, ctx) : "void";
    sigScanParts.push(params, ret);
    const hookName = `${lowerFirst(op.name)}Extern`;
    const msg = `extern operation '${op.name}' on ${agg.name} is not implemented — write its body in src/domain/${slug}.ts`;
    methods.push(
      `  protected override ${hookName}(${params}): ${ret} {\n` +
        `    throw new Error(${JSON.stringify(msg)});\n` +
        `  }`,
    );
  }

  // Header imports = whatever the override SIGNATURES reference (blank the
  // string literals first so a name inside the throw message can't count).
  const scan = sigScanParts.join(" ").replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const imports: string[] = [`import { ${agg.name}Base } from "./${slug}.base";`];
  // Re-export the entity-part classes (emitted in `<agg>.base.ts`) so
  // `domain/<agg>` stays the single import surface: consumers (repositories,
  // the wire mapper) import `<Agg>` + its parts from here regardless of the
  // base/subclass split.
  if (agg.parts.length > 0) {
    imports.push(`export { ${agg.parts.map((p) => p.name).join(", ")} } from "./${slug}.base";`);
  }
  if (/\bIds\.\w/.test(scan)) imports.push(`import * as Ids from "./ids";`);
  if (/\bUser\b/.test(scan)) imports.push(`import type { User } from "../auth/user-types";`);
  const voEnum = [
    ...new Set([...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]),
  ]
    .filter(refersTo)
    .sort();
  if (voEnum.length > 0) imports.push(`import { ${voEnum.join(", ")} } from "./value-objects";`);

  return `// ${SCAFFOLD_ONCE_MARKER} — this file is yours.  Loom scaffolds it on the first
// \`generate\` and NEVER overwrites it again, so your implementation survives
// every regenerate.  Replace each \`throw\` with the operation's real domain logic.
${imports.join("\n")}

/**
 * ${agg.name} — the concrete aggregate.  Loom generates the machinery in
 * \`${slug}.base.ts\` (regenerated each run) and leaves each \`extern\` operation's
 * hand-written body to you here.  Every \`*Extern\` method is the body of an
 * \`operation … extern\`: mutate \`this._<field>\` directly and call
 * \`this._raiseEvent(...)\` to emit; the framework runs the operation's
 * preconditions before and re-asserts invariants after.
 */
export class ${agg.name} extends ${agg.name}Base {
${methods.join("\n\n")}
}
`;
}
