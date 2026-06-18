// ---------------------------------------------------------------------------
// Angular route-table emitter (angular-frontend-plan.md Slice 3).
//
// Hand-renders `src/app/app.routes.ts` — the standalone `Routes` array
// `provideRouter` consumes.  The walking skeleton wires the Home landing at
// `""` and a wildcard NotFound; Slice 4 lazy-loads one route per declared
// ui page (`loadComponent`) and threads route params via input binding.
// ---------------------------------------------------------------------------

export function renderAngularRoutes(): string {
  return [
    "// Auto-generated.",
    'import type { Routes } from "@angular/router";',
    'import { HomeComponent } from "./home.component";',
    'import { NotFoundComponent } from "./not-found.component";',
    "",
    "export const routes: Routes = [",
    '  { path: "", component: HomeComponent },',
    '  { path: "**", component: NotFoundComponent },',
    "];",
    "",
  ].join("\n");
}
