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
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 8080 }
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
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 8080 }
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
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 8080 }
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
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 8080 }
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
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 8080 }
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
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 8080 }
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
      platform: node
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
      "@if (!orderAll.isLoading() && !orderAll.isError() && (orderAll.data()?.items ?? []).length === 0) {",
    );
    expect(page).toContain("@if ((orderAll.data()?.items ?? []).length > 0) {");
  });

  it("binds the data lambda to the called data signal and iterates rows", async () => {
    const page = await queryPage();
    expect(page).toContain("@for (o of orderAll.data()!.items; track $index) {");
    expect(page).toContain("<div>{{ o.customerId }}</div>");
  });
});

// ---------------------------------------------------------------------------
// Table inside a QueryView data branch (data path sub-slice C).  `Table` lowers
// to a plain `@for`-driven HTML `<table class="loom-table">` (no mat-table /
// MatTableDataSource / displayedColumns component state) — headers from the
// Column labels, one `<td>` per column whose cell walks the accessor lambda
// (IdLink / Text / EnumBadge / DateDisplay) against the loop `row`.  Style
// flags map to `.loom-table-*` modifiers; `rowTestid` to a bound attribute.
// (ng build-verified separately.)
// ---------------------------------------------------------------------------

const TABLE_SOURCE = `
  system Smoke {
    api SalesApi from Sales
    subdomain Sales {
      context Orders {
        enum OrderStatus { Draft, Confirmed, Shipped }
        aggregate Order with crudish {
          customerId: string
          status: OrderStatus
          placedAt: datetime
        }
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
          empty: Empty { "No orders yet" },
          data: rows => Table {
            rows: rows,
            striped: true,
            highlight: true,
            sticky: true,
            rowTestid: r => "orders-row-" + r.id,
            Column { "ID", o => IdLink { o.id, of: Order } },
            Column { "Customer", o => Text { o.customerId } },
            Column { "Status", o => EnumBadge { o.status } },
            Column { "Placed", o => DateDisplay { o.placedAt } }
          },
          testid: "orders-query"
        }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api {
      platform: node
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

async function tablePage(): Promise<string> {
  const all = await generateSystemFiles(TABLE_SOURCE);
  return all.get("web/src/app/pages/order-list.component.ts")!;
}

describe("angular generator — Table in a QueryView data branch", () => {
  it("renders a plain @for table with column headers and the style modifiers", async () => {
    const page = await tablePage();
    expect(page).toContain(
      '<table class="loom-table loom-table-striped loom-table-highlight loom-table-sticky">',
    );
    expect(page).toContain("<tr><th>ID</th><th>Customer</th><th>Status</th><th>Placed</th></tr>");
    expect(page).toContain("@for (row of orderAll.data()!.items; track row.id) {");
    expect(page).toContain("[attr.data-testid]='(\"orders-row-\" + row.id)'");
  });

  it("walks each column accessor against the loop row", async () => {
    const page = await tablePage();
    // IdLink → routerLink + shortId; Text → interpolation; EnumBadge → badge;
    // DateDisplay → formatDateTime — all reading the `row` loop variable.
    expect(page).toContain("[routerLink]='\"/orders/\" + row.id'");
    expect(page).toContain("{{ shortId(row.id) }}");
    expect(page).toContain("<td><div>{{ row.customerId }}</div></td>");
    expect(page).toContain('<span class="loom-badge">{{ row.status }}</span>');
    expect(page).toContain("{{ formatDateTime(row.placedAt) }}");
  });
});

// ---------------------------------------------------------------------------
// Standalone state-bound inputs (Field / NumberField / MultilineField /
// PasswordField / Toggle / SelectField).  Each `bind:`s to a page-state signal
// — read via `<bind>()`, written via `<bind>.set(...)` from an `(input)` /
// `(change)` / `(selectionChange)` handler — distinct from the `form-of`
// Reactive-Forms machinery.  Also covers the page-shell honouring each state
// field's declared `= <init>`.  (ng build-verified separately.)
// ---------------------------------------------------------------------------

const INPUT_SOURCE = `
  system Smoke {
    subdomain Sales {
      context Orders {
        aggregate Order with crudish { total: int }
      }
    }
    ui Web {
      page Settings {
        route: "/"
        title: "Settings"
        state {
          name: string = ""
          count: int = 3
          bio: string = ""
          passcode: string = ""
          notify: bool = true
          size: string = "M"
        }
        body: Stack {
          Field { "Name", bind: name },
          NumberField { "Count", bind: count },
          MultilineField { "Bio", bind: bio },
          PasswordField { "Secret", bind: passcode },
          Toggle { "Notify me", bind: notify },
          SelectField { "Size", bind: size, options: ["S", "M", "L"] }
        }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 8080 }
    deployable web { platform: angular, targets: api, ui: Web, port: 3004 }
  }
`;

async function inputPage(): Promise<string> {
  const all = await generateSystemFiles(INPUT_SOURCE);
  return all.get("web/src/app/pages/settings.component.ts")!;
}

describe("angular generator — standalone state-bound inputs", () => {
  it("binds each input to its state signal (read () / write .set())", async () => {
    const page = await inputPage();
    expect(page).toContain(
      '<input matInput [value]="name()" (input)="name.set($any($event.target).value)" />',
    );
    expect(page).toContain(
      '<input matInput type="number" [value]="count()" (input)="count.set(+$any($event.target).value)" />',
    );
    expect(page).toContain('<textarea matInput [value]="bio()"');
    expect(page).toContain('<input matInput type="password" [value]="passcode()"');
    expect(page).toContain(
      '<mat-slide-toggle [checked]="notify()" (change)="notify.set($event.checked)">Notify me</mat-slide-toggle>',
    );
    expect(page).toContain(
      '<mat-select [value]="size()" (selectionChange)="size.set($event.value)">',
    );
    expect(page).toContain('@for (opt of ["S", "M", "L"]; track opt) {<mat-option [value]="opt">');
  });

  it("aggregates the field MatModules and honours each state field's declared init", async () => {
    const page = await inputPage();
    expect(page).toContain('import { MatFormFieldModule } from "@angular/material/form-field";');
    expect(page).toContain('import { MatInputModule } from "@angular/material/input";');
    expect(page).toContain('import { MatSelectModule } from "@angular/material/select";');
    expect(page).toContain(
      'import { MatSlideToggleModule } from "@angular/material/slide-toggle";',
    );
    // Declared inits, not type zero values.
    expect(page).toContain("readonly count = signal(3);");
    expect(page).toContain("readonly notify = signal(true);");
    expect(page).toContain('readonly size = signal("M");');
  });
});

// ---------------------------------------------------------------------------
// CreateForm(of: <Agg>) — idiomatic typed Reactive Forms (forms sub-slice).
// The Angular `renderCreateForm` seam forks the shared react-hook-form path:
// a `[formGroup]` / `(ngSubmit)` shell, per-field controls by type (text /
// number / mat-select for enums / mat-checkbox for bool / datetime-local), and
// a typed FormGroup + submit handler (`mutate(getRawValue())` → navigate) on
// the component class.  (ng build-verified separately.)
// ---------------------------------------------------------------------------

const FORM_SOURCE = `
  system Smoke {
    api SalesApi from Sales
    subdomain Sales {
      context Orders {
        enum OrderStatus { Draft, Confirmed, Shipped }
        aggregate Order with crudish {
          customerId: string
          status: OrderStatus
          priority: int
          rush: bool
        }
        repository Orders for Order { }
      }
    }
    ui WebApp {
      api Sales: SalesApi
      page OrderNew {
        route: "/"
        body: CreateForm { of: Order, testid: "orders-new" }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api {
      platform: node
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

async function formPage(): Promise<string> {
  const all = await generateSystemFiles(FORM_SOURCE);
  return all.get("web/src/app/pages/order-new.component.ts")!;
}

describe("angular generator — CreateForm typed Reactive Forms", () => {
  it("renders a [formGroup]/(ngSubmit) shell with per-type field controls", async () => {
    const page = await formPage();
    expect(page).toContain(
      '<form [formGroup]="orderForm" (ngSubmit)="onSubmitOrder()" data-testid="orders-new">',
    );
    expect(page).toContain('<input matInput formControlName="customerId"');
    expect(page).toContain('<mat-select formControlName="status"');
    expect(page).toContain('<mat-option value="Draft">Draft</mat-option>');
    expect(page).toContain('<input matInput type="number" formControlName="priority"');
    expect(page).toContain('<mat-checkbox formControlName="rush"');
    expect(page).toContain('[disabled]="orderCreate.isPending()"');
  });

  it("builds the typed FormGroup + submit handler on the component class", async () => {
    const page = await formPage();
    expect(page).toContain("readonly orderCreate = useCreateOrder();");
    expect(page).toContain('customerId: new FormControl("", { nonNullable: true })');
    expect(page).toContain("priority: new FormControl(0, { nonNullable: true })");
    expect(page).toContain("rush: new FormControl(false, { nonNullable: true })");
    expect(page).toContain("async onSubmitOrder(): Promise<void> {");
    expect(page).toContain(
      "const out = await this.orderCreate.mutateAsync(this.orderForm.getRawValue());",
    );
    expect(page).toContain("this.router.navigateByUrl(`/orders/${out.id}`);");
  });

  it("imports the Reactive Forms + api surface and is not stubbed", async () => {
    const page = await formPage();
    expect(page).toContain('import { CreateOrderRequest, useCreateOrder } from "../../api/order";');
    expect(page).toContain(
      'import { FormControl, FormGroup, ReactiveFormsModule } from "@angular/forms";',
    );
    expect(page).toContain("ReactiveFormsModule");
    expect(page).not.toContain("body needs api/forms support");
  });
});

// ---------------------------------------------------------------------------
// byId single-record reads — a detail page's `QueryView(of: …byId(id),
// single: true)` un-stubs and renders the single-record guards.  The `data()`
// signal is `T | null`, so the detail-lambda body non-null-asserts (`data()!`)
// inside the truthy `@if` (Angular templates don't narrow a call result).  The
// api module gains a `findById` + nullable-id `use<Agg>ById` factory.
// (ng build-verified separately.)
// ---------------------------------------------------------------------------

const DETAIL_SOURCE = `
  system Smoke {
    api SalesApi from Sales
    subdomain Sales {
      context Orders {
        aggregate Order with crudish {
          customerId: string
          total: int
        }
        repository Orders for Order { }
      }
    }
    ui WebApp {
      api Sales: SalesApi
      page OrderDetail {
        route: "/orders/:id"
        body: QueryView {
          of: Sales.Order.byId(id),
          single: true,
          data: o => Stack { Heading { "Order" }, Text { o.customerId } }
        }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api {
      platform: node
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

describe("angular generator — byId single-record reads", () => {
  it("un-stubs the detail page with single-record guards + non-null data access", async () => {
    const all = await generateSystemFiles(DETAIL_SOURCE);
    const page = all.get("web/src/app/pages/order-detail.component.ts")!;
    expect(page).not.toContain("body needs api/forms support");
    expect(page).toContain('import { useOrderById } from "../../api/order";');
    // The magic route `id` binds from the ActivatedRoute snapshot, and the byId
    // read receives it (it used to be `useOrderById(undefined)` — never fetched).
    expect(page).not.toContain("unsupported expr: id");
    expect(page).toContain('readonly id = this.route.snapshot.paramMap.get("id") ?? "";');
    expect(page).toContain("readonly orderById = useOrderById(this.id);");
    // Single-record (not collection `.length`) guards.
    expect(page).toContain(
      "@if (!orderById.isLoading() && !orderById.isError() && !orderById.data())",
    );
    expect(page).toContain("@if (orderById.data()) {");
    // Body asserts non-null inside the truthy branch (template can't narrow a call).
    expect(page).toContain("orderById.data()!.customerId");
  });

  it("emits a findById service method + an injectQuery byId factory (cached, id-guarded)", async () => {
    const all = await generateSystemFiles(DETAIL_SOURCE);
    const api = all.get("web/src/api/order.ts")!;
    expect(api).toContain("findById(id: string) {");
    expect(api).toContain("this.http.get<OrderResponse>(`${API_BASE_URL}/orders/${id}`)");
    expect(api).toContain("export function useOrderById(id: string | undefined) {");
    // TanStack injectQuery: keyed by [record, id], idle until the id resolves.
    expect(api).toContain(
      'import { QueryClient, injectMutation, injectQuery } from "@tanstack/angular-query-experimental";',
    );
    expect(api).toContain('queryKey: ["order", id] as const,');
    expect(api).toContain("queryFn: () => firstValueFrom(service.findById(id as string)),");
    expect(api).toContain("enabled: !!id,");
  });

  // An aggregate carrying a public operation, for the Action variants.
  const opSource = (actionBody: string): string =>
    DETAIL_SOURCE.replace(
      'data: o => Stack { Heading { "Order" }, Text { o.customerId } }',
      `data: o => Stack { ${actionBody} }`,
    ).replace(
      "aggregate Order with crudish {\n          customerId: string\n          total: int\n        }",
      "aggregate Order with crudish {\n          customerId: string\n          operation cancel() { }\n        }",
    );

  it("renders a no-then Action as a dumb-template method call + id-guarded mutate", async () => {
    const all = await generateSystemFiles(opSource("Action { o.cancel }"));
    const page = all.get("web/src/app/pages/order-detail.component.ts")!;
    expect(page).not.toContain("stub — body needs api/forms support");
    // Dumb template — one event, one method call (no arrow, no in-markup id).
    expect(page).toContain("(click)='onCancelOrder()'");
    expect(page).toContain("[disabled]='cancelOrder.isPending()'");
    expect(page).not.toContain("() =>");
    // The method reads the id inside, with a `?.id` guard + early return.
    expect(page).toContain("readonly cancelOrder = useCancelOrder();");
    expect(page).toContain("async onCancelOrder(): Promise<void> {");
    expect(page).toContain("const id = this.orderById.data()?.id;");
    expect(page).toContain("if (!id) return;");
    expect(page).toContain("await this.cancelOrder.mutateAsync({ id, input: {} });");
    expect(page).toContain('import { useCancelOrder } from "../../api/order";');
    // No capture-signal workaround.
    expect(page).not.toContain("cancelOrderId");
    // Factory shape: an injectMutation carrying the id in its variables.
    const api = all.get("web/src/api/order.ts")!;
    expect(api).toContain("export function useCancelOrder() {");
    expect(api).toContain("return injectMutation(() => ({");
    expect(api).toContain("mutationFn: (vars: { id: string; input: CancelOrderRequest }) =>");
  });

  it("renders a then-bearing Action via the same method, with the effect appended", async () => {
    const all = await generateSystemFiles(
      opSource("Action { o.cancel, then: navigate(OrderDetail) }"),
    );
    const page = all.get("web/src/app/pages/order-detail.component.ts")!;
    expect(page).not.toContain("stub — body needs api/forms support");
    // Same dumb-template shape — the `then:` effect just runs after the mutate.
    expect(page).toContain("(click)='onCancelOrder()'");
    expect(page).toContain("async onCancelOrder(): Promise<void> {");
    expect(page).toContain("const id = this.orderById.data()?.id;");
    expect(page).toContain("if (!id) return;");
    expect(page).toContain("await this.cancelOrder.mutateAsync({ id, input: {} });");
    // The `then:` effect runs after the mutation resolves, `this.`-prefixed.
    expect(page).toContain("this.router.navigateByUrl(");
    // No capture-signal workaround.
    expect(page).not.toContain("cancelOrderId");
  });
});

// ---------------------------------------------------------------------------
// Modal { OperationForm(…), trigger: … } — the operation-dialog form, rendered
// as a signal-toggled inline Reactive Form.  The trigger captures the record id
// into a signal (so the submit method reads it without this-prefixing a
// template expr), the `@if (<op>Open())` block holds the typed FormGroup over
// the op's params, and submit calls the id-at-mutate `use<Op><Agg>()` factory
// then closes.  (ng build-verified separately.)
// ---------------------------------------------------------------------------

const MODAL_SOURCE = `
  system Smoke {
    api SalesApi from Sales
    subdomain Sales {
      context Orders {
        aggregate Order with crudish {
          customerId: string
          operation addNote(reason: string) { }
        }
        repository Orders for Order { }
      }
    }
    ui WebApp {
      api Sales: SalesApi
      page OrderDetail {
        route: "/orders/:id"
        body: QueryView {
          of: Sales.Order.byId(id),
          single: true,
          data: o => Stack {
            Heading { "Order" },
            Modal {
              OperationForm { of: Order, op: addNote, testid: "orders-op-addNote" },
              title: "Add note",
              trigger: Button { "Add note", emphasis: "primary", testid: "orders-op-addNote" }
            }
          }
        }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api {
      platform: node
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

describe("angular generator — Modal operation-dialog form", () => {
  it("renders a trigger that captures the id + toggles an @if form block", async () => {
    const all = await generateSystemFiles(MODAL_SOURCE);
    const page = all.get("web/src/app/pages/order-detail.component.ts")!;
    expect(page).not.toContain("not yet supported on Angular");
    // Trigger captures the record id into a signal + opens (single-quoted
    // binding so the bare `id` ref is clean).
    expect(page).toContain("(click)='addNoteOrderId.set(id); addNoteOrderOpen.set(true)'");
    expect(page).toContain("@if (addNoteOrderOpen()) {");
    expect(page).toContain(
      '<form [formGroup]="addNoteOrderForm" (ngSubmit)="submitAddNoteOrder()"',
    );
    expect(page).toContain('formControlName="reason"');
    expect(page).toContain('[disabled]="addNoteOrder.isPending()"');
  });

  it("wires the toggle signals, op mutation, FormGroup + submit method on the class", async () => {
    const all = await generateSystemFiles(MODAL_SOURCE);
    const page = all.get("web/src/app/pages/order-detail.component.ts")!;
    expect(page).toContain("readonly addNoteOrderOpen = signal(false);");
    expect(page).toContain('readonly addNoteOrderId = signal("");');
    expect(page).toContain("readonly addNoteOrder = useAddNoteOrder();");
    expect(page).toContain(
      'readonly addNoteOrderForm = new FormGroup({ reason: new FormControl("", { nonNullable: true }) });',
    );
    expect(page).toContain("async submitAddNoteOrder(): Promise<void> {");
    expect(page).toContain(
      "await this.addNoteOrder.mutateAsync({ id: this.addNoteOrderId(), input: this.addNoteOrderForm.getRawValue() });",
    );
    expect(page).toContain("this.addNoteOrderOpen.set(false);");
    expect(page).toContain('import { useAddNoteOrder } from "../../api/order";');
  });
});

// ---------------------------------------------------------------------------
// Parameterised find + view + workflow reads (gap-closure: the api-service
// layer).  A `QueryView(of: <api>.<Agg>.<find>(arg))` un-stubs and hoists the
// `use<Find><Agg>(query)` factory; a `QueryView(of: Views.<View>)` hoists
// `use<View>View()` from `../api/views`; both the per-aggregate module's find
// factory and the views/workflows modules are emitted Angular-native (TanStack
// injectQuery off an @Injectable service).  (ng build-verified separately.)
// ---------------------------------------------------------------------------

const FIND_SOURCE = `
  system Smoke {
    api SalesApi from Sales
    subdomain Sales {
      context Orders {
        enum OrderStatus { Draft, Confirmed, Shipped }
        aggregate Order with crudish { customerId: string  status: OrderStatus }
        repository Orders for Order { find byStatus(status: OrderStatus): Order[] }
        view RecentOrders from Order
      }
    }
    ui WebApp {
      api Sales: SalesApi
      page ByStatus {
        route: "/by-status"
        state { status: OrderStatus = Draft }
        body: QueryView {
          of: Sales.Order.byStatus(status),
          loading: Loader {},
          error: Alert { "err" },
          empty: Empty { "none" },
          data: rows => Stack { For { each: rows, o => Text { o.customerId } } }
        }
      }
      page Recent {
        route: "/recent"
        body: QueryView {
          of: Views.RecentOrders,
          loading: Loader {},
          error: Alert { "err" },
          empty: Empty { "none" },
          data: rows => Stack { For { each: rows, o => Text { o.id } } }
        }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: SalesApi, port: 8080 }
    deployable web { platform: angular, targets: api, ui: WebApp { Sales: api }, port: 3004 }
  }
`;

async function findFiles(): Promise<Map<string, string>> {
  const all = await generateSystemFiles(FIND_SOURCE);
  const out = new Map<string, string>();
  for (const [p, c] of all) if (p.startsWith("web/")) out.set(p.slice("web/".length), c);
  return out;
}

describe("angular generator — parameterised find + view reads", () => {
  it("un-stubs the find page and hoists the find factory with a REACTIVE getter", async () => {
    const page = (await findFiles()).get("src/app/pages/by-status.component.ts")!;
    expect(page).not.toContain("body needs api/forms support");
    expect(page).toContain('import { useByStatusOrder } from "../../api/order";');
    // The shared walker renders find args as a `{ <param>: <value> }` object; the
    // state signal read resolves against `this`.  The whole object is wrapped in
    // a getter (`() => (...)`) so the `injectQuery` options re-read it and the
    // query LIVE-REFETCHES when the bound `status` signal changes — a bare
    // `{ status: this.status() }` snapshot would freeze the query at construction.
    expect(page).toContain(
      "readonly orderByStatus = useByStatusOrder(() => ({ status: this.status() }));",
    );
  });

  it("emits the find query interface + service method + reactive-getter factory", async () => {
    const api = (await findFiles()).get("src/api/order.ts")!;
    expect(api).toContain("export interface ByStatusOrderQuery {");
    expect(api).toContain("byStatus(query: ByStatusOrderQuery) {");
    // The factory takes a getter and re-reads it inside the reactive options.
    expect(api).toContain("export function useByStatusOrder(query: () => ByStatusOrderQuery) {");
    expect(api).toContain(`queryKey: ["orders", "find", "by_status", query()] as const,`);
    expect(api).toContain("queryFn: () => firstValueFrom(service.byStatus(query())),");
  });

  it("un-stubs the view page and emits the Angular-native views module", async () => {
    const files = await findFiles();
    const page = files.get("src/app/pages/recent.component.ts")!;
    expect(page).not.toContain("body needs api/forms support");
    expect(page).toContain('import { useRecentOrdersView } from "../../api/views";');
    expect(page).toContain("readonly recentOrdersView = useRecentOrdersView();");
    const views = files.get("src/api/views.ts")!;
    expect(views).toContain('import { injectQuery } from "@tanstack/angular-query-experimental";');
    expect(views).toContain("export class ViewsService {");
    expect(views).toContain("export function useRecentOrdersView() {");
    expect(views).toContain(`queryKey: ["views", "recent_orders"] as const,`);
  });
});

// ---------------------------------------------------------------------------
// WorkflowForm(runs: <Wf>) — the workflow-command form, forked to a typed
// Reactive Form posting `use<Wf>Workflow` then navigating `/workflows`.  The
// Angular workflows module emits the `injectMutation` command factory + (for
// observable workflows) the instance read factories.  (ng build-verified.)
// ---------------------------------------------------------------------------

const WF_FORM_SOURCE = `
  system Smoke {
    api SalesApi from Sales
    subdomain Sales {
      context Orders {
        aggregate Order with crudish { customerId: string }
        workflow Fulfill for Order {
          actor staff
          input { note: string }
          state Packing
          state Shipped
          transition pack from Packing to Shipped by staff { }
        }
      }
    }
    ui WebApp {
      api Sales: SalesApi
      page RunFulfill {
        route: "/run"
        body: Card { WorkflowForm { runs: Fulfill, testid: "workflow-fulfill" } }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: SalesApi, port: 8080 }
    deployable web { platform: angular, targets: api, ui: WebApp { Sales: api }, port: 3004 }
  }
`;

describe("angular generator — WorkflowForm typed Reactive Form", () => {
  it("un-stubs the workflow page and wires the command FormGroup + submit", async () => {
    const all = await generateSystemFiles(WF_FORM_SOURCE);
    const page = all.get("web/src/app/pages/run-fulfill.component.ts")!;
    expect(page).not.toContain("body needs api/forms support");
    expect(page).toContain(
      '<form [formGroup]="fulfillForm" (ngSubmit)="onRunFulfill()" data-testid="workflow-fulfill">',
    );
    expect(page).toContain("readonly fulfillRun = useFulfillWorkflow();");
    expect(page).toContain("async onRunFulfill(): Promise<void> {");
    expect(page).toContain("await this.fulfillRun.mutateAsync(this.fulfillForm.getRawValue());");
    expect(page).toContain('this.router.navigateByUrl("/workflows");');
    expect(page).toContain(
      'import { FulfillRequest, useFulfillWorkflow } from "../../api/workflows";',
    );
  });

  it("emits the Angular workflows module (injectMutation command factory)", async () => {
    const all = await generateSystemFiles(WF_FORM_SOURCE);
    const wf = all.get("web/src/api/workflows.ts")!;
    expect(wf).toContain("export interface FulfillRequest {");
    expect(wf).toContain("export class WorkflowsService {");
    expect(wf).toContain("export function useFulfillWorkflow() {");
    // A non-observable workflow has no instance reads, so only injectMutation
    // is imported (an unused injectQuery would be an ng build error).
    expect(wf).toContain('import { injectMutation } from "@tanstack/angular-query-experimental";');
  });
});

// ---------------------------------------------------------------------------
// Standalone OperationForm(...) — the operation-command form NOT hosted in a
// Modal, forked to an always-visible typed Reactive Form.  Two source shapes:
// the flat `OperationForm(of:, op:)` (targets the route id) and the instance
// `OperationForm(<inst>.<op>)` inside a Detail data lambda (the spoken `Form`
// shape).  Submit calls `use<Op><Agg>()` with the id + the op-param form.
// (ng build-verified separately.)
// ---------------------------------------------------------------------------

const OPFORM_SOURCE = (body: string) => `
  system Smoke {
    api SalesApi from Sales
    subdomain Sales {
      context Orders {
        aggregate Order with crudish {
          customerId: string
          operation addNote(reason: string) { }
        }
        repository Orders for Order { }
      }
    }
    ui WebApp {
      api Sales: SalesApi
      page OrderEdit {
        route: "/orders/:id/edit"
        body: ${body}
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api {
      platform: node
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

describe("angular generator — standalone OperationForm (flat of:/op:)", () => {
  it("renders an always-visible [formGroup]/(ngSubmit) form over the op params", async () => {
    const all = await generateSystemFiles(
      OPFORM_SOURCE(`OperationForm { of: Order, op: addNote, testid: "orders-op-addNote" }`),
    );
    const page = all.get("web/src/app/pages/order-edit.component.ts")!;
    expect(page).not.toContain("not yet supported on Angular");
    expect(page).not.toContain("body needs api/forms support");
    expect(page).toContain(
      '<form [formGroup]="addNoteOrderForm" (ngSubmit)="submitAddNoteOrder()" data-testid="orders-op-addNote">',
    );
    expect(page).toContain('formControlName="reason"');
  });

  it("wires the op mutation, FormGroup + an id-from-route submit method", async () => {
    const all = await generateSystemFiles(
      OPFORM_SOURCE(`OperationForm { of: Order, op: addNote }`),
    );
    const page = all.get("web/src/app/pages/order-edit.component.ts")!;
    // The route id binds from the ActivatedRoute snapshot; the mutate targets it.
    expect(page).toContain('readonly id = this.route.snapshot.paramMap.get("id") ?? "";');
    expect(page).toContain("readonly addNoteOrder = useAddNoteOrder();");
    expect(page).toContain(
      'readonly addNoteOrderForm = new FormGroup({ reason: new FormControl("", { nonNullable: true }) });',
    );
    expect(page).toContain("async submitAddNoteOrder(): Promise<void> {");
    expect(page).toContain(
      "await this.addNoteOrder.mutateAsync({ id: this.id, input: this.addNoteOrderForm.getRawValue() });",
    );
    expect(page).toContain('import { useAddNoteOrder } from "../../api/order";');
    // Single import (not duplicated by the side-channel + addNg).
    expect(page.match(/import \{ useAddNoteOrder \}/g)?.length).toBe(1);
  });

  it("renders the instance shape (Form-style <inst>.<op>) inside a Detail lambda", async () => {
    const all = await generateSystemFiles(
      OPFORM_SOURCE(
        `QueryView { of: Sales.Order.byId(id), single: true, data: o => Stack { OperationForm { o.addNote } } }`,
      ),
    );
    const page = all.get("web/src/app/pages/order-edit.component.ts")!;
    expect(page).not.toContain("not yet supported on Angular");
    expect(page).toContain(
      '<form [formGroup]="addNoteOrderForm" (ngSubmit)="submitAddNoteOrder()"',
    );
    // The lambda binding isn't class-field-scoped, so the mutate targets route id.
    expect(page).toContain(
      "await this.addNoteOrder.mutateAsync({ id: this.id, input: this.addNoteOrderForm.getRawValue() });",
    );
  });
});

// ---------------------------------------------------------------------------
// DestroyForm(of: <Agg>) — the canonical-destroy confirmation form, forked to a
// confirm-delete button wired to `useDelete<Agg>`.  The button's (click) calls a
// dumb-template method: window.confirm → mutateAsync(id) → navigate the list
// route (default `then:`).  The api module gains a `delete` service method + an
// `injectMutation` factory, gated on the aggregate's canonical destroy.
// (ng build-verified separately.)
// ---------------------------------------------------------------------------

const DESTROY_SOURCE = `
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
      page OrderDelete {
        route: "/orders/:id/delete"
        body: DestroyForm { of: Order }
      }
    }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api {
      platform: node
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

describe("angular generator — DestroyForm confirm-delete", () => {
  it("renders a confirm-delete button + a dumb-template method (no stub)", async () => {
    const all = await generateSystemFiles(DESTROY_SOURCE);
    const page = all.get("web/src/app/pages/order-delete.component.ts")!;
    expect(page).not.toContain("body needs api/forms support");
    expect(page).toContain(
      '<button mat-raised-button color="warn" (click)="onDeleteOrder()" [disabled]="deleteOrder.isPending()" data-testid="orders-destroy">Delete Order</button>',
    );
    expect(page).toContain("readonly deleteOrder = useDeleteOrder();");
    expect(page).toContain("async onDeleteOrder(): Promise<void> {");
    expect(page).toContain('if (!window.confirm("Delete this order?")) return;');
    expect(page).toContain("await this.deleteOrder.mutateAsync(this.id);");
    // Default then: navigates to the aggregate list route.
    expect(page).toContain('this.router.navigateByUrl("/orders");');
    expect(page).toContain('import { useDeleteOrder } from "../../api/order";');
    expect(page.match(/import \{ useDeleteOrder \}/g)?.length).toBe(1);
  });

  it("emits the delete service method + injectMutation factory (gated on canonical destroy)", async () => {
    const all = await generateSystemFiles(DESTROY_SOURCE);
    const api = all.get("web/src/api/order.ts")!;
    expect(api).toContain("delete(id: string) {");
    expect(api).toContain("return this.http.delete<void>(`${API_BASE_URL}/orders/${id}`);");
    expect(api).toContain("export function useDeleteOrder() {");
    expect(api).toContain("mutationFn: (id: string) => firstValueFrom(service.delete(id)),");
  });
});
