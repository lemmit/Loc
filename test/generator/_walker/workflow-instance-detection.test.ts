// Workflow-instance api-hook detection (workflow-instance-visibility.md):
// `<Workflow>.instances.all` (Pattern F) and `<Workflow>.instances.byId(id)`
// (Pattern G) resolve to a `workflow-instance` DetectedApiCall carrying the
// workflow name + operation, so the React walker hoists the right query hook.

import { describe, expect, it } from "vitest";
import { tryDetectApiHook } from "../../../src/generator/_walker/api-hook-detector.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";

const ctx = {
  apiParamNames: new Set<string>(),
  aggregatesByName: new Set<string>(["Order"]),
  workflowsByName: new Set<string>(["Fulfillment"]),
};

const ref = (name: string) => ({ kind: "ref", name }) as unknown as ExprIR;
const member = (receiver: ExprIR, m: string) =>
  ({ kind: "member", receiver, member: m }) as unknown as ExprIR;
const methodCall = (receiver: ExprIR, m: string, args: ExprIR[]) =>
  ({ kind: "method-call", receiver, member: m, args }) as unknown as ExprIR;

describe("workflow-instance api-hook detection", () => {
  it("detects `<Workflow>.instances.all` (Pattern F)", () => {
    const expr = member(member(ref("Fulfillment"), "instances"), "all");
    expect(tryDetectApiHook(expr, ctx)).toEqual({
      aggregateName: "Fulfillment",
      operation: "all",
      args: [],
      kind: "workflow-instance",
    });
  });

  it("detects `<Workflow>.instances.byId(id)` (Pattern G) with its arg", () => {
    const idArg = ref("id");
    const expr = methodCall(member(ref("Fulfillment"), "instances"), "byId", [idArg]);
    expect(tryDetectApiHook(expr, ctx)).toEqual({
      aggregateName: "Fulfillment",
      operation: "byId",
      args: [idArg],
      kind: "workflow-instance",
    });
  });

  it("ignores `.instances.all` on a name that isn't a known workflow", () => {
    const expr = member(member(ref("Order"), "instances"), "all");
    expect(tryDetectApiHook(expr, ctx)).toBeNull();
  });

  it("does not fire when workflowsByName is absent from the context", () => {
    const expr = member(member(ref("Fulfillment"), "instances"), "all");
    expect(
      tryDetectApiHook(expr, {
        apiParamNames: new Set<string>(),
        aggregatesByName: new Set<string>(),
      }),
    ).toBeNull();
  });
});
