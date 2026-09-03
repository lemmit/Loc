// ---------------------------------------------------------------------------
// ProvenanceInfo disclosure — scaffold + cross-frontend render gate.
//
// A `provenanced` field records the lineage of every value it holds
// (docs/provenance.md).  Since M-T6.12 the value and its lineage ride the wire
// as ONE `Provenanced<T>` carrier — `{ value, lineage }` — stamped into
// `wireShape` once by `wireTypeForField`, so EVERY frontend's response type
// carries the lineage rather than the React-first opt-in it used to be.  On a
// scaffolded DETAIL page the figure reads `<record>.<field>.value` and pairs
// with a `ProvenanceInfo` "?" disclosure over `<record>.<field>.lineage`.
//
// This suite is the cross-target gate on BOTH halves: that each frontend types
// the carrier (not a bare `T`, and not the old trailing `<field>_provenance`
// sibling), and that each renders the disclosure off the carrier's lineage
// member — through the real generators, not a unit stub.
//
// HEEx is the documented exception: Phoenix LiveView renders server-side off
// the Ecto struct, where the pair is still SPLIT, so it reads the value column
// and the `<field>_provenance` jsonb column directly.
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

/** The FRONTEND deployable's files only.  The negative assertions below ("no
 *  trailing `<field>_provenance` key any more") have to be scoped: the BACKEND
 *  in the same system still names that column everywhere — its Drizzle schema,
 *  its domain class, its migration — because STORAGE keeps the pair split.
 *  Only the wire folded. */
function webFiles(files: Map<string, string>): string {
  let all = "";
  for (const [path, content] of files) if (path.startsWith("web/")) all += `\n${content}`;
  return all;
}

describe("ProvenanceInfo — React renders a `<details>` disclosure over the lineage", () => {
  it("surfaces the lineage on the response schema + shared lib", async () => {
    const files = await generateSystemFiles(provScaffoldSystem("react"));
    const out = allFiles(files);
    const web = webFiles(files);
    // The shared lib exports the nullable lineage carrier.
    expect(out).toContain("export const provLineageSchema = z.object({");
    expect(out).toContain("snapshotId: z.string()");
    // The Order response schema types the field as the CARRIER, not a bare
    // number and not a trailing sibling key.
    expect(out).toContain('import { provLineageSchema } from "../lib/schemas";');
    expect(out).toContain(
      "total: z.object({ value: z.number().int(), lineage: provLineageSchema.nullish() }),",
    );
    expect(web).not.toContain("total_provenance");
  });

  it("renders the disclosure on the scaffolded detail page", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("react")));
    expect(out).toContain('data-testid="orders-detail-total-prov"');
    expect(out).toMatch(/<details className="loom-provenance"/);
    // Null-guarded on the carrier's lineage half, then rule id + computed value
    // + input list.
    expect(out).toMatch(/\.total\.lineage != null \? \(/);
    expect(out).toContain(".total.lineage.snapshotId}");
    expect(out).toContain("String(");
    expect(out).toMatch(/\.total\.lineage\.inputs\.map\(\(inp\) => \(/);
    // The FIGURE renders next to the disclosure, through the carrier's value
    // half — a bare `.total}` would render the whole object.
    expect(out).toContain(".total.value}");
  });
});

describe("ProvenanceInfo — Vue renders a `<details v-if>` disclosure over the lineage", () => {
  it("surfaces the lineage on the response schema + shared lib", async () => {
    const files = await generateSystemFiles(provScaffoldSystem("vue"));
    const out = allFiles(files);
    const web = webFiles(files);
    expect(out).toContain("export const provLineageSchema = z.object({");
    expect(out).toContain('import { provLineageSchema } from "../lib/schemas";');
    expect(out).toContain(
      "total: z.object({ value: z.number().int(), lineage: provLineageSchema.nullish() }),",
    );
    expect(web).not.toContain("total_provenance");
  });

  it("renders the disclosure on the scaffolded detail page", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("vue")));
    expect(out).toContain('data-testid="orders-detail-total-prov"');
    // Vue guards with `v-if`, interpolates with `{{ }}`, iterates with `v-for`.
    expect(out).toMatch(/<details v-if="[\w.]+\.total\.lineage != null" class="loom-provenance"/);
    expect(out).toContain(".total.lineage.snapshotId }}");
    expect(out).toMatch(/v-for="inp in [\w.]+\.total\.lineage\.inputs" :key="inp\.path"/);
  });
});

describe("ProvenanceInfo — Svelte renders an `{#if}`/`{#each}` disclosure", () => {
  it("surfaces the lineage on the response schema + shared lib", async () => {
    const files = await generateSystemFiles(provScaffoldSystem("svelte"));
    const out = allFiles(files);
    const web = webFiles(files);
    expect(out).toContain("export const provLineageSchema = z.object({");
    expect(out).toContain('import { provLineageSchema } from "../schemas";');
    expect(out).toContain(
      "total: z.object({ value: z.number().int(), lineage: provLineageSchema.nullish() }),",
    );
    expect(web).not.toContain("total_provenance");
  });

  it("renders the disclosure on the scaffolded detail page", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("svelte")));
    expect(out).toContain('data-testid="orders-detail-total-prov"');
    // Svelte guards with `{#if}`, interpolates with `{expr}`, iterates keyed.
    expect(out).toMatch(/\{#if [\w.]+\.total\.lineage != null\}/);
    expect(out).toContain("{orderById.data.total.lineage.snapshotId}");
    expect(out).toMatch(/\{#each [\w.]+\.total\.lineage\.inputs as inp \(inp\.path\)\}/);
  });
});

describe("ProvenanceInfo — Angular renders an `@if (…; as prov)` disclosure", () => {
  it("surfaces the lineage on the response interface (no shared zod lib)", async () => {
    const files = await generateSystemFiles(provScaffoldSystem("angular"));
    const out = allFiles(files);
    const web = webFiles(files);
    // Angular has no zod lib — the lineage is a plain TS interface, and the
    // carrier is spelled inline on the field.
    expect(out).toContain("export interface ProvLineage {");
    expect(out).toContain("total: { value: number; lineage: ProvLineage | null };");
    expect(web).not.toContain("total_provenance");
  });

  it("renders the disclosure on the scaffolded detail page", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("angular")));
    expect(out).toContain('data-testid="orders-detail-total-prov"');
    // A signal-call result can't narrow in place — the `as prov` alias binds it.
    expect(out).toMatch(/@if \([\w.()!]+\.total\.lineage; as prov\)/);
    expect(out).toContain("{{ prov.snapshotId }}");
    // `unknown` values ride `$any(...)` (templates can't call `String`).
    expect(out).toContain("{{ $any(prov.computedValue) }}");
    expect(out).toContain("@for (inp of prov.inputs; track inp.path)");
  });
});

describe("ProvenanceInfo — Feliz renders an F# `Html.details` disclosure", () => {
  it("carries the lineage as an F# ProvLineage record + Thoth decoder", async () => {
    const files = await generateSystemFiles(provScaffoldSystem("feliz"));
    const out = allFiles(files);
    const web = webFiles(files);
    expect(out).toContain("type ProvLineage =");
    expect(out).toContain("let provLineageDecoder : Decoder<ProvLineage> =");
    // The generic carrier record + its decoder factory, and the Order field
    // typed through them.  Without the carrier arm the field fell through to
    // `obj` / `Decode.string` — a silent degradation, not a compile error.
    expect(out).toContain("type Provenanced<'T> =");
    expect(out).toContain(
      "let provenancedDecoder (inner: Decoder<'T>) : Decoder<Provenanced<'T>> =",
    );
    expect(out).toContain("total: Provenanced<int>");
    expect(out).toContain('total = get.Required.Field "total" (provenancedDecoder Decode.int)');
    expect(web).not.toContain("total_provenance");
  });

  it("renders the disclosure (Some/None match over the lineage option)", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("feliz")));
    expect(out).toMatch(/match [\w.]+\.total\.lineage with Some __p -> Html\.details/);
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
    const files = await generateSystemFiles(provScaffoldSystem("flutter"));
    const out = allFiles(files);
    const web = webFiles(files);
    // The fixed lineage classes ship (the Dart analogue of `provLineageSchema` /
    // Feliz's `ProvLineage` record) …
    expect(out).toContain("class ProvLineage {");
    expect(out).toContain("class ProvInput {");
    expect(out).toContain("final String snapshotId;");
    // … plus the generic carrier class, and the Order model's field typed
    // through it (the value decoder is passed in, so the carried type keeps its
    // own conversion).
    expect(out).toContain("class Provenanced<T> {");
    expect(out).toContain("final Provenanced<int> total;");
    expect(out).toContain(
      "total: Provenanced.fromJson(json['total'] as Map<String, dynamic>, (__v) => __v as int),",
    );
    expect(web).not.toContain("total_provenance");
  });

  it("renders the disclosure on the scaffolded detail page", async () => {
    const out = allFiles(await generateSystemFiles(provScaffoldSystem("flutter")));
    // No fall-through comment any more — the seam owns the primitive.
    expect(out).not.toContain("provenance disclosure not yet supported on flutter");
    // A null-BINDING switch pattern (a property read off a model class is not
    // type-promotable in Dart) into the Material disclosure.
    expect(out).toMatch(/\(switch \([\w.]*\.total\.lineage\) \{ final __p\? => ExpansionTile\(/);
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

// ---------------------------------------------------------------------------
// The BARE read — a hand-written page body that reads a `provenanced` field
// without spelling the carrier hop.
//
// M-T6.12 moved the lineage INSIDE the field's wire entry, which changed what
// `<record>.<field>` denotes: a `{ value, lineage }` object where the field's
// DECLARED type still says `int`.  Only the scaffold macro was taught to append
// `.value`, so a hand-written `Text { o.total }` put the whole carrier object
// into a text slot — TS2322 under `tsc --noEmit` on the JSX frontends,
// "Objects are not valid as a React child" at runtime, a stringified record on
// Feliz/Flutter — and no `loom.*` code said a word.
//
// The walker now appends the hop itself, so the two spellings agree: the
// DECLARED type keeps meaning what it says, and `.value` stays legal for an
// author who prefers to be explicit (it must not double into `.value.value`).
// HEEx is the documented exception in the OTHER direction — LiveView renders
// off the Ecto struct, where the field is still the scalar column — so both
// spellings must render the bare column there.
// ---------------------------------------------------------------------------

/** A HAND-WRITTEN detail page reading the provenanced `total` twice: once bare,
 *  once through the explicit `.value` hop.  Both must render the figure. */
const bareReadSystem = (frontend: string): string => `
  system BareRead {
    api SalesApi from Sales
    subdomain Sales {
      context Orders {
        aggregate Order with crudish {
          name: string
          total: int provenanced
        }
        repository Orders for Order { }
      }
    }
    storage primary { type: postgres }
    ui Web {
      api A: SalesApi
      page OrderDetail(id: Order id) {
        route: "/orders/:id"
        body: QueryView {
          of: A.Order.byId(id),
          data: o => Stack { Text { o.total }, Text { string(o.total.value) } }
        }
      }
    }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api {
      platform: node, contexts: [Orders], dataSources: [ordersState],
      serves: SalesApi, port: 3000
    }
    deployable web { platform: ${frontend}, targets: api, ui: Web { A: api }, port: 3001 }
  }
`;

/** The HEEx twin — Phoenix LiveView is fullstack, so the ui is hosted ON the
 *  elixir backend rather than on a separate frontend deployable. */
const bareReadHeex = `
  system BareRead {
    api SalesApi from Sales
    subdomain Sales {
      context Orders {
        aggregate Order with crudish {
          name: string
          total: int provenanced
        }
        repository Orders for Order { }
      }
    }
    storage primary { type: postgres }
    ui Web {
      api A: SalesApi
      page OrderDetail(id: Order id) {
        route: "/orders/:id"
        body: QueryView {
          of: A.Order.byId(id),
          data: o => Stack { Text { o.total }, Text { string(o.total.value) } }
        }
      }
    }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable app {
      platform: elixir, contexts: [Orders], dataSources: [ordersState],
      serves: SalesApi, ui: Web { A: app }, port: 4000
    }
  }
`;

/** Per-frontend: the exact text the DETAIL page must contain for the bare read,
 *  and the substring that proves the explicit hop did not double. */
const BARE_READ_EXPECTATIONS: readonly {
  frontend: string;
  /** How the bare `o.total` must render — with the hop appended. */
  bare: string;
  /** How the explicit `o.total.value` must still render. */
  explicit: string;
}[] = [
  {
    frontend: "react",
    bare: "<Text>{orderById.data.total.value}</Text>",
    explicit: "<Text>{String(orderById.data.total.value)}</Text>",
  },
  {
    frontend: "vue",
    bare: "{{ orderById.data.total.value }}",
    explicit: "{{ String(orderById.data.total.value) }}",
  },
  {
    frontend: "svelte",
    bare: ">{orderById.data.total.value}<",
    explicit: ">{String(orderById.data.total.value)}<",
  },
  {
    frontend: "angular",
    bare: "{{ orderById.data()!.total.value }}",
    explicit: "{{ String(orderById.data()!.total.value) }}",
  },
  {
    frontend: "feliz",
    bare: "Html.text (string (orderById.total.value))",
    explicit: "Html.text ((string orderById.total.value))",
  },
  {
    frontend: "flutter",
    bare: "Text('${orderById.total.value}')",
    explicit: "Text(orderById.total.value.toString())",
  },
];

describe("a hand-written page body reading a `provenanced` field bare", () => {
  for (const { frontend, bare, explicit } of BARE_READ_EXPECTATIONS) {
    it(`${frontend}: the bare read gets the carrier hop, the explicit one is left alone`, async () => {
      const out = allFiles(await generateSystemFiles(bareReadSystem(frontend)));
      // The bug: the bare read emitted the `{ value, lineage }` object itself.
      expect(out).toContain(bare);
      // …and the explicit spelling must not double into `.value.value`.
      expect(out).toContain(explicit);
      expect(out).not.toContain(".total.value.value");
    });
  }

  it("heex: BOTH spellings read the scalar column — the hop is dropped, not added", async () => {
    const out = allFiles(await generateSystemFiles(bareReadHeex));
    // LiveView renders server-side off the Ecto struct, where `total` is the
    // typed column and the lineage is a separate jsonb sibling.  A `.value` hop
    // would raise on an integer, so the HEEx engine strips it — and must not
    // acquire the JS walker's opposite edit.
    expect(out).toContain("<%= @o.total %>");
    expect(out).toContain("<%= to_string(@o.total) %>");
    expect(out).not.toContain("@o.total.value");
  });
});
