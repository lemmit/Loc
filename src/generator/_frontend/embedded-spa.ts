// ---------------------------------------------------------------------------
// Embedded-SPA host conventions (fullstack mode — a `ui:` on a backend
// deployable).  The three backends that host an embedded frontend SPA under
// `ClientApp/` (dotnet, java, python) each copy the generated SPA's files into
// their own output map, drop the SPA pack's project-root files the host owns,
// and emit one `ClientApp/.gitignore`.
//
// The drop-list was triplicated verbatim across the three orchestrators — a
// file added to it in one host but not the others silently leaks into the
// other two projects.  Centralising it (plus the `.gitignore` convention)
// keeps the three in lockstep; the framework dispatch stays per-backend
// (python embeds React only, dotnet/java dispatch on `uiFramework`), and this
// module imports no frontend generator, so it can't cycle with them.
// ---------------------------------------------------------------------------

/** The folder every embedded-SPA file sits under. */
export const EMBEDDED_SPA_PREFIX = "ClientApp/";

/** Root files the SPA pack ships that the HOST backend owns in fullstack
 *  mode: its multi-stage Dockerfile builds the SPA, and its own root ships
 *  the Dockerfile / .dockerignore / certs (and, outside the SPA prefix, the
 *  e2e harness).  Dropped from the embedded copy so the file map stays
 *  clean.  `prefix` is the folder the SPA sits under (`ClientApp/` for the
 *  dotnet/java/python hosts, `assets/` for the Phoenix host). */
export function isHostOwnedSpaFile(path: string, prefix: string = EMBEDDED_SPA_PREFIX): boolean {
  return (
    path === `${prefix}Dockerfile` ||
    path === `${prefix}.dockerignore` ||
    path === `${prefix}certs/.gitkeep` ||
    path.startsWith(`${prefix}e2e/`)
  );
}

/** The embedded SPA's `.gitignore` body.  SvelteKit's adapter-static writes
 *  `build/` (+ `.svelte-kit`); every Vite SPA (React / Vue) writes `dist/`. */
export function embeddedSpaGitignore(uiFramework: string | undefined): string {
  return uiFramework === "svelte" ? "node_modules\nbuild\n.svelte-kit\n" : "node_modules\ndist\n";
}

/** Copy an already-generated SPA's files into the host `out` map, dropping
 *  the host-owned root files, then emit `<prefix>.gitignore` for the hosted
 *  framework.  `prefix` defaults to `ClientApp/` (dotnet/java/python); the
 *  Phoenix host passes `assets/` (its own multi-stage Dockerfile builds the
 *  SPA source that lives there — see `elixir/shell/project.ts`). */
export function embedSpaInto(
  out: Map<string, string>,
  spaFiles: Map<string, string>,
  uiFramework: string | undefined,
  prefix: string = EMBEDDED_SPA_PREFIX,
): void {
  for (const [path, content] of spaFiles) {
    if (isHostOwnedSpaFile(path, prefix)) continue;
    out.set(path, content);
  }
  out.set(`${prefix}.gitignore`, embeddedSpaGitignore(uiFramework));
}
