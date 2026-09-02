// ---------------------------------------------------------------------------
// Two per-target body shapes that used to vanish without a word.
//
// `loom.table-filter-server-paged` / `loom.table-filter-unsupported` (M-T1.1)
//   `Table { filter: <state> }` renders on the six frameworks that ride the
//   shared `walkBody` core.  It is DROPPED, silently, in two places:
//     * on HEEx, whose parallel engine's `renderTable` handles rows / testid /
//       sort / page and lets `filter:` fall through into nothing;
//     * on any SERVER-PAGED table, where `table.ts` gates it off because the
//       rows are one server window.  That is the common case, not the exotic
//       one: `auto-paged-table.ts` rewrites the simplest hand-written
//       `QueryView { of: X.all, data: rows => Table { rows: rows, filter: q } }`
//       into the server-paged shape, so the natural spelling loses its filter
//       while `ddd parse` reports `0 error(s), 0 warning(s)` and the bound
//       state field is left as a dead `useState`.
//
// `loom.modal-controlled-op-form-unsupported` (F2-CFE-12)
//   `Modal { open: <stateBool>, OperationForm { … } }` collapses the WHOLE
//   modal — form included — to `{/* Modal: expects trigger: Button(...) … */}`
//   on react / vue / svelte / flutter, because `emitModal` only reaches the
//   controlled path when there is NO form child.  Angular and Feliz fork the
//   primitive and render the form, and HEEx's `renderModal` handles it, so this
//   is a per-target gap keyed on the rendering framework — not a rejected shape.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import {
  CONTROLLED_MODAL_OP_FORM_FRAMEWORKS,
  TABLE_FILTER_FRAMEWORKS,
} from "../../src/ir/validate/checks/ui-checks.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const FILTER_PAGED = "loom.table-filter-server-paged";
const FILTER_UNSUPPORTED = "loom.table-filter-unsupported";
const MODAL = "loom.modal-controlled-op-form-unsupported";

/** JSX-family hosts are `platform: static`; feliz and flutter self-host. */
const HOST: Record<string, string> = {
  react: "static",
  vue: "static",
  svelte: "static",
  angular: "static",
  feliz: "feliz",
  flutter: "flutter",
};

const jsSystem = (framework: string, uiBody: string) => `
system Demo {
  subdomain S {
    context C {
      aggregate Item with crudish {
        name: string
        operation activate() { }
      }
      repository Items for Item { }
    }
  }
  api A from S
  ui Web {
    framework: ${framework}
    api Shop: A
    ${uiBody}
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3000 }
  deployable web { platform: ${HOST[framework]}  targets: api  port: 3001  ui: Web { Shop: api } }
}`;

const heexSystem = (uiBody: string) => `
system Demo {
  subdomain S {
    context C {
      aggregate Item with crudish {
        name: string
        operation activate() { }
      }
      repository Items for Item { }
    }
  }
  api A from S
  ui Web {
    framework: phoenixLiveView
    api Shop: A
    ${uiBody}
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api {
    platform: elixir  contexts: [C]  dataSources: [st]  serves: A
    ui: Web { Shop: api }  port: 4000
  }
}`;

async function codes(source: string): Promise<string[]> {
  const { model, errors } = await parseString(source);
  if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code ?? "");
}

/** The hand-written paged table the auto-paged rewrite upgrades to server mode. */
const FILTERED_TABLE = `
    page Listing {
      route: "/l"
      state { q: string = "" }
      body: QueryView {
        of: Shop.Item.all,
        data: rows => Table { rows: rows, filter: q, Column { "Name", o => Text { o.name } } }
      }
    }`;

describe("loom.table-filter-server-paged", () => {
  it("flags the natural hand-written paged table on every JSX/Dart frontend", async () => {
    for (const fw of Object.keys(HOST)) {
      expect(
        await codes(jsSystem(fw, FILTERED_TABLE)),
        `${fw}: filter drop not reported`,
      ).toContain(FILTER_PAGED);
    }
  });

  it("POSITIVE CONTROL: a client table over a plain list keeps its filter", async () => {
    expect(
      await codes(
        jsSystem(
          "react",
          `
    page Listing {
      route: "/l"
      state { q: string = "" }
      body: QueryView {
        of: Shop.Item.all,
        paged: true,
        data: rows => Table {
          rows: rows.items,
          page: pageNum,
          totalPages: rows.totalPages,
          filter: q,
          Column { "Name", o => Text { o.name } }
        }
      }
      state { pageNum: int = 1 }
    }`,
        ),
      ),
    ).not.toContain(FILTER_PAGED);
  });
});

describe("loom.table-filter-unsupported", () => {
  it("flags a `filter:` on HEEx, whose engine never reads it", async () => {
    expect(await codes(heexSystem(FILTERED_TABLE))).toContain(FILTER_UNSUPPORTED);
  });

  it("does NOT fire on a framework that has the seam", async () => {
    expect(await codes(jsSystem("react", FILTERED_TABLE))).not.toContain(FILTER_UNSUPPORTED);
  });

  it("REACHABILITY: the framework Set is what makes it fire", () => {
    // The Set names all six shipping walkBody frameworks, so "the check works"
    // and "the check is unreachable" look identical from outside.  This is what
    // tells them apart — the same discipline CHART_FRAMEWORKS uses.
    expect([...TABLE_FILTER_FRAMEWORKS].sort()).toEqual([
      "angular",
      "feliz",
      "flutter",
      "react",
      "svelte",
      "vue",
    ]);
    expect(TABLE_FILTER_FRAMEWORKS.has("phoenixLiveView")).toBe(false);
  });
});

const CONTROLLED_MODAL = `
    page Board {
      route: "/b"
      state { showModal: bool = false }
      body: Tabs {
        Tab { "Ops",
          Modal { open: showModal, title: "Activate", OperationForm { of: Item, op: activate } }
        }
      }
    }`;

describe("loom.modal-controlled-op-form-unsupported", () => {
  it.each(["react", "vue", "svelte", "flutter"])("flags the combination on %s", async (fw) => {
    expect(await codes(jsSystem(fw, CONTROLLED_MODAL)), `${fw}: modal drop not reported`).toContain(
      MODAL,
    );
  });

  it.each(["angular", "feliz"])("does NOT fire on %s, which renders the form", async (fw) => {
    expect(await codes(jsSystem(fw, CONTROLLED_MODAL))).not.toContain(MODAL);
  });

  it("does NOT fire on HEEx, whose renderModal handles it", async () => {
    expect(await codes(heexSystem(CONTROLLED_MODAL))).not.toContain(MODAL);
  });

  it("POSITIVE CONTROL: the trigger shape is untouched", async () => {
    expect(
      await codes(
        jsSystem(
          "react",
          `
    page Board {
      route: "/b"
      body: Modal { trigger: Button { "Activate" }, OperationForm { of: Item, op: activate } }
    }`,
        ),
      ),
    ).not.toContain(MODAL);
  });

  it("POSITIVE CONTROL: a controlled modal with plain children is untouched", async () => {
    expect(
      await codes(
        jsSystem(
          "react",
          `
    page Board {
      route: "/b"
      state { showModal: bool = false }
      body: Modal { Text { "hi" }, open: showModal }
    }`,
        ),
      ),
    ).not.toContain(MODAL);
  });

  it("REACHABILITY: the framework Set is what makes it fire", () => {
    expect([...CONTROLLED_MODAL_OP_FORM_FRAMEWORKS].sort()).toEqual([
      "angular",
      "feliz",
      "phoenixLiveView",
    ]);
  });
});
