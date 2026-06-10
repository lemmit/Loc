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

export function renderWireValidationException(basePkg: string): string {
  return lines(
    `package ${basePkg}.domain.common;`,
    ``,
    `import java.util.List;`,
    ``,
    `/**`,
    ` * Wire-boundary validation failure — maps to the cross-backend 422`,
    ` * problem envelope with the {@code errors[]} extension`,
    ` * ({@code [{ pointer, message }]}).`,
    ` */`,
    `public class WireValidationException extends RuntimeException {`,
    `    public record WireError(String pointer, String message) {`,
    `    }`,
    ``,
    `    private final List<WireError> errors;`,
    ``,
    `    public WireValidationException(List<WireError> errors) {`,
    `        super("Validation failed");`,
    `        this.errors = List.copyOf(errors);`,
    `    }`,
    ``,
    `    public List<WireError> errors() {`,
    `        return errors;`,
    `    }`,
    ``,
    `    public static WireError error(String pointer, String message) {`,
    `        return new WireError(pointer, message);`,
    `    }`,
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
