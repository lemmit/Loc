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
            operation confirm() { }
          }
          repository Orders for Order { }
        }
      }
      ui WebApp {
        api Sales: SalesApi
        page OrderList {
          route: "/"
          body: Stack {
            Heading { "Orders" },
            QueryView {
              of: Sales.Order.all,
              loaded: rows => Table { of: rows, columns: [o => o.customerId, o => o.status] }
            },
            Anchor { "New order", to: "/orders/new" }
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
 *  from a page action (`discard() { Cart.clear() }`).  Page-only (Angular emits
 *  no standalone user-component files), so the store-from-component path of the
 *  React `store-showcase.ddd` is covered here purely through pages.  Asserts
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
 *  `FormControl<FileRef | null>`.  (The standalone `FileUpload(bind:)` on
 *  Angular renders a bare input — functionally deferred — but still builds.) */
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

const PACKS = ["angularMaterial@v1", "primeng@v1", "spartanNg@v1"] as const;

interface MatrixCase extends Case {
  pack: (typeof PACKS)[number];
  label: string;
}

const allCases: MatrixCase[] = [MINIMAL, SCAFFOLD, SHOWCASE, STORE, FILE].flatMap((c) =>
  PACKS.map((pack) => ({ ...c, pack, label: `${c.name}:${pack}` })),
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
  it.each(cases)("$label → ng build passes", ({ source, angularDir, pack }) => {
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
      execSync(`npm install --silent --no-audit --no-fund`, {
        cwd: projectDir,
        stdio: "inherit",
        timeout: 240_000,
      });
      // `ng build` runs the Angular compiler (strict template typecheck) +
      // esbuild bundle in one step.
      execSync(`npx ng build`, {
        cwd: projectDir,
        stdio: "inherit",
        timeout: 240_000,
      });
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 600_000);
});
