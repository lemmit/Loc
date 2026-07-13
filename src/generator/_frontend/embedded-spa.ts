// ---------------------------------------------------------------------------
// Embedded-SPA host conventions (fullstack mode — a `ui:` on a backend
// deployable).  The backends that host an embedded frontend SPA each copy the
// generated SPA's files into their own output map, drop the SPA pack's
// project-root files the host owns, and emit one `<prefix>.gitignore`.
//
// The drop-list was triplicated verbatim across the .NET/Java/Python
// orchestrators — a file added to it in one host but not the others silently
// leaks into the other two projects.  Centralising it (plus the `.gitignore`
// convention) keeps the hosts in lockstep; the framework dispatch stays
// per-backend (python embeds React only, dotnet/java dispatch on
// `uiFramework`), and this module imports no frontend generator, so it can't
// cycle with them.
//
// The SPA sub-directory differs by host: .NET/Java/Python drop the SPA under
// `ClientApp/` (Vite-source tree, built into `wwwroot/`); Phoenix drops it
// under `assets/` (its conventional JS home, built into `priv/static/app`).
// `prefix` is therefore a parameter — every path predicate keys off it, so a
// new host convention needs no fork of the drop-list.
// ---------------------------------------------------------------------------

/** The default folder embedded-SPA files sit under (dotnet / java / python). */
export const EMBEDDED_SPA_PREFIX = "ClientApp/";

/** Root files the SPA pack ships that the HOST backend owns in fullstack
 *  mode: its multi-stage Dockerfile builds the SPA, and its own root ships
 *  the Dockerfile / .dockerignore / certs (and, outside the SPA prefix, the
 *  e2e harness).  Dropped from the embedded copy so the file map stays
 *  clean.  `prefix` is the host's SPA sub-directory (`ClientApp/`, `assets/`). */
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
 *  the host-owned root files, then emit `<prefix>.gitignore` for the
 *  hosted framework.  `prefix` defaults to `ClientApp/`; Phoenix passes
 *  `assets/`. */
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
