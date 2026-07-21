// Regression: a pure `derived` whose body lowers to a block expression — a
// `match` renders to `cond do … end` — was emitted in the one-liner keyword
// form `def name(record), do: cond do … end`.  Elixir binds the trailing
// `do … end` to `def` itself there, so it sees `def/3` ("undefined function
// def/3") and the module won't compile (it broke the docker-compose parity
// build of the Phoenix backend).  The emitter now wraps a block body in parens
// (`, do: (cond do … end)`) so the `do … end` rebinds to the block; single-line
// deriveds keep the bare keyword form.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// The pure domain core (where the derived accessors live) is emitted only for an
// aggregate that declares `test` blocks — the same combination `examples/
// showcase.ddd` hits, which is where this bug reached the parity compose build.
const FIXTURE = `
system S {
  subdomain Sales {
    context Catalog {
      aggregate Thing {
        active: bool
        name: string
        // match → cond do … end (block body)
        derived label: string = match {
          (active == true) => "on",
          else => "off"
        }
        // single-line body — must stay in the bare keyword form
        derived plain: string = name
        operation rename(newName: string) { name := newName }
        test "renames" {
          let t = Thing.create({ active: true, name: "a" })
          t.rename("b")
          expect(t.name).toBe("b")
        }
      }
      repository Things for Thing { }
    }
  }
  api A from Sales
  storage primary { type: postgres }
  resource st { for: Catalog, kind: state, use: primary }
  deployable api { platform: elixir contexts: [Catalog] dataSources: [st] serves: A port: 4000 }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  throw new Error(`no generated file matched ${pattern}; have:\n${[...files.keys()].join("\n")}`);
}

describe("vanilla Phoenix: block-bodied derived accessor", () => {
  it("wraps a `cond do … end` derived body so `def` can't capture the block", async () => {
    const agg = findFile(await generateSystemFiles(FIXTURE), /api\/lib\/api\/catalog\/thing\.ex$/);

    // Block body: parenthesised keyword form — NOT the capture-prone bare form.
    expect(agg).toContain("def label(%__MODULE__{} = record), do: (cond do");
    expect(agg).toMatch(/def label\(%__MODULE__\{\} = record\), do: \(cond do[\s\S]*?end\)/);
    expect(agg).not.toMatch(/def label\(%__MODULE__\{\} = record\), do: cond do/);

    // Single-line body: unchanged bare keyword form.
    expect(agg).toContain("def plain(%__MODULE__{} = record), do: record.name");
  });
});
