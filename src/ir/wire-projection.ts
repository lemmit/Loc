// Wire-projection filters — the canonical per-boundary semantics for
// `FieldAccess`.  Backends import these helpers instead of reinventing
// the modifier matrix.  Each helper is a pure filter over the existing
// `wireShape: readonly WireField[]`; no pre-split IR shape, no
// duplicated lists.  See `FieldAccess` in `src/ir/loom-ir.ts` for the
// canonical role semantics this layer implements.

import type { WireField } from "./loom-ir.js";

/** Fields visible in an **API read** response (HTTP/OpenAPI surfaces).
 * Excludes:
 *   - `internal` — never exposed via API; views may still render it.
 *   - `secret`   — write-only, never disclosed in any read.
 * Everything else (editable, immutable, managed, token) is included. */
export function forApiRead(wire: readonly WireField[]): WireField[] {
  return wire.filter((f) => f.access !== "internal" && f.access !== "secret");
}

/** Fields visible in a **UI read** projection (in-system view; admin
 * surface, scaffolded detail/list pages).  Excludes only:
 *   - `secret`   — never disclosed anywhere.
 * `internal` is INCLUDED — admin UIs are exactly the audience the
 * modifier was designed for. */
export function forUiRead(wire: readonly WireField[]): WireField[] {
  return wire.filter((f) => f.access !== "secret");
}

/** Fields clients supply on a **create** request.  Excludes:
 *   - `managed`  — server lifecycle owns the value (audit fields, etc.).
 *   - `token`    — server-assigned on create (id) or absent (version
 *                  doesn't exist yet); never client-supplied here.
 *   - `internal` — domain-only state.
 * `immutable` is INCLUDED — this is when it's settable.
 * `secret` is INCLUDED — clients supply password hashes / API keys. */
export function forCreateInput(wire: readonly WireField[]): WireField[] {
  return wire.filter(
    (f) => f.access !== "managed" && f.access !== "token" && f.access !== "internal",
  );
}

/** Fields clients may modify in an **update** request's editable
 * payload.  Excludes:
 *   - `managed`  — server lifecycle.
 *   - `token`    — sent as precondition (see `updatePreconditions`),
 *                  not as a value to modify.
 *   - `internal` — domain-only.
 *   - `immutable`— frozen after create.
 * Only editable + `secret` remain. */
export function forUpdateInput(wire: readonly WireField[]): WireField[] {
  return wire.filter(
    (f) =>
      f.access !== "managed" &&
      f.access !== "token" &&
      f.access !== "internal" &&
      f.access !== "immutable",
  );
}

/** Tokens that an update request must carry as **preconditions** —
 * sent by the client, used by the server to identify the target row
 * (id) or detect a concurrency conflict (version), but never modified
 * by the request.  Backends emit these separately from the editable
 * payload — route param for identity, ETag/header or body field for
 * concurrency, depending on transport. */
export function updatePreconditions(wire: readonly WireField[]): WireField[] {
  return wire.filter((f) => f.access === "token");
}
