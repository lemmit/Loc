// MultilineField + SelectField with `bind:` two-way state binding —
// the last two source-admissible input primitives that previously had
// no renderer (they fell through to an "unknown layout component"
// comment).  Same controlled-input shape as Field / Toggle:
//
//   state { notes: string = ""  region: string = "" }
//   body: Stack {
//     MultilineField { "Notes",  bind: notes },
//     SelectField    { "Region", bind: region, options: ["EU", "US"] }
//   }
//
//     →  <Textarea label="Notes" value={notes} onChange={…} />
//        <Select label="Region" data={ ["EU", "US"] } value={region} onChange={…} />
//
// (`Switch` is deliberately NOT covered: docs/page-metamodel.md removed
// it from the closed set — control-flow Switch is subsumed by `match`,
// and the boolean input is `Toggle`.  It is no longer source-admissible.)

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const page = (body: string, state: string): string => `
  system S {
    subdomain M { context C { } }
    ui WebApp {
      page Form {
        route: "/form"
        state { ${state} }
        body:  ${body}
      }
    }
    deployable api { platform: hono, contexts: [C], port: 3000 }
    deployable web {
      platform: static
      targets: api
      ui: WebApp
      port: 3001
    }
  }
`;

describe("MultilineField + SelectField with bind: state binding", () => {
  it("MultilineField { 'Label', bind: notes } wires a controlled Textarea to state", async () => {
    const files = await generateSystemFiles(
      page(`MultilineField { "Notes", bind: notes }`, `notes: string = ""`),
    );
    const content = files.get("web/src/pages/form.tsx")!;
    expect(content).toMatch(/import \{ Textarea \} from "@mantine\/core";/);
    expect(content).toMatch(/const \[notes, setNotes\] = useState<string>\(""\);/);
    expect(content).toMatch(
      /<Textarea label="Notes" value=\{notes\} onChange=\{\(e\) => setNotes\(e\.currentTarget\.value\)\} \/>/,
    );
  });

  it("SelectField { 'Label', bind: region, options: [...] } wires a controlled Select", async () => {
    const files = await generateSystemFiles(
      page(`SelectField { "Region", bind: region, options: ["EU", "US"] }`, `region: string = ""`),
    );
    const content = files.get("web/src/pages/form.tsx")!;
    expect(content).toMatch(/import \{ Select \} from "@mantine\/core";/);
    expect(content).toContain('data={ ["EU", "US"] }');
    expect(content).toMatch(
      /<Select label="Region" data=\{ \["EU", "US"\] \} value=\{region\} onChange=\{\(v\) => setRegion\(v \?\? ""\)\} \/>/,
    );
  });

  it("unbound MultilineField renders a label-only textarea", async () => {
    const files = await generateSystemFiles(
      page(`MultilineField { "Notes" }`, `unused: string = ""`),
    );
    const content = files.get("web/src/pages/form.tsx")!;
    expect(content).toContain('<Textarea label="Notes" />');
  });
});
