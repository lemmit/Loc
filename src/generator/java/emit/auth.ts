import type { SystemIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { renderJavaType } from "../render-expr.js";

// ---------------------------------------------------------------------------
// Auth surface — emitted only when the deployable opts in via
// `auth: required` AND the system declares a `user { … }` block (the
// validator rejects the half-state).  Mirrors the .NET Auth/* set:
//
//   User              — the typed claim shape (`currentUser` resolves
//                       members against it)
//   UserVerifier      — the boundary the user replaces for production
//   DevStubUserVerifier — accepts every request as a built-in user
//   UserFilter        — 401 gate + request-scoped CurrentUserAccessor fill
//                       (health/ready/openapi bypass, like UserMiddleware)
//   CurrentUserAccessor — ThreadLocal holder services read from
// ---------------------------------------------------------------------------

export function renderAuthFiles(
  sys: SystemIR,
  basePkg: string,
  /** Fullstack mode: only guard routes under this prefix ("/api"), so
   *  the SPA bundle + client-side routes stay public. */
  guardPrefix?: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const fields = sys.user?.fields ?? [];
  const pkg = `${basePkg}.auth`;

  const imports = new Set<string>();
  const components = fields
    .map((f) => {
      collectAuthImports(f.type, imports);
      return `${renderJavaType(f.type)} ${f.name}`;
    })
    .join(", ");
  out.set(
    "User.java",
    lines(
      `package ${pkg};`,
      ``,
      ...[...imports].sort().map((i) => `import ${i};`),
      imports.size > 0 ? `` : null,
      `/** Strongly-typed claim shape from the system's user block —`,
      ` *  \`currentUser\` references resolve against this. */`,
      `public record User(${components}) {`,
      `}`,
      ``,
    ),
  );

  out.set(
    "UserVerifier.java",
    lines(
      `package ${pkg};`,
      ``,
      `import jakarta.servlet.http.HttpServletRequest;`,
      ``,
      `/** Verify the inbound request's credentials.  Return null to reject`,
      ` *  (401).  Replace the dev stub with your own @Primary bean for`,
      ` *  production (e.g. a JWT verifier). */`,
      `public interface UserVerifier {`,
      `    User verify(HttpServletRequest request);`,
      `}`,
      ``,
    ),
  );

  const stubImports = new Set<string>();
  for (const f of fields) collectAuthImports(f.type, stubImports);
  out.set(
    "DevStubUserVerifier.java",
    lines(
      `package ${pkg};`,
      ``,
      ...[...stubImports].sort().map((i) => `import ${i};`),
      stubImports.size > 0 ? `` : null,
      `import org.springframework.stereotype.Component;`,
      ``,
      `import jakarta.servlet.http.HttpServletRequest;`,
      ``,
      `/** Dev-stub verifier — accepts every request as a built-in user.`,
      ` *  REPLACE for production by providing your own @Primary UserVerifier. */`,
      `@Component`,
      `public class DevStubUserVerifier implements UserVerifier {`,
      `    @Override`,
      `    public User verify(HttpServletRequest request) {`,
      `        return new User(${fields.map((f) => stubValue(f.type)).join(", ")});`,
      `    }`,
      `}`,
      ``,
    ),
  );

  out.set(
    "CurrentUserAccessor.java",
    lines(
      `package ${pkg};`,
      ``,
      `import org.springframework.stereotype.Component;`,
      ``,
      `/** Request-scoped current user, filled by UserFilter. */`,
      `@Component`,
      `public class CurrentUserAccessor {`,
      `    private static final ThreadLocal<User> HOLDER = new ThreadLocal<>();`,
      ``,
      `    public User user() {`,
      `        return HOLDER.get();`,
      `    }`,
      ``,
      `    void set(User user) {`,
      `        HOLDER.set(user);`,
      `    }`,
      ``,
      `    void clear() {`,
      `        HOLDER.remove();`,
      `    }`,
      `}`,
      ``,
    ),
  );

  out.set(
    "UserFilter.java",
    lines(
      `package ${pkg};`,
      ``,
      `import java.io.IOException;`,
      ``,
      `import org.springframework.stereotype.Component;`,
      `import org.springframework.web.filter.OncePerRequestFilter;`,
      ``,
      `import jakarta.servlet.FilterChain;`,
      `import jakarta.servlet.ServletException;`,
      `import jakarta.servlet.http.HttpServletRequest;`,
      `import jakarta.servlet.http.HttpServletResponse;`,
      ``,
      `/** 401 gate — every route except the bypass prefixes requires a`,
      ` *  verifiable user.  Mirrors the .NET UserMiddleware. */`,
      `@Component`,
      `public class UserFilter extends OncePerRequestFilter {`,
      `    private static final String[] BYPASS_PREFIXES = {`,
      `        "/health",`,
      `        "/ready",`,
      `        "/openapi.json",`,
      `        "/swagger",`,
      `    };`,
      ``,
      `    private final UserVerifier verifier;`,
      `    private final CurrentUserAccessor accessor;`,
      ``,
      `    public UserFilter(UserVerifier verifier, CurrentUserAccessor accessor) {`,
      `        this.verifier = verifier;`,
      `        this.accessor = accessor;`,
      `    }`,
      ``,
      `    @Override`,
      `    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)`,
      `            throws ServletException, IOException {`,
      `        var path = request.getRequestURI();`,
      ...(guardPrefix
        ? [
            `        // Fullstack: only the API surface is guarded — the SPA`,
            `        // bundle and client-side routes stay public.`,
            `        if (!path.startsWith("${guardPrefix}/")) {`,
            `            chain.doFilter(request, response);`,
            `            return;`,
            `        }`,
          ]
        : []),
      `        for (var prefix : BYPASS_PREFIXES) {`,
      `            if (path.regionMatches(true, 0, prefix, 0, prefix.length())) {`,
      `                chain.doFilter(request, response);`,
      `                return;`,
      `            }`,
      `        }`,
      `        User user;`,
      `        try {`,
      `            user = verifier.verify(request);`,
      `        } catch (Exception e) {`,
      `            user = null;`,
      `        }`,
      `        if (user == null) {`,
      `            response.setStatus(401);`,
      `            response.getWriter().write("unauthorized");`,
      `            return;`,
      `        }`,
      `        accessor.set(user);`,
      `        try {`,
      `            chain.doFilter(request, response);`,
      `        } finally {`,
      `            accessor.clear();`,
      `        }`,
      `    }`,
      `}`,
      ``,
    ),
  );

  return out;
}

function collectAuthImports(t: TypeIR, into: Set<string>): void {
  if (t.kind === "primitive" && t.name === "guid") into.add("java.util.UUID");
  if (t.kind === "primitive" && t.name === "datetime") into.add("java.time.Instant");
  if (t.kind === "primitive" && (t.name === "decimal" || t.name === "money"))
    into.add("java.math.BigDecimal");
  if (t.kind === "array") {
    into.add("java.util.List");
    collectAuthImports(t.element, into);
  }
  if (t.kind === "optional") collectAuthImports(t.inner, into);
}

/** Dev-stub claim values — mirrors the .NET DevStubUserVerifier:
 *  Guid.Empty / "admin" / empty list / zeroes.  Exported for the JUnit
 *  test emitter's stub test user. */
export function stubUserValue(t: TypeIR): string {
  return stubValue(t);
}

function stubValue(t: TypeIR): string {
  if (t.kind === "primitive") {
    switch (t.name) {
      case "guid":
        return "new UUID(0L, 0L)";
      case "string":
        return '"admin"';
      case "int":
      case "long":
        return "0";
      case "bool":
        return "false";
      case "datetime":
        return "Instant.EPOCH";
      case "decimal":
      case "money":
        return "java.math.BigDecimal.ZERO";
      default:
        return "null";
    }
  }
  if (t.kind === "array") return "List.of()";
  return "null";
}
