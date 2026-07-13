// ---------------------------------------------------------------------------
// `app/domain/errors.py` — the domain error taxonomy every layer maps
// onto HTTP statuses (DomainError → 400, AggregateNotFoundError → 404,
// ForbiddenError → 403, DisallowedError → 409).  Mirrors the TS
// `domain/errors.ts`.
// ---------------------------------------------------------------------------

/** The domain error taxonomy module.  A `ConcurrencyError` (mapped to
 *  HTTP 409) is added only when some in-scope aggregate carries the
 *  `versioned` capability, so a concurrency-free app stays byte-identical. */
export function errorsPy(hasVersioned: boolean): string {
  const concurrencyError = hasVersioned
    ? `

class ConcurrencyError(Exception):
    """An optimistic-concurrency guard (the \`versioned\` capability) found the
    row's version no longer matched the caller's expected version — a competing
    write won the race (surfaces as HTTP 409; reload and retry)."""`
    : "";
  return `"""Domain error types.  Auto-generated."""


class DomainError(Exception):
    """Precondition or invariant violation (surfaces as HTTP 400)."""


class AggregateNotFoundError(Exception):
    """An aggregate id resolved to no row (surfaces as HTTP 404)."""


class ForbiddenError(Exception):
    """An authorization guard rejected the caller (surfaces as HTTP 403)."""


class DisallowedError(Exception):
    """A \`when\` state gate rejected the operation in the aggregate's
    current state (surfaces as HTTP 409; the side-effect-free
    \`GET /{id}/can_<op>\` query reports the same predicate as
    \`{ allowed }\`)."""${concurrencyError}
`;
}
