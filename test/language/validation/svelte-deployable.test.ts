import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// `platform: svelte` — language-level plumbing (svelte-frontend-plan.md
// Slice 1).  Svelte is the second frontend-only platform: same deployable
// contract as `react` (targets a backend, mounts a `ui:`, no contexts of
// its own), rendered against svelte-format design packs
// (`shadcnSvelte` / `flowbite`).
// ---------------------------------------------------------------------------

const BASE = `
  subdomain M { context C { aggregate A { x: int } } }
`;

describe("validator: svelte deployable", () => {
  it("accepts a svelte deployable with `targets:` + `ui:`", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: svelte, targets: api, ui: WebApp, port: 3002 }
      }
    `);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("emits `loom.svelte-deployable-missing-ui` on a svelte deployable with no ui binding", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: svelte, targets: api, port: 3002 }
      }
    `);
    expect(
      errors.some(
        (e) => /Svelte deployable 'web' must declare a 'ui:' binding/.test(e) && /scaffold/.test(e),
      ),
      errors.join("\n"),
    ).toBe(true);
  });

  it("requires `targets:` on a svelte deployable", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: svelte, ui: WebApp, port: 3002 }
      }
    `);
    expect(
      errors.some((e) => /Frontend deployable 'web' must declare 'targets:/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("rejects a svelte deployable targeting another frontend", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web1 { platform: react, targets: api, ui: WebApp, port: 3001 }
        deployable web2 { platform: svelte, targets: web1, ui: WebApp, port: 3002 }
      }
    `);
    expect(
      errors.some((e) => /cannot target another frontend/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("rejects a tsx design pack on a svelte deployable (format mismatch, Rule 14)", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: svelte, targets: api, ui: WebApp, design: mantine, port: 3002 }
      }
    `);
    expect(
      errors.some(
        (e) =>
          /is a tsx pack but framework 'svelte' renders svelte/.test(e) &&
          /shadcnSvelte/.test(e) &&
          /flowbite/.test(e),
      ),
      errors.join("\n"),
    ).toBe(true);
  });

  it("rejects a svelte design pack on a react deployable (format mismatch, Rule 14)", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, ui: WebApp, design: shadcnSvelte, port: 3001 }
      }
    `);
    expect(
      errors.some((e) => /is a svelte pack but framework 'react' renders tsx/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("rejects realization axes on a svelte deployable (frontends carry none)", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: svelte { persistence: drizzle }, targets: api, ui: WebApp, port: 3002 }
      }
    `);
    expect(
      errors.some((e) => /realization axes apply to backend deployables/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });
});
