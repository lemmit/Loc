// ---------------------------------------------------------------------------
// src/dap-server/session.ts — the Loom DAP (Debug Adapter Protocol) session:
// the REMAP LAYER over the two pure cores in `src/dap/`
// (docs/proposals/source-map-and-debugging.md §6E, docs/plans/
// dap-node-debug.md, Milestone 27 — the phase-8 protocol shell).
//
// SCOPE (read before extending): this class wires `resolveSetBreakpoints`
// (forward: `.ddd` breakpoint -> generated location to arm) and
// `remapStackFrames` (reverse: a reported stack, in generated coordinates,
// rewritten back to `.ddd`) to real `@vscode/debugadapter` request handlers.
// It does NOT implement the full delegating target-debugger proxy the
// proposal's north star (§6E) describes — spawning/proxying `js-debug` /
// `coreclr` / JDWP and forwarding `launch`/`attach`/`continue`/`stepIn`/…
// to it. That full proxy needs a live editor + a running target debugger to
// verify and is out of scope for this slice; it stays the documented,
// editor-verified frontier. `stackTraceRequest` below demonstrates exactly
// that boundary: in the eventual full adapter, the raw (generated-coordinate)
// frames come from the delegated debugger's own `stackTrace` response; here
// there is no delegate, so `fetchRawFrames` is the seam a real adapter would
// fill in — overridden by unit tests to prove the remap path headlessly.
//
// Deliberately `fs`-FREE: `map` (a parsed `SourceMap`) and `readSource` (a
// source-text accessor) are both injected via the constructor, so this class
// is unit-testable with in-memory fixtures with no real filesystem. The only
// `fs`-touching code in this package is `load-map.ts` (parses
// `.loom/sourcemap.json` — reusing the exact same `JSON.parse` `src/cli/
// main.ts`'s `ddd trace` / `ddd breakpoints` commands already use — and a
// caching fs-backed `readSource`) and `main.ts` (the stdio entrypoint).
// ---------------------------------------------------------------------------

import { DebugSession, InitializedEvent } from "@vscode/debugadapter";
import type { DebugProtocol } from "@vscode/debugprotocol";
import type { DapStackFrame } from "../dap/index.js";
import { remapStackFrames, resolveSetBreakpoints } from "../dap/index.js";
import type { SourceMap } from "../trace/index.js";

/** Source-text accessor injected into the session (and threaded straight
 *  through to both cores) — `undefined` for missing/moved source, never a
 *  guess. See `resolveSetBreakpoints`/`remapStackFrames`'s own doc comments
 *  (`src/dap/set-breakpoints.ts` / `src/dap/stack-trace.ts`) for exactly how
 *  each core uses it. */
export type ReadSource = (path: string) => string | undefined;

/**
 * `LoomDebugSession` — a `@vscode/debugadapter` `DebugSession` whose
 * `initialize` / `setBreakpoints` / `stackTrace` handlers are thin wiring
 * over the pure `src/dap/` cores. See the module comment above for the exact
 * scope boundary (remap layer only, no target-debugger delegation).
 */
export class LoomDebugSession extends DebugSession {
  constructor(
    private readonly map: SourceMap,
    private readonly readSource: ReadSource,
  ) {
    super();
  }

  /** Advertise the minimal, HONEST capability set this remap layer backs.
   *  `DebugSession.initializeRequest` (the base class) already fills
   *  `response.body` with every `supports*` flag defaulted to `false` (bar
   *  `supportsConfigurationDoneRequest`, which the base session always
   *  honours) and calls `sendResponse` — exactly the "don't advertise a
   *  capability this remap layer can't back" posture this slice wants, so it
   *  is reused verbatim rather than re-declared. This session adds nothing
   *  to that set (no conditional breakpoints, no stepping, no evaluate —
   *  all of that is target-debugger-delegation work, out of scope here);
   *  the only addition is the `InitializedEvent`, which tells the client the
   *  adapter is ready for `setBreakpoints` / `configurationDone`. */
  protected override initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args: DebugProtocol.InitializeRequestArguments,
  ): void {
    super.initializeRequest(response, args);
    this.sendEvent(new InitializedEvent());
  }

  /** Forward core: resolve every requested `.ddd` breakpoint to the
   *  generated location `resolveSetBreakpoints` computes, one-to-one in
   *  request order. `DapBreakpoint`/`DapSource`/`DapSourceBreakpoint` (the
   *  hand-modeled, dependency-free shapes `src/dap/dap-protocol.ts` mirrors
   *  field-for-field off the real DAP spec) are structurally compatible with
   *  `DebugProtocol.Breakpoint`/`Source`/`SourceBreakpoint` — every field
   *  `resolveSetBreakpoints` reads or writes is present with a compatible
   *  type on both sides, so the SDK's `args` and this core's return value
   *  are used directly, with no field-by-field adapter in between. */
  protected override setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): void {
    response.body = { breakpoints: resolveSetBreakpoints(args, this.map, this.readSource) };
    this.sendResponse(response);
  }

  /** TEST SEAM (see the module comment): in the full delegating adapter this
   *  out-of-scope slice does not build, the raw stack frames — in GENERATED
   *  coordinates — come from the target debugger's own `stackTrace`
   *  response, keyed off `args.threadId`/`startFrame`/`levels`. There is no
   *  delegate here, so the default returns no frames; a subclass (this
   *  package's own unit test, `test/dap/session.test.ts`) overrides this
   *  method to inject a fixture stack directly, which is what proves
   *  `stackTraceRequest` below actually calls `remapStackFrames` without
   *  needing a live target debugger to drive it. */
  protected fetchRawFrames(_args: DebugProtocol.StackTraceArguments): DapStackFrame[] {
    return [];
  }

  /** Reverse core: remap `fetchRawFrames`'s stack (generated coordinates)
   *  back to `.ddd` source via `remapStackFrames`, one-to-one, same order —
   *  the mirror of `setBreakPointsRequest` above. */
  protected override stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments,
  ): void {
    const stackFrames = remapStackFrames(this.fetchRawFrames(args), this.map, this.readSource);
    response.body = { stackFrames, totalFrames: stackFrames.length };
    this.sendResponse(response);
  }
}
