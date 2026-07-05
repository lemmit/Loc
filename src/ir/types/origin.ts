// ---------------------------------------------------------------------------
// Origin spine — provenance chain from a structural IR node back to the
// `.ddd` source that produced it (or the macro call / derivation that did,
// when there is no direct source span).
//
// See docs/proposals/source-map-and-debugging.md §4 for the north star and
// the pinned design decisions (byte offsets not line/col, a chain not a
// single span, inline field not a side-table).
// ---------------------------------------------------------------------------

/** Byte-offset span into a `.ddd` source, same shape as `ProvSite.source.span`
 *  (`loom-ir.ts`). */
export interface OriginSpan {
  start: number;
  end: number;
}

/** A real span of user-written `.ddd` text. */
export interface SourceRef {
  kind: "source";
  path: string;
  span: OriginSpan;
}

/** A construct synthesized by a macro — points at the `with <macro>(...)`
 *  call site.  `inner` optionally chains to a more specific origin (e.g. a
 *  nested macro invocation) when one is known. */
export interface MacroRef {
  kind: "macro";
  macro: string;
  call: SourceRef;
  inner?: OriginRef;
}

/** A construct derived by the toolchain with no source of its own — e.g.
 *  auto-`findAll`, `wireShape`.  `from` optionally chains to the origin of
 *  the fact it was derived from. */
export interface DerivedRef {
  kind: "derived";
  reason: string;
  from?: OriginRef;
}

/** Provenance chain back to the `.ddd` source (or macro call, or
 *  derivation) that produced an IR node. */
export type OriginRef = SourceRef | MacroRef | DerivedRef;

/** Walk the chain to the nearest real source span: a `macro` resolves
 *  through its `call`, a `derived` resolves through `from` (if present).
 *  Returns `undefined` only for a bare `derived` ref with no `from` chain. */
export function resolveToSource(origin: OriginRef | undefined): SourceRef | undefined {
  if (!origin) return undefined;
  switch (origin.kind) {
    case "source":
      return origin;
    case "macro":
      return origin.call;
    case "derived":
      return resolveToSource(origin.from);
  }
}
