// Page & component `derived name: T = expr` on Phoenix/HEEx — LiveView has
// no render-scope hoist site, so a derived ref INLINE-RECOMPUTES: the
// binding's expr is substituted at each use (LiveView re-renders on assign
// change, so each use stays fresh).  A derived referencing an earlier
// derived resolves via the same substitution (recursively).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (ui: string): string => `
  system Demo {
    subdomain S { context C { } }
    ui Web { ${ui} }
    api Api from S
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable app {
      platform: elixir
      contexts: [C] dataSources: [cState] serves: Api ui: Web port: 4000
    }
  }
`;

function file(files: Map<string, string>, suffix: string): string {
  for (const [p, v] of files) if (p.endsWith(suffix)) return v;
  return "";
}

describe("Phoenix/HEEx `derived` bindings (inline-recompute)", () => {
  it("substitutes a page derived's expr at the use site (state → @assign)", async () => {
    const files = await generateSystemFiles(
      SYS(
        `page P { route: "/p" state { n: int = 0 } derived doubled: int = n + n body: Stack { Text { doubled } } }`,
      ),
    );
    const live = file(files, "p_live.ex");
    expect(live).toContain("<%= (@n + @n) %>");
    // No un-substituted bare ref.
    expect(live).not.toMatch(/<%=\s*@?doubled\s*%>/);
  });

  it("a derived referencing an earlier derived substitutes recursively", async () => {
    const files = await generateSystemFiles(
      SYS(
        `page P { route: "/p" state { n: int = 0 } derived doubled: int = n + n derived quad: int = doubled + doubled body: Stack { Text { quad } } }`,
      ),
    );
    expect(file(files, "p_live.ex")).toContain("<%= ((@n + @n) + (@n + @n)) %>");
  });

  it("works on a component (param → @attr inside the substituted expr)", async () => {
    const files = await generateSystemFiles(
      SYS(
        `component Badge(count: int) { derived label: string = "n=" + count body: Stack { Text { label } } } page P { route: "/p" body: Stack { Badge(3) } }`,
      ),
    );
    expect(file(files, "ui_components.ex")).toContain('<%= ("n=" <> to_string(@count)) %>');
  });
});
