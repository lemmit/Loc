// Internal helpers shared across the factories layer.  Macros must
// not import from this file — it's for the factories themselves.
// Public surface lives in `factories.ts` / `ui-factories.ts` /
// `index.ts`.

import type { OriginToken } from "./define.js";

/** Hidden property on every macro-emitted AST node — the expander
 * uses it when splicing, and the validator/diagnostics layer reads
 * it to redirect errors at the call site.  Not part of the public
 * Langium AST contract. */
export const ORIGIN_PROP = "$origin" as const;

// ---------------------------------------------------------------------------
// Active-origin slot — single source of truth across factory files.
// ---------------------------------------------------------------------------
//
// Factories read this thread-local to find the active macro's origin
// token.  Set by the expander immediately before each `expand()`
// call via `_withOrigin(...)`; cleared after.  Single-threaded JS
// makes this safe; if we ever move expansion into workers, replace
// with AsyncLocalStorage or explicit context-passing.

let _activeOrigin: OriginToken | undefined;

export function _currentOrigin(): OriginToken | undefined {
  return _activeOrigin;
}

/** Internal API used by the expander.  Binds the active origin
 * for the duration of `fn`.  Restored on return — nested calls
 * (e.g. from sub-macros, when they land) compose correctly. */
export function _withOrigin<T>(origin: OriginToken, fn: () => T): T {
  const prev = _activeOrigin;
  _activeOrigin = origin;
  try {
    return fn();
  } finally {
    _activeOrigin = prev;
  }
}

// ---------------------------------------------------------------------------
// AST-node decoration utilities
// ---------------------------------------------------------------------------

/** Attach the origin metadata to a node.  Used by every factory. */
export function _tag<T>(node: T, origin: OriginToken | undefined): T {
  if (origin) (node as Record<string, unknown>)[ORIGIN_PROP] = origin;
  return node;
}

/** Wire the standard $container / $containerProperty / $containerIndex
 * triple on a child AST node.  Skipping any of these causes Langium's
 * scope computation to throw "Missing '$containerProperty'". */
export function _setContainer(
  child: unknown,
  parent: object,
  property: string,
  index?: number,
): void {
  const c = child as Record<string, unknown>;
  c.$container = parent;
  c.$containerProperty = property;
  if (index !== undefined) c.$containerIndex = index;
}

/** Read the origin token off a node, if any.  Walks `$container`
 * chain so a property buried inside a synthesised operation body
 * still reports its origin. */
export function originOf(node: unknown): OriginToken | undefined {
  let cur: unknown = node;
  while (cur && typeof cur === "object") {
    const v = (cur as Record<string, unknown>)[ORIGIN_PROP];
    if (v !== undefined) return v as OriginToken;
    cur = (cur as Record<string, unknown>).$container;
  }
  return undefined;
}
