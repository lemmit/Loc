// The `error:` slot on bindable inputs — the ergonomic half of
// dependent form validation "the state way" (page-metamodel §8.2).
// The expression is walked in page scope (reads state/derived) and
// renders in EACH pack's native error idiom.  This locks the fan-out:
// Mantine's `error=` prop, shadcn's destructive `<p>`, MUI's
// `helperText`, Chakra's `ErrorText`, Vuetify's `:error-messages`,
// Svelte's `{#if}` span, and Angular's `@if`-gated span are all
// structurally different — one test per idiom family.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const src = (framework: string, design: string) => `
  system S {
    subdomain M { context C { } }
    ui WebApp {
      framework: ${framework}
      page SignUp {
        route: "/signup"
        state { password: string = "" confirmPassword: string = "" }
        body: Stack {
          PasswordField { "Confirm", bind: confirmPassword,
                          error: confirmPassword == password ? "" : "Passwords must match" }
        }
      }
    }
    deployable api { platform: node, contexts: [C], port: 3000 }
    deployable web { platform: static targets: api ui: WebApp design: ${design} port: 3001 }
  }`;

/** Find the emitted SignUp page module (path differs per framework). */
async function pageFor(framework: string, design: string): Promise<string> {
  const files = await generateSystemFiles(src(framework, design));
  for (const [k, v] of files) {
    if (/sign.?up/i.test(k) && !k.includes("e2e") && v.includes("Passwords must match")) return v;
  }
  throw new Error(`no SignUp page emitted for ${framework}/${design}`);
}

describe("error: slot renders in each pack's native error idiom", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["react", "mantine", /error=\{[^}]*Passwords must match/],
    ["react", "shadcn", /text-destructive">\{[^}]*Passwords must match/],
    ["react", "mui", /helperText=\{[^}]*Passwords must match/],
    ["react", "chakra", /ErrorText>\{[^}]*Passwords must match/],
    ["vue", "vuetify", /:error-messages='[^']*Passwords must match/],
    ["vue", "shadcnVue", /v-text='[^']*Passwords must match/],
    ["svelte", "shadcnSvelte", /text-red-500">\{[^}]*Passwords must match/],
    ["svelte", "flowbite", /text-red-600">\{[^}]*Passwords must match/],
    ["angular", "angularMaterial", /loom-error">\{\{[^}]*Passwords must match/],
    ["angular", "spartanNg", /loom-error">\{\{[^}]*Passwords must match/],
    ["angular", "primeng", /loom-error">\{\{[^}]*Passwords must match/],
  ];

  for (const [framework, design, idiom] of cases) {
    it(`${framework}/${design} renders the error message in its slot`, async () => {
      const page = await pageFor(framework, design);
      expect(page).toMatch(idiom);
    });
  }
});
