// ---------------------------------------------------------------------------
// byFeature — package-by-feature layout for the java platform (idiomatic
// in Spring / Spring Modulith).  Every per-aggregate artifact colocates
// under `<base>.features.<plural>`; shared artifacts (domain common,
// enums, views, config, api advice) keep their byLayer homes.
// ---------------------------------------------------------------------------

import type { EmitCtx } from "../../_adapters/index.js";
import { basePackageFor } from "../naming.js";
import {
  aggSegment,
  byLayerPackage,
  isPerAggregateCategory,
  type JavaArtifactCategory,
  type JavaLayoutAdapter,
  makeJavaLayoutAdapter,
} from "./by-layer-layout.js";

export function byFeaturePackage(
  category: JavaArtifactCategory,
  basePkg: string,
  aggregateName?: string,
): string {
  if (isPerAggregateCategory(category) && aggregateName) {
    return `${basePkg}.features.${aggSegment(aggregateName)}`;
  }
  return byLayerPackage(category, basePkg, aggregateName);
}

const basePkgOfCtx = (ctx: EmitCtx): string => basePackageFor(ctx.deployable?.name ?? "app");

export const byFeatureLayoutAdapter: JavaLayoutAdapter = makeJavaLayoutAdapter(
  "byFeature",
  byFeaturePackage,
  basePkgOfCtx,
);
