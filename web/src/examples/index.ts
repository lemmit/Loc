// Vite's `?raw` suffix gives us the file's text content as a string.
// Adding more examples is just another `?raw` import + an entry in
// the array below.
import storefrontSystemSource from "./storefront-system.ddd?raw";
import storefrontDotnetSource from "./storefront-dotnet.ddd?raw";
import storefrontPhoenixSource from "./storefront-phoenix.ddd?raw";
import salesSystemSource from "./sales-system.ddd?raw";
import bankingSystemSource from "./banking-system.ddd?raw";
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
import loomLandingSource from "./loom-landing.ddd?raw";
import dotnetBackendSource from "./dotnet-backend.ddd?raw";
import actionShowcaseSource from "./action-showcase.ddd?raw";
import multifileMainSource from "./multifile-main.ddd?raw";
import multifileSharedMoneySource from "./multifile-shared-money.ddd?raw";
import multifileSharedCurrencySource from "./multifile-shared-currency.ddd?raw";
import multifileLandingSource from "./multifile-landing.ddd?raw";
import multifileMarketingLibSource from "./multifile-marketing-lib.ddd?raw";

export interface LoomExample {
  id: string;
  label: string;
  /** Main `.ddd` body — the content placed at `/workspace/main.ddd`
   *  when the user picks this example.  Required for every example
   *  so single-file consumers (legacy URL-hash sharing, the
   *  Workspace-autosave preview) always have something to show. */
  source: string;
  /** Optional companion files placed under `/workspace/` alongside
   *  `main.ddd`.  Keys are workspace-relative (no leading slash,
   *  e.g. `shared/money.ddd`) so the example author doesn't have to
   *  type the prefix at every entry.  The picker writes these to
   *  the workspace VFS when the example is chosen.  See
   *  `docs/multi-file-source.md`. */
  files?: Record<string, string>;
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
  // Multi-file example — picks up the workspace tabs strip and the
  // project loader's `import`-graph walk.  The companion `.ddd`
  // files are placed under `/workspace/shared/` when the user picks
  // this entry; the editor switches to main.ddd.
  {
    id: "multifile-store",
    label: "Multi-file project (root-level shared types)",
    source: multifileMainSource,
    files: {
      "shared/money.ddd": multifileSharedMoneySource,
      "shared/currency.ddd": multifileSharedCurrencySource,
    },
    blurb:
      "Tiny Hono backend that imports a root-level Money valueobject and Currency enum from sibling files — exercises the multi-file workspace + tabs strip.",
  },
  {
    id: "multifile-landing",
    label: "Multi-file project (shared component library)",
    source: multifileLandingSource,
    files: {
      "multifile-marketing-lib.ddd": multifileMarketingLibSource,
    },
    blurb:
      "Landing page that imports a marketing component library (Hero / FeatureCard / CtaSection / Footer) declared as top-level `component`s in a sibling .ddd — same scope as root-level value objects and enums.",
  },
  // Storybook entries lead with the discriminator (pack name or
  // "components") so the eye lands on what makes each one different,
  // not on a five-word identical prefix.  The previous
  // "UI Storybook (Mantine, aggregate-CRUD)" pattern made MUI / Chakra
  // entries hard to spot in a narrow mobile dropdown — they all
  // looked like "UI Storybook (..." until you read to the parenthesis.
  {
    id: "loom-landing",
    label: "Loom landing page — gap-closing baseline",
    source: loomLandingSource,
    blurb:
      "A faithful port of the hand-authored landing at docs/index.html using today's primitives.  Visible approximations (plain-text code blocks, equal-weight grids, no icons) mark each gap that subsequent PRs will close one at a time.",
  },
  {
    id: "storybook-components",
    label: "Components storybook (single page)",
    source: storybookComponentsSource,
    blurb:
      "Single long page exercising every page-metamodel primitive — layout, display, input, action — no aggregates.",
  },
  {
    id: "action-showcase",
    label: "Action showcase (operation buttons + forms)",
    source: actionShowcaseSource,
    blurb:
      "Hand-authored Action { order.confirm } buttons in a component, plus scaffold operation forms — the instance-qualified operation surface end-to-end.",
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
    id: "storefront-system",
    label: "Storefront (Hono + React)",
    source: storefrontSystemSource,
    blurb:
      "Flagship domain: a Sales-style aggregate tree (Order → OrderLine + Money VO + derived rollup) fused with a Banking-style Wallet, tied together by a transactional `checkout` saga. Diff against the .NET and Phoenix storefronts below.",
  },
  {
    id: "pokemon-world",
    label: "Pokémon World (Hono + React)",
    source: pokemonWorldSource,
    blurb:
      "Four aggregates across two modules — levels/evolution, party management with a 6-slot limit, and a battle lifecycle with rounds. Ternary HP-clamp, X id party lists, e2e tests.",
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
      "Optional fields, X id refs, where-filters, transactional `transferFunds` workflow.",
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
    id: "acme",
    label: "Acme (multi-deployable system)",
    source: acmeSource,
    blurb:
      "Modules, multiple deployables, .NET + Hono + React — generator showcase, partial Preview only.",
  },
  {
    id: "storefront-dotnet",
    label: "Storefront · fullstack .NET",
    source: storefrontDotnetSource,
    blurb:
      "The Storefront domain on a single .NET deployable (EF Core + Mediator) serving /api/* and a React SPA (shadcn pack) from wwwroot/. Files-only in the playground (.NET doesn't boot in-browser).",
  },
  {
    id: "storefront-phoenix",
    label: "Storefront · fullstack Phoenix LiveView",
    source: storefrontPhoenixSource,
    blurb:
      "The Storefront domain on Elixir/Ash — aggregates lower to Ash.Resource, the `checkout` saga to a Reactor, views to Ash.Query. Files-only in the playground (BEAM, not Node).",
  },
  {
    id: "dotnet-backend",
    label: ".NET backend only (CQRS + EF Core)",
    source: dotnetBackendSource,
    blurb:
      "Pure .NET backend — Mediator commands/queries, per-aggregate controllers, EF Core configurations, FluentValidation pipeline. No UI. Files-only in the playground.",
  },
];

// Default is the Sales System — the canonical full-stack demo with
// aggregates, repositories, workflows, events, a React UI, AND the
// requirements that the mobile-requirements e2e relies on (US-001,
// SOL-001…). `examples[0]` is the multi-file showcase, which is also
// fully supported now that `lsp/workspace-lsp-sync.ts` pushes every
// workspace `.ddd` to the LSP — but the mobile-requirements specs
// hard-code US-001 / SOL-001 row IDs that only live in sales-system,
// so we keep sales as the cold-boot landing.
export const defaultExample =
  examples.find((e) => e.id === "sales-system") ?? examples[0];
