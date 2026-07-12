// ---------------------------------------------------------------------------
// A MINIMAL Debug Adapter Protocol (DAP) type subset — hand-modeled, zero
// dependency. See the DAP spec's `SetBreakpointsArguments` / `Breakpoint` /
// `Source` / `SourceBreakpoint` shapes:
// https://microsoft.github.io/debug-adapter-protocol/specification
//
// These mirror `DebugProtocol.*` from `@vscode/debugprotocol` field-for-field
// (only the fields this resolver actually reads/writes), hand-modeled here to
// keep `src/dap/` dependency-free and browser-safe, exactly like
// `translateBreakpoint` (`src/dap/breakpoints.ts`). When the eventual protocol
// shell (`packages/ddd-dap`, a real `@vscode/debugadapter` dependency) lands,
// `DebugSession.setBreakpointsRequest` can widen these to the real
// `DebugProtocol.*` types with no shape change — every field name below is
// exactly the spec's.
// ---------------------------------------------------------------------------

/** DAP: `Source` — a reference to a source file (subset). */
export interface DapSource {
  /** DAP: `Source.name` — the short display name. */
  name?: string;
  /** DAP: `Source.path` — the path (or URI) of the source. */
  path?: string;
}

/** DAP: `SourceBreakpoint` — one requested breakpoint on a `Source` (subset).
 *  `condition?`/`hitCondition?`/`logMessage?` are part of the real spec but
 *  are not read by this resolver — they are passed through untouched by a
 *  caller that needs them, not modeled here since this resolver never
 *  inspects them. */
export interface DapSourceBreakpoint {
  /** DAP: `SourceBreakpoint.line` — 1-based line in the referenced source. */
  line: number;
  /** DAP: `SourceBreakpoint.column` — OPTIONAL 1-based column. This
   *  resolver's lookup is line-granular only (see `resolveSetBreakpoints`'s
   *  doc comment) — the field is modeled for shape-completeness but ignored
   *  for lookup. */
  column?: number;
}

/** DAP: `SetBreakpointsArguments` (subset — `lines?`, deprecated in the real
 *  spec in favor of `breakpoints`, is intentionally NOT modeled; this
 *  resolver requires `breakpoints`). */
export interface DapSetBreakpointsArguments {
  /** DAP: `SetBreakpointsArguments.source` — the source file to set
   *  breakpoints on. */
  source: DapSource;
  /** DAP: `SetBreakpointsArguments.breakpoints` — the breakpoints to set;
   *  absent/empty means "clear all breakpoints for this source". */
  breakpoints?: DapSourceBreakpoint[];
}

/** DAP: `Breakpoint` — information about the result of a breakpoint request
 *  (subset). */
export interface DapBreakpoint {
  /** DAP: `Breakpoint.verified` — whether the breakpoint could be set (and
   *  actually reflects the resolved location). */
  verified: boolean;
  /** DAP: `Breakpoint.line` — the resolved (generated) line. */
  line?: number;
  /** DAP: `Breakpoint.column` — the resolved (generated) column, straight
   *  from `BreakpointTarget.column` (the M23 forward-column field) — set
   *  only when the underlying region actually carries one. */
  column?: number;
  /** DAP: `Breakpoint.source` — the (generated) source this breakpoint
   *  actually resolved into. */
  source?: DapSource;
  /** DAP: `Breakpoint.message` — a message about the state of the
   *  breakpoint, e.g. why it could not be verified. */
  message?: string;
}
