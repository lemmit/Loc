import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Negative validator test for `loom.react-deployable-missing-ui`.
//
// The legacy "no-ui → per-aggregate scaffolded pages" fallback was
// removed from the React generator.  Every React deployable now flows
// through `ui.pages` (populated either by explicit `page` declarations
// or by the `scaffold` stdlib macro).  A `platform: react` deployable
// without a `ui:` binding is no longer accepted; the validator must
// surface a precise error pointing the user at the macro form.
// ---------------------------------------------------------------------------

describe("validator: react deployable requires `ui:`", () => {
  it("emits `loom.react-deployable-missing-ui` on a react deployable with no ui binding", async () => {
    const { errors } = await parseString(`
      system S {
        module M { context C { aggregate A { x: int } } }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: react, targets: api, port: 3001 }
      }
    `);
    // The diagnostic mentions the deployable name + points the user
    // at the `with scaffold(...)` form so the fix is one keystroke away.
    expect(
      errors.some(
        (e) => /React deployable 'web' must declare a 'ui:' binding/.test(e) && /scaffold/.test(e),
      ),
      errors.join("\n"),
    ).toBe(true);
  });

  it("accepts a react deployable with an explicit `ui:` binding", async () => {
    const { errors } = await parseString(`
      system S {
        module M { context C { aggregate A { x: int } } }
        ui WebApp { }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    expect(
      errors.some((e) => /react-deployable-missing-ui/.test(e) || /must declare a 'ui:'/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("accepts a react deployable with a scaffold-populated `ui:` binding", async () => {
    // The bulk-CRUD migration path: `with scaffold(...)` populates
    // `ui.pages` for every aggregate / workflow / view in the listed
    // modules — equivalent to the legacy per-aggregate fallback.
    const { errors } = await parseString(`
      system S {
        module M {
          context C {
            aggregate A { name: string  derived display: string = name }
            repository As for A { }
          }
        }
        ui WebApp with scaffold(modules: [M]) { }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    expect(
      errors.some((e) => /react-deployable-missing-ui/.test(e) || /must declare a 'ui:'/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("does not require ui on a non-react frontend deployable that already has a separate rule (static)", async () => {
    // `static` already has its own rule from years ago; verify the
    // new rule is react-only and doesn't double-fire on `static`.
    const { errors } = await parseString(`
      system S {
        module M { context C { aggregate A { x: int } } }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: static, targets: api, port: 3001 }
      }
    `);
    // Static already errors via the pre-existing rule; the new
    // react-specific rule shouldn't also fire.
    expect(errors.some((e) => /React deployable 'web'/.test(e))).toBe(false);
    // The existing static rule still fires.
    expect(
      errors.some((e) => /Static deployable 'web'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });
});
