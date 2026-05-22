// Vite's `?raw` suffix gives us the file's text content as a string.
// Adding more examples is just another `?raw` import + an entry in
// the array below.
import salesSource from "./sales.ddd?raw";
import salesSystemSource from "./sales-system.ddd?raw";
import bankingSource from "./banking.ddd?raw";
import bankingSystemSource from "./banking-system.ddd?raw";
import inventorySource from "./inventory.ddd?raw";
import inventorySystemSource from "./inventory-system.ddd?raw";
import provenanceSystemSource from "./provenance-system.ddd?raw";
import pokemonWorldSource from "./pokemon-world.ddd?raw";
import acmeSource from "./acme.ddd?raw";
import storybookMantineSource from "./storybook-mantine.ddd?raw";
import storybookMantineV9Source from "./storybook-mantine-v9.ddd?raw";
import storybookShadcnSource from "./storybook-shadcn.ddd?raw";
import storybookShadcnV4Source from "./storybook-shadcn-v4.ddd?raw";
import storybookMuiSource from "./storybook-mui.ddd?raw";
import storybookMuiV7Source from "./storybook-mui-v7.ddd?raw";
import storybookChakraSource from "./storybook-chakra.ddd?raw";
import storybookChakraV3Source from "./storybook-chakra-v3.ddd?raw";
import storybookComponentsSource from "./storybook-components.ddd?raw";
import dotnetFullstackSource from "./dotnet-fullstack.ddd?raw";
import dotnetBackendSource from "./dotnet-backend.ddd?raw";
import dotnetBankingSource from "./dotnet-banking.ddd?raw";
import phoenixFullstackSource from "./phoenix-fullstack.ddd?raw";
import phoenixBankingSource from "./phoenix-banking.ddd?raw";

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
    // First example pinned to a specific pack version
    // (`design: \"mantine@v9\"`).  Demonstrates the Phase 0 pack-
    // versioning mechanic — selecting this regenerates against the
    // Mantine 9 + React 19 deps while the bareword Mantine entry
    // above still tracks v7 until the default flips.
    id: "storybook-mantine-v9",
    label: "Mantine 9 · pinned storybook (React 19)",
    source: storybookMantineV9Source,
    blurb:
      "Same catalogue as the Mantine storybook, generated against the new Mantine 9 + React 19 pack — explicit `design: \"mantine@v9\"`.",
  },
  {
    id: "storybook-shadcn",
    label: "shadcn · aggregate-CRUD storybook",
    source: storybookShadcnSource,
    blurb:
      "Same catalogue as the Mantine storybook, rendered through the shadcn/ui pack.",
  },
  {
    id: "storybook-shadcn-v4",
    label: "shadcn v4 · aggregate-CRUD storybook",
    source: storybookShadcnV4Source,
    blurb:
      "The shadcn storybook pinned to the Tailwind 4 / shadcn v4 pack (CSS-first config, React 19).",
  },
  {
    id: "storybook-mui",
    label: "MUI · aggregate-CRUD storybook",
    source: storybookMuiSource,
    blurb:
      "Same catalogue as the Mantine storybook, rendered through the Material UI pack.",
  },
  {
    id: "storybook-mui-v7",
    label: "MUI v7 · aggregate-CRUD storybook",
    source: storybookMuiV7Source,
    blurb:
      "The MUI storybook pinned to the Material UI v7 pack (new Grid, React 19).",
  },
  {
    id: "storybook-chakra",
    label: "Chakra · aggregate-CRUD storybook",
    source: storybookChakraSource,
    blurb:
      "Same catalogue as the Mantine storybook, rendered through the Chakra UI pack.",
  },
  {
    id: "storybook-chakra-v3",
    label: "Chakra v3 · aggregate-CRUD storybook",
    source: storybookChakraV3Source,
    blurb:
      "The Chakra storybook pinned to the Chakra UI v3 pack (compound components, createSystem theme).",
  },
  {
    id: "pokemon-world",
    label: "Pokémon World (Hono + React)",
    source: pokemonWorldSource,
    blurb:
      "Four aggregates across two modules — levels/evolution, party management with a 6-slot limit, and a battle lifecycle with rounds. Ternary HP-clamp, Id<X> party lists, e2e tests.",
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
    id: "provenance-system",
    label: "Provenance System (Hono + React)",
    source: provenanceSystemSource,
    blurb:
      "`provenanced` field: each write to `order.total` is captured as a rule snapshot; the Hono backend records a runtime trace per write.",
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
    id: "dotnet-backend",
    label: ".NET backend only (CQRS + EF Core)",
    source: dotnetBackendSource,
    blurb:
      "Pure .NET backend — Mediator commands/queries, per-aggregate controllers, EF Core configurations, FluentValidation pipeline. No UI. Files-only in the playground.",
  },
  {
    id: "dotnet-fullstack",
    label: "Fullstack .NET (Sales)",
    source: dotnetFullstackSource,
    blurb:
      "Single .NET deployable serving /api/* and a React SPA (Mantine) from wwwroot/. Files-only in the playground (.NET doesn't boot in-browser).",
  },
  {
    id: "dotnet-banking",
    label: "Fullstack .NET (Banking)",
    source: dotnetBankingSource,
    blurb:
      "Same banking domain as `banking-system.ddd` rendered as fullstack .NET with the shadcn pack. Three-way diff target alongside `phoenix-banking` and `banking-system`.",
  },
  {
    id: "phoenix-fullstack",
    label: "Fullstack Phoenix LiveView (Sales)",
    source: phoenixFullstackSource,
    blurb:
      "Elixir/Ash + Phoenix LiveView: Ash resources, JSON API, LiveView pages (HEEx), Ecto migrations. Files-only in the playground (Phoenix runs on BEAM, not Node).",
  },
  {
    id: "phoenix-banking",
    label: "Fullstack Phoenix LiveView (Banking)",
    source: phoenixBankingSource,
    blurb:
      "Same banking domain as `banking-system.ddd` rendered as Elixir/Ash — exercises optional fields, where-filters, and a transactional `transferFunds` Reactor saga.",
  },
];

export const defaultExample = examples[0];
