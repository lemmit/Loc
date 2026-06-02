// ---------------------------------------------------------------------------
// byFeature — a real LayoutAdapter for the dotnet platform (D-REALIZATION-AXES
// Phase 5a).  The sibling of `byLayer`: same artifacts, different on-disk
// arrangement.  Where `byLayer` groups by ARCHITECTURAL LAYER
// (`Application/<Plural>/Commands`, `Api/<Agg>Controller.cs`, …), `byFeature`
// colocates everything for ONE aggregate's application + API surface under a
// single `Features/<Aggregate>/` folder — the "vertical slice" / feature-folders
// arrangement many .NET teams prefer.
//
// SCOPE (this slice): only the per-aggregate CQRS + controller artifacts flow
// through the threaded layout dispatch today (`cqrsStyleAdapter.emitForAggregate`
// → `layout.pathFor`, see `generator/dotnet/index.ts`).  Those are the artifacts
// `byFeature` rehomes.  The Domain / Infrastructure / Tests / root files are
// still emitted with inline paths in the orchestrator (not yet threaded), so
// for every NON-application category `byFeature` DELEGATES to `byLayer` —
// keeping the tree coherent (feature folders for the app/API layer; shared
// Domain + Infrastructure stay layered).  When the F5d rewire threads the
// remaining emissions through the layout adapter, those categories move here too.
//
// NAMESPACE NOTE: this adapter relocates FILES only; the C# `namespace`
// declarations baked into each artifact's content by the style emitter are
// unchanged (a file under `Features/Order/Commands/` still declares
// `namespace <Ns>.Application.Orders.Commands`).  C# namespaces are independent
// of file paths and the `.csproj` globs `**/*.cs`, so the project compiles
// unchanged — the `LOOM_DOTNET_BUILD` gate proves it.  Namespace-by-feature is a
// later slice (it requires the style emitter to vary its content by layout).
// ---------------------------------------------------------------------------

import { upperFirst } from "../../../util/naming.js";
import type { EmitCtx, EmittedArtifact, LayoutAdapter } from "../../_adapters/index.js";
import { byLayerLayoutAdapter, type DotnetArtifact } from "./by-layer-layout.js";

/** Feature folder for an aggregate — the singular PascalCase aggregate
 *  name (`Order`), distinct from `byLayer`'s plural layer folder
 *  (`Orders`).  Single source of truth for every feature placement. */
const featureFolder = (name: string): string => upperFirst(name);

/** Route the per-aggregate application + controller categories under
 *  `Features/<Aggregate>/`.  Returns `null` for any category this layout
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
    default:
      // Not an application/API artifact (Domain, Infrastructure, Tests,
      // root, views, workflows) — keep the layered placement.
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
    // Application/API categories rehome under Features/<Agg>/; everything
    // else stays layered (delegated to byLayer) so the tree is coherent.
    return featurePath ?? byLayerLayoutAdapter.pathFor(artifact, ctx);
  },
};
