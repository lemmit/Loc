import type { BoundedContextIR, EventIR, FieldIR } from "../../ir/loom-ir.js";
import { snake, pascal } from "../../util/naming.js";
import { renderAshType } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Event emitter — per `EventIR` produce a plain Elixir struct module.
//
// Events are plain `defstruct` modules.  Phoenix.PubSub broadcast wiring
// is emitted on the statement renderer side (render-stmt.ts).
//
// Output path: lib/<app>/<ctx_snake>/events/<event_snake>.ex
// Module name: <AppModule>.<CtxModule>.Events.<EventModule>
// ---------------------------------------------------------------------------

export function emitEvents(
  ctx: BoundedContextIR,
  appModule: string,
  appSnake: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const ctxModule = `${appModule}.${pascal(ctx.name)}`;
  const ctxSnake = snake(ctx.name);

  for (const ev of ctx.events) {
    const path = `lib/${appSnake}/${ctxSnake}/events/${snake(ev.name)}.ex`;
    out.set(path, renderEvent(ev, ctxModule));
  }
  return out;
}

function renderEvent(ev: EventIR, ctxModule: string): string {
  const moduleName = `${ctxModule}.Events.${pascal(ev.name)}`;
  const fieldAtoms = ev.fields.map((f) => `:${snake(f.name)}`).join(", ");
  const typespecs = ev.fields.map((f) => renderTypespec(f, ctxModule)).join("\n  ");

  return `defmodule ${moduleName} do
  @moduledoc "Domain event emitted when ${humanize(ev.name)}."

  @type t :: %__MODULE__{
  ${typespecs}
  }

  defstruct [${fieldAtoms}]
end
`;
}

function renderTypespec(f: FieldIR, ctxModule: string): string {
  const typeStr = fieldTypeString(f, ctxModule);
  return `  ${snake(f.name)}: ${typeStr}`;
}

function fieldTypeString(f: FieldIR, ctxModule: string): string {
  const t = f.type;
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "string": return "String.t()";
        case "int": return "integer()";
        case "long": return "integer()";
        case "decimal": return "Decimal.t()";
        case "bool": return "boolean()";
        case "datetime": return "DateTime.t()";
        case "guid": return "String.t()";
      }
      /* eslint-disable-next-line no-fallthrough */
    case "id":
      return "String.t()";
    case "enum":
      return `${ctxModule}.${pascal(t.name)}.t()`;
    case "valueobject":
      return `${ctxModule}.${pascal(t.name)}.t()`;
    case "entity":
      return `${ctxModule}.${pascal(t.name)}.t()`;
    case "array":
      return `list(${fieldTypeString({ ...f, type: t.element }, ctxModule)})`;
    case "optional":
      return `${fieldTypeString({ ...f, type: t.inner }, ctxModule)} | nil`;
  }
}

function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
}
