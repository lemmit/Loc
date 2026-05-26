// ---------------------------------------------------------------------------
// HEEx walker target — concrete `WalkerTarget` implementation
// consumed by `src/generator/phoenix-live-view/heex-walker.ts` for the
// state / navigation / match seams.
//
// Behavioural contract: the methods MUST return byte-identical
// fragments to the inlined seams they replaced.  See the heex-* test
// suite (heex-walker.test.ts, heex-state-mutations.test.ts) for the
// exact expectations.
//
// State syntax (HEEx):
//   - read at template position →  `@step`
//   - read at handler position  →  `socket.assigns.step`
//   - `state := v`              →  `|> assign(:step, v)`
//
// Navigation: `push_navigate(socket, to: ~p"/path")` — `state:` is
// ignored (LiveView reads query params, not React-Router state).
//
// Match: `cond do … end`; caller wraps in `<%= … %>` at template
// position.
// ---------------------------------------------------------------------------

import type { TypeIR } from "../../../ir/loom-ir.js";
import type { RenderPosition, WalkerTarget } from "../../_walker/target.js";
import { snake } from "../../../util/naming.js";

/** HEEx/Phoenix-LiveView WalkerTarget implementation. */
export const heexTarget: WalkerTarget = {
  framework: "phoenixLiveView",

  stateRead(name: string, position: RenderPosition): string {
    const s = snake(name);
    return position === "template" ? `@${s}` : `socket.assigns.${s}`;
  },

  stateWrite(name: string, value: string): string {
    return `|> assign(:${snake(name)}, ${value})`;
  },

  stateCompoundWrite(_name: string, _op: "+" | "-", _value: string): string {
    // HEEx page-state compound updates (`state.count += 1`) are
    // expressed via the same assign pipe — the caller computes the
    // new value first.  Not currently invoked from the HEEx walker
    // (the walker doesn't lower `+=` / `-=` for page state yet) so
    // a clear marker is emitted if it ever is.
    throw new Error(
      "heexTarget: compound state writes (+=/-=) not yet supported in HEEx walker",
    );
  },

  renderNavigate(route: string, _state: string | undefined): string {
    // The route is already in `~p` shape with `:param`/interpolation.
    return `push_navigate(socket, to: ~p"${route}")`;
  },

  renderMatch(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
    position: RenderPosition,
  ): string {
    const armsHeex = arms.map((a) => `      ${a.predicate} -> ${a.value}`).join("\n");
    const elseLine = elseArm !== undefined ? `\n      true -> ${elseArm}` : "";
    const cond = `cond do\n${armsHeex}${elseLine}\n    end`;
    return position === "template" ? `<%= ${cond} %>` : cond;
  },

  defaultInitFor(t: TypeIR): string {
    switch (t.kind) {
      case "optional":
        return "nil";
      case "primitive":
        switch (t.name) {
          case "int":
          case "long":
          case "decimal":
            return "0";
          case "money":
            return `Decimal.new("0")`;
          case "bool":
            return "false";
          case "string":
          case "guid":
            return `""`;
          case "datetime":
            return "DateTime.utc_now()";
          default:
            return "nil";
        }
      case "id":
        return "nil";
      case "array":
        return "[]";
      default:
        return "nil";
    }
  },
};
