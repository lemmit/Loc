// .NET canonical-destroy consumption — the controller emits a
// `DELETE /{id}` action + a `Destroy<Agg>Command`/handler + a repo
// `DeleteAsync`, but ONLY when the aggregate has a canonical (unnamed)
// destroy (declared or via `crudish`).  Plain aggregates are unchanged, so
// this is purely additive.  Mirrors the Hono slice
// (test/generator/hono/hono-destroy-route.test.ts).

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseString } from "../../_helpers/index.js";

const FIXTURE = `
context Ops {
  aggregate Widget with crudish {
    label: string
    size: int
  }
  aggregate Gadget {
    name: string
  }
  repository Widgets for Widget { }
  repository Gadgets for Gadget { }
}
`;

async function gen(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(errors.join("; "));
  return generateDotnet(model);
}

describe(".NET canonical-destroy → DELETE /{id}", () => {
  it('controller emits a [HttpDelete("{id}")] action dispatching Destroy<Agg>Command', async () => {
    const files = await gen();
    const controller = files.get("Api/WidgetsController.cs");
    expect(controller, "WidgetsController.cs should be emitted").toBeDefined();
    expect(controller).toContain('[HttpDelete("{id}")]');
    expect(controller).toContain("public async Task<IActionResult> DestroyWidget([FromRoute]");
    expect(controller).toContain(
      "await _mediator.Send(new DestroyWidgetCommand(new WidgetId(id)));",
    );
    expect(controller).toContain("return NoContent();");
  });

  it("emits the Destroy command + handler (load → 404 guard → repo.DeleteAsync)", async () => {
    const files = await gen();
    expect(files.get("Application/Widgets/Commands/DestroyWidgetCommand.cs")).toContain(
      "DestroyWidgetCommand(WidgetId Id)",
    );
    const handler = files.get("Application/Widgets/Commands/DestroyWidgetHandler.cs");
    expect(handler, "DestroyWidgetHandler.cs should be emitted").toBeDefined();
    expect(handler).toContain("await _repo.GetByIdAsync(cmd.Id, ct)");
    expect(handler).toContain("throw new AggregateNotFoundException");
    expect(handler).toContain("await _repo.DeleteAsync(aggregate, ct);");
  });

  it("repository interface + impl gain DeleteAsync", async () => {
    const files = await gen();
    expect(files.get("Domain/Widgets/IWidgetRepository.cs")).toContain(
      "Task DeleteAsync(Widget aggregate, CancellationToken ct = default);",
    );
    const impl = files.get("Infrastructure/Repositories/WidgetRepository.cs");
    expect(impl).toContain(
      "public async Task DeleteAsync(Widget aggregate, CancellationToken ct = default)",
    );
    expect(impl).toContain("_db.Widgets.Remove(aggregate);");
  });

  it("plain aggregate emits no destroy command, action, or DeleteAsync (gating)", async () => {
    const files = await gen();
    expect(files.has("Application/Gadgets/Commands/DestroyGadgetCommand.cs")).toBe(false);
    expect(files.get("Api/GadgetsController.cs")).not.toContain("[HttpDelete");
    expect(files.get("Domain/Gadgets/IGadgetRepository.cs")).not.toContain("DeleteAsync");
    expect(files.get("Infrastructure/Repositories/GadgetRepository.cs")).not.toContain(
      "DeleteAsync",
    );
  });
});
