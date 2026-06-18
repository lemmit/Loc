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
