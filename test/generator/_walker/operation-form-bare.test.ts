// ---------------------------------------------------------------------------
// `OperationForm` outside a `Modal` — the two halves that shipped broken.
//
// (1) THE ROUTE ID IS BOUND.  Both op-form shapes fall back to the route `id`
//     when no in-scope record carries one, and both spelled the hook argument
//     `id ?? ""` while marking NEITHER `usedParams` nor `usesRouteId`.  Every
//     shell gates the whole `id` binding on `usesRouteId` (React destructures
//     `useParams<{ id: string }>()`, Svelte `$derived(page.params.id ?? "")`,
//     Vue `route.params.id`), so the emitted page called
//     `use<Op><Agg>(id ?? "")` against a name it never bound — a TS2304 on a
//     page whose route DOES declare `:id`.  `emitDestroyForm` sets both flags
//     and carries a comment describing exactly this failure; the op forms did
//     not.
//
// (2) THE FORM IS REACHABLE.  A bare op form recorded its `formOfs` state and
//     returned `""`.  The shell then emitted the module-scope `<Op>Form`
//     component and its `open<Op>Modal` opener with NOTHING in the body calling
//     them — an empty page on React/Vue, and on Svelte a page that declared
//     `{#snippet <op>OpModal(…)}` (never `{@render}`ed) while calling
//     `createForm` / `toast.*` with none of the three symbols imported, because
//     `addImportsForPrimitive(ctx, "primitive-modal")` was reached only by the
//     instance-qualified shape, never the by-name one.
//
// Both shapes, all three frontends that ride the SHARED form path (Angular,
// Feliz and Flutter fork the whole primitive through `renderOperationForm` /
// `renderModal`; HEEx runs its own engine).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** `of:`/`op:` (no record in scope) vs `<inst>.<op>` (a QueryView data lambda). */
const SHAPES = {
  byName: `OperationForm { of: Item, op: activate }`,
  byInstance: `QueryView { of: Ops.Item.byId(id), single: true, data: row => OperationForm { row.activate } }`,
} as const;

const sys = (framework: string, body: string) => `
system OpForm {
  subdomain S {
    context Ops {
      aggregate Item {
        name: string
        active: bool
        operation activate(reason: string) { active := true }
      }
      repository Items for Item { }
    }
  }
  ui App {
    framework: ${framework}
    api Ops: OpsApi
    page Detail {
      route: "/items/:id"
      body: Stack { ${body} }
    }
  }
  api OpsApi from S
  storage primary { type: postgres }
  resource st { for: Ops, kind: state, use: primary }
  deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 4400 }
  deployable app { platform: static targets: api ui: App { Ops: api } port: 3007 }
}`;

/** The emitted Detail page, whichever file the framework routes it to. */
async function detailPage(framework: string, body: string): Promise<string> {
  const files = await generateSystemFiles(sys(framework, body));
  let out = "";
  for (const [p, c] of files) {
    if (/detail\.(tsx|vue)$/.test(p) || (/\+page\.svelte$/.test(p) && /items/.test(p))) out += c;
  }
  expect(out, `no Detail page emitted for ${framework}`).not.toBe("");
  return out;
}

/** How each shell brings the route `id` into scope — the `usesRouteId` binding
 *  the op form must ask for.  Present ⇒ `id ?? ""` resolves. */
const ROUTE_ID_BINDING: Record<string, RegExp> = {
  react: /useParams<\{[^}]*id: string[^}]*\}>\(\)/,
  vue: /route\.params\.id/,
  svelte: /page\.params\.id/,
};

/** The op form's trigger AS RENDERED IN THE BODY — a call site, not the
 *  module-scope declaration the shell emits either way. */
const TRIGGER_CALL: Record<string, RegExp> = {
  react: /onClick=\{\(\) => openActivateModal\(/,
  vue: /@click="openActivateModal\(/,
  svelte: /\{@render activateOpModal\(/,
};

describe.each(["react", "vue", "svelte"])("%s — bare OperationForm", (framework) => {
  it.each(Object.entries(SHAPES))("binds the route id (%s shape)", async (_shape, body) => {
    const src = await detailPage(framework, body);
    // The hook argument is the route id …
    expect(src).toMatch(/useActivateItem\(/);
    // … and the shell actually binds `id`.  Without `usesRouteId` this is the
    // TS2304: the hook reads a name nothing declares.
    expect(src, `${framework}: no route-id binding for the op form's id`).toMatch(
      ROUTE_ID_BINDING[framework]!,
    );
  });

  it.each(
    Object.entries(SHAPES),
  )("renders a reachable trigger (%s shape)", async (_shape, body) => {
    const src = await detailPage(framework, body);
    // The shell always emits the opener/snippet — asserting its mere PRESENCE
    // would pass on the broken output too (that is the whole bug: dead
    // module-scope code).  Assert the CALL SITE in the rendered body.
    expect(src, `${framework}: the op form's own trigger is never rendered`).toMatch(
      TRIGGER_CALL[framework]!,
    );
  });
});

it("svelte: a bare by-name op form imports every symbol its snippet uses", async () => {
  const src = await detailPage("svelte", SHAPES.byName);
  // The three TS2304s the primitive-modal import registration closes.  Assert
  // each only when the emitted page actually uses it — the pack owns the
  // spelling, this test owns "used ⇒ imported".
  for (const [use, imported] of [
    [/\bcreateForm\(/, /import\b[^;]*\bcreateForm\b/],
    [/\bLoomForm</, /import\b[^;]*\bLoomForm\b/],
    [/\btoast\./, /import\b[^;]*\btoast\b/],
  ] as const) {
    if (use.test(src)) {
      expect(src, `svelte: uses ${use} but never imports it`).toMatch(imported);
    }
  }
  // At least one of them must be present, or the assertion above is vacuous.
  expect(/\bcreateForm\(|\bLoomForm<|\btoast\./.test(src)).toBe(true);
});

it("a Modal-wrapped op form still renders ONE trigger — its authored label", async () => {
  const src = await detailPage(
    "react",
    `Modal { trigger: Button { "Turn on" }, OperationForm { of: Item, op: activate } }`,
  );
  // `emitModal` walks the child for its recorded state and DISCARDS the markup,
  // rendering its own trigger; the child's default trigger must not survive
  // alongside it.
  expect(src.match(TRIGGER_CALL.react!)?.length).toBe(1);
  expect(src.match(/onClick=\{\(\) => openActivateModal\(/g)?.length).toBe(1);
  expect(src).toMatch(/Turn on/);
});
