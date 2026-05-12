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
import storybookMantineSource from "./storybook-mantine.ddd?raw";
import storybookShadcnSource from "./storybook-shadcn.ddd?raw";
import storybookMuiSource from "./storybook-mui.ddd?raw";
import storybookChakraSource from "./storybook-chakra.ddd?raw";
import storybookComponentsSource from "./storybook-components.ddd?raw";
import dotnetFullstackSource from "./dotnet-fullstack.ddd?raw";

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
  // Storybook entries lead with the discriminator (pack name or
  // "components") so the eye lands on what makes each one different,
  // not on a five-word identical prefix.  The previous
  // "UI Storybook (Mantine, aggregate-CRUD)" pattern made MUI / Chakra
  // entries hard to spot in a narrow mobile dropdown — they all
  // looked like "UI Storybook (..." until you read to the parenthesis.
  {
    id: "storybook-components",
    label: "Components storybook (single page)",
    source: storybookComponentsSource,
    blurb:
      "Single long page exercising every page-metamodel primitive — layout, display, input, action — no aggregates.",
  },
  {
    id: "storybook-mantine",
    label: "Mantine · aggregate-CRUD storybook",
    source: storybookMantineSource,
    blurb:
      "Catalogue: each aggregate demonstrates one UI primitive — cells, fields, value-objects, references, ops, workflows, views.",
  },
  {
    id: "storybook-shadcn",
    label: "shadcn · aggregate-CRUD storybook",
    source: storybookShadcnSource,
    blurb:
      "Same catalogue as the Mantine storybook, rendered through the shadcn/ui pack.",
  },
  {
    id: "storybook-mui",
    label: "MUI · aggregate-CRUD storybook",
    source: storybookMuiSource,
    blurb:
      "Same catalogue as the Mantine storybook, rendered through the Material UI pack.",
  },
  {
    id: "storybook-chakra",
    label: "Chakra · aggregate-CRUD storybook",
    source: storybookChakraSource,
    blurb:
      "Same catalogue as the Mantine storybook, rendered through the Chakra UI pack.",
  },
  {
    id: "sales-system",
    label: "Sales System (Hono + React)",
    source: salesSystemSource,
    blurb:
      "Aggregates, value-objects, events, operations, transactional `placeOrder` workflow.",
  },
  {
    id: "banking-system",
    label: "Banking System (Hono + React)",
    source: bankingSystemSource,
    blurb:
      "Optional fields, Id<X> refs, where-filters, transactional `transferFunds` workflow.",
  },
  {
    id: "inventory-system",
    label: "Inventory System (Hono + React)",
    source: inventorySystemSource,
    blurb:
      "Nested parts, guid ids, non-transactional `recordReservation` workflow.",
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
  {
    id: "dotnet-fullstack",
    label: "Fullstack .NET (embeds React SPA)",
    source: dotnetFullstackSource,
    blurb:
      "Single .NET deployable that serves both /api/* and a React SPA from wwwroot/. Files-only in the playground (.NET doesn't boot in-browser).",
  },
];

export const defaultExample = examples[0];
