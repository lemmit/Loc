import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// `platform: vue` — language-level plumbing (vue-frontend-plan.md
// Slice 1).  Vue is the third frontend-only platform: same deployable
// contract as `react` (targets a backend, mounts a `ui:`, no contexts
// of its own), rendered against vue-format design packs
// (`vuetify` / `shadcnVue`).
// ---------------------------------------------------------------------------

const BASE = `
  subdomain M { context C { aggregate A { x: int } } }
`;

describe("validator: vue deployable", () => {
  it("accepts a vue deployable with `targets:` + `ui:`", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: vue, targets: api, ui: WebApp, port: 3003 }
      }
    `);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("emits `loom.vue-deployable-missing-ui` on a vue deployable with no ui binding", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: vue, targets: api, port: 3003 }
      }
    `);
    expect(
      errors.some(
        (e) => /Vue deployable 'web' must declare a 'ui:' binding/.test(e) && /scaffold/.test(e),
      ),
      errors.join("\n"),
    ).toBe(true);
  });

  it("requires `targets:` on a vue deployable", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: vue, ui: WebApp, port: 3003 }
      }
    `);
    expect(
      errors.some((e) => /Frontend deployable 'web' must declare 'targets:/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("rejects a vue deployable targeting another frontend", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web1 { platform: react, targets: api, ui: WebApp, port: 3001 }
        deployable web2 { platform: vue, targets: web1, ui: WebApp, port: 3003 }
      }
    `);
    expect(
      errors.some((e) => /cannot target another frontend/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("rejects a tsx design pack on a vue deployable (format mismatch, Rule 14)", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: vue, targets: api, ui: WebApp, design: mantine, port: 3003 }
      }
    `);
    expect(
      errors.some(
        (e) =>
          /is a tsx pack but framework 'vue' renders vue/.test(e) &&
          /vuetify/.test(e) &&
          /shadcnVue/.test(e),
      ),
      errors.join("\n"),
    ).toBe(true);
  });

  it("rejects a vue design pack on a react deployable (format mismatch, Rule 14)", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, ui: WebApp, design: vuetify, port: 3001 }
      }
    `);
    expect(
      errors.some((e) => /is a vue pack but framework 'react' renders tsx/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("rejects a vue design pack on a svelte deployable (format mismatch, Rule 14)", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: svelte, targets: api, ui: WebApp, design: shadcnVue, port: 3002 }
      }
    `);
    expect(
      errors.some((e) => /is a vue pack but framework 'svelte' renders svelte/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("rejects realization axes on a vue deployable (frontends carry none)", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: vue { persistence: drizzle }, targets: api, ui: WebApp, port: 3003 }
      }
    `);
    expect(
      errors.some((e) => /realization axes apply to backend deployables/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });
});
