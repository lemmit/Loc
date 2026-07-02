// Top-level (implicit-composition) system members must run through the same
// per-System check family as their nested siblings (full-review remediation
// §B6, audit finding 23).  A `platform: react` deployable with no `ui:`
// errored when nested in `system { }` but passed when written at file top
// level (folding into the project's single system) — the dispatcher only
// descended into nested members.  See `src/language/ddd-validator.ts`.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const parse = (source: string) => parseString(source);

describe("validator: top-level composition members get per-System checks", () => {
  it("flags a top-level react deployable missing `ui:` — the same as nested", async () => {
    const { errors } = await parse(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
      }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: react, targets: api, port: 3001 }
    `);
    expect(
      errors.some((e) => /React deployable 'web' must declare a 'ui:' binding/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("errors identically for the nested form (control)", async () => {
    const { errors } = await parse(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, port: 3001 }
      }
    `);
    expect(
      errors.some((e) => /React deployable 'web' must declare a 'ui:' binding/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("accepts a well-formed top-level react deployable (with `ui:`)", async () => {
    const { errors } = await parse(`
      system S {
        subdomain M {
          context C {
            aggregate A { name: string  derived display: string = name }
            repository As for A { }
          }
        }
      }
      ui WebApp with scaffold(subdomains: [M]) { }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
    `);
    expect(
      errors.some((e) => /must declare a 'ui:'/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });
});
