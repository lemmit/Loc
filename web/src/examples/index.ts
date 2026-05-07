// Vite's `?raw` suffix gives us the file's text content as a string.
// Adding more examples is just another `?raw` import + an entry in
// the array below.
import salesSource from "./sales.ddd?raw";
import salesSystemSource from "./sales-system.ddd?raw";
import bankingSource from "./banking.ddd?raw";
import bankingSystemSource from "./banking-system.ddd?raw";
import inventorySource from "./inventory.ddd?raw";
import inventorySystemSource from "./inventory-system.ddd?raw";
import acmeSource from "./acme.ddd?raw";

export interface LoomExample {
  id: string;
  label: string;
  source: string;
  /** Optional one-liner shown under the dropdown — what the
   *  example demonstrates and whether it supports the Preview
   *  iframe (system mode with a Hono + React deployable pair). */
  blurb?: string;
}

// Order matters: we put system-mode (preview-capable) sources at
// the top because the Preview pane is the headline feature, then
// the legacy single-context sources, and finally Acme as a
// generator-level showcase that doesn't preview cleanly (its React
// frontend targets a .NET deployable we don't run in the browser).
export const examples: LoomExample[] = [
  {
    id: "sales-system",
    label: "Sales System (Hono + React)",
    source: salesSystemSource,
    blurb:
      "Aggregates / value-objects / events / operations + system block with full Preview.",
  },
  {
    id: "banking-system",
    label: "Banking System (Hono + React)",
    source: bankingSystemSource,
    blurb:
      "Optional fields, cross-aggregate Id<X> refs, richer where-filters; full Preview.",
  },
  {
    id: "inventory-system",
    label: "Inventory System (Hono + React)",
    source: inventorySystemSource,
    blurb: "Nested parts and explicit guid ids; full Preview.",
  },
  {
    id: "sales",
    label: "Sales (single context)",
    source: salesSource,
    blurb: "Bare-context generator: Hono backend only — no Preview.",
  },
  {
    id: "banking",
    label: "Banking (single context)",
    source: bankingSource,
    blurb: "Bare-context generator: Hono backend only — no Preview.",
  },
  {
    id: "inventory",
    label: "Inventory (single context)",
    source: inventorySource,
    blurb: "Bare-context generator: Hono backend only — no Preview.",
  },
  {
    id: "acme",
    label: "Acme (multi-deployable system)",
    source: acmeSource,
    blurb:
      "Modules, multiple deployables, .NET + Hono + React — generator showcase, partial Preview only.",
  },
];

export const defaultExample = examples[0];
