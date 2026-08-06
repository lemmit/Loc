// ---------------------------------------------------------------------------
// Shared domain types for the Java emission: exception classes (one public
// class per file — Java's rule) + the DomainEvent marker interface.
// ---------------------------------------------------------------------------

import { lines } from "../../../util/code-builder.js";

export function renderDomainException(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `/** Domain-rule violation (preconditions, invariants) — maps to HTTP 400. */`,
    `public class DomainException extends RuntimeException {`,
    `    public DomainException(String message) {`,
    `        super(message);`,
    `    }`,
    `}`,
    ``,
  );
}

export function renderForbiddenException(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `/**`,
    ` * Authorization failure — raised by {@code requires} expressions when the`,
    ` * resolved currentUser doesn't satisfy the gate.  Maps to HTTP 403,`,
    ` * distinct from DomainException's 400.`,
    ` */`,
    `public class ForbiddenException extends RuntimeException {`,
    `    public ForbiddenException(String message) {`,
    `        super(message);`,
    `    }`,
    `}`,
    ``,
  );
}

export function renderDisallowedException(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `/**`,
    ` * Operation state-gate failure — raised when a {@code when} predicate is`,
    ` * false at the call site, so the command is disallowed in the aggregate's`,
    ` * current state (criterion.md, use site 2).  Maps to HTTP 409 (Conflict),`,
    ` * distinct from DomainException's 400.`,
    ` */`,
    `public class DisallowedException extends RuntimeException {`,
    `    public DisallowedException(String message) {`,
    `        super(message);`,
    `    }`,
    `}`,
    ``,
  );
}

export function renderAggregateNotFoundException(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `/** Lookup miss on a getById-style read — maps to HTTP 404. */`,
    `public class AggregateNotFoundException extends RuntimeException {`,
    `    public AggregateNotFoundException(String message) {`,
    `        super(message);`,
    `    }`,
    `}`,
    ``,
  );
}

/**
 * The `new AggregateNotFoundException(...)` a 404-BY-ID raises, as ONE
 * emitter-side expression (RS-27, docs/conformance-semantics.md).
 *
 * Java spells this at five sites — the relational / document / event-store
 * repositories, the history read, and (since RS-27) the by-id READ in the
 * service.  RS-27's whole finding is that a 404 must come from ONE producer,
 * because the two backends that diverged were exactly the two that hand-rolled
 * it at a route.  Five hand-written copies of the message inside a SINGLE
 * backend is that same risk one level down, so the string is written once here
 * and every site renders it.
 *
 * `idExpr` is the in-scope id variable; every java id record overrides
 * `toString()` to `String.valueOf(value)` (`emit/ids.ts`), so the concatenation
 * yields the bare id — byte-identical to what node/.NET/python/elixir send.
 */
export function javaNotFoundThrow(aggName: string, idExpr = "id"): string {
  return `new AggregateNotFoundException("${aggName} " + ${idExpr} + " not found")`;
}

/**
 * The `new AggregateNotFoundException(...)` a FIND-ABSENCE 404 raises — the
 * `T option` / `T?` miss, which RS-27 explicitly scopes OUT of the by-id
 * sentence and leaves carrying the `"not_found"` token that node, python,
 * dotnet and elixir all send.
 *
 * Separate from `javaNotFoundThrow` because the two answer different questions:
 * a by-id miss names the aggregate and the id it was asked for; a find miss has
 * no id to name.  Same producer either way, and that is the point — RS-22
 * requires the five-member envelope on ANY error response, and java answered an
 * EMPTY body here (`ResponseEntity.notFound().build()`, Spring's own bare 404,
 * which never reaches the `@RestControllerAdvice`).  It is the identical defect
 * RS-27 fixed on the by-id read, at the two route arms that read `null` and
 * answered locally instead of throwing.
 *
 * It also made java emit TWO different wires for shapes `docs/payloads.md`
 * declares wire-identical: a union find with a declared `error` variant built a
 * real ProblemDetail in the same controller, while `T option` / `T?` beside it
 * built nothing.
 *
 * Found 2026-08-05 by the caller census drain: the `option` find
 * (`corpus/union-find-absence`'s `maybeFirst`) and the optional find
 * (`corpus/inheritance`'s `byEmail`) got their first callers, and the java leg
 * read `golden {…} ≠ java ""`.
 */
export const JAVA_FIND_ABSENCE_THROW = `new AggregateNotFoundException("not_found")`;

export function renderPagedRecord(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `import java.util.List;`,
    ``,
    `/** Cross-backend paged envelope — items/page/pageSize/total/totalPages`,
    ` *  (1-based page), identical wire shape on every backend. */`,
    `public record Paged<T>(List<T> items, int page, int pageSize, int total, int totalPages) {`,
    `}`,
    ``,
  );
}

/** The shared `FileRef` wire/jsonb shape a `File` field round-trips
 *  ({url, key, contentType, size}) — the object-store reference an upload
 *  returns (M-T1.2).  Jackson serializes the record components by name, so the
 *  wire JSON matches the Hono / other backends.  Emitted only when a hosted
 *  aggregate declares a File field. */
export function renderFileRefRecord(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `/** The {url, key, contentType, size} an object-store upload returns for a`,
    ` *  \`File\` field (M-T1.2). */`,
    `public record FileRef(String url, String key, String contentType, long size) {`,
    `}`,
    ``,
  );
}

/** Pure marker interface for aggregates carrying lifecycle-stamp audit
 *  columns (`with auditable` / a context `stamp`).  Zero members — runtime
 *  type identity only; the JPA auditing wiring keys off the field annotations
 *  + AuditingEntityListener, not this interface, but it gives a documented
 *  join point and a single readable "this aggregate is audited" signal.
 *  See §5a of docs/old/plans/capability-stamp-dedup-simulation.md. */
export function renderAuditableInterface(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `/** Pure tag: this aggregate carries audit columns. Zero members. */`,
    `public interface Auditable {`,
    `}`,
    ``,
  );
}

export function renderDomainEventInterface(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.events;`,
    ``,
    `/** Marker for domain events recorded by aggregates and drained via pullEvents(). */`,
    `public interface DomainEvent {`,
    `}`,
    ``,
  );
}

/** Package marker — keeps `import <pkg>.*;` wildcard imports valid even
 *  when a deployable's contexts contribute no types to the package (the
 *  Java analog of the dotnet `_namespace.cs` markers). */
export function renderPackageMarker(pkg: string): string {
  return lines(
    `package ${pkg};`,
    ``,
    `/** Auto-generated package marker — keeps wildcard imports of this package valid. */`,
    `public final class _Namespace {`,
    `    private _Namespace() {`,
    `    }`,
    `}`,
    ``,
  );
}
