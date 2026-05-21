import type { SerializedNodes } from "@craftjs/core";
import { isContainer, type BuilderNode, type PrimitiveName } from "./model.js";

// Adapter between the craft-agnostic `BuilderNode` tree and craft.js's
// `SerializedNodes` map (the format `<Frame data>` and `query.serialize()`
// speak).  The root node id must be "ROOT".

// craft requires the root node to be a canvas, but a page body may be a leaf
// (e.g. `body: Heading(...)`).  We wrap the body in a synthetic `Root` canvas
// that is never emitted — the real body is its single child.
export function toCraft(root: BuilderNode): SerializedNodes {
  const nodes: Record<string, unknown> = {
    ROOT: {
      type: { resolvedName: "Root" },
      isCanvas: true,
      props: {},
      parent: null,
      displayName: "Root",
      custom: {},
      hidden: false,
      nodes: ["body"],
      linkedNodes: {},
    },
  };
  const add = (node: BuilderNode, id: string, parent: string): void => {
    const childIds = node.children.map((_, i) => `${id}-${i}`);
    nodes[id] = {
      type: { resolvedName: node.name },
      isCanvas: isContainer(node.name),
      props: { ...node.props },
      parent,
      displayName: node.name,
      custom: {},
      hidden: false,
      nodes: childIds,
      linkedNodes: {},
    };
    node.children.forEach((c, i) => add(c, childIds[i], id));
  };
  add(root, "body", "ROOT");
  return nodes as SerializedNodes;
}

type RawNode = {
  type: string | { resolvedName: string };
  props: Record<string, string | number | undefined>;
  nodes?: string[];
};

function fromNode(nodes: Record<string, RawNode>, id: string): BuilderNode {
  const n = nodes[id];
  const name = (typeof n.type === "string" ? n.type : n.type.resolvedName) as PrimitiveName;
  return {
    name,
    props: { ...n.props },
    children: (n.nodes ?? []).map((cid) => fromNode(nodes, cid)),
  };
}

/** Recover the body tree (unwrapping the synthetic `Root`). */
export function fromCraft(nodes: SerializedNodes): BuilderNode {
  const raw = nodes as unknown as Record<string, RawNode>;
  const bodyId = raw.ROOT.nodes?.[0];
  if (!bodyId) throw new Error("fromCraft: empty Root");
  return fromNode(raw, bodyId);
}
