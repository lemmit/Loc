// ---------------------------------------------------------------------------
// The DAP `setBreakpoints` resolution core — the testable heart of the
// eventual `ddd-dap` adapter (docs/old/proposals/source-map-and-debugging.md
// §6E, docs/old/plans/dap-node-debug.md phase 8). Given a DAP
// `SetBreakpointsArguments` for a `.ddd` source, resolves each requested
// `SourceBreakpoint` to the generated location the debugger should arm, by
// calling the already-shipped `translateBreakpoint` once per breakpoint.
//
// This is the "pure core -> thin protocol adapter" precedent `src/trace/`
// and `src/dap/breakpoints.ts` already set: the eventual
// `DebugSession.setBreakpointsRequest(response, args)` handler becomes
// `response.body = { breakpoints: resolveSetBreakpoints(args, map,
// readSource) }`. Pure, dependency-free, browser-safe — no `fs`, no DAP
// protocol I/O, no `@vscode/debugadapter` dependency.
// ---------------------------------------------------------------------------

import type { SourceMap } from "../trace/index.js";
import { translateBreakpoint } from "./breakpoints.js";
import type {
  DapBreakpoint,
  DapSetBreakpointsArguments,
  DapSourceBreakpoint,
} from "./dap-protocol.js";

/** Resolve one requested `DapSourceBreakpoint` against `sourcePath`. */
function resolveOne(
  sourcePath: string,
  bp: DapSourceBreakpoint,
  map: SourceMap,
  readSource: (path: string) => string | undefined,
): DapBreakpoint {
  // `bp.column` (the column the user's editor sent on the REQUEST) is
  // intentionally IGNORED for lookup here: `translateBreakpoint` is
  // line-granular on input. A request-column-aware forward lookup (narrowing
  // candidates to the one whose origin span covers that column too) is a
  // later refinement, not built in this slice. The RESPONSE `column` below
  // is the GENERATED column (from `BreakpointTarget.column`), independent of
  // any column the request carried.
  const targets = translateBreakpoint(map, sourcePath, bp.line, readSource);

  if (targets.length === 0) {
    return {
      verified: false,
      line: bp.line,
      message: `No generated location maps to ${sourcePath}:${bp.line}.`,
    };
  }

  // DESIGN DECISION (pinned, see test/dap/set-breakpoints.test.ts): a `.ddd`
  // line that fans out to MULTIPLE generated files/targets reports only the
  // NARROWEST single target as the verified location — `targets[0]`, since
  // `translateBreakpoint` already sorts narrowest-origin-span first. DAP's
  // `Breakpoint` names one location; arming the sibling fan-out targets too
  // is adapter-runtime work (the `DebugSession` can set additional real
  // breakpoints internally once it exists) and is out of scope for this pure
  // resolver.
  const target = targets[0]!;
  return {
    verified: true,
    line: target.line,
    // NEVER synthesize a column: only set it when `BreakpointTarget.column`
    // is actually defined (coarse regions stay line-only), mirroring the
    // M23 forward-path + reverse-path "col only when present" rule.
    ...(target.column !== undefined ? { column: target.column } : {}),
    source: { path: target.file },
  };
}

/**
 * Resolve a DAP `setBreakpoints` request: one `DapBreakpoint` per requested
 * `DapSourceBreakpoint`, in the SAME order (the DAP spec requires the
 * response `breakpoints` array to correspond 1:1 positionally to the
 * request's `SetBreakpointsArguments.breakpoints`).
 *
 * - `args.source.path` undefined → every breakpoint is unverified (a
 *   source-reference-only `Source` is not resolvable here — honest, not a
 *   guess).
 * - Each requested breakpoint is translated independently via
 *   `translateBreakpoint`; a line with no covering region comes back
 *   unverified but keeps the REQUESTED `.ddd` line (so the editor still
 *   shows the grey breakpoint marker on the right line).
 * - A line whose regions fan out across multiple targets reports only the
 *   narrowest one verified — see the design-decision comment in
 *   `resolveOne` above.
 */
export function resolveSetBreakpoints(
  args: DapSetBreakpointsArguments,
  map: SourceMap,
  readSource: (path: string) => string | undefined,
): DapBreakpoint[] {
  const requested = args.breakpoints ?? [];
  const sourcePath = args.source.path;

  if (sourcePath === undefined) {
    return requested.map(() => ({
      verified: false,
      message: "source has no path",
    }));
  }

  return requested.map((bp) => resolveOne(sourcePath, bp, map, readSource));
}
