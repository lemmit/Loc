import { lowerModel } from "../../src/ir/lower.js";
import { enrichLoomModel } from "../../src/ir/enrichments.js";
import type { LoomModel } from "../../src/ir/loom-ir.js";
import type { Model } from "../../src/language/generated/ast.js";
import { parseValid } from "./parse.js";

/** Lower + enrich an already-parsed AST Model into the canonical Loom IR. */
export const toLoomModel = (model: Model): LoomModel =>
  enrichLoomModel(lowerModel(model));

/**
 * Parse a `.ddd` string, assert it validates, then lower + enrich to IR.
 * This is the canonical parse → lower → enrich path every backend consumes.
 */
export async function buildLoomModel(source: string): Promise<LoomModel> {
  return toLoomModel(await parseValid(source));
}
