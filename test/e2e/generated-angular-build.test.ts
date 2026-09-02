import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

// ---------------------------------------------------------------------------
// Generator build gate for the Angular frontend (angular-frontend-plan.md
// Slice 4): generate a system with an angular deployable, npm-install the
// emitted project, and `ng build` it (the Angular CLI typechecks + bundles in
// one step — no separate `--noEmit` like the Vue/React harnesses).  Catches
// generator/pack drift invisible to the IR-level tests; institutionalises the
// per-PR `ng build` verification done by hand through the Slice-4 batches.
//
// Run modes:
//   1. `LOOM_ANGULAR_BUILD=1 npx vitest run …` (or `npm run test:angular-build`).
//   2. Single shard — `LOOM_ANGULAR_BUILD_CASE=<name>` filters to one case.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const SHARD = process.env.LOOM_ANGULAR_BUILD_CASE;
const ENABLED = process.env.LOOM_ANGULAR_BUILD === "1" || SHARD !== undefined;

interface Case {
  name: string;
  source: string;
  angularDir: string;
  /** Markers that MUST appear somewhere under the emitted project's `src/`
   *  before it is built.  A build case is only as good as what it generates:
   *  if the emitter stops producing the surface the case exists to compile, a
   *  green `ng build` says nothing.  Spelling the marker out turns that silent
   *  hollowing-out into a failure. */
  mustEmit?: readonly string[];
}

/** Minimal angular system — one aggregate (crudish → full read + create
 *  surface) and one explicit static page. */
const MINIMAL: Case = {
  name: "minimal",
  angularDir: "web",
  source: `
    system Shop {
      subdomain Sales {
        context Orders {
          aggregate Customer with crudish {
            name: string
            email: string
          }
        }
      }
      ui WebApp {
        page Home {
          route: "/"
          title: "Home"
        }
      }
      storage primary { type: postgres }
      resource ordersState { for: Orders, kind: state, use: primary }
      deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 3000 }
      deployable web { platform: angular, targets: api, ui: WebApp, port: 3004 }
    }
  `,
};

/** Scaffolded ui — exercises the router emitters across the
 *  scaffold-synthesised page set (list / new / detail / home).  Every page
 *  now renders a real body: the detail page's op-forms (#1457), the list
 *  (QueryView), and the new (CreateForm) — no page stubs in this set. */
const SCAFFOLD: Case = {
  name: "scaffold",
  angularDir: "web",
  source: `
    system Shop {
      subdomain Sales {
        context Orders {
          aggregate Customer with crudish {
            name: string
            email: string
          }
          valueobject LineItem { sku: string  qty: int }
          aggregate Order with crudish {
            total: int
            items: LineItem[]
          }
        }
      }
      ui WebApp with scaffold(subdomains: [Sales]) { }
      storage primary { type: postgres }
      resource ordersState { for: Orders, kind: state, use: primary }
      deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 3000 }
      deployable web { platform: angular, targets: api, ui: WebApp, port: 3004 }
    }
  `,
};

/** Feature-comprehensive hand-written ui covering the Slice-4 surface that
 *  actually renders: a collection QueryView + Table list, a CreateForm (string
 *  / enum / int / bool / datetime fields), and a byId detail page hosting an
 *  inline `Action(inst.op)` button. */
const SHOWCASE: Case = {
  name: "showcase",
  angularDir: "web",
  source: `
    system Shop {
      api SalesApi from Sales
      subdomain Sales {
        context Orders {
          enum OrderStatus { Draft, Confirmed, Shipped }
          aggregate Order with crudish {
            customerId: string
            status: OrderStatus
            priority: int
            rush: bool
            placedAt: datetime
            total: money?
            operation confirm() { }
          }
          repository Orders for Order { }
          criterion ConfirmedOrders of Order as o = o.status == OrderStatus.Confirmed
          projection RevenueSnapshot {
            confirmed: int
            revenue: money
            from Order as o
            where ConfirmedOrders
            select confirmed = count, revenue = sum(o.total)
          }
        }
      }
      ui WebApp {
        api Sales: SalesApi
        // User (non-extern) components — emitted as standalone @Component
        // classes under src/app/components/ (angular/components-emit.ts).
        // THREE shapes, because they typecheck differently under
        // strictTemplates: scalar @Input()s read bare in the template; an
        // aggregate-typed input carrying the wire DTO (its ../../api/<agg>
        // import resolves only at component depth); and a STATEFUL component
        // whose signal / computed / action-method members come from the page
        // shell's own machinery; a component that ISSUES A READ (its TanStack
        // query hoists as a class field, the same as a page's); and the
        // canonical Action host (an @Input()-typed record + the mutation the
        // click method awaits).  ng build is the only gate that type-checks a
        // generated Angular TEMPLATE, so all five live here.
        component TierBadge(label: string, level: int) {
          body: Stack {
            Text { label },
            Text { level > 2 ? "high" : "low" },
            Text { string(level * 2) }
          }
        }
        component OrderLine(order: Order) {
          body: Stack { Text { order.customerId }, Text { string(order.priority) } }
        }
        component OrderActions(order: Order) {
          body: Stack { Action { order.confirm } }
        }
        component OrderCount() {
          body: QueryView {
            of: Sales.Order.all,
            loading: Loader { },
            error: Alert { "Could not count orders" },
            empty: Text { "No orders yet" },
            data: rows => Text { string(rows.length) }
          }
        }
        component Ticker(caption: string) {
          state { n: int = 0 }
          derived doubled: int = n * 2
          action bump() { n := n + 1 }
          body: Stack {
            Text { caption },
            Text { string(doubled) },
            Button { "more", onClick: bump }
          }
        }
        page OrderList {
          route: "/"
          body: Stack {
            Heading { "Orders" },
            TierBadge { label: "gold", level: 3 },
            Ticker { caption: "hits" },
            OrderCount { },
            QueryView {
              of: Sales.Order.all,
              data: rows => Table {
                Column { "Customer", o => Text { o.customerId } },
                Column { "Status", o => Text { o.status } },
                rows: rows
              }
            },
            Anchor { "New order", to: "/orders/new" },
            QueryView {
              of: Sales.RevenueSnapshot,
              loading: Loader { },
              error: Alert { "Could not load revenue" },
              empty: Text { "No confirmed orders yet" },
              data: r => Group {
                Stat { "Confirmed orders", r.confirmed },
                Stat { "Revenue", Money { r.revenue } },
                testid: "revenue-snapshot"
              }
            }
          }
        }
        page OrderNew {
          route: "/orders/new"
          body: Card { CreateForm { of: Order, testid: "orders-new" } }
        }
        page OrderDetail {
          route: "/orders/:id"
          body: QueryView {
            of: Sales.Order.byId(id),
            single: true,
            data: o => Stack {
              Heading { "Order" },
              Text { o.customerId },
              OrderLine { order: o },
              OrderActions { order: o },
              Action { o.confirm }
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
  `,
};

/** Store surface (named-actions-and-stores.md §3, Stage 5) — a shared
 *  client-side `store Cart { state {…} action … }` injectable signal service,
 *  a page that READS store state by dotted name (`Cart.lines`, `Cart.count`)
 *  in markup (`For { each: Cart.lines }`, a Heading) and CALLS a store action
 *  from a page action (`discard() { Cart.clear() }`).  Page-only by choice — the
 *  showcase case above is where walked user components are compiled — so the
 *  store-from-component path of the React `store-showcase.ddd` is covered here
 *  purely through pages.  Asserts
 *  the `@Injectable` signal store at `src/app/stores/cart.store.ts` and the
 *  per-page `inject(CartStore)` + `this.cart.lines()` read / `this.cart.clear()`
 *  call all `ng build` cleanly. */
const STORE: Case = {
  name: "store",
  angularDir: "web",
  source: `
    system StoreShowcase {
      subdomain Sales {
        context Sales {
          aggregate Order with crudish {
            customerId: string
          }
          repository Orders for Order { }
        }
      }
      api SalesApi from Sales
      ui WebApp {
        api Sales: SalesApi
        store Cart {
          state {
            lines: string[]
            count: int = 0
          }
          action add(sku: string) {
            lines += sku
            count += 1
          }
          action clear() {
            lines := [ ]
            count := 0
          }
        }
        // Lifetime ladder (frontend-state-management.md §3.1) — gates the
        // native-router URL sync + the persist-middleware emit through ng build.
        store Filters persist: url {
          state {
            term: string = ""
            pageNo: int = 0
          }
          action setTerm(q: string) { term := q }
          action setPage(n: int) { pageNo := n }
        }
        store Draft persist: local {
          state { note: string = "" }
          action write(t: string) { note := t }
        }
        page CartPage {
          route: "/cart"
          state { confirming: bool = false }
          action discard() { Cart.clear() }
          action addOne() { Cart.add("SKU-1") }
          body: Stack {
            Heading { "Your cart", level: 1 },
            Heading { Cart.count, level: 3 },
            For { each: Cart.lines, line => Card { line } },
            Button { "Add item", onClick: addOne },
            Button { "Discard", onClick: discard }
          }
        }
        page Home {
          route: "/"
          body: Stack {
            Heading { "Store showcase", level: 1 },
            Heading { Filters.term, level: 3 },
            Heading { Draft.note, level: 3 }
          }
        }
      }
      storage primary { type: postgres }
      resource salesState { for: Sales, kind: state, use: primary }
      deployable api {
        platform: node
        contexts: [Sales]
        dataSources: [salesState]
        serves: SalesApi
        port: 3000
      }
      deployable web {
        platform: angular
        targets: api
        ui: WebApp { Sales: api }
        port: 3004
      }
    }
  `,
};

/** The angular pack matrix.  angularMaterial (Material components), primeng
 *  (PrimeNG components), and spartanNg (shadcn-for-Angular design language,
 *  plain styled elements) all ship the required template surface. */
/** File upload (M-T1.2 slice 4b) — a `File` aggregate field in a CreateForm
 *  renders a native file input wired through `onFileUpload` into a
 *  `FormControl<FileRef | null>`; the standalone `FileUpload(bind: <File
 *  state>)` (the `Up` page) wires a `signal<FileRef | null>` through the
 *  component's `onFileUploadTo` method.  Both paths must tsc-build. */
const FILE: Case = {
  name: "file",
  angularDir: "web",
  source: `
    system AFileUp {
      subdomain Media { context Docs {
        aggregate Attachment with crudish { title: string  blob: File }
      } }
      ui WebApp {
        page NewDoc { route: "/new"  title: "New"
          body: Stack { CreateForm { of: Attachment } } }
        page Up { route: "/up"  title: "Upload"
          state { doc: File }
          body: Stack { FileUpload { "Doc", bind: doc } } }
      }
      api DocsApi from Media
      storage primary { type: postgres }
      storage uploads { type: localDisk }
      resource docsState { for: Docs, kind: state, use: primary }
      resource docsFiles { for: Docs, kind: objectStore, use: uploads }
      deployable api { platform: node, contexts: [Docs], dataSources: [docsState, docsFiles], serves: DocsApi, port: 3000 }
      deployable web { platform: angular, targets: api, ui: WebApp, port: 3004 }
    }
  `,
};

/** DataGrid (M-T1.1 slice 10) — the TanStack-backed grid, whose markup the
 *  walker renders into a HOISTED SIBLING COMPONENT
 *  (`src/app/components/<kebab>.component.ts`) rather than the page.  Angular
 *  is the target where that matters most: its template is type-checked under
 *  `strictTemplates`, and every name the markup calls has to be re-exposed as
 *  a CLASS MEMBER (`String`, `Math`, the format helpers, `t` for the pager's
 *  translated chrome) — a missing member is an `ng build` error the page's own
 *  compile never sees.
 *
 *  React has had a DataGrid build case since the primitive landed
 *  (`react-build-cases.ts`); Vue, Svelte and Angular never did.  Filterable +
 *  computed-cell + selection on purpose: those switch on the branches
 *  (`hasFilters`, the `@if` cell branch, the `selectionChange` output) a bare
 *  grid leaves unemitted. */
const GRID: Case = {
  name: "grid",
  angularDir: "web",
  source: `
    system AGrid {
      subdomain Sales { context Orders {
        enum Tier { Bronze, Silver, Gold }
        aggregate Customer {
          name: string
          tier: Tier
          sequence: int
          spend: money
        }
        repository Customers for Customer { }
      } }
      api SalesApi from Sales
      ui WebApp {
        api Sales: SalesApi
        page CustomerGrid {
          route: "/customers"
          title: "Customers"
          state { selectedIds: string[] }
          body: Stack {
            Heading { "Customers", level: 1 },
            Text { \`Selected: {selectedIds.length}\` },
            QueryView { of: Sales.Customer.all, data: rows => DataGrid {
              Column { "Name", o => o.name, sortable: true, filterable: true },
              Column { "Sequence", o => o.sequence, sortable: true },
              Column { "Spend", o => o.spend, sortable: true },
              Column { "Tier", o => EnumBadge { o.tier } },
              rows: rows,
              selection: selectedIds,
              multiSort: true,
              columnVisibility: true,
              pageSize: 25,
              testid: "customer-data-grid"
            } }
          }
        }
      }
      storage primary { type: postgres }
      resource ordersState { for: Orders, kind: state, use: primary }
      deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: SalesApi, port: 3000 }
      deployable web {
        platform: angular
        targets: api
        ui: WebApp { Sales: api }
        port: 3004
      }
    }
  `,
};

/** Entity history (M-T3.9) — an `audited` aggregate PAIRED WITH a scaffolded
 *  `ui`, which is the only shape that emits the scaffolded History section.
 *
 *  Why this case has to exist at all: no example and no corpus fixture pairs
 *  those two, so the section — the `Timeline` over `useHistory<Agg>(id)` that
 *  `scaffoldDetails` hangs off the Detail page — was never generated by any
 *  build matrix.  Its author verified it by hand across four frontends, and
 *  hand verification is exactly what rots.
 *
 *  Why ANGULAR is the arm that carries it (and, per the matrix policy in
 *  `.github/workflows/generated-angular-build.yml`, ONE cell of it): the
 *  History section's whole payload is a TEMPLATE — an `@for`/`@if` tree over an
 *  `AuditEntry[]` whose `actor` / `before` / `after` are `unknown` on the wire.
 *  `ng build` runs `strictTemplates` over exactly that markup, resolving every
 *  name against the component class.  The defect that shipped and was caught by
 *  hand is in this class: `(orderHistory.data() ?? []) ?? []`, TS2869, because
 *  the `QueryView` data-lambda binding arrives already guarded and `Timeline`
 *  re-guarded it (`_walker/primitives/timeline.ts` `guardedList`).
 *
 *  Deliberately minimal: ONE audited aggregate, `crudish` for the write surface
 *  the trail records, and nothing else — every other page the scaffold emits is
 *  already covered by the `scaffold` case. */
const HISTORY: Case = {
  name: "history",
  angularDir: "web",
  // The three pieces that have to meet for this case to be testing anything:
  // the api-client read, the scaffolded section frame, and the `Timeline`
  // markup `strictTemplates` then has to accept.
  mustEmit: ["useHistoryOrder", "orders-detail-history", "loom-timeline"],
  source: `
    system AuditShop {
      subdomain Sales {
        context Orders {
          aggregate Order audited with crudish {
            reference: string
            quantity: int
          }
          repository Orders for Order { }
        }
      }
      ui WebApp with scaffold(subdomains: [Sales]) { }
      storage primary { type: postgres }
      resource ordersState { for: Orders, kind: state, use: primary }
      deployable api {
        platform: node
        contexts: [Orders]
        dataSources: [ordersState]
        port: 3000
      }
      deployable web {
        platform: angular
        targets: api
        ui: WebApp
        port: 3004
      }
    }
  `,
};

const PACKS = ["angularMaterial@v1", "primeng@v1", "spartanNg@v1"] as const;

interface MatrixCase extends Case {
  pack: (typeof PACKS)[number];
  label: string;
}

const allCases: MatrixCase[] = [MINIMAL, SCAFFOLD, SHOWCASE, STORE, FILE, GRID, HISTORY].flatMap(
  (c) => PACKS.map((pack) => ({ ...c, pack, label: `${c.name}:${pack}` })),
);

/** Inject `design: "<pack>"` into the angular deployable (single-line or
 *  multi-line `platform: angular` block). */
function injectDesign(src: string, qualified: string): string {
  const existing = /(\bdesign:\s*)(?:"[^"]*"|\w+)/;
  if (existing.test(src)) return src.replace(existing, `$1"${qualified}"`);
  const singleLine = /(deployable \w+ \{[^}\n]*platform: angular\b[^}\n]*?)(\s*)\}/;
  if (singleLine.test(src)) return src.replace(singleLine, `$1, design: "${qualified}"$2}`);
  return src.replace(
    /(deployable \w+ \{[^}]*?platform: angular\b)/,
    `$1\n        design: "${qualified}"`,
  );
}

/** Concatenate every file under `dir`, recursively. */
function readAll(dir: string): string {
  let out = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out += entry.isDirectory() ? readAll(full) : fs.readFileSync(full, "utf8");
  }
  return out;
}

function selectCases(): MatrixCase[] {
  if (SHARD === undefined) return allCases;
  const match = allCases.find((c) => c.label === SHARD || c.name === SHARD);
  if (!match) {
    throw new Error(
      `LOOM_ANGULAR_BUILD_CASE="${SHARD}" did not match any case.  Available: ${allCases
        .map((c) => c.label)
        .join(", ")}`,
    );
  }
  return [match];
}

const cases = ENABLED ? selectCases() : [];

describe.skipIf(!ENABLED)("generated Angular project compiles + bundles (ng build)", () => {
  it.each(cases)("$label → ng build passes", ({ source, angularDir, pack, mustEmit }) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-angular-build-"));
    try {
      const dddPath = path.join(outDir, "_case.ddd");
      fs.writeFileSync(dddPath, injectDesign(source, pack));
      execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
        stdio: "inherit",
        cwd: repoRoot,
      });
      const projectDir = path.join(outDir, angularDir);
      if (!fs.existsSync(projectDir)) {
        throw new Error(`Expected Angular project at ${projectDir}`);
      }
      if (mustEmit) {
        const src = readAll(path.join(projectDir, "src"));
        const missing = mustEmit.filter((m) => !src.includes(m));
        if (missing.length > 0) {
          throw new Error(
            `The generated project no longer emits ${missing.join(", ")} — this case ` +
              `would build green while covering nothing.  Fix the emitter, or retire the case.`,
          );
        }
      }
      execSync(`npm install --silent --no-audit --no-fund`, {
        cwd: projectDir,
        stdio: "inherit",
        timeout: 240_000,
      });
      // `ng build` runs the Angular compiler (strict template typecheck) +
      // esbuild bundle in one step.
      //
      // `stdio: "inherit"` is the convention across the e2e harnesses (in CI each
      // matrix cell is its own job, so the child's output IS the job log). The
      // cost lands locally, where this file loops over ALL 21 cells: execSync
      // throws a bare `Command failed: npx ng build`, and the reason is somewhere
      // up in interleaved output. Re-throw with the one piece of context that is
      // always relevant here and never in that output at the point of failure —
      // the Node version — because the Angular CLI enforces a hard floor and
      // failing it fails every cell at once, which reads exactly like a broken
      // diff. Deliberately does NOT hardcode the floor: the CLI prints its own
      // requirement, which cannot go stale.
      try {
        execSync(`npx ng build`, {
          cwd: projectDir,
          stdio: "inherit",
          timeout: 240_000,
        });
      } catch (e) {
        throw new Error(
          `npx ng build failed in ${projectDir} (running node ${process.version}).\n` +
            `See the build output above for the compiler's own message. If it names a ` +
            `minimum Node version, that is an environment limit, not a code defect — ` +
            `every cell in this matrix fails together when the floor is unmet.\n` +
            `Original: ${(e as Error).message}`,
        );
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 600_000);
});
