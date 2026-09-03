// ---------------------------------------------------------------------------
// The generated app's own name (field-test finding E7).
//
// The browser tab is the first string a user of a scaffolded app reads, and it
// read `webApp` — the DEPLOYABLE's name, an infrastructure identifier that
// exists so `docker compose` has a service to call.  The system HAS a name
// (`system Fable { … }`); nothing was using it.
//
// The rule this pins, on every frontend that shows a title: the landing page's
// own static `title:` wins when it has one (unchanged), and the fallback is the
// SYSTEM name — never the deployable's.  Angular and Svelte already spelled it
// that way; react, vue, feliz (a hardcoded "Loom · Feliz"!) and flutter did not.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const DOMAIN = `
    subdomain S {
      context C {
        aggregate Doc with crudish {
          name: string
        }
        repository Docs for Doc { }
      }
    }
    api DemoApi from S`;

/** A scaffolded ui: its Home page declares no static `title:`, so the shell
 *  falls back — which is the case under test. */
const spa = (platform: string): string => `
  system Fable {${DOMAIN}
    ui Web with scaffold(subdomains: [S]) {
      api Ops: DemoApi
    }
    storage loomDb { type: postgres }
    resource cState { for: C, kind: state, use: loomDb }
    deployable api { platform: node, contexts: [C], dataSources: [cState], serves: DemoApi, port: 3000 }
    deployable webApp { platform: ${platform}, targets: api, ui: Web { Ops: api }, port: 3001 }
  }
`;

/** Where each frontend spells the app title, and what it should say. */
const TARGETS = [
  { name: "react", file: "index.html", title: "<title>Fable</title>" },
  { name: "vue", file: "index.html", title: "<title>Fable</title>" },
  { name: "svelte", file: "src/app.html", title: "<title>Fable</title>" },
  { name: "angular", file: "src/index.html", title: "<title>Fable</title>" },
  { name: "feliz", file: "index.html", title: "<title>Fable</title>" },
  // Flutter has no HTML shell: `MaterialApp(title:)` is what the browser tab
  // (flutter web) and the OS task switcher show.
  { name: "flutter", file: "lib/main.dart", title: "title: 'Fable'" },
] as const;

describe("E7 — the app title comes from the system, not the deployable", () => {
  for (const { name, file, title } of TARGETS) {
    it(`${name}: ${file} titles the app 'Fable', not 'webApp'`, async () => {
      const files = await generateSystemFiles(spa(name));
      const entry = [...files].find(([p]) => p.endsWith(`web_app/${file}`));
      expect(entry, `no ${file} was emitted for ${name}`).toBeDefined();
      expect(entry![1]).toContain(title);
      // The deployable name must not be what names the app.  (Checked on the
      // title-bearing file only — `webApp` legitimately appears elsewhere in a
      // project, e.g. a package name or a compose service.)
      expect(entry![1]).not.toContain("webApp");
    });
  }
});

describe("a page's own static title still wins", () => {
  it("react: a `/` page with `title:` keeps titling the shell", async () => {
    const files = await generateSystemFiles(`
  system Fable {${DOMAIN}
    ui Web {
      api Ops: DemoApi
      page Landing {
        route: "/"
        title: "Docs home"
        body: Stack { Heading { "Hi" } }
      }
    }
    storage loomDb { type: postgres }
    resource cState { for: C, kind: state, use: loomDb }
    deployable api { platform: node, contexts: [C], dataSources: [cState], serves: DemoApi, port: 3000 }
    deployable webApp { platform: react, targets: api, ui: Web { Ops: api }, port: 3001 }
  }
`);
    const html = [...files].find(([p]) => p.endsWith("web_app/index.html"))![1];
    expect(html).toContain("<title>Docs home</title>");
  });
});
