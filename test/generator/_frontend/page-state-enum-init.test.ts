// A page-`state` field initialised to an ENUM VALUE must mount at that value.
//
//   enum Status { draft, live }
//   page P { state { s: Status = Status.draft } … }
//
// React and Svelte render page-state inits through the real expression
// emitter, so they always emitted `useState<string>("draft")` /
// `$state<string>("draft")`.  Vue and Angular render theirs through a local
// LITERAL-ONLY reader (`renderInitLiteral`), which handled string / number /
// bool / null / list and returned `undefined` for everything else — so
// `Status.draft` (a `ref` with `refKind: "enum-value"`) fell through to the
// TYPE ZERO and the field mounted as `ref("")` / `signal("")`.
//
// `""` is not a member of the enum, so the page started in a state the
// aggregate's own schema rejects: a select bound to it shows no selection, and
// submitting without touching it fails the server's enum check.  Silent — the
// empty string is a perfectly well-typed `string`.
//
// Found while verifying the M-T1.15 enum handoff (see
// `page-state-enum-type.md` note in the PR): the enum arm of
// `stateTypeAsTsString` is a SEPARATE, still-open issue — this test covers the
// init VALUE, not the declared TS type.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function pageSource(platform: string): Promise<string> {
  const files = await generateSystemFiles(`
    system Demo {
      subdomain S {
        context C {
          enum Status { draft, live }
          aggregate Item { name: string  status: Status }
          repository Items for Item { }
        }
      }
      api Api from S
      ui Web {
        api C: Api
        page P {
          route: "/p"
          state {
            s: Status = Status.draft
            label: string = "hello"
          }
          body: Stack { Text { s }, Text { label } }
        }
      }
      storage loomDb { type: postgres }
      resource st { for: C, kind: state, use: loomDb }
      deployable api { platform: node, contexts: [C], dataSources: [st], serves: Api, port: 3000 }
      deployable web { platform: ${platform}, targets: api, ui: Web { C: api }, port: 3001 }
    }
  `);
  for (const [path, body] of files) {
    if (!path.startsWith("web/src")) continue;
    if (/pages\/p\.|p\.component\.ts|\/p\/\+page\.svelte$/.test(path)) return body;
  }
  throw new Error(`no page emitted for ${platform}`);
}

describe("page state initialised to an enum value", () => {
  const EXPECTED: Record<string, string> = {
    react: 'const [s, setS] = useState<string>("draft");',
    vue: 'const s = ref("draft");',
    svelte: 'let s = $state<string>("draft");',
    angular: 'readonly s = signal("draft");',
  };

  for (const [platform, expected] of Object.entries(EXPECTED)) {
    it(`${platform}: mounts at the declared enum member, not the type zero`, async () => {
      const src = await pageSource(platform);
      expect(src).toContain(expected);
      // The type zero for an enum is `""`, which is not a member of the enum.
      expect(src).not.toContain('s = ref("")');
      expect(src).not.toContain('s = signal("")');
      expect(src).not.toContain('useState<string>("")');
    });

    it(`${platform}: a plain string init still works (no regression)`, async () => {
      const src = await pageSource(platform);
      expect(src).toContain('"hello"');
    });
  }
});
