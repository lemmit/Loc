// F5d — per-operation style decomposition.  The cqrs StyleAdapter's
// per-op methods (`emitHandlerOrService(op)` / `emitEndpoint(op)`) are
// real: each returns the byte-identical content the per-aggregate
// `emitForAggregate` path packages for that operation — the command /
// validator / handler (+ extern interface & stub) artifacts, and the
// controller action block — so an orchestrator may place artifacts
// operation-grained without output drift.

import { describe, expect, it, vi } from "vitest";
import type { EmitCtx, EmittedArtifact } from "../../src/generator/_adapters/index.js";
import * as cqrsStyleModule from "../../src/generator/dotnet/adapters/cqrs-style.js";
import type { EnrichedAggregateIR, OperationIR } from "../../src/ir/types/loom-ir.js";
import { generateSystems } from "../../src/system/index.js";
import { parseValid } from "../_helpers/parse.js";

const SYSTEM_SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order {
        name: string
        status: string
        operation rename(newName: string) {
          precondition newName.length > 0
          name := newName
        }
        operation close() when status == "Open" {
          status := "Closed"
        }
        operation handover(toTeam: string) extern {
          precondition toTeam.length > 0
        }
      }
      repository Orders for Order { }
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: dotnet
    contexts: [Orders]
    dataSources: [ordersState]
    port: 5000
  }
}
`;

/** Run a system generate with the per-aggregate adapter spied, capturing
 *  the (agg, ctx) it received and the artifacts it returned. */
async function captureAggregateEmit(): Promise<{
  agg: EnrichedAggregateIR;
  ctx: EmitCtx;
  artifacts: readonly EmittedArtifact[];
}> {
  const spy = vi.spyOn(cqrsStyleModule.cqrsStyleAdapter, "emitForAggregate");
  try {
    await generateSystems(await parseValid(SYSTEM_SRC));
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls[0]!;
    const artifacts = spy.mock.results[0]!.value as readonly EmittedArtifact[];
    return { agg: call[0] as EnrichedAggregateIR, ctx: call[1] as EmitCtx, artifacts };
  } finally {
    spy.mockRestore();
  }
}

function opNamed(agg: EnrichedAggregateIR, name: string): OperationIR {
  const op = agg.operations.find((o) => o.name === name);
  expect(op, `operation ${name}`).toBeDefined();
  return op!;
}

describe("F5d — cqrs per-operation decomposition", () => {
  it("emitHandlerOrService(op) returns the per-aggregate path's exact command/validator/handler artifacts", async () => {
    const { agg, ctx, artifacts } = await captureAggregateEmit();
    const byName = new Map(artifacts.map((a) => [a.name, a]));

    const rename = cqrsStyleModule.cqrsStyleAdapter.emitHandlerOrService(
      opNamed(agg, "rename"),
      ctx,
    );
    // rename: command + FluentValidation validator (from the wire-translatable
    // precondition) + handler.
    expect(rename.map((a) => a.name).sort()).toEqual([
      "RenameCommand.cs",
      "RenameCommandValidator.cs",
      "RenameHandler.cs",
    ]);
    for (const a of rename) {
      expect(byName.get(a.name)?.content, a.name).toBe(a.content);
      expect(byName.get(a.name)?.category, a.name).toBe(a.category);
      expect(a.aggregateName).toBe("Order");
    }
  });

  it("an extern op yields the same command trio (the hook is a partial member of the aggregate)", async () => {
    const { agg, ctx, artifacts } = await captureAggregateEmit();
    const byName = new Map(artifacts.map((a) => [a.name, a]));
    const handover = cqrsStyleModule.cqrsStyleAdapter.emitHandlerOrService(
      opNamed(agg, "handover"),
      ctx,
    );
    // The extern op is now a domain extension point (a `partial` method that is
    // a member of the aggregate), so its cqrs decomposition is identical to a
    // normal op — command + validator + handler — with no injected per-op
    // handler interface or dev stub.  The hook itself lives in the aggregate's
    // co-located scaffold-once `<Agg>.Extern.cs` partial (emitted at aggregate
    // level, asserted in the dotnet generator tests).
    expect(handover.map((a) => a.name).sort()).toEqual([
      "HandoverCommand.cs",
      "HandoverCommandValidator.cs",
      "HandoverHandler.cs",
    ]);
    expect(handover.map((a) => a.category).sort()).toEqual([
      "command",
      "command-handler",
      "command-validator",
    ]);
    for (const a of handover) {
      expect(byName.get(a.name)?.content, a.name).toBe(a.content);
    }
  });

  it("emitEndpoint(op) returns the exact action block the aggregate controller contains", async () => {
    const { agg, ctx, artifacts } = await captureAggregateEmit();
    const controller = artifacts.find((a) => a.category === "controller");
    expect(controller).toBeDefined();

    for (const name of ["rename", "close", "handover"]) {
      const lines = cqrsStyleModule.cqrsStyleAdapter.emitEndpoint(opNamed(agg, name), ctx);
      expect(lines.length).toBeGreaterThan(0);
      // The per-op block appears verbatim (contiguously) in the
      // controller file the per-aggregate path emitted.
      expect(controller!.content, `endpoint block for ${name}`).toContain(lines.join("\n"));
    }
    // The when-gated op's block carries the can_<op> companion + 409.
    const close = cqrsStyleModule.cqrsStyleAdapter.emitEndpoint(opNamed(agg, "close"), ctx);
    const closeText = close.join("\n");
    expect(closeText).toContain('[HttpGet("{id}/can_close")]');
    expect(closeText).toContain("[ProducesResponseType(typeof(ProblemDetails), 409)]");
  });
});
