// Stdlib HTTP status defaults + auto-derived ProblemDetails fields for error
// payloads (exception-less.md, A1).
//
// Domain `error` declarations are HTTP-blind — they carry no status code. The
// api edge is the only place an error becomes an HTTP response, and the mapping
// is owned here: a stdlib default table (NotFound → 404, …) plus the derived
// RFC-7807 `title` / `type` fields. The per-api `status <Error> <Code>`
// override clause is a later slice; until it lands, every backend's route
// translator reads these defaults so the wire is identical by construction.
//
// Pure + dependency-free (only the naming helpers, same util layer).

import { humanize, snake } from "./naming.js";

/** The blessed stdlib error names and their default HTTP status. Mirrors the
 *  proposal's default table (exception-less.md §"Status mapping"). A
 *  user-declared error with no match falls through to 500 — the "unexpected"
 *  default (the `loom.unmapped-error-status` warning prompting an explicit
 *  `status` line arrives with the api-clause slice). */
const STDLIB_ERROR_STATUS: Readonly<Record<string, number>> = {
  NotFound: 404,
  ValidationError: 422,
  ParseError: 400,
  Forbidden: 403,
  TransportFailure: 502,
  UnexpectedStatus: 502,
  DeserializeError: 502,
  // Structural-conflict built-ins (expressible-builtins.md §3 / M-T3.4a). Each
  // backend used to hardcode a literal 409 at the runtime site AND declare it
  // independently in OpenAPI (so the two could drift and a user couldn't remap
  // them). They are now blessed stdlib names defaulting to 409, so their status
  // flows through the SAME `httpStatus <Error> <Code>` override path as user
  // errors — `httpStatus UniquenessConflict 422` retargets both the runtime
  // response and the OpenAPI declaration. Absent an override, the resolved value
  // is 409 → byte-identical output.
  UniquenessConflict: 409, // a `unique (...)` invariant tripped (PG 23505)
  ConcurrencyConflict: 409, // optimistic-lock / event-store append CAS lost a race
  Disallowed: 409, // a `when` state-gate rejected the operation
  ReferencedInUse: 409, // a still-referenced aggregate can't be deleted (FK RESTRICT, PG 23503)
};

/** The blessed structural-conflict error names (expressible-builtins.md §3).
 *  Their per-backend runtime 409 sites + OpenAPI declarations resolve their
 *  status through the `httpStatus` override map keyed on these names, exactly
 *  like a user-declared `error`. App-wide (folded across every api) because the
 *  conflicts surface in app-global exception handlers with no per-context tag. */
export const STRUCTURAL_CONFLICT_ERRORS = [
  "UniquenessConflict",
  "ConcurrencyConflict",
  "Disallowed",
  "ReferencedInUse",
] as const;

export type StructuralConflictError = (typeof STRUCTURAL_CONFLICT_ERRORS)[number];

/** Resolve an error name to its HTTP status at generation time: the api's
 *  `httpStatus` override if present, else the stdlib default. The canonical
 *  idiom every backend's route/handler emitter uses for both user `error`
 *  payloads and the structural-conflict built-ins (one status mechanism, so the
 *  runtime response and the OpenAPI declaration can't drift). */
export function resolveErrorStatus(name: string, overrides?: Record<string, number>): number {
  return overrides?.[name] ?? defaultErrorStatus(name);
}

/** The HTTP status an error variant maps to at the api edge: its stdlib default,
 *  or 500 for an unrecognised (user-declared, unmapped) error. */
export function defaultErrorStatus(name: string): number {
  return STDLIB_ERROR_STATUS[name] ?? 500;
}

/** True when an error name is one of the blessed stdlib errors (carries a
 *  default status).  A user-declared error that is *not* stdlib and has no
 *  api `httpStatus` override falls through to 500 — the validator warns
 *  (`loom.unmapped-error-status`) prompting an explicit mapping. */
export function isStdlibError(name: string): boolean {
  return name in STDLIB_ERROR_STATUS;
}

/** The RFC-7807 `title` for an error: its name prettified —
 *  `NotFound` → `"Not Found"`, `OutOfStock` → `"Out Of Stock"`. */
export function errorTitle(name: string): string {
  return humanize(name);
}

/** The RFC-7807 `type` URI for an error: `/errors/<kebab-case-name>` —
 *  `NotFound` → `"/errors/not-found"`, `OutOfStock` → `"/errors/out-of-stock"`. */
export function errorTypeUri(name: string): string {
  return `/errors/${snake(name).replace(/_/g, "-")}`;
}
