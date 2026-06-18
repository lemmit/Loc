import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
} from "../../ir/types/loom-ir.js";
import { isTpcBase, isTpcConcrete, isTphBase, isTphConcrete } from "../../ir/util/inheritance.js";
import { effectiveSavingShape } from "../../ir/util/resolve-datasource.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import { crudOpNames } from "./api-emit.js";
import { emitAggregateResources } from "./domain-emit.js";
import { renderEventModule } from "./events-emit.js";
import { renderJasonEncoderImpl } from "./jason-camel-emit.js";
import { joinEntityName, renderJoinResource } from "./join-resource-emit.js";
import { isAshReturningOpSupported } from "./operation-returns-ash-emit.js";
import { renderAshType, renderTypespec } from "./render-expr.js";
import {
  buildFindActions,
  buildRetrievalActions,
  findRepoFor,
  mergeViewFindsForAgg,
} from "./repository-emit.js";

// ---------------------------------------------------------------------------
// Context emission — one Ash.Resource per aggregate + one Ash.Domain per ctx
// ---------------------------------------------------------------------------

export function emitContext(
  appName: string,
  ctx: EnrichedBoundedContextIR,
  appModule: string,
  out: Map<string, string>,
  options: {
    resolveDataSource?: (
      agg: AggregateIR,
    ) => import("../../ir/util/resolve-datasource.js").ResolvedDataSource | undefined;
  } = {},
): void {
  const ctxSnake = snake(ctx.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  // Shared <App>.Types module — referenced by id / timestamp typespecs.
  // Emitted once at the app level by the orchestrator (index.ts).
  const typesModule = `${appModule}.Types`;

  // Enums — Ash enum types
  for (const en of ctx.enums) {
    const path = `lib/${appName}/${ctxSnake}/${snake(en.name)}.ex`;
    out.set(path, renderEnumModule(en, contextModule));
  }

  // Value objects — Ash embedded resources
  for (const vo of ctx.valueObjects) {
    const path = `lib/${appName}/${ctxSnake}/${snake(vo.name)}.ex`;
    out.set(path, renderValueObjectModule(vo, contextModule, appModule, typesModule));
  }

  // Events
  for (const ev of ctx.events) {
    const path = `lib/${appName}/${ctxSnake}/events/${snake(ev.name)}.ex`;
    out.set(path, renderEventModule(ev, contextModule, typesModule));
  }

  // Aggregates — Ash.Resource modules. Validations (operation preconditions
  // / aggregate invariants) and validate-clause emission are produced by
  // emitAggregateResources.
  const allResources: string[] = [];
  const aggFiles = emitAggregateResources(ctx, appModule, appName, {
    resolveDataSource: options.resolveDataSource,
  });
  for (const [path, content] of aggFiles) out.set(path, content);
  for (const agg of ctx.aggregates) {
    // Abstract TPC base: no Ash.Resource is emitted for it, so it is not
    // registered on the domain (and has no parts / join resources).
    if (agg.isAbstract) continue;
    allResources.push(`${contextModule}.${upperFirst(agg.name)}`);
    for (const part of agg.parts) {
      allResources.push(`${contextModule}.${upperFirst(part.name)}`);
    }
    // Reference-collection (`Id<T>[]`) join resources — one Ash.Resource
    // module per association, owning the join table.  Registered on the
    // context's Ash.Domain like any other resource so the auto-discovery
    // sees it.  Naming flows through `joinEntityName(assoc)` so all four
    // emitters (resource, configuration, domain, migration) stay in sync.
    for (const assoc of agg.associations) {
      const joinPath = `lib/${appName}/${ctxSnake}/${assoc.joinTable}.ex`;
      out.set(joinPath, renderJoinResource(assoc, contextModule, appModule));
      allResources.push(`${contextModule}.${joinEntityName(assoc)}`);
    }
  }
  // Custom find actions (repository finds + view-derived finds) are
  // spliced in via a separate side-channel — emitAggregateResources
  // doesn't yet consume customFinds, so we wrap each aggregate's
  // emitted source by injecting custom find action lines.  Until
  // emitAggregateResources accepts customFinds, the orchestrator
  // keeps its repository-find responsibility here as a post-pass.
  for (const agg of ctx.aggregates) {
    if (agg.isAbstract) continue;
    const repo = findRepoFor(ctx, agg.name);
    const repoWithViews = mergeViewFindsForAgg(agg, repo, ctx);
    if (!repoWithViews) continue;
    // Retrieval read actions (retrieval.md) join the custom finds — both
    // splice into the resource's `actions do` block the same way.
    const customFinds = [
      ...buildFindActions(repoWithViews, agg, contextModule, ctx),
      ...buildRetrievalActions(ctx, agg, contextModule),
    ];
    if (customFinds.length === 0) continue;
    const path = `lib/${appName}/${ctxSnake}/${snake(agg.name)}.ex`;
    const existing = out.get(path);
    if (!existing) continue;
    // Splice find actions before the `defaults` line inside `actions do`.
    out.set(
      path,
      existing.replace(
        /( {2}actions do\n)/,
        `$1${customFinds.map((s) => "    " + s).join("\n")}\n\n`,
      ),
    );
  }

  // Domain module per context
  const domainPath = `lib/${appName}/${ctxSnake}.ex`;
  out.set(domainPath, renderDomainModule(ctx, contextModule, allResources));
}

// ---------------------------------------------------------------------------
// Enum module
// ---------------------------------------------------------------------------

function renderEnumModule(
  en: import("../../ir/types/loom-ir.js").EnumIR,
  contextModule: string,
): string {
  const moduleName = `${contextModule}.${upperFirst(en.name)}`;
  const values = en.values.map((v) => `  :${snake(v)}`).join(",\n");
  return `# Auto-generated.
defmodule ${moduleName} do
  use Ash.Type.Enum, values: [
${values}
  ]
end
`;
}

// ---------------------------------------------------------------------------
// Value object module (embedded Ash.Resource)
// ---------------------------------------------------------------------------

function renderValueObjectModule(
  vo: import("../../ir/types/loom-ir.js").ValueObjectIR,
  contextModule: string,
  appModule: string,
  typesModule: string,
): string {
  const moduleName = `${contextModule}.${upperFirst(vo.name)}`;
  const attrLines = vo.fields.map((f) => {
    const ashType = renderAshType(f.type, contextModule);
    const opts = f.optional ? "allow_nil?: true" : "allow_nil?: false";
    return `    attribute :${snake(f.name)}, ${ashType}, ${opts}`;
  });

  // Explicit @type t — Ash 3.x auto-generates a typespec for resource
  // modules, but emitting our own gives Dialyzer / hover docs a
  // field-accurate shape that matches the IR exactly.  The IR's
  // FieldIR.optional flag corresponds to the same "| nil" the type
  // would have if it were a TypeIR `{kind: optional}`, so apply it here.
  // `typesModule` references the shared `<App>.Types` for id / timestamp.
  const typespecLines = vo.fields.map((f, i) => {
    const base = renderTypespec(f.type, contextModule, typesModule);
    const ty = f.optional && !base.endsWith("| nil") ? `${base} | nil` : base;
    const sep = i === vo.fields.length - 1 ? "" : ",";
    return `    ${snake(f.name)}: ${ty}${sep}`;
  });

  // VOs are embedded inside aggregates' wire shape, so they need the
  // camelCase Jason encoder too — same shared helper as aggregates.
  const fieldAtoms = vo.fields.map((f) => `:${snake(f.name)}`);
  const jasonImpl = renderJasonEncoderImpl(moduleName, fieldAtoms, appModule);

  return `# Auto-generated.
defmodule ${moduleName} do
  use Ash.Resource, data_layer: :embedded

  attributes do
${attrLines.join("\n")}
  end

  @type t :: %__MODULE__{
${typespecLines.join("\n")}
  }
end

${jasonImpl}`;
}

// ---------------------------------------------------------------------------
// Event modules — `renderEventModule` is now sibling-shared (see
// ./events-emit.ts).  Foundation-agnostic; the vanilla orchestrator
// reuses the same renderer.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Ash.Domain rendering (per context)
// ---------------------------------------------------------------------------

function renderDomainModule(
  ctx: BoundedContextIR,
  contextModule: string,
  resources: string[],
): string {
  // Ash 3.x: `define` calls live INSIDE the `resource ... do`
  // block, NOT in a separate top-level `code_interface do` block
  // (that was Ash 2.x; removed in 3.0).
  const resourceBlocks: string[] = [];
  const partResources = new Set<string>();
  // Parts of `shape(embedded)` aggregates are Ash *embedded* resources —
  // they are NOT domain-registered (Ash forbids an embedded resource in a
  // domain's `resources` block); they live inline in the parent's jsonb.
  const embeddedParts = new Set<string>();
  for (const agg of ctx.aggregates) {
    const isEmbedded = effectiveSavingShape(agg as EnrichedAggregateIR) === "embedded";
    for (const part of agg.parts) {
      const mod = `${contextModule}.${upperFirst(part.name)}`;
      partResources.add(mod);
      if (isEmbedded) embeddedParts.add(mod);
    }
  }
  for (const r of resources) {
    if (embeddedParts.has(r)) continue;
    const aggName = r.split(".").pop()!;
    // Locate the IR aggregate to enumerate its custom finds.
    const agg = ctx.aggregates.find((a) => upperFirst(a.name) === aggName);
    if (!agg) {
      // Entity-part resource (child table) — registered with no
      // code-interface defines; Ash 3.x's `resource X` shorthand.
      resourceBlocks.push(`    resource ${r}`);
      continue;
    }
    // A CRUD verb claimed by a public operation (e.g. crudish `update`) drops
    // its standard `define` — the per-op define below owns that name, matching
    // the cross-backend per-op form (avoids a duplicate Ash code-interface
    // define).  See CRUD_VERB_NAMES.
    const crudOps = crudOpNames(agg);
    const defines: string[] = (
      [
        ["create", `      define :create_${snake(agg.name)}, action: :create`],
        ["list", `      define :list_${snake(plural(agg.name))}, action: :read`],
        ["get", `      define :get_${snake(agg.name)}, action: :read, get_by: [:id]`],
        ["update", `      define :update_${snake(agg.name)}, action: :update, get_by: [:id]`],
        ["destroy", `      define :destroy_${snake(agg.name)}, action: :destroy, get_by: [:id]`],
      ] as const
    )
      .filter(([name]) => !crudOps.has(name))
      .map(([, src]) => src);
    const repo = ctx.repositories.find((rr) => rr.aggregateName === agg.name);
    if (repo) {
      for (const find of repo.finds) {
        // Skip the IR-enriched "all" find — `define :list_X, action: :read`
        // (above) already provides the equivalent code-interface entry.
        // Emitting `define :all_X, action: :all` would also require a
        // matching custom `read :all do end` action on the resource;
        // dropping both keeps the domain block minimal and compile-clean.
        if (find.name === "all") continue;
        const argsList = find.params.map((p) => `:${snake(p.name)}`).join(", ");
        const argsClause = argsList ? `, args: [${argsList}]` : "";
        defines.push(
          `      define :${snake(find.name)}_${snake(agg.name)}, action: :${snake(find.name)}${argsClause}`,
        );
      }
    }
    // Retrieval code-interface defines (retrieval.md): `run_<name>_<agg>`
    // invokes the retrieval's read action; `page:` rides as a call opt.
    for (const r of ctx.retrievals ?? []) {
      if (r.targetType.kind !== "entity" || r.targetType.name !== agg.name) continue;
      const argsList = r.params.map((p) => `:${snake(p.name)}`).join(", ");
      const argsClause = argsList ? `, args: [${argsList}]` : "";
      defines.push(
        `      define :run_${snake(r.name)}_${snake(agg.name)}, action: :${snake(r.name)}${argsClause}`,
      );
    }
    // Operation actions (`update :<op>`) get a code-interface define so a
    // one-click `Action(<instance>.<op>)` can invoke them directly
    // (`<Ctx>.<op>_<agg>!(record)`).  Op params become positional args.
    // A return-dominant `or`-union op (DEBT-03) is a *generic* action that
    // loads the record itself, so its interface takes `:id` first.
    for (const op of agg.operations.filter((o) => o.visibility === "public")) {
      const paramArgs = op.params.map((p) => `:${snake(p.name)}`);
      const args = isAshReturningOpSupported(op) ? [":id", ...paramArgs] : paramArgs;
      const argsClause = args.length > 0 ? `, args: [${args.join(", ")}]` : "";
      defines.push(
        `      define :${snake(op.name)}_${snake(agg.name)}, action: :${snake(op.name)}${argsClause}`,
      );
    }
    resourceBlocks.push(`    resource ${r} do\n${defines.join("\n")}\n    end`);
  }

  // Polymorphic read home for each abstract base (aggregate-inheritance.md,
  // `find all <Base>`).  The base owns no resource; its read is the union of its
  // concrete subtypes' generated `list_<concrete>` code-interface functions.
  // Emitted as plain module functions (Ash has no cross-resource read action) —
  // read-only; writes go through the concretes.  Identical shape for TPC and
  // TPH: a TPH concrete's `list_*` is already `kind`-scoped by its `base_filter`,
  // so the union over the shared table returns exactly the base's rows.
  const baseBlocks: string[] = [];
  for (const base of ctx.aggregates) {
    const tphB = isTphBase(base, ctx.aggregates);
    if (!isTpcBase(base, ctx.aggregates) && !tphB) continue;
    const concretes = ctx.aggregates.filter(
      (a) =>
        a.extendsAggregate === base.name &&
        (isTpcConcrete(a, ctx.aggregates) || isTphConcrete(a, ctx.aggregates)),
    );
    if (concretes.length === 0) continue;
    const listName = `list_${snake(plural(base.name))}`;
    const union = concretes.map((c) => `list_${snake(plural(c.name))}!()`).join(" ++ ");
    // Polymorphic return type — union of the concrete struct types.  More
    // precise than `[base.t()]` since the base owns no resource and has no
    // auto-generated struct typespec to reference.
    const elemType = concretes.map((c) => `${contextModule}.${upperFirst(c.name)}.t()`).join(" | ");
    baseBlocks.push(
      [
        `  @doc "Polymorphic read of the abstract base ${upperFirst(base.name)} — the union of its concrete subtypes."`,
        `  @spec ${listName}!() :: [${elemType}]`,
        `  def ${listName}!, do: ${union}`,
        `  @spec ${listName}() :: {:ok, [${elemType}]}`,
        `  def ${listName}, do: {:ok, ${listName}!()}`,
      ].join("\n"),
    );
  }
  // Byte-identical with the pre-inheritance output when there is no TPC base.
  const readerSection = baseBlocks.length > 0 ? `\n\n${baseBlocks.join("\n\n")}` : "";

  return `# Auto-generated.
defmodule ${contextModule} do
  use Ash.Domain

  resources do
${resourceBlocks.join("\n")}
  end${readerSection}
end
`;
}
