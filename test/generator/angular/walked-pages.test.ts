import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Angular generator — walked pages (angular-frontend-plan.md Slice 4b
// batch 1).  A `ui` page body walks through the shared markup walker with
// `angularTarget`; the angularMaterial pack owns the emitted markup.  The
// page becomes a standalone component, the route table mounts it, and the
// sidebar derives an entry.  (Structure-level; the emitted project is
// separately `ng build`-verified.)
// ---------------------------------------------------------------------------

const SOURCE = `
  system Smoke {
    subdomain Sales {
      context Orders {
        aggregate Order with crudish { total: int }
      }
    }
    ui Web {
      page Home {
        route: "/"
        title: "Home"
        body: Stack {
          Heading { "Welcome to Loom on Angular", testid: "home-title" },
          Text { "This page rendered through the shared walker." }
        }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: hono, contexts: [Orders], dataSources: [ordersState], port: 8080 }
    deployable web { platform: angular, targets: api, ui: Web, port: 3004 }
  }
`;

async function angularFiles(): Promise<Map<string, string>> {
  const all = await generateSystemFiles(SOURCE);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web/")) out.set(p.slice("web/".length), c);
  }
  return out;
}

describe("angular generator — walked pages", () => {
  it("emits the page as a standalone component under src/app/pages/", async () => {
    const page = (await angularFiles()).get("src/app/pages/home.component.ts");
    expect(page, "home page component should be emitted").toBeTruthy();
    expect(page!).toContain("@Component({");
    expect(page!).toContain('selector: "app-home"');
    expect(page!).toContain("export class HomeComponent");
  });

  it("renders the walked body markup (Stack → div.loom-stack, Heading → h2, Text → div)", async () => {
    const page = (await angularFiles()).get("src/app/pages/home.component.ts")!;
    expect(page).toContain('<div class="loom-stack">');
    expect(page).toContain('<h2 data-testid="home-title">Welcome to Loom on Angular</h2>');
    expect(page).toContain("<div>This page rendered through the shared walker.</div>");
  });

  it("mounts the page at its route + a wildcard NotFound (no synthetic Home when a page owns `/`)", async () => {
    const files = await angularFiles();
    const routes = files.get("src/app/app.routes.ts")!;
    expect(routes).toContain('import { HomeComponent } from "./pages/home.component";');
    expect(routes).toContain('{ path: "", component: HomeComponent }');
    expect(routes).toContain('{ path: "**", component: NotFoundComponent }');
    // A page owns the index route, so no separate hand-rolled Home.
    expect(files.has("src/app/home.component.ts")).toBe(false);
  });

  it("derives a sidebar entry for the page (nav populated → RouterLinkActive imported)", async () => {
    const shell = (await angularFiles()).get("src/app/app.component.ts")!;
    expect(shell).toContain("RouterLinkActive");
    expect(shell).toContain('routerLink="/"');
    expect(shell).toContain('data-testid="nav-home"');
  });
});

// ---------------------------------------------------------------------------
// Material-module primitives (Card, Divider) prove the `imports: []`
// aggregation: the pack declares the `*Module` each primitive needs, and the
// page shell hoists those into both the import lines and the standalone
// component's `imports: []`.  (Card + Divider carry no event handlers, so they
// land in batch 2 ahead of the event-handler seam.)
// ---------------------------------------------------------------------------

const CARD_SOURCE = `
  system Smoke {
    subdomain Sales {
      context Orders {
        aggregate Order with crudish { total: int }
      }
    }
    ui Web {
      page Home {
        route: "/"
        title: "Home"
        body: Stack {
          Card { "Summary", Text { "Inside the card." } },
          Divider {},
          Text { "After the divider." }
        }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: hono, contexts: [Orders], dataSources: [ordersState], port: 8080 }
    deployable web { platform: angular, targets: api, ui: Web, port: 3004 }
  }
`;

async function cardPage(): Promise<string> {
  const all = await generateSystemFiles(CARD_SOURCE);
  return all.get("web/src/app/pages/home.component.ts")!;
}

describe("angular generator — Material-module primitives (imports aggregation)", () => {
  it("renders Card → <mat-card> and Divider → <mat-divider>", async () => {
    const page = await cardPage();
    expect(page).toContain("<mat-card>");
    expect(page).toContain("<mat-card-title>Summary</mat-card-title>");
    expect(page).toContain("<mat-card-content><div>Inside the card.</div></mat-card-content>");
    expect(page).toContain("<mat-divider></mat-divider>");
  });

  it("hoists each primitive's declared module into imports + the component imports: []", async () => {
    const page = await cardPage();
    expect(page).toContain('import { MatCardModule } from "@angular/material/card";');
    expect(page).toContain('import { MatDividerModule } from "@angular/material/divider";');
    expect(page).toContain("imports: [MatCardModule, MatDividerModule],");
  });
});

// ---------------------------------------------------------------------------
// Button + the event-handler seam.  Angular `(click)` binds a STATEMENT, not
// a function value — an arrow there is created and discarded (a silent
// runtime no-op).  The `renderEventHandler` target seam inlines the lambda's
// statements, so a counter `onClick: e => { count := count + 1 }` lowers to
// `(click)='count.set((count() + 1))'`.  (ng build-verified separately.)
// ---------------------------------------------------------------------------

const BUTTON_SOURCE = `
  system Smoke {
    subdomain Sales {
      context Orders {
        aggregate Order with crudish { total: int }
      }
    }
    ui Web {
      page Home {
        route: "/"
        title: "Home"
        state { count: int = 0 }
        body: Stack {
          Button { "Increment", onClick: e => { count := count + 1 }, variant: "primary", testid: "inc" },
          Button { "Reset", onClick: e => { count := 0 }, testid: "reset" }
        }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: hono, contexts: [Orders], dataSources: [ordersState], port: 8080 }
    deployable web { platform: angular, targets: api, ui: Web, port: 3004 }
  }
`;

async function buttonPage(): Promise<string> {
  const all = await generateSystemFiles(BUTTON_SOURCE);
  return all.get("web/src/app/pages/home.component.ts")!;
}

describe("angular generator — Button + event-handler seam", () => {
  it("binds the onClick handler as a STATEMENT, not a discarded arrow", async () => {
    const page = await buttonPage();
    expect(page).toContain("(click)='count.set((count() + 1))'");
    expect(page).toContain("(click)='count.set(0)'");
    // The JSX arrow wrapper must NOT survive into an Angular event binding.
    expect(page).not.toContain("() =>");
  });

  it("maps variant → Material button rank and registers MatButtonModule", async () => {
    const page = await buttonPage();
    expect(page).toContain("<button mat-raised-button (click)=");
    expect(page).toContain("<button mat-button (click)=");
    expect(page).toContain('import { MatButtonModule } from "@angular/material/button";');
    expect(page).toContain("imports: [MatButtonModule],");
  });
});

// ---------------------------------------------------------------------------
// Pure-markup display + layout primitives (Container / Toolbar / Group /
// Paper / Stat / Badge / Alert).  No api / state / event needs — they walk to
// plain styled markup whose `.loom-*` classes the pack's theme owns.  Grows
// the angularMaterial primitive surface toward the full required set.  (ng
// build-verified separately.)
// ---------------------------------------------------------------------------

const DISPLAY_SOURCE = `
  system Smoke {
    subdomain Sales {
      context Orders {
        aggregate Order with crudish { total: int }
      }
    }
    ui Web {
      page Home {
        route: "/"
        title: "Home"
        body: Container {
          Toolbar {
            Heading { "Dashboard", testid: "home-title" },
            Badge { "New" }
          },
          Group {
            Stat { "Orders", "42" }
          },
          Paper {
            Text { "Inside a paper surface." }
          },
          Alert { "Something needs attention.", color: "yellow", title: "Heads up" }
        }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: hono, contexts: [Orders], dataSources: [ordersState], port: 8080 }
    deployable web { platform: angular, targets: api, ui: Web, port: 3004 }
  }
`;

async function displayPage(): Promise<string> {
  const all = await generateSystemFiles(DISPLAY_SOURCE);
  return all.get("web/src/app/pages/home.component.ts")!;
}

describe("angular generator — display + layout primitives", () => {
  it("walks each primitive to its pack markup", async () => {
    const page = await displayPage();
    expect(page).toContain('<div class="loom-container">');
    expect(page).toContain('<div class="loom-toolbar">');
    expect(page).toContain('<div class="loom-group">');
    expect(page).toContain('<div class="loom-paper">');
    expect(page).toContain('<span class="loom-badge">New</span>');
    expect(page).toContain(
      '<div class="loom-stat"><div class="loom-stat-label">Orders</div><div class="loom-stat-value">42</div></div>',
    );
    expect(page).toContain('<div class="loom-alert loom-alert-yellow" role="alert">');
    expect(page).toContain('<div class="loom-alert-title">Heads up</div>');
  });

  it("needs no Material module imports for the pure-markup primitives", async () => {
    const page = await displayPage();
    expect(page).toContain("imports: [],");
  });
});

// ---------------------------------------------------------------------------
// Inline / media / layout primitives — Bold/Italic/InlineCode/KeyValueRow/
// Empty/Skeleton/Avatar/Image/Loader/Icon/Grid/Tabs.  Tabs (mat-tab-group)
// manages its own selection so it needs no page state; Icon inlines the
// trusted builtin SVG directly (no sanitizer); the multi-Skeleton unrolls via
// the new `range` Handlebars helper.  (ng build-verified separately.)
// ---------------------------------------------------------------------------

const INLINE_SOURCE = `
  system Smoke {
    subdomain Sales {
      context Orders {
        aggregate Order with crudish { total: int }
      }
    }
    ui Web {
      page Home {
        route: "/"
        title: "Home"
        body: Stack {
          Bold { "bold" },
          Italic { "italic" },
          InlineCode { ".ddd" },
          KeyValueRow { "Status", Text { "Active" } },
          Grid {
            Card { "One", Text { "first" } }
          },
          Tabs {
            Tab { "Overview", Text { "overview body" } }
          },
          Avatar { src: "/a.png", alt: "user" },
          Image { src: "/logo.png", alt: "logo" },
          Loader { size: "lg" },
          Skeleton { count: 3, height: 20 },
          Icon { name: "github", size: "md" },
          Empty { "Nothing here yet" }
        }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: hono, contexts: [Orders], dataSources: [ordersState], port: 8080 }
    deployable web { platform: angular, targets: api, ui: Web, port: 3004 }
  }
`;

async function inlinePage(): Promise<string> {
  const all = await generateSystemFiles(INLINE_SOURCE);
  return all.get("web/src/app/pages/home.component.ts")!;
}

describe("angular generator — inline / media / layout primitives", () => {
  it("walks the inline + media primitives to their markup", async () => {
    const page = await inlinePage();
    expect(page).toContain("<strong>bold</strong>");
    expect(page).toContain("<em>italic</em>");
    expect(page).toContain('<code class="loom-inline-code">.ddd</code>');
    expect(page).toContain('<div class="loom-key-value-row">');
    expect(page).toContain('<img class="loom-avatar" src="/a.png" alt="user" />');
    expect(page).toContain('<img class="loom-image" src="/logo.png" alt="logo" />');
    expect(page).toContain('<div class="loom-empty">Nothing here yet</div>');
  });

  it("inlines the builtin Icon SVG and unrolls the multi-Skeleton via range", async () => {
    const page = await inlinePage();
    expect(page).toContain('<span class="loom-icon loom-icon-md"><svg');
    // count: 3 → three skeleton blocks unrolled at generation time.
    expect(page.match(/loom-skeleton" style="height: 20px"/g)?.length).toBe(3);
  });

  it("registers MatTabsModule + MatProgressSpinnerModule (Grid/Avatar etc. stay import-free)", async () => {
    const page = await inlinePage();
    expect(page).toContain("<mat-tab-group>");
    expect(page).toContain('<mat-tab label="Overview">');
    expect(page).toContain('<mat-progress-spinner mode="indeterminate"');
    expect(page).toContain('import { MatTabsModule } from "@angular/material/tabs";');
    expect(page).toContain(
      'import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";',
    );
    // Grid is CSS-only — no module pulled in for it.
    expect(page).toContain('<div class="loom-grid">');
  });
});

// ---------------------------------------------------------------------------
// Navigation + format-helper primitives — Anchor/IdLink/Breadcrumbs route via
// `[routerLink]` (the page shell registers the RouterLink directive), and
// Money/DateDisplay/IdLink call `src/lib/format.ts` helpers, which Angular can
// only resolve as component members — so the shell re-exposes each used helper
// as a `protected readonly` field.  EnumBadge interpolates its value; CodeBlock
// is plain markup.  (ng build-verified separately.)
// ---------------------------------------------------------------------------

const NAV_SOURCE = `
  system Smoke {
    subdomain Sales {
      context Orders {
        aggregate Order with crudish { total: int }
      }
    }
    ui Web {
      page Home {
        route: "/"
        title: "Home"
        body: Stack {
          Breadcrumbs {
            Anchor { "Home", to: "/" }
          },
          Anchor { "About", to: "/about" },
          IdLink { id: "abc12345def", of: Order },
          Money { value: 1299, currency: "USD" },
          DateDisplay { value: "2026-06-18T12:00:00Z" },
          EnumBadge { "active", color: "green" },
          CodeBlock { "aggregate Order { total: int }", language: "plaintext", title: "orders.ddd" }
        }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: hono, contexts: [Orders], dataSources: [ordersState], port: 8080 }
    deployable web { platform: angular, targets: api, ui: Web, port: 3004 }
  }
`;

async function navPage(): Promise<string> {
  const all = await generateSystemFiles(NAV_SOURCE);
  return all.get("web/src/app/pages/home.component.ts")!;
}

describe("angular generator — navigation + format-helper primitives", () => {
  it("routes Anchor/IdLink/Breadcrumbs via [routerLink] + registers RouterLink", async () => {
    const page = await navPage();
    expect(page).toContain('<nav class="loom-breadcrumbs">');
    expect(page).toContain('<a class="loom-anchor" [routerLink]=\'"/about"\'>About</a>');
    expect(page).toContain('[routerLink]=\'"/orders/" + "abc12345def"\'');
    expect(page).toContain('import { RouterLink } from "@angular/router";');
    expect(page).toContain("imports: [RouterLink],");
  });

  it("re-exposes only the format helpers the markup calls", async () => {
    const page = await navPage();
    expect(page).toContain(
      'import { formatMoney, formatDateTime, shortId } from "../../lib/format";',
    );
    expect(page).toContain("protected readonly formatMoney = formatMoney;");
    expect(page).toContain("protected readonly formatDateTime = formatDateTime;");
    expect(page).toContain("protected readonly shortId = shortId;");
    // A helper the page never calls is not imported or exposed.
    expect(page).not.toContain("formatBool");
  });

  it("interpolates the helper calls + EnumBadge value and renders CodeBlock markup", async () => {
    const page = await navPage();
    expect(page).toContain('{{ formatMoney(1299, "USD") }}');
    expect(page).toContain('{{ formatDateTime("2026-06-18T12:00:00Z") }}');
    expect(page).toContain('{{ shortId("abc12345def") }}');
    expect(page).toContain('<span class="loom-badge" data-color="green">{{ "active" }}</span>');
    expect(page).toContain('<pre><code class="language-plaintext">');
  });
});

// ---------------------------------------------------------------------------
// QueryView collection read (data path sub-slice B).  A `QueryView { of:
// <handle>.<Agg>.all, … }` un-stubs: the shared walker detects the api call,
// the page shell imports the `useAll<Agg>s` factory from `../../api/<agg>` and
// hoists it as a `readonly` class field, and the Angular QueryView template
// branches on the signal-backed handle (`isLoading()`/`isError()`/`data()`).
// The `data:` lambda binds rows to `<handle>.data()` (the renderQueryDataAccess
// seam — signals are called), so the `For` iterates the array.  (ng
// build-verified separately.)
// ---------------------------------------------------------------------------

const QUERY_SOURCE = `
  system Smoke {
    api SalesApi from Sales
    subdomain Sales {
      context Orders {
        aggregate Order with crudish { customerId: string }
        repository Orders for Order { }
      }
    }
    ui WebApp {
      api Sales: SalesApi
      page OrderList {
        route: "/"
        body: QueryView {
          of: Sales.Order.all,
          loading: Loader {},
          error: Alert { "Couldn't load orders" },
          empty: Empty { "No orders yet" },
          data: rows => Stack {
            For { each: rows, o => Card { "Order", Text { o.customerId } } }
          },
          testid: "orders-query"
        }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api {
      platform: hono
      contexts: [Orders]
      dataSources: [ordersState]
      serves: SalesApi
      port: 8080
    }
    deployable web {
      platform: angular
      targets: api
      ui: WebApp { Sales: api }
      port: 3004
    }
  }
`;

async function queryPage(): Promise<string> {
  const all = await generateSystemFiles(QUERY_SOURCE);
  return all.get("web/src/app/pages/order-list.component.ts")!;
}

describe("angular generator — QueryView collection read", () => {
  it("un-stubs the page: imports the read factory and hoists it as a class field", async () => {
    const page = await queryPage();
    expect(page).toContain('import { useAllOrders } from "../../api/order";');
    expect(page).toContain("readonly orderAll = useAllOrders();");
    // Not the stub.
    expect(page).not.toContain("body needs api/forms support");
  });

  it("branches the QueryView on the signal-backed handle (called signals)", async () => {
    const page = await queryPage();
    expect(page).toContain("@if (orderAll.isLoading()) {");
    expect(page).toContain("@if (orderAll.isError()) {");
    expect(page).toContain(
      "@if (!orderAll.isLoading() && !orderAll.isError() && orderAll.data().length === 0) {",
    );
    expect(page).toContain("@if (orderAll.data().length > 0) {");
  });

  it("binds the data lambda to the called data signal and iterates rows", async () => {
    const page = await queryPage();
    expect(page).toContain("@for (o of orderAll.data(); track $index) {");
    expect(page).toContain("<div>{{ o.customerId }}</div>");
  });
});
