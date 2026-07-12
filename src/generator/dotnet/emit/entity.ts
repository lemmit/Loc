import type { SourceMapSubRegion } from "../../../generator/_trace/sourcemap.js";
import { offsetToLineCol } from "../../../generator/_trace/sourcemap.js";
import { forCreateInput, hasCreate } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedEntityPartIR,
  IdValueType,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import type { OriginRef } from "../../../ir/types/origin.js";
import { resolveToSource } from "../../../ir/types/origin.js";
import { lines } from "../../../util/code-builder.js";
import { plural, upperFirst } from "../../../util/naming.js";
import type { UnionMember } from "../../_payload/union-wire.js";
import { collectCsExprUsings, csNewIdValue, renderCsExpr, renderCsType } from "../render-expr.js";
import {
  collectCsStmtUsings,
  renderCsStatementChunks,
  renderCsStatements,
  statementSubRegions,
} from "../render-stmt.js";

/** One operation body's exact emitted text plus its per-statement
 *  sub-regions — surfaced by `renderEntity` (when `opFragments` is passed)
 *  to the caller that owns the recorder and the final file content
 *  (`src/generator/dotnet/index.ts`'s `emitAggregate`/`place`), which
 *  anchors it via `SourceMapRecorder.fragment`.  Covers only the REGULAR
 *  (non-extern) named-operation body path — see the call site in
 *  `renderEntity` below; extern check bodies, event-sourced init, and
 *  appliers are out of scope for this slice. */
export interface OpFragment {
  fragmentText: string;
  subRegions: SourceMapSubRegion[];
}

/** True for a field type that is a collection of references
 * (`Id<T>[]`) — persisted via a join table, not a column. */
function isRefCollection(t: TypeIR): boolean {
  return t.kind === "array" && t.element.kind === "id";
}

/** A statement shape narrow enough to cover both a real `StmtIR` and the
 *  bare `{ origin }` fixtures `weave-line-directives.test.ts` exercises —
 *  `value`/`expr` mirror the `assign`/`return`/`let` StmtIR fields (see
 *  `src/ir/types/loom-ir.ts`), each narrowed to just the inner `origin` a
 *  weave needs. */
interface NarrowableStmt {
  kind?: string;
  origin?: OriginRef;
  value?: { origin?: OriginRef };
  expr?: { origin?: OriginRef };
}

/** Prefer an `assign`/`return`/`let` statement's INNER expression origin
 *  (the RHS span) over the whole statement's span — the statement span
 *  always includes the LHS/keyword too, so the narrower expression span
 *  gives column-precise `#line` stepping for free (the origin is already
 *  stamped by `lowerExpr`'s wrapper, `src/ir/lower/lower-expr.ts`; no new
 *  mechanism here).  Falls back to the statement's own origin for every
 *  other statement kind, and when the inner expression has no origin of
 *  its own (e.g. it lowered to a synthetic node). */
function narrowedOrigin(stmt: NarrowableStmt): OriginRef | undefined {
  if (stmt.kind === "assign" || stmt.kind === "return") return stmt.value?.origin ?? stmt.origin;
  if (stmt.kind === "let") return stmt.expr?.origin ?? stmt.origin;
  return stmt.origin;
}

/** M7 phase 6a: weave enhanced C#10 `#line (a,b)-(c,d) "path"` directives
 *  (source-map-and-debugging.md §6.C) into a REGULAR named-operation's
 *  per-statement chunk list, one directive per statement whose origin
 *  resolves to a span in `sourceTexts`.  A statement with no usable origin
 *  gets `#line hidden` instead (the debugger steps over it) — but only once
 *  at least one OTHER statement in this body resolved; an all-unmapped body
 *  is left untouched (`wove: false`), never a body of bare `#line hidden`s.
 *  Directives sit flush-left (column 0) ahead of the original chunk text,
 *  matching generated-code readability over C#'s tolerance for indented
 *  directives.  `stmts`/`chunks` must be the same 1:1 arrays
 *  `statementSubRegions` walks, so the returned chunks stay line-countable
 *  the same way.  An `assign`/`return`/`let` statement narrows to its inner
 *  expression's span via `narrowedOrigin` — see there. */
export function weaveLineDirectives(
  stmts: readonly NarrowableStmt[],
  chunks: readonly string[],
  sourceTexts: ReadonlyMap<string, string>,
): { chunks: string[]; wove: boolean } {
  const resolved = stmts.map((s) => {
    const src = resolveToSource(narrowedOrigin(s));
    if (!src) return undefined;
    const text = sourceTexts.get(src.path);
    return text === undefined ? undefined : { path: src.path, span: src.span, text };
  });
  if (!resolved.some((r) => r !== undefined)) return { chunks: [...chunks], wove: false };
  const woven = chunks.map((chunk, i) => {
    const r = resolved[i];
    if (!r) return `#line hidden\n${chunk}`;
    const from = offsetToLineCol(r.text, r.span.start);
    const to = offsetToLineCol(r.text, r.span.end);
    return `#line (${from.line},${from.col})-(${to.line},${to.col}) "${r.path}"\n${chunk}`;
  });
  return { chunks: woven, wove: true };
}

// ---------------------------------------------------------------------------
// Aggregate root + entity-part class emission for .NET.  The shape is a
// sealed class with private setters everywhere, an explicit
// parameterless ctor for EF Core, an explicit `_Create(State)` factory
// used by repository hydration, and (for the root) a public `Create`
// factory + `PullEvents()` drainage hook.
//
// Extern operations (S10 containment): when an aggregate declares
// `operation X(...) extern { precondition ... }`, the generated request
// handler delegates the business decision to a user-supplied
// `IXFooHandler`.  That handler needs to mutate state and raise events —
// but instead of widening EVERY setter to `internal set` (which let any
// same-assembly code bypass invariants), the aggregate implements a narrow
// `I<Agg>Mutator` EXPLICITLY (get/set per field + Id + RaiseDomainEvent).
// The concrete setters stay `private`; the write surface is reachable only
// through the interface reference the command handler passes, so
// `order.Status = …` on a plain `Order` no longer compiles app-wide.
// ---------------------------------------------------------------------------

/** Identifies the abstract base a concrete aggregate `extends`, so the
 *  concrete declares `: <Base>` and leaves the base's fields to the inherited
 *  declarations (see `renderAbstractBaseEntity`).  `fieldNames` is the set of
 *  base-declared field names the concrete must NOT re-declare (re-declaring
 *  would trip CS0108 hidden-member → fatal under `/warnaserror`).
 *
 *  `sharesIdentity` distinguishes TPH (`sharedTable`) from TPC (`ownTable`):
 *  a TPH concrete shares the base's single-table primary key, so the base
 *  owns the `Id` property and the concrete must NOT declare its own (it
 *  inherits the strongly-typed `<Base>Id`).  `idValueType` carries the
 *  base's id value type so the concrete's `Create` factory mints the
 *  inherited key with the right `csNewIdValue`.  A TPC concrete leaves both
 *  unset and keeps its own `<Concrete>Id`. */
export interface SuperTypeInfo {
  readonly name: string;
  readonly fieldNames: ReadonlySet<string>;
  /** Base-declared derived members (e.g. the synthesized `inspect`) the
   *  concrete must NOT re-declare — it inherits them, and re-declaring would
   *  hide the inherited member (CS0108, fatal under `/warnaserror`). */
  readonly derivedNames?: ReadonlySet<string>;
  readonly sharesIdentity?: boolean;
  readonly idValueType?: IdValueType;
}

export function renderEntity(
  entity: EnrichedAggregateIR | EnrichedEntityPartIR,
  isRoot: boolean,
  ns: string,
  rootName: string,
  /** The entity whose id brands this part's `ParentId` — its DIRECT parent (a
   *  sibling part for a part-in-part, else the aggregate root).  Distinct from
   *  `rootName`, which still names the aggregate folder/namespace all parts
   *  share.  Equals `rootName` for a root-level part (byte-identical). */
  parentName: string,
  emitTrace = false,
  /** When true, the entity is part of a document-shaped
   *  (`shape(document)`) aggregate: emit the `ToSnapshot()` /
   *  `FromSnapshot(...)` mapping methods the JSONB repository serialises
   *  through.  Additive — byte-identical output when false. */
  document = false,
  /** Present when this aggregate is a concrete TPC subtype (`extends` an
   *  abstract `ownTable` base): the class declares `: <Base>` and inherits the
   *  base fields rather than re-declaring them.  Undefined ⇒ byte-identical
   *  with the standalone-aggregate output. */
  superType?: SuperTypeInfo,
  /** Exception-less operation returns (exception-less.md): opName → the Domain
   *  union the method returns + its variant members (field order), precomputed
   *  where the bounded context is in scope.  A return-typed op renders its
   *  signature with the union type and threads `returnUnion` into the body's
   *  render context so tagged `return`s build the right variant record. */
  operationReturnUnions?: Map<string, { name: string; members: UnionMember[] }>,
  /** Source-map Milestone 3 (statement regions) — when passed, the REGULAR
   *  named-operation body loop below pushes one `OpFragment` per operation.
   *  Only the root render call gets this (entity parts carry no
   *  operations); allocated by the caller ONLY when a recorder is present
   *  (`src/generator/dotnet/index.ts`), so a no-`--sourcemap` run pays no
   *  per-statement bookkeeping cost. */
  opFragments?: OpFragment[],
  /** Dotted construct prefix for this entity's operations, e.g.
   *  `"Sales.Order"` — combined with each op's name to build the
   *  `statementSubRegions` construct id `"Sales.Order.confirm"`.  Required
   *  whenever `opFragments` is passed. */
  constructPrefix?: string,
  /** `.ddd` source text keyed by `OriginRef` source path (M7 phase 6a) —
   *  present only alongside `opFragments` (same recorder-present gate).
   *  When set, the REGULAR named-operation body loop below weaves C#
   *  enhanced `#line` directives (see `weaveLineDirectives`) so the PDB
   *  carries `.ddd` sequence points.  Absent ⇒ byte-identical output;
   *  only dotnet consumes this today, and only the root render call
   *  passes it (entity parts carry no operations). */
  sourceTexts?: ReadonlyMap<string, string>,
): string {
  // `operations` is the discriminator between EnrichedAggregateIR and
  // EnrichedEntityPartIR — wrapped in a type predicate so the union
  // narrows in every downstream consumer without per-site casts.
  const isAgg = (e: typeof entity): e is EnrichedAggregateIR => "operations" in e;
  const idValueType = isAgg(entity) ? entity.idValueType : "guid";
  // TPH (`sharesIdentity`): the concrete shares the base's single-table key,
  // so its `Id` / `State.Id` / `Create` mint the inherited `<Base>Id` with the
  // base's value type.  TPC and standalone aggregates use their own id class.
  const idClass = superType?.sharesIdentity ? `${superType.name}Id` : `${entity.name}Id`;
  const effIdValueType: IdValueType = superType?.sharesIdentity
    ? (superType.idValueType ?? idValueType)
    : idValueType;
  const operations = isAgg(entity) ? entity.operations : [];
  // Public `Create(...)` factory params — the create-input set
  // (`forCreateInput`, incl. optionals), matching the CreateCommand/handler
  // call order + wire DTO, so `Agg.Create(cmd.Field, ...)` binds
  // positionally.  Every constructible aggregate's create is parameterized
  // by this set; there is no parameterless form.
  const createInputFieldList = isAgg(entity) ? forCreateInput(entity.fields) : [];
  // Event sourcing (appliers A2.2b): an event-sourced aggregate folds
  // events into state via appliers, is rehydrated by `_FromEvents`, and is
  // constructed by its single `create` action's emit-only body (not a
  // state-writing factory).  `eventSourced` gates all of that; `appliers` /
  // `esCreate` drive the fold + construction emission.
  const eventSourced = isAgg(entity) && entity.persistedAs === "eventLog";
  const appliers = isAgg(entity) ? (entity.appliers ?? []) : [];
  const esCreate = isAgg(entity) ? entity.creates?.[0] : undefined;
  const hasExtern = operations.some((o) => o.extern);
  // S10 containment: an `extern` op no longer widens EVERY setter to
  // `internal` (which, in a single-assembly app, let any handler / controller
  // / test do `order.Status = …` and skip invariants).  Setters stay
  // `private`; the extern handler gets a narrow write surface through an
  // explicitly-implemented `I<Agg>Mutator` (below) — reachable only via the
  // interface reference the command handler passes, never on the concrete
  // aggregate type.
  const setterVisibility = "private";
  // Auditable capability (capability-stamp-dedup): an aggregate with any
  // `contextStamps` carries audit columns the AuditableInterceptor stamps at
  // SaveChanges.  The interceptor writes them through EF's metadata accessor
  // via the compile-checked lambda (`ctx.Entry(e).Property(x => x.CreatedAt)
  // .CurrentValue = …`), NOT the CLR setter, so the stamped fields stay
  // `{ get; private set; }` — no `internal set` leak — while the write stays
  // bound to a real property at compile time (per-aggregate switch arm, no
  // marker interface, no string-keyed property lookup).
  // Non-implicit namespaces this entity's rendered expressions reach
  // into (`System.Text.RegularExpressions` when an invariant uses
  // `email.matches(...)`), collected over the same derived / function /
  // invariant / operation bodies rendered below so the file imports
  // only what its own expressions actually use.
  const usings = new Set<string>();
  for (const d of entity.derived) collectCsExprUsings(d.expr, usings, ns);
  for (const fn of entity.functions) {
    if ("expr" in fn.body) collectCsExprUsings(fn.body.expr, usings, ns);
    else collectCsStmtUsings(fn.body.stmts, usings, ns);
  }
  for (const inv of entity.invariants) {
    collectCsExprUsings(inv.expr, usings, ns);
    if (inv.guard) collectCsExprUsings(inv.guard, usings, ns);
  }
  for (const op of operations) collectCsStmtUsings(op.statements, usings, ns);
  // Applier + event-sourced-create bodies render through the same path, so
  // their expressions can pull in the same namespaces (e.g. regex).
  for (const ap of appliers) collectCsStmtUsings(ap.statements, usings, ns);
  if (esCreate) collectCsStmtUsings(esCreate.statements, usings, ns);
  const renderCtx = {
    thisName: "this",
    // Threaded through so render-stmt's collection-mutation path can
    // distinguish ref-collection fields (writable public `Party`)
    // from containment fields (private `_lines` backing).  Entity
    // parts don't have associations, but typing as the union keeps
    // the ctx shape stable across the two callers.
    agg: isAgg(entity) ? entity : undefined,
  };

  const propLines: string[] = [];
  // A TPH concrete inherits `Id` from its base (the shared-table key); declaring
  // it again would shadow the inherited member (CS0108, fatal under /warnaserror).
  if (!superType?.sharesIdentity) {
    propLines.push(`    public ${entity.name}Id Id { get; ${setterVisibility} set; }`);
    // A TPC concrete (`extends` an `ownTable` base) implements the base's
    // boxed-id accessor so the base's derived members can read the id
    // polymorphically (the base owns no typed `Id` — each concrete's is its
    // own strongly-typed record-struct, which can't covariantly override an
    // `object` property, so we box through this getter instead).
    if (superType) {
      propLines.push(`    public override object IdBoxed => Id;`);
    }
  }
  if (!isRoot) {
    propLines.push(`    public ${parentName}Id ParentId { get; ${setterVisibility} set; }`);
  }
  for (const f of entity.fields) {
    // A concrete TPC subtype inherits its base fields from the abstract base
    // class (renderAbstractBaseEntity declares them).  Re-declaring here would
    // shadow the inherited member (CS0108, fatal under /warnaserror), so skip
    // them — the State/ctor/_Create/factory below still set them via the
    // inherited (internal-set) accessors.
    if (superType?.fieldNames.has(f.name)) continue;
    // Optional fields default to null on their own — emitting `= default`
    // explicitly trips CA1805 ("redundant initialization to default").
    // Non-optional reference types still need the null-forgiving `= default!`
    // so the non-null analyzer accepts the auto-property declaration.
    const def = f.optional ? "" : " = default!;";
    // Reference-collection (`Id<T>[]`) fields are persisted via a
    // separate join table; the repository (in the Infrastructure
    // assembly) needs to write the `List<TargetId>` after loading
    // join rows post-`FirstOrDefaultAsync`.  Widening the setter from
    // `private` to `internal` keeps the field unwritable from
    // user/application code but lets the same-assembly hydration
    // succeed without reflection.
    const fieldSetter = isRefCollection(f.type) ? "internal" : setterVisibility;
    propLines.push(
      `    public ${renderCsType(f.type)} ${upperFirst(f.name)} { get; ${fieldSetter} set; }${def}`,
    );
  }
  for (const c of entity.contains) {
    if (c.collection) {
      propLines.push(`    private readonly List<${c.partName}> _${c.name} = new();`);
      propLines.push(
        `    public IReadOnlyList<${c.partName}> ${upperFirst(c.name)} => _${c.name}.AsReadOnly();`,
      );
    } else {
      propLines.push(
        `    public ${c.partName} ${upperFirst(c.name)} { get; private set; } = default!;`,
      );
    }
  }

  const eventBlock = isRoot
    ? [
        "",
        `    private readonly List<IDomainEvent> _domainEvents = new();`,
        `    public IReadOnlyList<IDomainEvent> DomainEvents => _domainEvents.AsReadOnly();`,
      ]
    : [];

  // Provenance runtime (provenance.md): each `provenanced` ROOT field carries a
  // co-located `<Field>Provenance` lineage property (persisted on the row via a
  // jsonb value-converter — see efcore.ts) holding the lineage of its current
  // value; `_provTraces` buffers every write's lineage for the repository to
  // drain into provenance_records inside the save transaction.  Root-only —
  // operations (the write sites) live on the root; a containment write-through
  // carries no co-located slot (render-stmt's segment guard).
  const provFields = isRoot ? entity.fields.filter((f) => f.provenanced) : [];
  const provBlock =
    provFields.length > 0
      ? [
          "",
          ...provFields.map(
            (f) => `    public ProvLineage? ${upperFirst(f.name)}Provenance { get; private set; }`,
          ),
          "    private readonly List<ProvLineage> _provTraces = new();",
          "    public IReadOnlyList<ProvLineage> DrainProv()",
          "    {",
          "        var __copy = _provTraces.ToArray();",
          "        _provTraces.Clear();",
          "        return __copy;",
          "    }",
        ]
      : [];

  const ctorLines: string[] = [];
  ctorLines.push(`    private ${entity.name}()`);
  ctorLines.push("    {");
  ctorLines.push("        Id = default!;");
  if (!isRoot) ctorLines.push("        ParentId = default!;");
  for (const f of entity.fields) {
    ctorLines.push(`        ${upperFirst(f.name)} = default!;`);
  }
  ctorLines.push("    }");

  // A concrete subtype inherits the base's derived members; re-declaring one
  // hides the inherited member (CS0108 under /warnaserror), so skip any the
  // base already declares (same rule as the inherited fields above).
  const ownDerived = superType?.derivedNames
    ? entity.derived.filter((d) => !superType.derivedNames!.has(d.name))
    : entity.derived;
  const derivedLines = ownDerived.map(
    (d) =>
      `    public ${renderCsType(d.type)} ${upperFirst(d.name)} => ${renderCsExpr(d.expr, renderCtx)};`,
  );
  // Override `ToString()` on aggregate roots to delegate to the
  // `Inspect` derived — gives a useful debug form in exceptions,
  // debugger watches, Serilog destructuring, etc.
  if (isRoot && entity.derived.some((d) => d.name === "inspect")) {
    derivedLines.push("    public override string ToString() => Inspect;");
  }
  const fnLines = entity.functions.flatMap((fn) => {
    const params = fn.params.map((p) => `${renderCsType(p.type)} ${p.name}`).join(", ");
    const head = `    private ${renderCsType(fn.returnType)} ${upperFirst(fn.name)}(${params})`;
    // Expression form keeps the expression-bodied `=> expr;` shape
    // (byte-identical); block form (domain-services.md rev. 4) emits a
    // statement body whose `return`s carry the value out.
    if ("expr" in fn.body) {
      return [`${head} => ${renderCsExpr(fn.body.expr, renderCtx)};`];
    }
    const body = renderCsStatements(fn.body.stmts, renderCtx);
    return [head, "    {", ...(body.length > 0 ? [body] : []), "    }"];
  });

  const opLines: string[] = [];
  // Whether any operation references `currentUser`.  When true, we
  // pull in the Auth namespace alongside the existing usings so the
  // `User` type resolves; per-op signatures append a `User currentUser`
  // parameter (and the Mediator handler passes _currentUser.User).
  const anyOpUsesCurrentUser = operations.some(operationUsesCurrentUser);
  for (const op of operations) {
    const usesUser = operationUsesCurrentUser(op);
    const userParam = usesUser ? "User currentUser" : "";
    const baseParams = op.params.map((p) => `${renderCsType(p.type)} ${p.name}`).join(", ");
    const params = [baseParams, userParam].filter(Boolean).join(", ");
    if (op.extern) {
      // Extern op: emit a `Check<Pascal>` that runs preconditions only.
      // The auto-generated Mediator handler calls this, then dispatches
      // to the user-supplied handler, then runs AssertInvariants.  No
      // `<Pascal>` method exists on the aggregate; the user owns the
      // business decision.
      opLines.push(`    public void Check${upperFirst(op.name)}(${params})`);
      opLines.push("    {");
      const body = renderCsStatements(op.statements, renderCtx, {
        emitTrace,
        aggregate: entity.name,
        op: op.name,
        eventSourced,
      });
      if (body.length > 0) opLines.push(body);
      opLines.push("    }");
      opLines.push("");
      continue;
    }
    const visibility = op.visibility === "public" ? "public" : "private";
    // Exception-less return-typed op: the method returns its Domain union and
    // ends in `return` (so the trailing AssertInvariants would be unreachable —
    // skip it, mirroring the Hono producer).  Thread `returnUnion` so tagged
    // returns construct the variant records.
    const retUnion = operationReturnUnions?.get(op.name);
    const retType = op.returnType ? renderCsType(op.returnType) : "void";
    opLines.push(`    ${visibility} ${retType} ${upperFirst(op.name)}(${params})`);
    opLines.push("    {");
    // Chunked (one string per statement) rather than the pre-joined
    // `renderCsStatements` here — `renderCsStatements` IS `chunks.join("\n")`
    // by construction, so `body` below is byte-identical either way, but the
    // per-chunk list lets us surface per-statement sub-regions to the caller
    // that owns the recorder + this file's final content (source-map
    // Milestone 3).
    const opRenderCtx = retUnion ? { ...renderCtx, returnUnion: retUnion } : renderCtx;
    const rawChunks = renderCsStatementChunks(op.statements, opRenderCtx, {
      emitTrace,
      aggregate: entity.name,
      op: op.name,
      eventSourced,
    });
    // M7 phase 6a: weave enhanced `#line` directives BEFORE the join, so
    // `chunks`/`body`/`fragmentText` and the sub-region cursor walk below
    // all see the exact same (post-weave) text that lands in the file —
    // never post-process the joined `body`, that would desync
    // `content.indexOf(fragmentText)` in `SourceMapRecorder.fragment`.
    const woven = sourceTexts
      ? weaveLineDirectives(op.statements, rawChunks, sourceTexts)
      : undefined;
    const chunks = woven?.chunks ?? rawChunks;
    const body = chunks.join("\n");
    if (opFragments && chunks.length > 0) {
      opFragments.push({
        fragmentText: body,
        subRegions: statementSubRegions(
          op.statements,
          chunks,
          `${constructPrefix ?? entity.name}.${op.name}`,
        ),
      });
    }
    if (body.length > 0) opLines.push(body);
    if (woven?.wove) opLines.push("#line default");
    if (!op.returnType) {
      opLines.push(
        emitTrace ? `        AssertInvariants("${op.name}");` : "        AssertInvariants();",
      );
    }
    opLines.push("    }");
    opLines.push("");
  }

  // S10 containment: for an aggregate with ≥1 extern op, the write surface
  // the user's `[ExternHandler]` needs (per-field set + RaiseEvent) is
  // exposed through an EXPLICITLY-implemented `I<Agg>Mutator` rather than by
  // widening the aggregate's own setters.  Explicit implementation means the
  // members are reachable ONLY through the interface reference the command
  // handler passes — `order.Status = …` on a plain `Order` no longer
  // compiles.  The concrete setters stay `private`; the interface get/set
  // ride the class's own private setter (legal inside the class body).
  const externHookLines: string[] = [];
  const mutatorInterfaceLines: string[] = [];
  const mutatorFields = isAgg(entity)
    ? entity.fields.filter((f) => !superType?.fieldNames.has(f.name))
    : [];
  if (isRoot && hasExtern) {
    const mutatorName = `I${entity.name}Mutator`;
    externHookLines.push(
      `    // S10 containment: extern write surface, explicitly implemented so it`,
      `    // is reachable only through ${mutatorName}, never on ${entity.name} itself.`,
      `    ${idClass} ${mutatorName}.Id => Id;`,
    );
    for (const f of mutatorFields) {
      const p = upperFirst(f.name);
      externHookLines.push(
        `    ${renderCsType(f.type)} ${mutatorName}.${p} { get => ${p}; set => ${p} = value; }`,
      );
    }
    externHookLines.push(
      // `RaiseDomainEvent`, not `RaiseEvent`: the latter is a reserved VB
      // keyword and trips CA1716 on a public interface member (/warnaserror).
      `    void ${mutatorName}.RaiseDomainEvent(IDomainEvent ev) => _domainEvents.Add(ev);`,
      "",
    );
    mutatorInterfaceLines.push(
      "",
      `/// <summary>Narrow, extern-scoped write surface for ${entity.name} (S10`,
      "/// containment).  The command handler passes the loaded aggregate as this",
      `/// interface to the user's [ExternHandler]; the concrete ${entity.name} keeps`,
      "/// its setters private, so nothing else can bypass invariants.</summary>",
      `public interface ${mutatorName}`,
      "{",
      `    ${idClass} Id { get; }`,
      ...mutatorFields.map(
        (f) => `    ${renderCsType(f.type)} ${upperFirst(f.name)} { get; set; }`,
      ),
      "    void RaiseDomainEvent(IDomainEvent ev);",
      "}",
    );
  }

  const pullEventsLines = isRoot
    ? [
        "    public IReadOnlyList<IDomainEvent> PullEvents()",
        "    {",
        "        var copy = _domainEvents.ToArray();",
        "        _domainEvents.Clear();",
        "        return copy;",
        "    }",
        "",
      ]
    : [];

  // Event-sourcing fold (appliers A2.2b): one `_Apply<Event>` method per
  // applier, a `_Apply(IDomainEvent)` dispatch (C# type-pattern switch over
  // the sealed event records), and a `_FromEvents` rehydrator that folds a
  // stream from an empty shell.  Root-only, event-sourced-only; the
  // repository calls `_FromEvents` on load and the record-and-apply `emit`
  // calls `_Apply`.
  const applierLines: string[] = [];
  if (isRoot && eventSourced && appliers.length > 0) {
    for (const ap of appliers) {
      applierLines.push(`    private void _Apply${ap.event}(${ap.event} ${ap.param})`);
      applierLines.push("    {");
      const body = renderCsStatements(ap.statements, renderCtx, {
        emitTrace,
        aggregate: entity.name,
        op: `apply(${ap.event})`,
        eventSourced,
      });
      if (body.length > 0) applierLines.push(body);
      applierLines.push("    }");
      applierLines.push("");
    }
    applierLines.push("    private void _Apply(IDomainEvent ev)");
    applierLines.push("    {");
    applierLines.push("        switch (ev)");
    applierLines.push("        {");
    for (const ap of appliers) {
      applierLines.push(`            case ${ap.event} e: _Apply${ap.event}(e); break;`);
    }
    applierLines.push("        }");
    applierLines.push("    }");
    applierLines.push("");
    applierLines.push(
      `    public static ${entity.name} _FromEvents(${entity.name}Id id, IReadOnlyList<IDomainEvent> events)`,
    );
    applierLines.push("    {");
    applierLines.push(`        var e = new ${entity.name}();`);
    applierLines.push("        e.Id = id;");
    applierLines.push("        foreach (var ev in events) e._Apply(ev);");
    applierLines.push(
      emitTrace ? `        e.AssertInvariants("<init>");` : "        e.AssertInvariants();",
    );
    applierLines.push("        return e;");
    applierLines.push("    }");
    applierLines.push("");
  }

  // Event-sourced construction (appliers A2.2b): the single `create`
  // action's emit-only body runs against a fresh empty shell via `_Init`,
  // where each `emit` records-and-folds the creation event.  Input is the
  // create action's params (the command shape).  Replaces the state-writing
  // public factory for event-sourced aggregates.
  const esCreateFactoryLines: string[] =
    isRoot && eventSourced && esCreate
      ? [
          `    public static ${entity.name} Create(${esCreate.params
            .map((p) => `${renderCsType(p.type)} ${p.name}`)
            .join(", ")})`,
          "    {",
          `        var e = new ${entity.name}();`,
          `        e.Id = new ${idClass}(${csNewIdValue(effIdValueType)});`,
          `        e._Init(${esCreate.params.map((p) => p.name).join(", ")});`,
          "        return e;",
          "    }",
          "",
          `    private void _Init(${esCreate.params
            .map((p) => `${renderCsType(p.type)} ${p.name}`)
            .join(", ")})`,
          "    {",
          renderCsStatements(esCreate.statements, renderCtx, {
            emitTrace,
            aggregate: entity.name,
            op: esCreate.name,
            eventSourced,
          }),
          "    }",
          "",
        ]
      : [];

  // Per-invariant body.  Trace-off: the one-liner if-throw.  Trace-on:
  // bind the boolean to `__inv_<i>_ok` so BOTH pass and fail outcomes
  // log (invariant_evaluated) before the conditional throw fires off
  // the same temp.  A GUARDED invariant logs ONLY when its guard
  // applies — the wrap sits inside `if (guard) { … }` so an
  // inapplicable invariant doesn't pollute the stream.  Op context
  // comes from the `__op` parameter on the trace-on AssertInvariants
  // signature.
  const invariantLines = entity.invariants.flatMap((inv, i) => {
    const thrown = `throw new DomainException(${JSON.stringify(`Invariant violated: ${inv.source}`)})`;
    if (!emitTrace) {
      const check = inv.guard
        ? `if ((${renderCsExpr(inv.guard, renderCtx)}) && !(${renderCsExpr(inv.expr, renderCtx)}))`
        : `if (!(${renderCsExpr(inv.expr, renderCtx)}))`;
      return [`        ${check} ${thrown};`];
    }
    const ok = `__inv_${i}_ok`;
    const traceCall = `DomainLog.LogTrace("{Event} aggregate={Aggregate} op={Op} expr={Expr} passed={Passed}", "invariant_evaluated", "${entity.name}", __op, ${JSON.stringify(inv.source)}, ${ok});`;
    if (inv.guard) {
      return [
        `        if (${renderCsExpr(inv.guard, renderCtx)})`,
        "        {",
        `            var ${ok} = (${renderCsExpr(inv.expr, renderCtx)});`,
        `            ${traceCall}`,
        `            if (!${ok}) ${thrown};`,
        "        }",
      ];
    }
    return [
      `        var ${ok} = (${renderCsExpr(inv.expr, renderCtx)});`,
      `        ${traceCall}`,
      `        if (!${ok}) ${thrown};`,
    ];
  });

  const stateLines: string[] = [];
  stateLines.push("    public sealed class State");
  stateLines.push("    {");
  stateLines.push(`        public ${idClass} Id { get; init; } = default!;`);
  if (!isRoot) {
    stateLines.push(`        public ${parentName}Id ParentId { get; init; } = default!;`);
  }
  for (const f of entity.fields) {
    stateLines.push(
      `        public ${renderCsType(f.type)} ${upperFirst(f.name)} { get; init; } = default!;`,
    );
  }
  stateLines.push("    }");

  const createInternalLines: string[] = [];
  createInternalLines.push(`    public static ${entity.name} _Create(State s)`);
  createInternalLines.push("    {");
  createInternalLines.push(`        var e = new ${entity.name}();`);
  createInternalLines.push("        e.Id = s.Id;");
  if (!isRoot) createInternalLines.push("        e.ParentId = s.ParentId;");
  for (const f of entity.fields) {
    createInternalLines.push(`        e.${upperFirst(f.name)} = s.${upperFirst(f.name)};`);
  }
  // Hydration path — repository's _Create.  Under --trace, label as
  // `"<init>"` so the invariant_evaluated lines for ctor / hydration
  // runs are distinguishable from in-operation evaluations.
  createInternalLines.push(
    emitTrace ? `        e.AssertInvariants("<init>");` : "        e.AssertInvariants();",
  );
  createInternalLines.push("        return e;");
  createInternalLines.push("    }");

  // Public `Create(...)` factory gated on constructibility — a
  // non-constructible aggregate exposes no public factory; it is
  // reconstructed only via `_Create` (hydration).  Assigns each create-input
  // field from its positional param.
  const createAssignments = createInputFieldList.map(
    (f) => `        e.${upperFirst(f.name)} = ${f.name};`,
  );
  const createPublicLines =
    isRoot && isAgg(entity) && hasCreate(entity) && !eventSourced
      ? [
          `    public static ${entity.name} Create(${createInputFieldList
            .map((f) => `${renderCsType(f.type)} ${f.name}`)
            .join(", ")})`,
          "    {",
          `        var e = new ${entity.name}();`,
          `        e.Id = new ${idClass}(${csNewIdValue(effIdValueType)});`,
          ...createAssignments,
          // Public Create factory — same "<init>" label as the hydration path.
          emitTrace ? `        e.AssertInvariants("<init>");` : "        e.AssertInvariants();",
          "        return e;",
          "    }",
        ]
      : [];

  // Document-shape (shape(document)) round-trip mapping.  Emitted
  // ONLY for entities inside a document aggregate.  Both methods live
  // on the entity class so they can reach private setters + the
  // `_<containment>` backing lists; the repository calls them across
  // the same assembly via `internal`.  `ToSnapshot` copies state out;
  // `FromSnapshot` rebuilds it (running AssertInvariants once, AFTER
  // the contained parts are rehydrated, so part-dependent invariants
  // see the full tree — unlike `_Create`, which only knows fields).
  const snapshotLines: string[] = [];
  if (document) {
    const toInit: string[] = [];
    toInit.push("            Id = Id,");
    if (!isRoot) toInit.push("            ParentId = ParentId,");
    for (const f of entity.fields) {
      toInit.push(`            ${upperFirst(f.name)} = ${upperFirst(f.name)},`);
    }
    for (const c of entity.contains) {
      toInit.push(
        c.collection
          ? `            ${upperFirst(c.name)} = _${c.name}.Select(__x => __x.ToSnapshot()).ToList(),`
          : `            ${upperFirst(c.name)} = ${upperFirst(c.name)}.ToSnapshot(),`,
      );
    }
    snapshotLines.push(
      `    internal ${entity.name}Snapshot ToSnapshot()`,
      "    {",
      `        return new ${entity.name}Snapshot`,
      "        {",
      ...toInit,
      "        };",
      "    }",
      "",
      `    internal static ${entity.name} FromSnapshot(${entity.name}Snapshot s)`,
      "    {",
      `        var e = new ${entity.name}();`,
      "        e.Id = s.Id;",
    );
    if (!isRoot) snapshotLines.push("        e.ParentId = s.ParentId;");
    for (const f of entity.fields) {
      snapshotLines.push(`        e.${upperFirst(f.name)} = s.${upperFirst(f.name)};`);
    }
    for (const c of entity.contains) {
      if (c.collection) {
        snapshotLines.push(
          `        foreach (var __it in s.${upperFirst(c.name)}) e._${c.name}.Add(${c.partName}.FromSnapshot(__it));`,
        );
      } else {
        snapshotLines.push(
          `        e.${upperFirst(c.name)} = ${c.partName}.FromSnapshot(s.${upperFirst(c.name)});`,
        );
      }
    }
    snapshotLines.push(
      emitTrace ? `        e.AssertInvariants("<init>");` : "        e.AssertInvariants();",
      "        return e;",
      "    }",
    );
  }

  const extraUsings = [...usings].sort().map((n) => `using ${n};`);
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      "using System.Collections.Generic;",
      "using System.Linq;",
      ...extraUsings,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.Events;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      `using ${ns}.Domain.Common;`,
      anyOpUsesCurrentUser ? `using ${ns}.Auth;` : null,
      // A concrete TPC subtype lives in its own `Domain.<Plural>` namespace
      // and inherits the abstract base from `Domain.<BasePlural>`.
      superType ? `using ${ns}.Domain.${plural(superType.name)};` : null,
      "",
      `namespace ${ns}.Domain.${plural(rootName)};`,
      "",
      `public sealed class ${entity.name}${(() => {
        const bases = [
          superType ? superType.name : null,
          isRoot && hasExtern ? `I${entity.name}Mutator` : null,
        ].filter((b): b is string => b != null);
        return bases.length > 0 ? ` : ${bases.join(", ")}` : "";
      })()}`,
      "{",
      ...propLines,
      ...eventBlock,
      ...provBlock,
      ...(isRoot ? [] : [""]),
      ...ctorLines,
      "",
      ...derivedLines,
      ...fnLines,
      ...opLines,
      ...externHookLines,
      "",
      ...pullEventsLines,
      `    ${hasExtern ? "internal" : "private"} void AssertInvariants(${emitTrace ? 'string __op = "<init>"' : ""})`,
      "    {",
      // When no invariants are declared the body is empty, which trips CA1822
      // ("can be marked as static").  AssertInvariants is intentionally kept
      // on the instance for two reasons: (a) it is called via `e.AssertInvariants()`
      // from the event-sourcing applier (line ~295) where `e` is an instance,
      // and (b) user extensions via the `internal` hatch (when `hasExtern`) may
      // add instance-touching invariants over time.  Emit a `this` discard so
      // the analyzer sees the method as instance-bound.
      ...(invariantLines.length === 0 ? ["        _ = this;"] : invariantLines),
      "    }",
      "",
      ...stateLines,
      "",
      ...createInternalLines,
      ...createPublicLines,
      ...(applierLines.length > 0 ? ["", ...applierLines] : []),
      ...esCreateFactoryLines,
      ...(snapshotLines.length > 0 ? ["", ...snapshotLines] : []),
      "}",
      ...mutatorInterfaceLines,
    ) + "\n"
  );
}

/** The abstract TPC base class (aggregate-inheritance.md, `ownTable`).
 *
 *  An abstract `ownTable` base has no table and is never instantiated; each
 *  concrete subtype is a standalone EF entity carrying the merged base + own
 *  fields.  This emits the shared C# base the concretes inherit so the
 *  polymorphic reader can return `IReadOnlyList<<Base>>`.  It declares the
 *  base's fields with `internal set` accessors (the concrete's hydration —
 *  ctor / `_Create` / `Create` — assigns them across the same assembly) plus
 *  any base-declared `derived` getters.
 *
 *  Identity stays per-concrete (each concrete keeps its own strongly-typed
 *  `<Concrete>Id`), so the base declares no `Id`; EF maps each concrete
 *  standalone via `modelBuilder.Ignore<<Base>>()` (the base is excluded from
 *  the model, its properties flatten onto each concrete's own table). */
export function renderAbstractBaseEntity(
  base: EnrichedAggregateIR,
  ns: string,
  /** TPH (`sharedTable`): the base is a *mapped* abstract entity that owns
   *  the single shared-table primary key, so it declares `Id` (concretes
   *  inherit it).  TPC (`ownTable`, the default): the base is Id-less and
   *  excluded from the EF model via `Ignore<Base>()`. */
  options: { tph?: boolean } = {},
): string {
  // TPC bases own no typed `Id` (each concrete carries its own strongly-typed
  // id); a base derived body that reads `id` must go through the boxed accessor
  // the concretes override (`IdBoxed`).  TPH bases own the shared typed `Id`.
  const renderCtx = options.tph
    ? { thisName: "this", agg: base }
    : { thisName: "this", agg: base, idAccessor: "IdBoxed" };
  const usings = new Set<string>();
  for (const d of base.derived) collectCsExprUsings(d.expr, usings);
  // A TPH base owns the shared `Id`; the concretes inherit it.  `internal set`
  // matches the field accessors so hydration (`_Create` / `Create`) assigns it
  // across the same assembly.  A TPC base owns no table/identity; it exposes a
  // boxed `IdBoxed` accessor each concrete overrides so base derived members
  // (e.g. the synthesized `inspect`) can read the concrete's id polymorphically.
  const idLines = options.tph
    ? [`    public ${base.name}Id Id { get; internal set; } = default!;`]
    : [`    public abstract object IdBoxed { get; }`];
  const propLines = base.fields.map((f) => {
    // Optional fields default to null on their own — emitting `= default`
    // explicitly trips CA1805 ("redundant initialization to default").
    // Non-optional reference types still need the null-forgiving `= default!`
    // so the non-null analyzer accepts the auto-property declaration.
    const def = f.optional ? "" : " = default!;";
    return `    public ${renderCsType(f.type)} ${upperFirst(f.name)} { get; internal set; }${def}`;
  });
  const derivedLines = base.derived.map(
    (d) =>
      `    public ${renderCsType(d.type)} ${upperFirst(d.name)} => ${renderCsExpr(d.expr, renderCtx)};`,
  );
  const extraUsings = [...usings].sort().map((n) => `using ${n};`);
  return (
    lines(
      "// Auto-generated.",
      "using System;",
      "using System.Collections.Generic;",
      "using System.Linq;",
      ...extraUsings,
      `using ${ns}.Domain.Ids;`,
      `using ${ns}.Domain.ValueObjects;`,
      `using ${ns}.Domain.Enums;`,
      "",
      `namespace ${ns}.Domain.${plural(base.name)};`,
      "",
      ...(options.tph
        ? [
            `// Abstract TPH base — the whole hierarchy maps to one table named`,
            `// for this base; it owns the shared Id + a 'kind' discriminator.`,
            `// Each concrete subtype is a derived EF entity sharing this table.`,
          ]
        : [
            `// Abstract TPC base — never instantiated; each concrete subtype is its`,
            `// own EF entity/table.  Excluded from the EF model via Ignore<${base.name}>().`,
          ]),
      `public abstract class ${base.name}`,
      "{",
      ...idLines,
      ...propLines,
      ...(derivedLines.length > 0 ? ["", ...derivedLines] : []),
      "}",
    ) + "\n"
  );
}
