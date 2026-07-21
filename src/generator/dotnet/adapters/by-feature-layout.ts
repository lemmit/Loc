// ---------------------------------------------------------------------------
// byFeature — a real LayoutAdapter for the dotnet platform (D-REALIZATION-AXES
// Phase 5a).  The sibling of `byLayer`: same artifacts, different on-disk
// arrangement.  Where `byLayer` groups by ARCHITECTURAL LAYER
// (`Application/<Plural>/Commands`, `Api/<Agg>Controller.cs`, …), `byFeature`
// colocates everything for ONE aggregate's application + API surface under a
// single `Features/<Plural>/` folder — the "vertical slice" / feature-folders
// arrangement many .NET teams prefer.
//
// SCOPE: every PER-AGGREGATE artifact flows through the threaded layout
// dispatch and rehomes under `Features/<Plural>/` — the CQRS + controller
// surface (via `cqrsStyleAdapter.emitForAggregate`) PLUS the aggregate's domain
// model + persistence (entity / repository / EF config / join tables / document
// POCO, routed from `emitAggregate`).  CROSS-CUTTING artifacts stay layered
// (delegated to `byLayer`): context-level Domain primitives (ids, enums, value
// objects, events, common), shared Infrastructure (dbcontext, dispatcher,
// interceptor, migrations), per-context workflows, the separate Tests
// project, and the project root.  That is the intended vertical-slice shape:
// one folder per feature for its own code; shared scaffolding stays central.
//
// NAMESPACE NOTE: this adapter relocates FILES only; the matching C#
// `namespace` rewrite (a relocated file declares the namespace that mirrors
// its feature folder, e.g. `<Ns>.Features.Orders.Commands`, and every
// `using` / qualified reference across the project follows) is the sibling
// post-emit pass `../layout-namespaces.ts`, run by the orchestrator after all
// files are placed.  Compile-gated end to end by the `LOOM_DOTNET_BUILD`
// fixture `test/e2e/fixtures/dotnet-build/byfeature.ddd`.
//
// FOLDER PLURALITY: the feature folder is the PLURAL aggregate name
// (`Features/Orders/`), matching byLayer's per-aggregate folders.  This is
// load-bearing for the namespace mirror, not cosmetic: a singular folder
// would put `class Order` inside `namespace <Ns>.Features.Order`, and C#
// resolves simple names against ENCLOSING namespaces before `using`
// directives — so any cross-feature reference to `Order` (inheritance bases,
// TPH discriminator configs, polymorphic finds) would resolve the NAMESPACE
// `<Ns>.Features.Order` instead of the type (CS0118).  Plural segments vs
// singular type names keep the two name spaces disjoint by construction.
// ---------------------------------------------------------------------------

import { plural, upperFirst } from "../../../util/naming.js";
import type { EmitCtx, EmittedArtifact, LayoutAdapter } from "../../_adapters/index.js";
import { byLayerLayoutAdapter, type DotnetArtifact } from "./by-layer-layout.js";

/** Feature folder for an aggregate — the plural PascalCase aggregate
 *  name (`Orders`), same convention as `byLayer`'s per-aggregate layer
 *  folders.  Single source of truth for every feature placement.  Plural
 *  on purpose — see the FOLDER PLURALITY note above. */
const featureFolder = (name: string): string => plural(upperFirst(name));

/** Route the per-aggregate application + controller categories under
 *  `Features/<Plural>/`.  Returns `null` for any category this layout
 *  doesn't reposition — the caller then delegates to `byLayer`. */
function featurePathFor(artifact: DotnetArtifact): string | null {
  const { category: cat, name, aggregateName: agg } = artifact;
  // Every category below is per-aggregate, so `aggregateName` is required;
  // the style emitter (`cqrsStyleAdapter.emitForAggregate`) always tags it.
  const need = (): string => {
    if (!agg)
      throw new Error(`byFeature.pathFor: '${cat}' artifact missing aggregateName (${name})`);
    return featureFolder(agg);
  };
  switch (cat) {
    case "command":
    case "command-handler":
    case "command-validator":
      return `Features/${need()}/Commands/${name}`;
    case "query":
    case "query-handler":
      return `Features/${need()}/Queries/${name}`;
    case "request-dto":
      return `Features/${need()}/Requests/${name}`;
    case "response-dto":
      return `Features/${need()}/Responses/${name}`;
    case "extern-handler-interface":
    case "extern-handler-stub":
      return `Features/${need()}/Handlers/${name}`;
    case "controller":
      // The feature's API surface, colocated at the feature root.
      return `Features/${need()}/${name}`;
    // Domain model + persistence for the aggregate — the rest of the
    // vertical slice.  All flatten to the feature root (the CQRS bits keep
    // their Commands/Queries/… subfolders above).  `entity` also covers
    // the abstract-base + `<Agg>Snapshots.cs` files (same Domain folder
    // under byLayer); `ef-configuration` covers both the relational and
    // the `<Agg>DocumentConfiguration.cs` document configs.
    case "entity":
    case "repository-interface":
    case "repository-impl":
    case "ef-configuration":
    case "join-entity":
    case "join-entity-configuration":
    case "document-poco":
    case "event-record-poco":
      return `Features/${need()}/${name}`;
    default:
      // Cross-cutting / shared artifacts stay layered: context-level
      // Domain primitives (ids, enums, value objects, events,
      // domain-common), shared Infrastructure (dbcontext, dispatcher,
      // interceptor, migrations), per-context workflows, the
      // separate Tests project, and the project root.
      return null;
  }
}

export const byFeatureLayoutAdapter: LayoutAdapter = {
  name: "byFeature",

  pathFor(artifact: EmittedArtifact, ctx: EmitCtx): string {
    if (!(artifact as DotnetArtifact).category) {
      throw new Error(
        `byFeature.pathFor: artifact '${artifact.name}' is missing a category (DotnetArtifactCategory).  ` +
          `Every dotnet emit site must tag its artifact with the right category before dispatching through the layout adapter.`,
      );
    }
    const featurePath = featurePathFor(artifact as DotnetArtifact);
    // Application/API categories rehome under Features/<Plural>/; everything
    // else stays layered (delegated to byLayer) so the tree is coherent.
    return featurePath ?? byLayerLayoutAdapter.pathFor(artifact, ctx);
  },
};
