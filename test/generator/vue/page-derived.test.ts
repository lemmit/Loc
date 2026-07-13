// Page & component `derived name: T = expr` bindings on Vue — read-only
// computed values in the render scope, hoisted as `computed(() => …)` in
// `<script setup>` before the body.  Vue's `computed` auto-tracks deps, so
// no deps array is derived; reads re-point to `.value` in script position
// (template reads auto-unwrap).  Sequential (a derived may reference an
// earlier derived).  See docs/old/proposals/page-derived-bindings.md.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function vueFiles(uiBody: string): Promise<Map<string, string>> {
  return generateSystemFiles(`
    system Demo {
      subdomain S { context C { } }
      ui Web { ${uiBody} }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: vue, targets: api, ui: Web, port: 3001 }
    }
  `);
}

describe("Vue page/component `derived` bindings", () => {
  it("hoists a state-derived value as computed, body ref resolves (.value in script)", async () => {
    const files = await vueFiles(`
      page P {
        route: "/p"
        state { n: int = 0 }
        derived doubled: int = n + n
        body: Stack { Text { doubled } }
      }
    `);
    const sfc = files.get("web/src/pages/p.vue")!;
    expect(sfc).toContain("const doubled = computed(() => (n.value + n.value));");
    expect(sfc).toContain("const n = ref(0);");
    expect(sfc).toContain("{{ doubled }}");
    expect(sfc).toContain('import { computed, ref } from "vue";');
    expect(sfc).not.toContain("ref: doubled");
  });

  it("sequential: a derived may reference an earlier derived (.value-deref'd)", async () => {
    const files = await vueFiles(`
      page P {
        route: "/p"
        state { n: int = 0 }
        derived doubled: int = n + n
        derived quad: int = doubled + doubled
        body: Stack { Text { quad } }
      }
    `);
    const sfc = files.get("web/src/pages/p.vue")!;
    expect(sfc).toContain("const doubled = computed(() => (n.value + n.value));");
    expect(sfc).toContain("const quad = computed(() => (doubled.value + doubled.value));");
    expect(sfc).toContain("{{ quad }}");
  });

  it("works on a component (param-derived value hoists with props.<name>)", async () => {
    const files = await vueFiles(`
      component Cart(count: int) {
        derived label: string = "Items: " + count
        body: Stack { Text { label } }
      }
      page P { route: "/p" body: Stack { Cart(3) } }
    `);
    let comp = "";
    for (const [p, v] of files) if (p.endsWith("components/Cart.vue")) comp = v;
    expect(comp).toContain('const label = computed(() => ("Items: " + String(props.count)));');
    expect(comp).toContain("{{ label }}");
    expect(comp).not.toContain("ref: label");
  });
});
