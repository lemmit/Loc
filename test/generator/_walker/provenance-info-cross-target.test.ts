// ---------------------------------------------------------------------------
// ProvenanceInfo disclosure — scaffold + cross-frontend render gate.
//
// A `provenanced` field records the lineage of every value it holds
// (docs/provenance.md).  The lineage rides the wire as a co-located
// `<field>_provenance` sibling; on a scaffolded DETAIL page the field's value
// now pairs with a `ProvenanceInfo` "?" disclosure that reveals where the value
// came from (rule id + computed value + the input list).
//
// React-first (the chosen scope): the React generator surfaces the lineage on
// the response schema (`provLineageSchema`) and renders a native `<details>`
// disclosure.  The other JSX frontends fall through to a visible comment — the
// value still renders, only the "?" is absent — and DON'T carry the lineage on
// their schema (byte-identical to before).  This proves both halves end-to-end
// through the real generators.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** A scaffolded aggregate with a `provenanced` `total`, served by a node
 *  backend and hosted on `frontend`. */
const provScaffoldSystem = (frontend: string): string => `
  system ProvDemo {
    subdomain Ordering {
      context Ordering {
        aggregate Order with crudish {
          reference: string
          quantity: int
          unitPrice: int
          discount: int
          total: int provenanced
          operation reprice(qty: int, price: int) {
            quantity := qty
            unitPrice := price
            total := qty * price - discount
          }
          derived display: string = reference
        }
        repository Orders for Order { }
      }
    }
    ui Web with scaffold(subdomains: [Ordering]) { }
    storage primary { type: postgres }
    resource orderingState { for: Ordering, kind: state, use: primary }
    deployable api {
      platform: node, contexts: [Ordering], dataSources: [orderingState], port: 3000
    }
    deployable web { platform: ${frontend}, targets: api, ui: Web, port: 3001 }
  }
`;

/** Concatenate every generated file so the assertions stay path-agnostic. */
function allFiles(files: Map<string, string>): string {
  let all = "";
  for (const content of files.values()) all += `\n${content}`;
  return all;
}

describe("ProvenanceInfo — React renders a `<details>` disclosure over the lineage", () => {
  it("surfaces the lineage on the response schema + shared lib", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("react")));
    // The shared lib exports the nullable lineage carrier.
    expect(out).toContain("export const provLineageSchema = z.object({");
    expect(out).toContain("snapshotId: z.string()");
    // The Order response schema carries the co-located sibling + imports it.
    expect(out).toContain('import { provLineageSchema } from "../lib/schemas";');
    expect(out).toContain("total_provenance: provLineageSchema.nullish(),");
  });

  it("renders the disclosure on the scaffolded detail page", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("react")));
    expect(out).toContain('data-testid="orders-detail-total-prov"');
    expect(out).toMatch(/<details className="loom-provenance"/);
    // Null-guarded, then the rule id + computed value + input list.
    expect(out).toMatch(/\.total_provenance != null \? \(/);
    expect(out).toContain(".total_provenance.snapshotId}");
    expect(out).toContain("String(");
    expect(out).toMatch(/\.total_provenance\.inputs\.map\(\(inp\) => \(/);
    // The value itself still renders next to the disclosure (inside a Group).
    expect(out).toContain(".total}");
  });
});

describe("ProvenanceInfo — Vue renders a `<details v-if>` disclosure over the lineage", () => {
  it("surfaces the lineage on the response schema + shared lib", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("vue")));
    expect(out).toContain("export const provLineageSchema = z.object({");
    expect(out).toContain('import { provLineageSchema } from "../lib/schemas";');
    expect(out).toContain("total_provenance: provLineageSchema.nullish(),");
  });

  it("renders the disclosure on the scaffolded detail page", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("vue")));
    expect(out).toContain('data-testid="orders-detail-total-prov"');
    // Vue guards with `v-if`, interpolates with `{{ }}`, iterates with `v-for`.
    expect(out).toMatch(/<details v-if="[\w.]+\.total_provenance != null" class="loom-provenance"/);
    expect(out).toContain(".total_provenance.snapshotId }}");
    expect(out).toMatch(/v-for="inp in [\w.]+\.total_provenance\.inputs" :key="inp\.path"/);
  });
});

describe("ProvenanceInfo — Svelte renders an `{#if}`/`{#each}` disclosure", () => {
  it("surfaces the lineage on the response schema + shared lib", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("svelte")));
    expect(out).toContain("export const provLineageSchema = z.object({");
    expect(out).toContain('import { provLineageSchema } from "../schemas";');
    expect(out).toContain("total_provenance: provLineageSchema.nullish(),");
  });

  it("renders the disclosure on the scaffolded detail page", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("svelte")));
    expect(out).toContain('data-testid="orders-detail-total-prov"');
    // Svelte guards with `{#if}`, interpolates with `{expr}`, iterates keyed.
    expect(out).toMatch(/\{#if [\w.]+\.total_provenance != null\}/);
    expect(out).toContain("{orderById.data.total_provenance.snapshotId}");
    expect(out).toMatch(/\{#each [\w.]+\.total_provenance\.inputs as inp \(inp\.path\)\}/);
  });
});

describe("ProvenanceInfo — Angular renders an `@if (…; as prov)` disclosure", () => {
  it("surfaces the lineage on the response interface (no shared zod lib)", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("angular")));
    // Angular has no zod lib — the lineage is a plain TS interface + a field.
    expect(out).toContain("export interface ProvLineage {");
    expect(out).toContain("total_provenance?: ProvLineage | null;");
  });

  it("renders the disclosure on the scaffolded detail page", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("angular")));
    expect(out).toContain('data-testid="orders-detail-total-prov"');
    // A signal-call result can't narrow in place — the `as prov` alias binds it.
    expect(out).toMatch(/@if \([\w.()!]+\.total_provenance; as prov\)/);
    expect(out).toContain("{{ prov.snapshotId }}");
    // `unknown` values ride `$any(...)` (templates can't call `String`).
    expect(out).toContain("{{ $any(prov.computedValue) }}");
    expect(out).toContain("@for (inp of prov.inputs; track inp.path)");
  });
});

describe("ProvenanceInfo — Feliz renders an F# `Html.details` disclosure", () => {
  it("carries the lineage as an F# ProvLineage record + Thoth decoder", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("feliz")));
    expect(out).toContain("type ProvLineage =");
    expect(out).toContain("let provLineageDecoder : Decoder<ProvLineage> =");
    // The Order record field + its optional decode.
    expect(out).toContain("total_provenance: ProvLineage option");
    expect(out).toContain(
      'total_provenance = get.Optional.Field "total_provenance" provLineageDecoder',
    );
  });

  it("renders the disclosure (Some/None match over the lineage option)", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("feliz")));
    expect(out).toMatch(/match [\w.]+\.total_provenance with Some __p -> Html\.details/);
    expect(out).toContain('Html.details [ prop.className "loom-provenance"');
    expect(out).toContain("for __i in __p.inputs");
    // The scaffold's Group wrapper is paren-wrapped (the walker fix that
    // unblocked Feliz) — otherwise Fable rejects the nested container.
    expect(out).toContain(
      'prop.children [ (Html.div [ prop.className "flex flex-row flex-wrap items-center gap-2"',
    );
  });
});

/** The HEEx twin of `provScaffoldSystem`: Phoenix LiveView is fullstack, so the
 *  scaffolded ui is hosted ON the elixir backend (no separate frontend
 *  deployable / no `targets:` — the detail page renders server-side). */
const provScaffoldHeex = `
  system ProvDemo {
    subdomain Ordering {
      context Ordering {
        aggregate Order with crudish {
          reference: string
          quantity: int
          unitPrice: int
          discount: int
          total: int provenanced
          operation reprice(qty: int, price: int) {
            quantity := qty
            unitPrice := price
            total := qty * price - discount
          }
          derived display: string = reference
        }
        repository Orders for Order { }
      }
    }
    ui Web with scaffold(subdomains: [Ordering]) { }
    storage primary { type: postgres }
    resource orderingState { for: Ordering, kind: state, use: primary }
    deployable api {
      platform: elixir, contexts: [Ordering], dataSources: [orderingState], port: 3000, ui: Web
    }
  }
`;

describe("ProvenanceInfo — HEEx renders a native `<details>` off the Ecto struct", () => {
  it("renders the disclosure on the scaffolded LiveView detail page", async () => {
    // The Phoenix LiveView renders server-side straight from the struct, so the
    // co-located `<field>_provenance` jsonb column is read via string-keyed
    // bracket access — with the SAME camelCase members the JSON wire carries
    // (RS-1/RS-18).  These were snake_case until the elixir wire-golden leg
    // showed the lineage members diverging; the reader moved with the writer.
    const out = allFiles(await generateSystemFiles(provScaffoldHeex));
    expect(out).toContain('data-testid="orders-detail-total-prov"');
    // Null-guarded EEx `if` over the struct field, then rule id + value.
    expect(out).toMatch(/<%= if [\w.@]+\.total_provenance do %>/);
    expect(out).toContain('<details class="loom-provenance"');
    expect(out).toContain('.total_provenance["snapshotId"]');
    expect(out).toContain('.total_provenance["computedValue"]');
    // Inputs fan out via a `for`-comprehension (LiveView's list idiom), keyed
    // on the same string-keyed `path`/`value`.
    expect(out).toMatch(/<%= for inp <- [\w.@]+\.total_provenance\["inputs"\] \|\| \[\] do %>/);
    expect(out).toContain('inp["path"]');
    expect(out).toContain('inp["value"]');
  });
});

describe("ProvenanceInfo — Flutter renders an ExpansionTile disclosure over the lineage", () => {
  it("carries the lineage on the Dart wire model", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("flutter")));
    // The fixed lineage classes ship (the Dart analogue of `provLineageSchema` /
    // Feliz's `ProvLineage` record) …
    expect(out).toContain("class ProvLineage {");
    expect(out).toContain("class ProvInput {");
    expect(out).toContain("final String snapshotId;");
    // … and the Order model carries the co-located, nullable sibling, decoded
    // through it.
    expect(out).toContain("final ProvLineage? total_provenance;");
    expect(out).toContain(
      "total_provenance: json['total_provenance'] == null ? null : ProvLineage.fromJson(json['total_provenance'] as Map<String, dynamic>),",
    );
  });

  it("renders the disclosure on the scaffolded detail page", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("flutter")));
    // No fall-through comment any more — the seam owns the primitive.
    expect(out).not.toContain("provenance disclosure not yet supported on flutter");
    // A null-BINDING switch pattern (a property read off a model class is not
    // type-promotable in Dart) into the Material disclosure.
    expect(out).toMatch(/\(switch \([\w.]*\.total_provenance\) \{ final __p\? => ExpansionTile\(/);
    expect(out).toContain("Semantics(label: 'How this value was computed'");
    // Rule id + computed value + the input list, same three rows as every other
    // frontend's disclosure.
    expect(out).toContain("Text(__p.snapshotId)");
    expect(out).toContain("Text(__p.computedValue)");
    expect(out).toContain("...__p.inputs.map((__i) =>");
    expect(out).toContain("Text(__i.path)");
    // No lineage carrier: `provLineageSchema` is unique to the zod frontends —
    // Dart decodes through its own class instead.
    expect(out).not.toContain("provLineageSchema");
  });
});
