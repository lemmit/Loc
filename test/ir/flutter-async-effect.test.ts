// `loom.flutter-async-effect-unsupported` — a `match await` in a COMPONENT
// action, on a Flutter-hosted ui.
//
// THE SILENT DROP.  `src/generator/flutter/component-emit.ts`'s `candidates()`
// filters out every component whose action carries a `variant-match`
// (`hasAsyncEffectAction`) — an async effect needs the page shell's notifier and
// route id, which a component widget has no access to.  A filtered component
// gets NO widget class emitted, and every call site of it renders
// `SizedBox.shrink() /* unknown layout component */`.  So the component, its
// body and its effect vanish from the built app: `ddd parse` clean, codegen
// clean, `flutter analyze` clean, and the feature is simply not there.
//
// Feliz has the SAME component-host limitation (its async effects are projected
// per PAGE into the Elmish Msg union) and has ALWAYS gated it honestly, via
// `loom.feliz-async-effect-unsupported`.  Flutter did not — the identical `.ddd`
// was refused on one self-hosting frontend and silently emptied on the other.
//
// SCOPE: the component host ONLY.  A PAGE-level `match await` renders fine on
// Flutter (the page notifier owns the effect), which is why — unlike the Feliz
// arm — there is no subject-shape classification here: the Flutter emitter's
// filter keys on the statement KIND alone, and this gate mirrors exactly that.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.flutter-async-effect-unsupported";
const FELIZ_CODE = "loom.feliz-async-effect-unsupported";

/** A system whose ui hosts the `match await` in a COMPONENT action, reached
 *  from a `:id` detail page (so the universal
 *  `loom.instance-effect-needs-route-id` gate is satisfied and this isolates the
 *  component-host question). */
const componentHost = (platform: string) => `
system Demo {
  subdomain S {
    context C {
      error OrderMissing { missingRef: string }
      aggregate Order with crudish {
        customerId: string
        operation reserve(): Order or OrderMissing { return OrderMissing { missingRef: customerId } }
      }
    }
  }
  api A from S
  ui Web {
    api C: A
    component Confirmer(order: Order) {
      state { note: string = "" }
      action go() {
        match await C.Order.reserve() {
          Order o => { note := o.customerId }
          else    => { note := "x" }
        }
      }
      body: Button { "Go", onClick: go }
    }
    page Detail(id: Order id) {
      route: "/orders/:id"
      body: Confirmer(order: C.Order.byId(id))
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: ${platform} targets: api ui: Web { C: api } port: 3001 }
}`;

/** The same effect hosted by the `:id` PAGE instead — the supported placement. */
const pageHost = (platform: string) => `
system Demo {
  subdomain S {
    context C {
      error OrderMissing { missingRef: string }
      aggregate Order with crudish {
        customerId: string
        operation reserve(): Order or OrderMissing { return OrderMissing { missingRef: customerId } }
      }
    }
  }
  api A from S
  ui Web {
    api C: A
    page Detail(id: Order id) {
      route: "/orders/:id"
      state { note: string = "" }
      action go() {
        match await C.Order.reserve() {
          Order o => { note := o.customerId }
          else    => { note := "x" }
        }
      }
      body: Button { "Go", onClick: go }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: ${platform} targets: api ui: Web { C: api } port: 3001 }
}`;

const diagsOf = async (src: string) => {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
};
const codesOf = async (src: string): Promise<string[]> => (await diagsOf(src)).map((d) => d.code);

describe("loom.flutter-async-effect-unsupported", () => {
  it("fires for a `match await` in a COMPONENT action on a Flutter deployable", async () => {
    expect(await codesOf(componentHost("flutter"))).toContain(CODE);
  });

  it("does NOT fire for the same effect in a PAGE action — Flutter renders that", async () => {
    expect(await codesOf(pageHost("flutter"))).not.toContain(CODE);
  });

  it("is Flutter-scoped: the SPA frontends render a component effect and stay clean", async () => {
    for (const platform of ["react", "vue", "svelte", "angular"]) {
      expect(
        await codesOf(componentHost(platform)),
        `expected no Flutter gate on ${platform}`,
      ).not.toContain(CODE);
    }
  });

  it("leaves the Feliz gate untouched — each frontend raises its own code", async () => {
    const feliz = await codesOf(componentHost("feliz"));
    expect(feliz).toContain(FELIZ_CODE);
    expect(feliz).not.toContain(CODE);
    const flutter = await codesOf(componentHost("flutter"));
    expect(flutter).toContain(CODE);
    expect(flutter).not.toContain(FELIZ_CODE);
  });

  it("names the component, the action, the ui and the deployable, and says where to move it", async () => {
    const d = (await diagsOf(componentHost("flutter"))).find((x) => x.code === CODE)!;
    expect(d.severity).toBe("error");
    expect(d.source).toBe("component 'Confirmer' action 'go'");
    expect(d.message).toContain("Confirmer");
    expect(d.message).toContain("'Web'");
    expect(d.message).toContain("'web'");
    expect(d.message).toContain("PAGE action");
  });

  it("stays clean for a Flutter component with no async effect at all", async () => {
    expect(
      await codesOf(`
system Demo {
  subdomain S { context C { aggregate Order with crudish { customerId: string } } }
  api A from S
  ui Web {
    api C: A
    component Label(order: Order) { body: Text { order.customerId } }
    page Detail(id: Order id) { route: "/orders/:id"  body: Label(order: C.Order.byId(id)) }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: flutter targets: api ui: Web { C: api } port: 3001 }
}`),
    ).not.toContain(CODE);
  });
});
