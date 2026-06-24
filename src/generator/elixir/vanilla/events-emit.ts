// ---------------------------------------------------------------------------
// Vanilla orchestrator hook for event struct modules.
//
// Per-context fan-out over `ctx.events` calling the shared sibling
// `renderEventModule` (see ../events-emit.ts).
// Files: `lib/<app>/<ctx>/events/<event>.ex`.
//
// Emitted unconditionally — even a context with no `emit` in any
// workflow may have channel handlers that pattern-match the struct, and
// a future channel-on-vanilla slice consumes the same module path.
// ---------------------------------------------------------------------------

import type { BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { renderEventModule } from "../events-emit.js";

export function emitVanillaEventModules(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
): void {
  if (ctx.events.length === 0) return;
  const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
  const ctxSnake = snake(ctx.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const typesModule = `${appModule}.Types`;
  for (const ev of ctx.events) {
    out.set(
      `lib/${appSnake}/${ctxSnake}/events/${snake(ev.name)}.ex`,
      renderEventModule(ev, contextModule, typesModule),
    );
  }
}
