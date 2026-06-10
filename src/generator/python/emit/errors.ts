// ---------------------------------------------------------------------------
// `app/domain/errors.py` — the domain error taxonomy every layer maps
// onto HTTP statuses (DomainError → 400, AggregateNotFoundError → 404,
// ForbiddenError → 403).  Mirrors the TS `domain/errors.ts`.
// ---------------------------------------------------------------------------

export const ERRORS_PY = `"""Domain error types.  Auto-generated."""


class DomainError(Exception):
    """Precondition or invariant violation (surfaces as HTTP 400)."""


class AggregateNotFoundError(Exception):
    """An aggregate id resolved to no row (surfaces as HTTP 404)."""


class ForbiddenError(Exception):
    """An authorization guard rejected the caller (surfaces as HTTP 403)."""
`;
