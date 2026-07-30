import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { createInputFields, wireCreateDefault } from "../../src/ir/enrich/wire-projection.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allAggregates } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/parse.js";
import { BACKEND_LABEL, BACKENDS, type Backend } from "../fixtures/corpus/backends.js";
import { corpusSource, generateCorpusCase } from "../fixtures/corpus/harness.js";

// ---------------------------------------------------------------------------
// Create-input default parity (G1's silent-drop arm, caught statically).
//
// `= <expr>` on a field moves it from the REQUIRED to the OMITTABLE side of the
// create request, and the backend must apply the declared value when the client
// omits it.  `wireCreateDefault` (src/ir/enrich/wire-projection.ts) is the ONE
// IR seam that says so — every backend is supposed to render it into its native
// default slot.
//
// G1 (#2316) is what happens when one doesn't.  A `this`-reading default broke
// the boot on Hono and Python, but on .NET and Java it was SILENTLY DROPPED:
// the emitted create surface simply lost the default, quietly turning an
// optional input into a required one.  Nothing caught that — the projects
// compiled, no sentinel was written, and the divergence is invisible to the
// wire-golden differential because a dropped default only shows up in a request
// that OMITS the field, which no behavioural spec sent.
//
// So this asserts the seam is honoured on all five, per backend mechanism.  The
// mechanisms genuinely differ — this is not five spellings of one check:
//
//   node    zod `.default(1)` on the create-request schema
//   python  a Pydantic model field initialiser, `qty: int = 1`
//   dotnet  a record positional-parameter default, `int Qty = 1`
//   java    NO schema default — a boxed component plus a service-side coalesce,
//           `request.qty() != null ? request.qty() : 1`
//   elixir  an Ecto schema default, `field :qty, :integer, default: 1`
//
// A backend that drops the default matches NONE of them, which is the point:
// "emitted nothing" has no textual signature of its own, so the gate looks for
// the positive mechanism instead.
// ---------------------------------------------------------------------------

const FEATURE = "field-defaults";

/** Does `files` show `field` carrying a create-time default on `backend`? */
function appliesDefault(files: Map<string, string>, backend: Backend, field: string): boolean {
  const all = [...files.values()].join("\n");
  const pascal = field.charAt(0).toUpperCase() + field.slice(1);
  switch (backend) {
    case "node":
      // zod: `qty: z.coerce.number().int().default(1),` inside CreateXRequest.
      return new RegExp(`\\b${field}:[^,\\n]*\\.default\\(`).test(createBlock(all, "z.object"));
    case "python":
      // Pydantic: `qty: int = 1` on the create model (the update model has no
      // initialiser, so an `=` on this name anywhere in a request class is the
      // create one).
      return new RegExp(`^\\s*${field}:\\s*[^=\\n]+=\\s*\\S`, "m").test(all);
    case "dotnet":
      // record positional default: `int Qty = 1`.
      return new RegExp(`\\b${pascal}\\s*=\\s*[^,)\\n]+[,)]`).test(all);
    case "java":
      // service-side coalesce on the boxed component.
      return new RegExp(`request\\.${field}\\(\\)\\s*!=\\s*null\\s*\\?`).test(all);
    case "vanilla":
      // Ecto schema default.
      return new RegExp(`field :${field},[^\\n]*default:`).test(all);
  }
}

/** Narrow to the zod object literals, so a `.default()` on an UPDATE schema
 *  can't stand in for a missing one on the create schema. */
function createBlock(source: string, marker: string): string {
  const at = source.indexOf(`CreateItemRequest = ${marker}`);
  if (at < 0) return source;
  const end = source.indexOf("})", at);
  return source.slice(at, end < 0 ? undefined : end);
}

/** The CLIENT-SUPPLIABLE fields carrying an explicit wire default — derived,
 *  not listed, so extending the fixture extends the gate.
 *
 *  Intersected with `createInputFields` deliberately: `version` (spliced by the
 *  `versioned` capability as `version: int = 1`) also carries a default, but it
 *  is a `token`-access field the client never supplies at create, so no backend
 *  owes it a create-request default slot. */
async function defaultedFields(): Promise<string[]> {
  const { model } = await parseString(corpusSource(FEATURE).replaceAll("__PLATFORM__", "node"));
  const loom = enrichLoomModel(lowerModel(model));
  return allAggregates(loom).flatMap((agg) =>
    createInputFields(agg)
      .filter((f) => wireCreateDefault(f) !== undefined)
      .map((f) => f.name),
  );
}

describe("create-input defaults reach every backend's create surface", () => {
  it("the fixture declares wire defaults for the IR to carry", async () => {
    // Guards the gate itself: if the fixture stopped declaring defaults, every
    // assertion below would vacuously pass.
    expect(await defaultedFields()).toEqual(expect.arrayContaining(["qty", "note", "active"]));
  });

  for (const backend of BACKENDS) {
    it(`${BACKEND_LABEL[backend]} applies each declared default`, async () => {
      const files = await generateCorpusCase(FEATURE, backend);
      for (const field of await defaultedFields()) {
        expect(
          appliesDefault(files, backend, field),
          `${BACKEND_LABEL[backend]} emits no create-time default for '${field}' — ` +
            `wireCreateDefault() carries one, so the client omitting it will not ` +
            `receive the declared value (this is G1's silent-drop shape)`,
        ).toBe(true);
      }
    });
  }
});
