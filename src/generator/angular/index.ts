import type {
  ComponentIR,
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  SystemIR,
} from "../../ir/types/loom-ir.js";
import { contextUsesMoney } from "../../ir/types/loom-ir.js";
import { API_BASE_PATH } from "../../util/api-base.js";
import { humanize } from "../../util/naming.js";
import { prepareThemeVM } from "../_frontend/theme-preparer.js";
import { loadPack, resolvePackDir } from "../_packs/loader-fs.js";
import { renderAngularRoutes } from "./routes-emitter.js";

// ---------------------------------------------------------------------------
// Angular frontend generator — orchestrator (angular-frontend-plan.md
// Slice 3, walking skeleton).
//
// Emits a complete, `ng build`-able empty Angular project: the project
// shell (package.json / angular.json / tsconfig[.app].json), the standalone
// bootstrap (main.ts + app.config.ts), the Material app shell, an empty
// route table (Home + wildcard NotFound), the DI-native api client/config,
// theme, format helpers, and the docker stage.  Page walking + the
// primitive/field/form tiers + per-aggregate @Injectable services land in
// Slice 4 — at which point the pack's required-primitive surface is
// complete and the `validateRequired: false` below flips on.
// ---------------------------------------------------------------------------

export interface GenerateAngularOptions {
  apiBaseUrl?: string;
  basePath?: string;
  topLevelComponents?: ComponentIR[];
}

const DEFAULT_DESIGN = "angularMaterial@v1";

export function generateAngularForContexts(
  contexts: EnrichedBoundedContextIR[],
  sys: SystemIR,
  deployable: DeployableIR,
  options: GenerateAngularOptions = {},
): Map<string, string> {
  const out = new Map<string, string>();

  // TODO(angular Slice 4): drop `validateRequired: false` once the
  // angularMaterial pack ships the full primitive/field/form tiers.
  const pack = loadPack(resolvePackDir(deployable.design ?? DEFAULT_DESIGN), {
    validateRequired: false,
  });

  const target = sys.deployables.find((d) => d.name === deployable.targetName);
  const apiBaseUrl = options.apiBaseUrl ?? API_BASE_PATH;

  const aggregates: Array<{ agg: EnrichedAggregateIR; ctx: EnrichedBoundedContextIR }> = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) aggregates.push({ agg, ctx });
  }
  const hasDelete = aggregates.some((a) => !!a.agg.canonicalDestroy);
  const usesMoney = contexts.some(contextUsesMoney);
  const authUi = !!(deployable.auth?.ui && target?.auth?.required && sys.user);

  // --- Project shell (pack-emitted) -----------------------------------
  out.set("package.json", pack.render("package-json", { usesMoney }));
  out.set("angular.json", pack.render("angular-json", {}));
  out.set("tsconfig.json", pack.render("tsconfig", {}));
  out.set("tsconfig.app.json", pack.render("tsconfig-app", {}));
  out.set("src/main.ts", pack.render("main", {}));
  out.set("src/styles.css", pack.render("theme", prepareThemeVM(sys.theme)));
  out.set("src/lib/format.ts", pack.render("format-helpers", {}));

  // The app shell (Material toolbar + sidenav).  No pages yet, so the
  // nav is empty (Slice 4 derives sections from the ui's pages).
  out.set(
    "src/app/app.component.ts",
    pack.render("app-shell", { systemNameHuman: humanize(sys.name), navSections: [] }),
  );
  out.set("src/app/app.config.ts", pack.render("app-config", {}));

  // --- Routes + skeleton page components (hand-rendered) --------------
  out.set("src/app/app.routes.ts", renderAngularRoutes());
  out.set("src/app/home.component.ts", HOME_COMPONENT);
  out.set("src/app/not-found.component.ts", NOT_FOUND_COMPONENT);

  // --- Shared neutral sources (angular/ + api/) ----------------------
  out.set(
    "src/index.html",
    pack.render("index-html", {
      title: humanize(sys.name),
      description: undefined,
      ogImage: undefined,
      canonical: undefined,
      favicon: undefined,
      usesCodeBlock: false,
    }),
  );
  out.set("src/api/client.ts", pack.render("api-client", { hasDelete, hasAuthUi: authUi }));
  out.set("src/api/config.ts", pack.render("api-config", { apiBaseUrl }));
  out.set("src/logger.ts", pack.render("logger", {}));
  out.set("Dockerfile", pack.render("dockerfile", {}));
  out.set(".dockerignore", pack.render("dockerignore", {}));
  out.set("certs/.gitkeep", "");

  return out;
}

const HOME_COMPONENT = `// Auto-generated.
import { Component } from "@angular/core";

@Component({
  selector: "app-home",
  imports: [],
  template: \`
    <section data-testid="page-home">
      <h2>Welcome</h2>
      <p>This app's pages render here once the ui declares them.</p>
    </section>
  \`,
})
export class HomeComponent {}
`;

const NOT_FOUND_COMPONENT = `// Auto-generated.
import { Component } from "@angular/core";
import { RouterLink } from "@angular/router";

@Component({
  selector: "app-not-found",
  imports: [RouterLink],
  template: \`
    <section data-testid="not-found" style="padding: 16px">
      <h2>Not found</h2>
      <a routerLink="/">&larr; Back to home</a>
    </section>
  \`,
})
export class NotFoundComponent {}
`;
