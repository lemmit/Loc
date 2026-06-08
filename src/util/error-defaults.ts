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
};

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
