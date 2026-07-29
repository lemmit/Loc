// ---------------------------------------------------------------------------
// The wire-differential waiver registry (M-T9.11 slice c).
//
// Every entry is a KNOWN, REVIEWED divergence between a backend and the
// canonical wire golden — the exact shape of the corpus `COMPILE_SKIP` maps and
// the M-T9.8 allowlist ratchet: a gap is a line of code someone signed, with a
// reason and a named exit, never a silent filter.
//
// Rules for adding one:
//   1. First decide WHO IS RIGHT — the golden is an oracle, not a vote.  If the
//      GOLDEN is wrong, fix the golden (rebaseline with LOOM_WIRE_UPDATE=1) and
//      open a bug on the backend that was accidentally the reference.
//   2. `reason` MUST name the RS-rule (`RS-n`, docs/conformance-semantics.md)
//      or the mission/PR that closes it.  `wire-record.test.ts` enforces this.
//   3. Scope as narrowly as the divergence: list the exact backends, add
//      `cases`/`request`/`kinds` when you know them, and prefer an exact `path`
//      over `**.` or `**`.
//
// The registry RATCHETS DOWN: a waiver that stops matching fails the gate as
// stale (see `staleWaivers`), so a fixed backend must delete its waiver in the
// same PR.  The list is meant to shrink to nothing.
//
// Both entries below were FOUND BY THIS GATE on its first five-backend run —
// neither was named by any prior rule, and neither is visible to the OpenAPI
// spec-diff (in both cases the published spec agrees; only the bytes differ).
// ---------------------------------------------------------------------------

import type { WireWaiver } from "./wire-record.js";

export const WIRE_WAIVERS: readonly WireWaiver[] = [
  // ── RS-13: elixir over-returns on create ─────────────────────────────────
  // node/dotnet/java/python all answer a create `POST /api/<plural>` with the
  // id envelope `{"id": …}`; elixir serializes the WHOLE aggregate.  The
  // emitted OpenAPI create response is the id envelope on every backend, so
  // elixir diverges from its own published contract — the spec-diff sees
  // nothing.  Scoped to key-set divergences on collection creates: the extra
  // keys are different field names on every aggregate, so this is an
  // ENDPOINT-shaped waiver, not a path-shaped one.
  {
    backends: ["elixir"],
    request: "POST /api/*",
    path: "**",
    kinds: ["key-set"],
    reason:
      "RS-13 — elixir returns the full aggregate on create where the other four return the id envelope (and where its own emitted OpenAPI declares the envelope). Fix is elixir-side; delete this entry with it.",
  },

  // ── RS-14: `version` increment is shape-dependent, and INVERTED per backend ──
  // A `versioned` aggregate must read back 1 + (one per persisted mutation).
  // node and python do this for every shape.  The other three each drop it on a
  // DIFFERENT shape — which is why no single fixture ever caught it, and why
  // the two entries below cannot be merged:
  //
  //   backend        document (`Cart`)   embedded (`Wishlist`)   plain (`Order`)
  //   node/python    2 ✓                 2 ✓                     3 ✓
  //   dotnet/java    1 ✗                 2 ✓                     3 ✓
  //   elixir         2 ✓                 1 ✗                     1 ✗
  //
  // dotnet/java: the ORM concurrency token is bound to a mapped column, and a
  // document aggregate's `version` lives inside the jsonb blob, so the mutation
  // persists without bumping it.  The `dapper` leg — same .NET emitters, raw
  // Npgsql, hand-rolled document SQL — increments CORRECTLY and needs no
  // waiver, which localizes this to the EF/JPA mapping rather than the .NET or
  // Java wire emitters.
  {
    backends: ["dotnet", "java"],
    cases: ["shapes"],
    path: "$.version",
    kinds: ["value"],
    reason:
      "RS-14 — dotnet/java do not increment `version` on a `shape: document` aggregate's persisted mutation (golden 2, they read 1). Fix is in the document-repo save path; delete this entry with it.",
  },
  // elixir: the inverse half — the document path bumps, but an operation on an
  // embedded/plain aggregate persists without touching `version` at all
  // (`sales` Order stays at 1 across TWO mutations where the golden reads 3).
  {
    backends: ["elixir"],
    cases: ["sales", "shapes"],
    path: "$.version",
    kinds: ["value"],
    reason:
      "RS-14 — elixir does not increment `version` on an embedded/plain aggregate's persisted mutation (golden 3 after two mutations on `sales`, it reads 1). Its document path DOES bump — the mirror image of the dotnet/java gap. Delete this entry with the fix.",
  },
];
