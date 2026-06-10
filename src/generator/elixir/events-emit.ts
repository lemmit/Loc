// ---------------------------------------------------------------------------
// Event struct module — `lib/<app>/<ctx>/events/<event>.ex`.
//
// Foundation-agnostic helper: a domain event lowers to a plain Elixir
// `defstruct` with a `@type t` typespec.  Both the Ash context emitter
// (`context-emit.ts`) and the vanilla orchestrator's events hook
// (`vanilla/events-emit.ts`) feed it the same EventIR; the output is the
// same struct module either way.
//
// Lives at this layer (not inside `context-emit.ts`) so the vanilla
// subtree can reuse it without importing the Ash context module — the
// extraction is mechanical, not a behaviour change for the Ash path.
// ---------------------------------------------------------------------------

import type { EventIR, TypeIR } from "../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";
import { renderTypespec } from "./render-expr.js";

export function renderEventModule(ev: EventIR, contextModule: string, typesModule: string): string {
  const moduleName = `${contextModule}.Events.${upperFirst(ev.name)}`;
  // FieldIR carries `optional` separately from TypeIR — preserve it in
  // the spec so a nullable event field is `T | nil`, not `T`.
  // `typesModule` lets the IDs lower to `<App>.Types.id()` (the shared
  // vocabulary) instead of bare `String.t()`.
  const typeFor = (f: { type: TypeIR; optional: boolean }) => {
    const base = renderTypespec(f.type, contextModule, typesModule);
    return f.optional && !base.endsWith("| nil") ? `${base} | nil` : base;
  };
  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc "Domain event: ${upperFirst(ev.name)}"

  defstruct [${ev.fields.map((f) => `:${snake(f.name)}`).join(", ")}]
  @type t :: %__MODULE__{
${ev.fields.map((f) => `    ${snake(f.name)}: ${typeFor(f)}`).join(",\n")}
  }
end
`;
}
