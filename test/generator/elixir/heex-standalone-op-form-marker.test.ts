// ---------------------------------------------------------------------------
// A `Modal`-less instance op-form must not vanish WITHOUT A WORD on HEEx.
//
// `renderForm` (heex-primitives.ts) bails on an instance-qualified positional —
// `OperationForm { row.<op> }` — because that shape is owned by `renderModal`,
// which consumes its form child directly.  Its comment called the guard a
// totality backstop for a shape that "is ever reached"; it IS reached:
//
//     QueryView { of: Shop.Item.all, single: true, data: row => OperationForm { row.rename } }
//
// hands the op-form straight to `renderForm` with no Modal, and the guard's
// `return ""` rendered an EMPTY `true ->` arm in the generated LiveView — no
// form, no marker, no diagnostic, just a blank panel that reads as "there is
// nothing here".  Every other target that cannot render this shape says so in
// the output (Flutter emits `const SizedBox.shrink() /* OperationForm(row.<op>):
// … */`); HEEx alone said nothing.
//
// Rendering the standalone instance op-form on LiveView needs the
// `handle_event` + form-binding half `renderModal` owns, so it is a feature,
// not a seam fix.  The visible marker is the honest minimum meanwhile.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = `
system HeexOpForm {
  subdomain S {
    context Shop {
      aggregate Item with crudish {
        name: string
        operation rename(newName: string) { name := newName }
      }
      repository Items for Item { }
    }
  }
  api ShopApi from S
  ui Web {
    framework: phoenixLiveView
    api S: ShopApi
    page Kitchen {
      route: "/k"
      body: QueryView {
        of: S.Item.all,
        single: true,
        loading: Loader { },
        empty: Empty { "none" },
        error: Alert { "err" },
        data: row => OperationForm { row.rename }
      }
    }
  }
  storage primary { type: postgres }
  resource shopState { for: Shop, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Shop]
    dataSources: [shopState]
    serves: ShopApi
    ui: Web { S: api }
    port: 4000
  }
}`;

describe("HEEx — a standalone instance OperationForm leaves a visible marker", () => {
  it("names the shape and the supported spelling instead of rendering nothing", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const live = [...files].find(([p]) => /kitchen_live\.ex$/.test(p));
    expect(live, "no Kitchen LiveView emitted").toBeDefined();
    const src = live![1];
    expect(
      src,
      "the op-form vanished without a marker — a reader sees a blank panel and cannot tell " +
        "whether the page is empty or the emitter dropped it",
    ).toMatch(/<%!--\s*OperationForm\(<instance>\.rename\)/);
    // The marker must say what DOES work, or it is only half a diagnostic.
    expect(src).toMatch(/OperationForm \{ of: <Agg>, op: rename \}/);
    // A HEEx comment is inert markup, so the page still compiles around it.
    expect(src).toContain("--%>");
  });
});
