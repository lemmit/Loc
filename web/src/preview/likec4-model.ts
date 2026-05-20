import type { LikeC4Model } from "likec4/model";
import type { C4Spec, C4SpecNode } from "../../../src/system/likec4.js";

export type { C4Spec };
export type LayoutedC4Model = LikeC4Model.Layouted;

// Rebuild the LikeC4 model from the toolchain's structured projection and lay
// it out with Graphviz (WASM).  The heavy LikeC4 Builder + layout engine are
// dynamically imported so they only land in the bundle once a `.c4` file is
// opened.  Returns a fully-layouted model ready for `LikeC4ModelProvider`.
//
// The Builder's fluent helpers carry compile-time element-id generics meant
// for hand-written models; here the model comes from runtime data, so the
// helpers are used untyped (`any`) — the shape is validated structurally by
// the toolchain that emits the spec.
export async function buildLayoutedModel(spec: C4Spec): Promise<LayoutedC4Model> {
  const [{ Builder }, { layoutLikeC4Model }] = await Promise.all([
    import("likec4/model/builder"),
    import("@likec4/layouts"),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const { model, views, builder } = Builder.forSpecification({
    elements: { system: {}, container: {}, component: {}, database: {} },
  }) as unknown as { model: any; views: any; builder: any };

  const buildNode = (node: C4SpecNode): any => {
    const props: Record<string, string> = { title: node.title };
    if (node.technology) props.technology = node.technology;
    const element = model[node.kind](node.localId, props);
    return node.children.length > 0 ? element.with(...node.children.map(buildNode)) : element;
  };

  const computed = builder
    .with(
      model.model(
        buildNode(spec.root),
        ...spec.relationships.map((r) => model.rel(r.source, r.target, r.label)),
      ),
      views.views(
        views.viewOf(spec.viewId, spec.viewOf, { title: spec.viewTitle }, views.$include("*")),
      ),
    )
    .toLikeC4Model();
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return layoutLikeC4Model(computed);
}
