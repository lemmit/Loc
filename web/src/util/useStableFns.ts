import { useRef } from "react";

// Stable identities for a bag of callbacks that are re-created every render.
//
// App.tsx builds ~50 of the `LayoutCtx` entries as plain function declarations
// / inline arrows in the component body, so each one is a fresh identity on
// every render.  That alone makes the whole `ctx` object un-memoisable: any dep
// list containing them would mismatch every render and the memo would never
// hit.  `useCallback`-ing each of them individually is not equivalent — their
// closures read live render state, so a wrong dep list silently freezes the UI
// on a stale snapshot (the exact failure mode we are trying to avoid).
//
// This is the `useEvent` pattern instead: the returned wrappers are created
// ONCE and never change identity, and each one forwards to the newest render's
// implementation through a ref that is refreshed during render (before any
// child reads it).  Semantics are therefore strictly at least as fresh as
// today's "rebuild the whole ctx every render" behaviour — a wrapper always
// invokes the most recently rendered closure — while the identities stay put.
//
// Contract: the KEY SET must be constant across renders (it is — the call site
// passes an object literal).  Do not put a function here that is called during
// the render of a component that renders BEFORE the owner (there is none: every
// entry is an event handler, an effect body, or a ref reader).
//
// Caveat, same as any `useEvent` shim: the ref is written during render, so a
// render that React later DISCARDS (concurrent rendering / a torn-off
// transition) would leave its closure installed.  The playground renders
// synchronously — no `startTransition`, no suspending data reads under App —
// so this cannot bite today; revisit if that changes.

// biome-ignore lint/suspicious/noExplicitAny: the wrapper is signature-preserving; `any` is the only bound that accepts every callback shape.
type AnyFn = (...args: any[]) => any;

export function useStableFns<T extends Record<string, AnyFn>>(fns: T): T {
  const latest = useRef(fns);
  latest.current = fns;

  const stable = useRef<T | null>(null);
  if (stable.current === null) {
    const out: Record<string, AnyFn> = {};
    for (const key of Object.keys(fns)) {
      out[key] = (...args: unknown[]) => latest.current[key](...args);
    }
    stable.current = out as T;
  }
  return stable.current;
}
