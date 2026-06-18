import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// `platform: angular` — language-level plumbing (angular-frontend-plan.md
// Slice 1).  Angular is the fourth frontend-only platform: same deployable
// contract as `react`/`svelte`/`vue` (targets a backend, mounts a `ui:`,
// no contexts of its own), rendered against angular-format design packs
// (`angularMaterial` / `primeng` / `spartanNg`).
// ---------------------------------------------------------------------------

const BASE = `
  subdomain M { context C { aggregate A { x: int } } }
`;

describe("validator: angular deployable", () => {
  it("accepts an angular deployable with `targets:` + `ui:`", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: angular, targets: api, ui: WebApp, port: 3004 }
      }
    `);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("emits `loom.angular-deployable-missing-ui` on an angular deployable with no ui binding", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: angular, targets: api, port: 3004 }
      }
    `);
    expect(
      errors.some(
        (e) =>
          /Angular deployable 'web' must declare a 'ui:' binding/.test(e) && /scaffold/.test(e),
      ),
      errors.join("\n"),
    ).toBe(true);
  });

  it("requires `targets:` on an angular deployable", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: angular, ui: WebApp, port: 3004 }
      }
    `);
    expect(
      errors.some((e) => /Frontend deployable 'web' must declare 'targets:/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("rejects an angular deployable targeting another frontend", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web1 { platform: react, targets: api, ui: WebApp, port: 3001 }
        deployable web2 { platform: angular, targets: web1, ui: WebApp, port: 3004 }
      }
    `);
    expect(
      errors.some((e) => /cannot target another frontend/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("rejects a tsx design pack on an angular deployable (format mismatch, Rule 14)", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: angular, targets: api, ui: WebApp, design: mantine, port: 3004 }
      }
    `);
    expect(
      errors.some(
        (e) =>
          /is a tsx pack but framework 'angular' renders angular/.test(e) &&
          /angularMaterial/.test(e) &&
          /primeng/.test(e) &&
          /spartanNg/.test(e),
      ),
      errors.join("\n"),
    ).toBe(true);
  });

  it("rejects an angular design pack on a react deployable (format mismatch, Rule 14)", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, ui: WebApp, design: angularMaterial, port: 3001 }
      }
    `);
    expect(
      errors.some((e) => /is a angular pack but framework 'react' renders tsx/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("rejects realization axes on an angular deployable (frontends carry none)", async () => {
    const { errors } = await parseString(`
      system S {
        ${BASE}
        ui WebApp { }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: angular { persistence: drizzle }, targets: api, ui: WebApp, port: 3004 }
      }
    `);
    expect(
      errors.some((e) => /realization axes apply to backend deployables/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });
});
