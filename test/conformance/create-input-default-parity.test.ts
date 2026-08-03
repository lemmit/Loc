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

// ---------------------------------------------------------------------------
// UPDATE-side: an omitted bool must be REJECTED, never silently defaulted.
//
// The sibling half of the rule above, and the one that eats data.  A create
// default is a construction rule; on UPDATE there is nothing to construct, so
// "absent" cannot mean "the default" — it can only mean "the client did not
// send a required field".  Loom's update contract is full-replacement (PUT
// carries every field), so every updatable field is required input.
//
// Applying a wire default there silently rewrote stored state: for
// `active: bool = true`, a PUT omitting `active` set it to FALSE — not even the
// declared default, because the value came from a hardcoded implicit-bool rule
// rather than the model.  This is the proto3 lesson: a wire-level default makes
// "absent" indistinguishable from "the default value", which is why proto3
// dropped custom field defaults and had to re-add explicit field presence.
//
// This is RS-26 (`test/conformance/semantics-rules.ts`, docs/conformance-
// semantics.md) — the exact inverse of RS-6, which says an omitted CREATE bool
// materializes its declared default.
//
// It began 1-vs-4 with the MINORITY correct — node's `.default(false)` had been
// added to match .NET model-binding and Phoenix, so four backends agreed and the
// agreement was wrong.  All five conform now, and NO TWO NEEDED THE SAME FIX,
// which is why the rule was worth numbering rather than patching one emitter:
//
//   node     zodFor gained a `create-body` context
//   python   requestFieldDecl gained a `slot`
//   elixir   SPEC-ONLY divergence — `@update_required` already listed every bool
//            at runtime while the OpenApiSpex schema did not
//   java     BOTH halves wrong — primitive components meant Jackson supplied
//            0/false for an omitted key while RequiredSet claimed required;
//            now boxed + @NotNull
//   dotnet   `[Required]` cannot express this at all: it tests for null, and an
//            omitted value type binds to 0/false.  Presence is a
//            DESERIALIZATION question → `[property: JsonRequired]`
//
// Each waiver dies when its backend lands the rule; the list only shrinks.
// ---------------------------------------------------------------------------

// Empty, and kept as a ratchet rather than deleted: a backend that REGRESSES
// gets an entry here plus an RS-26 `targets` row, instead of the assertion
// being quietly relaxed.
const UPDATE_BOOL_WAIVED: Partial<Record<Backend, string>> = {};

/** Is `field` REQUIRED (no default, no optionality) in the update request? */
function updateRequiresField(files: Map<string, string>, backend: Backend, field: string): boolean {
  const all = [...files.values()].join("\n");
  const pascal = field.charAt(0).toUpperCase() + field.slice(1);
  switch (backend) {
    case "node": {
      const block = sliceBlock(all, "const UpdateItemRequest = z.object({", "})");
      const decl = new RegExp(`\\b${field}:([^,\\n]*)`).exec(block);
      if (decl === null) return false;
      const zod = decl[1];
      // Requiredness in zod is "does the schema REJECT `undefined`" — which is
      // also exactly what zod-to-openapi asks (`schema.isOptional()`) when it
      // builds the served spec's `required[]`.  So the absence of `.default(`
      // is NOT enough: `z.coerce.boolean()` is `Boolean(input)`, and
      // `Boolean(undefined) === false`, so a COERCED bool accepts an omitted
      // key and yields `false` — the same silent wire default, spelled without
      // the word `default`.  This gate used to miss it, and the divergence
      // surfaced only in the 5-way OpenAPI parity run.
      return !/\.default\(|\.optional\(|\.nullish\(|z\.coerce\.boolean/.test(zod);
    }
    case "python": {
      const block = sliceBlock(all, "class UpdateItemRequest(BaseModel):", "\n\n");
      return new RegExp(`^\\s*${field}:\\s*[^=\\n]+$`, "m").test(block);
    }
    case "dotnet": {
      // `[property: JsonRequired]`, not `[Required]`: RequiredAttribute tests
      // for null, and an omitted value type binds to 0/false — non-null, so it
      // passes.  Presence is a DESERIALIZATION question, which is the one
      // JsonRequired asks.
      const block = sliceBlock(all, "public sealed record UpdateItemRequest(", ");");
      return new RegExp(`\\[property: JsonRequired\\][^,]*\\b${pascal}\\b`).test(block);
    }
    case "java": {
      const block = sliceBlock(all, 'new RequiredSet("UpdateItemRequest"', ")");
      return new RegExp(`"${field}"`).test(block);
    }
    case "vanilla": {
      // Scoped to the update-request MODULE, not the joined blob: every
      // OpenApiSpex schema carries a `required:` list, so a blob-wide
      // `indexOf("required: [")` matches whichever comes first (the shared
      // `File` schema, as it happens) and the check silently answers about the
      // wrong module.
      const mod = fileNamed(files, /update_item_request\.ex$/);
      return new RegExp(`required: \\[[^\\]]*:${field}\\b`).test(mod);
    }
  }
}

/** The one emitted file whose path matches — "" when absent, so a missing file
 *  fails the assertion rather than passing it vacuously. */
function fileNamed(files: Map<string, string>, pattern: RegExp): string {
  for (const [path, content] of files) if (pattern.test(path)) return content;
  return "";
}

function sliceBlock(source: string, from: string, to: string): string {
  const at = source.indexOf(from);
  if (at < 0) return "";
  const end = source.indexOf(to, at + from.length);
  return source.slice(at, end < 0 ? undefined : end + to.length);
}

describe("an omitted UPDATE bool is rejected, not silently defaulted", () => {
  // Both fixture bools are declared with an explicit `= default`, so a wire
  // default on the update side can only come from the implicit-bool rule.
  const BOOLS = ["active", "archived"];

  for (const backend of BACKENDS) {
    const waiver = UPDATE_BOOL_WAIVED[backend];
    it(`${BACKEND_LABEL[backend]}${waiver ? " (waived)" : ""}`, async () => {
      const files = await generateCorpusCase(FEATURE, backend);
      const required = BOOLS.filter((f) => updateRequiresField(files, backend, f));

      if (waiver) {
        // Ratchet: the waiver must still be EARNED.  If a backend starts
        // requiring its update bools, this fails and the waiver comes out —
        // a stale waiver is how a fixed gap silently stops being tracked.
        expect(
          required,
          `${BACKEND_LABEL[backend]} now requires ${required.join(", ")} on update — ` +
            `drop its UPDATE_BOOL_WAIVED entry (${waiver})`,
        ).toHaveLength(0);
        return;
      }

      expect(
        required,
        `${BACKEND_LABEL[backend]} does not require ${BOOLS.filter((f) => !required.includes(f)).join(", ")} ` +
          `on update — a PUT omitting the field will silently overwrite stored state`,
      ).toEqual(BOOLS);
    });
  }
});
