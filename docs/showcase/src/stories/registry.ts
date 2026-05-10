// ---------------------------------------------------------------------------
// Showcase story registry — the single source of truth for what
// the catalogue surfaces.
//
// Each story is a self-contained DDL slice that exercises one or
// more UI primitives in isolation.  The build script
// (`web/scripts/build-showcase.mjs`) imports this registry,
// generates each story through both packs (mantine + shadcn),
// bundles each pack output, and writes static iframes to
// `docs/_site/showcase/iframes/<story>/<pack>/index.html`.  The
// showcase Vite app reads the manifest emitted by the build and
// renders side-by-side iframes for the selected story.
//
// Adding a story:
//   1. Append an entry below.
//   2. Re-run `node web/scripts/build-showcase.mjs`.
// No app code needs touching — the catalogue is data-driven.
//
// Stay focused: each story should exercise *one* primitive, not a
// whole domain.  When a story tries to be a kitchen sink it stops
// answering "what does this primitive look like" cleanly.
// ---------------------------------------------------------------------------

export interface Story {
  /** URL-safe id used in static paths and in the manifest.  Stable
   *  across renames; rename the `label` instead so existing
   *  bookmarks keep working. */
  id: string;
  /** Sidebar label.  ~3-5 words. */
  label: string;
  /** Section grouping in the sidebar (e.g. "Cells", "Pages",
   *  "Workflows"). */
  group: string;
  /** Short blurb — one sentence — surfaced under the iframes. */
  blurb: string;
  /** The DDL source.  Must declare a `webApp` deployable; the build
   *  script overrides its `design:` slot per-pack so the story author
   *  doesn't need to duplicate the source. */
  ddd: string;
  /** Mock API responses keyed by URL pathname.  The iframe HTML
   *  injects a `fetch` interceptor that returns JSON for these
   *  paths so list/detail/view pages render with realistic
   *  content instead of the empty/loading state.  Pathnames are
   *  matched literally; the generator's API_BASE_URL is set to
   *  the empty string in the iframe so paths look like e.g.
   *  `/products` (or `/products/abc123` for detail). */
  mockApi?: Record<string, unknown>;
  /** Optional path inside the generated app to navigate to before
   *  rendering — e.g. `/products` for the list page,
   *  `/workflows/place-order` for a workflow form.  Defaults to
   *  `/` (the home page).  Stories that focus on a specific page
   *  kind set this so the iframe lands on the right route without
   *  user interaction. */
  initialPath?: string;
}

/** Wrap a context body with the system + module + deployable
 *  scaffolding every Loom React app needs.  `context` is the
 *  context body (between the `{ }` of `context X { ... }`).  The
 *  build script later flips the design slot for the shadcn pass. */
function wrap(opts: {
  contextName: string;
  contextBody: string;
  /** Default repository declarations to include after the context
   *  body — most stories need them but some declare their own
   *  inline if they want named finders. */
  repositories?: string;
}): string {
  const repos = opts.repositories ?? "";
  return `system Showcase {
  module ShowcaseMod {
    context ${opts.contextName} {
${opts.contextBody}
${repos}
    }
  }

  deployable api {
    platform: hono
    modules: ShowcaseMod
    port: 3000
  }

  deployable webApp {
    platform: react
    targets: api
    port: 3001
  }
}`;
}

export const STORIES: Story[] = [
  {
    id: "cells-string-datetime",
    group: "Cells",
    label: "List page — string + datetime",
    blurb:
      "Aggregate with two scalar fields.  List page renders one cell per field; datetime is humanised by the runtime helper.",
    ddd: wrap({
      contextName: "Sales",
      contextBody: `      aggregate Customer {
        name: string display
        email: string
        joined: datetime
      }`,
      repositories: `      repository Customers for Customer { }`,
    }),
    initialPath: "/customers",
    mockApi: {
      "/customers": [
        {
          id: "cust_001",
          name: "Ada Lovelace",
          email: "ada@example.com",
          joined: "2024-03-12T09:30:00Z",
        },
        {
          id: "cust_002",
          name: "Grace Hopper",
          email: "grace@example.com",
          joined: "2024-04-05T14:15:00Z",
        },
        {
          id: "cust_003",
          name: "Margaret Hamilton",
          email: "margaret@example.com",
          joined: "2024-06-18T08:00:00Z",
        },
      ],
    },
  },
  {
    id: "cells-money-bool-datetime",
    group: "Cells",
    label: "List page — money, bool, datetime",
    blurb:
      "Aggregate with a value-object money field, a boolean stock flag, and a datetime.  Demonstrates each pack's currency formatting, bool affordance, and date layout.",
    ddd: wrap({
      contextName: "Catalog",
      contextBody: `      valueobject Money {
        amount: decimal
        currency: string
      }

      aggregate Product {
        sku: string display
        name: string
        price: Money
        inStock: bool
        addedAt: datetime
      }`,
      repositories: `      repository Products for Product { }`,
    }),
    initialPath: "/products",
    mockApi: {
      "/products": [
        {
          id: "prod_001",
          sku: "SKU-001",
          name: "Mechanical Keyboard",
          price: { amount: "149.99", currency: "USD" },
          inStock: true,
          addedAt: "2024-01-10T10:00:00Z",
        },
        {
          id: "prod_002",
          sku: "SKU-002",
          name: "USB-C Cable",
          price: { amount: "12.50", currency: "USD" },
          inStock: false,
          addedAt: "2024-02-22T16:30:00Z",
        },
        {
          id: "prod_003",
          sku: "SKU-003",
          name: "Standing Desk",
          price: { amount: "599.00", currency: "USD" },
          inStock: true,
          addedAt: "2024-03-15T11:45:00Z",
        },
      ],
    },
  },
  {
    id: "cells-enum",
    group: "Cells",
    label: "List page — enum status",
    blurb:
      "Enum field surfaced as a coloured pill / badge in the list table — Mantine and shadcn pick different visual treatments.",
    ddd: wrap({
      contextName: "Catalog",
      contextBody: `      enum ProductStatus { Draft, Active, Discontinued }

      aggregate Product {
        sku: string display
        status: ProductStatus
      }`,
      repositories: `      repository Products for Product { }`,
    }),
    initialPath: "/products",
    mockApi: {
      "/products": [
        { id: "p1", sku: "SKU-A", status: "Draft" },
        { id: "p2", sku: "SKU-B", status: "Active" },
        { id: "p3", sku: "SKU-C", status: "Discontinued" },
      ],
    },
  },
  {
    id: "form-new",
    group: "Pages",
    label: "New form — mixed inputs",
    blurb:
      "Create form for an aggregate with string, decimal-via-money, bool, datetime, and enum fields.  Demonstrates each pack's control layout, label placement, and Submit button affordance.",
    ddd: wrap({
      contextName: "Catalog",
      contextBody: `      enum ProductStatus { Draft, Active, Discontinued }

      valueobject Money {
        amount: decimal
        currency: string
      }

      aggregate Product {
        sku: string display
        name: string
        price: Money
        inStock: bool
        addedAt: datetime
        status: ProductStatus
      }`,
      repositories: `      repository Products for Product { }`,
    }),
    initialPath: "/products/new",
  },
  {
    id: "workflow-form",
    group: "Workflows",
    label: "Workflow form — mixed params",
    blurb:
      "Workflow page with string, decimal, and bool parameters.  Shows the per-pack form layout, button affordances, and Cancel/Submit placement.",
    ddd: wrap({
      contextName: "Sales",
      contextBody: `      aggregate Customer {
        name: string display
      }

      workflow placeOrder(
        customerId: Id<Customer>,
        amount: decimal,
        urgent: bool
      ) {
        // intentionally empty body — the showcase only exercises
        // the form scaffold the React generator produces
      }`,
      repositories: `      repository Customers for Customer { }`,
    }),
    initialPath: "/workflows/place-order",
    mockApi: {
      "/customers": [
        { id: "cust_001", name: "Ada Lovelace" },
        { id: "cust_002", name: "Grace Hopper" },
      ],
    },
  },
];
