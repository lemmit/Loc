import type { AuthIR, AuthValueIR, FieldIR, SystemIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { AUTH_BASE_PATH } from "../../../util/api-base.js";
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
  // OIDC turnkey auth (D-AUTH-OIDC): an `auth { oidc }` block turns on the
  // generated verifier + the /auth/* redirect handshake; without it only
  // the dev stub + /auth/me probe are emitted (matching .NET).
  const oidc = sys.auth;
  // The principal's id key — the field named `id`, else the first declared
  // field.  Stamped into MDC (RequestContext.actorId) after the verifier
  // succeeds; only the id rides the carrier, the full principal stays here.
  const actorIdField = fields.find((f) => f.name === "id") ?? fields[0];

  const imports = new Set<string>();
  const components = fields
    .map((f) => {
      collectAuthImports(f.type, imports);
      return `${renderJavaType(f.type)} ${f.name}`;
    })
    .join(", ");
  // Derived `currentUser.orgPath` — the caller's tenant materialized path
  // (multi-tenancy P2.1).  An extra record accessor (not a component), so
  // every `new User(...)` site is untouched; stringified null-safely.  P2.1
  // resolves it to the tenancy claim value (the root path); P2.2 swaps the
  // body for a memoized registry `dataKey` lookup.
  const orgPathClaim = sys.tenancy?.claimField;
  const orgPathAccessor = orgPathClaim
    ? [
        ``,
        `    /** The caller's tenant materialized path (\`currentUser.orgPath\`) —`,
        `     *  derived per-request from the tenancy claim (Phase 2, P2.1). */`,
        `    public String orgPath() {`,
        `        return ${orgPathClaim}() == null ? "" : String.valueOf(${orgPathClaim}());`,
        `    }`,
      ]
    : [];
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
      ...orgPathAccessor,
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
  const stubArgs = fields.map((f) => stubValue(f.type)).join(", ");
  // Dev-claims override is limited to string-typed claims (the tenant-claim
  // case) — a JSON string maps cleanly onto a `String` component; non-string
  // components keep their built-in value.  FQNs avoid import churn.
  const stubStringFields = fields.filter(
    (f) => f.type.kind === "primitive" && f.type.name === "string",
  );
  const overrideArgs = fields
    .map((f) =>
      f.type.kind === "primitive" && f.type.name === "string"
        ? `claims.has("${f.name}") && claims.get("${f.name}").isTextual() ? claims.get("${f.name}").asText() : ${stubValue(f.type)}`
        : stubValue(f.type),
    )
    .join(", ");
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
      stubStringFields.length > 0
        ? ` *  Dev-only: override string claims (e.g. tenantId) by sending a base64-encoded`
        : null,
      stubStringFields.length > 0
        ? ` *  JSON object in the \`x-loom-dev-claims\` header — the same injection the Hono`
        : null,
      stubStringFields.length > 0 ? ` *  dev stub honours.` : null,
      ` *  REPLACE for production by providing your own @Primary UserVerifier. */`,
      `@Component`,
      `public class DevStubUserVerifier implements UserVerifier {`,
      ...(stubStringFields.length > 0
        ? [
            `    private static final com.fasterxml.jackson.databind.ObjectMapper MAPPER =`,
            `        new com.fasterxml.jackson.databind.ObjectMapper();`,
            ``,
            `    @Override`,
            `    public User verify(HttpServletRequest request) {`,
            `        String injected = request.getHeader("x-loom-dev-claims");`,
            `        if (injected != null && !injected.isEmpty()) {`,
            `            try {`,
            `                com.fasterxml.jackson.databind.JsonNode claims =`,
            `                    MAPPER.readTree(java.util.Base64.getDecoder().decode(injected));`,
            `                return new User(${overrideArgs});`,
            `            } catch (Exception e) {`,
            `                // Malformed dev-claims header → fall back to the built-in identity.`,
            `            }`,
            `        }`,
            `        return new User(${stubArgs});`,
            `    }`,
          ]
        : [
            `    @Override`,
            `    public User verify(HttpServletRequest request) {`,
            `        return new User(${stubArgs});`,
            `    }`,
          ]),
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
      `    /** Static read of the ambient principal — null outside a request`,
      `     *  (seed / system saves).  For JPA entity lifecycle callbacks`,
      `     *  (claim-valued stamps), which cannot inject beans. */`,
      `    public static User currentOrNull() {`,
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
      `import ${basePkg}.config.RequestContext;`,
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
      // OIDC redirect handshake — login/callback/logout must be reachable
      // without a verified principal; /auth/me stays protected (it is the
      // session probe the frontend guard reads).
      ...(oidc
        ? [
            `        "${AUTH_BASE_PATH}/login",`,
            `        "${AUTH_BASE_PATH}/callback",`,
            `        "${AUTH_BASE_PATH}/logout",`,
          ]
        : []),
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
      ...(actorIdField
        ? [`        RequestContext.putActorId(String.valueOf(user.${actorIdField.name}()));`]
        : []),
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

  // The session probe (`/auth/me`) + — under an `auth { oidc }` block —
  // the redirect handshake (/auth/login|callback|logout).  Always emitted
  // when auth is required (this function only runs then), mirroring the
  // .NET `authMe`/`authHandshake` split in emit/program.ts.
  out.set("AuthController.java", renderAuthController(pkg, oidc));
  // The generated OIDC verifier (D-AUTH-OIDC) — JWKS signature + iss/exp +
  // claim mapping onto the typed User.  @Primary so it wins over the dev
  // stub the moment an `auth { oidc }` block is present.
  if (oidc) {
    out.set("OidcUserVerifier.java", renderOidcVerifier(fields, oidc, pkg));
  }

  return out;
}

// ---------------------------------------------------------------------------
// OIDC verifier (D-AUTH-OIDC) — validates the bearer token's signature
// against the issuer's JWKS (discovered + cached via Nimbus), checks
// iss / exp, then projects the configured claims onto the User shape.
// Returns null to reject (→ 401).  Nimbus is the lightweight JOSE library
// Spring Security itself uses; it slots into the existing UserVerifier seam
// without dragging in the whole Spring Security filter chain.
// ---------------------------------------------------------------------------

/** Render an `AuthValueIR` (literal | env reference) as a Java expression.
 *  An env reference becomes `System.getenv("X")` (may be null — callers
 *  coalesce); a literal becomes a quoted string. */
function javaAuthValue(v: AuthValueIR | undefined, fallback = "null"): string {
  if (!v) return fallback;
  return v.kind === "literal" ? JSON.stringify(v.value) : `System.getenv(${JSON.stringify(v.env)})`;
}

/** `env-var ?? declared` as a Java expression — the canonical deploy-env
 *  var overrides the declared auth value (12-factor; the generated compose
 *  repoints OIDC_ISSUER / OIDC_CLIENT_ID at the bundled dev Keycloak; a
 *  baked literal issuer 401s every bundled-IdP token).  A declared env-kind
 *  value reading the same var stays a single read. */
function envOr(envVar: string, v: AuthValueIR | undefined): string {
  if (v?.kind === "env" && v.env === envVar) return javaAuthValue(v);
  return `(System.getenv(${JSON.stringify(envVar)}) != null ? System.getenv(${JSON.stringify(envVar)}) : ${javaAuthValue(v)})`;
}

/** The IdP claim path projected onto a given user field — explicit `claims:`
 *  mapping wins; `id` defaults to `sub`, others read their own name. */
function claimPathFor(field: string, auth: AuthIR): string {
  const mapped = auth.claims.find((c) => c.field === field);
  if (mapped) return mapped.path;
  return field === "id" ? "sub" : field;
}

/** The User-constructor argument reading a field off the verified payload.
 *  string / string[] are mapped (dotted paths supported); other field types
 *  fall back to the dev-stub default (a documented limitation — OIDC claims
 *  map cleanly onto string / string[] user fields). */
function javaClaimRead(f: FieldIR, auth: AuthIR): string {
  const path = JSON.stringify(claimPathFor(f.name, auth));
  const t = f.type;
  if (t.kind === "array" && t.element.kind === "primitive" && t.element.name === "string") {
    return `claimStringList(payload, ${path})`;
  }
  if (t.kind === "primitive" && t.name === "string") {
    return f.optional ? `claimString(payload, ${path})` : `claimStringOrEmpty(payload, ${path})`;
  }
  return stubValue(t);
}

function renderOidcVerifier(fields: FieldIR[], auth: AuthIR, pkg: string): string {
  // Imports for any stub-fallback field type (guid/datetime/etc.) plus the
  // List the string[] reader returns.
  const imports = new Set<string>(["java.util.List"]);
  for (const f of fields) {
    const mappableString =
      (f.type.kind === "primitive" && f.type.name === "string") ||
      (f.type.kind === "array" &&
        f.type.element.kind === "primitive" &&
        f.type.element.name === "string");
    if (!mappableString) collectAuthImports(f.type, imports);
  }
  // Env override first (12-factor): the generated compose repoints
  // OIDC_ISSUER at the bundled dev Keycloak, so a literal issuer must not
  // be baked un-overridably — with it baked, every token from the bundled
  // IdP fails `iss` validation (401, caught live by the parity 403 test).
  const issuerExpr = envOr("OIDC_ISSUER", auth.oidc.issuer);
  const audienceExpr = auth.oidc.audience
    ? envOr("OIDC_AUDIENCE", auth.oidc.audience)
    : `System.getenv("OIDC_AUDIENCE")`;
  const args = fields.map((f) => `                ${javaClaimRead(f, auth)}`).join(",\n");
  return lines(
    `package ${pkg};`,
    ``,
    `import java.net.URI;`,
    `import java.net.http.HttpClient;`,
    `import java.net.http.HttpRequest;`,
    `import java.net.http.HttpResponse;`,
    `import java.util.ArrayList;`,
    `import java.util.Map;`,
    `import java.util.Set;`,
    ...[...imports].sort().map((i) => `import ${i};`),
    ``,
    `import com.fasterxml.jackson.databind.JsonNode;`,
    `import com.fasterxml.jackson.databind.ObjectMapper;`,
    `import com.nimbusds.jose.JWSAlgorithm;`,
    `import com.nimbusds.jose.jwk.source.JWKSource;`,
    `import com.nimbusds.jose.jwk.source.JWKSourceBuilder;`,
    `import com.nimbusds.jose.proc.JWSKeySelector;`,
    `import com.nimbusds.jose.proc.JWSVerificationKeySelector;`,
    `import com.nimbusds.jose.proc.SecurityContext;`,
    `import com.nimbusds.jwt.JWTClaimsSet;`,
    `import com.nimbusds.jwt.proc.ConfigurableJWTProcessor;`,
    `import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier;`,
    `import com.nimbusds.jwt.proc.DefaultJWTProcessor;`,
    ``,
    `import org.springframework.context.annotation.Primary;`,
    `import org.springframework.stereotype.Component;`,
    ``,
    `import jakarta.servlet.http.Cookie;`,
    `import jakarta.servlet.http.HttpServletRequest;`,
    ``,
    `/** Generated OIDC verifier (D-AUTH-OIDC).  Validates the bearer token's`,
    ` *  signature against the issuer's JWKS (discovered + cached via Nimbus),`,
    ` *  checks iss / exp, then projects the configured claims onto User.`,
    ` *  Returns null to reject (-> 401).  @Primary so it wins over the dev`,
    ` *  stub once an auth { oidc } block is present. */`,
    `@Primary`,
    `@Component`,
    `public class OidcUserVerifier implements UserVerifier {`,
    `    private static final String ISSUER = stripTrailingSlashes(${issuerExpr});`,
    `    private static final String AUDIENCE = ${audienceExpr};`,
    `    private static final ObjectMapper MAPPER = new ObjectMapper();`,
    ``,
    `    private volatile ConfigurableJWTProcessor<SecurityContext> processor;`,
    ``,
    `    @Override`,
    `    public User verify(HttpServletRequest request) {`,
    `        String token = extractToken(request);`,
    `        if (token == null) {`,
    `            return null;`,
    `        }`,
    `        try {`,
    `            JWTClaimsSet claims = processor().process(token, null);`,
    `            Map<String, Object> payload = claims.toJSONObject();`,
    `            return new User(`,
    args,
    `            );`,
    `        } catch (Exception e) {`,
    `            // Any validation failure (bad signature / iss / exp / forged`,
    `            // token / discovery error) rejects with 401, never 500.`,
    `            return null;`,
    `        }`,
    `    }`,
    ``,
    `    private ConfigurableJWTProcessor<SecurityContext> processor() throws Exception {`,
    `        ConfigurableJWTProcessor<SecurityContext> p = processor;`,
    `        if (p == null) {`,
    `            synchronized (this) {`,
    `                p = processor;`,
    `                if (p == null) {`,
    `                    p = buildProcessor();`,
    `                    processor = p;`,
    `                }`,
    `            }`,
    `        }`,
    `        return p;`,
    `    }`,
    ``,
    `    private ConfigurableJWTProcessor<SecurityContext> buildProcessor() throws Exception {`,
    `        // The discovery + JWKS fetches run over the issuer's own scheme:`,
    `        // a real https issuer stays TLS, a plain-http dev issuer (the`,
    `        // bundled Keycloak / loopback) is fetched over http.  Nimbus's`,
    `        // default resource retriever permits both, so there is no`,
    `        // RequireHttps trap to disable for the dev path (the bug that bit`,
    `        // the .NET verifier does not arise here).`,
    `        String jwksUri = discoverJwksUri();`,
    `        JWKSource<SecurityContext> jwks = JWKSourceBuilder.create(URI.create(jwksUri).toURL()).build();`,
    `        JWSKeySelector<SecurityContext> keySelector =`,
    `            new JWSVerificationKeySelector<>(`,
    `                Set.of(JWSAlgorithm.RS256, JWSAlgorithm.RS384, JWSAlgorithm.RS512, JWSAlgorithm.ES256),`,
    `                jwks);`,
    `        DefaultJWTProcessor<SecurityContext> proc = new DefaultJWTProcessor<>();`,
    `        proc.setJWSKeySelector(keySelector);`,
    `        JWTClaimsSet exactMatch = new JWTClaimsSet.Builder().issuer(ISSUER).build();`,
    `        // AUDIENCE null -> audience validation is skipped (matches Hono/.NET).`,
    `        proc.setJWTClaimsSetVerifier(`,
    `            new DefaultJWTClaimsVerifier<>(AUDIENCE, exactMatch, Set.of("exp")));`,
    `        return proc;`,
    `    }`,
    ``,
    `    private static String discoverJwksUri() throws Exception {`,
    `        HttpRequest req = HttpRequest.newBuilder(`,
    `                URI.create(ISSUER + "/.well-known/openid-configuration"))`,
    `            .GET().build();`,
    `        HttpResponse<String> resp =`,
    `            HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());`,
    `        JsonNode doc = MAPPER.readTree(resp.body());`,
    `        return doc.get("jwks_uri").asText();`,
    `    }`,
    ``,
    `    /** The bearer token from the Authorization header, or the HttpOnly`,
    `     *  \`session\` cookie issued by /auth/callback (the browser flow).`,
    `     *  Null when neither is present. */`,
    `    private static String extractToken(HttpServletRequest request) {`,
    `        String header = request.getHeader("Authorization");`,
    `        if (header != null && header.regionMatches(true, 0, "Bearer ", 0, 7)) {`,
    `            return header.substring(7).trim();`,
    `        }`,
    `        if (request.getCookies() != null) {`,
    `            for (Cookie c : request.getCookies()) {`,
    `                if ("session".equals(c.getName()) && c.getValue() != null && !c.getValue().isEmpty()) {`,
    `                    return c.getValue();`,
    `                }`,
    `            }`,
    `        }`,
    `        return null;`,
    `    }`,
    ``,
    `    private static String stripTrailingSlashes(String s) {`,
    `        return s == null ? "" : s.replaceAll("/+$", "");`,
    `    }`,
    ``,
    `    /** Navigate a dotted claim path (e.g. \`realm_access.roles\`) over the`,
    `     *  decoded payload; null when any segment is missing. */`,
    `    private static Object navigate(Map<String, Object> payload, String path) {`,
    `        Object current = payload;`,
    `        for (String segment : path.split("\\\\.")) {`,
    `            if (!(current instanceof Map<?, ?> map)) {`,
    `                return null;`,
    `            }`,
    `            current = map.get(segment);`,
    `        }`,
    `        return current;`,
    `    }`,
    ``,
    `    private static String claimString(Map<String, Object> payload, String path) {`,
    `        Object value = navigate(payload, path);`,
    `        return value == null ? null : String.valueOf(value);`,
    `    }`,
    ``,
    `    private static String claimStringOrEmpty(Map<String, Object> payload, String path) {`,
    `        String value = claimString(payload, path);`,
    `        return value == null ? "" : value;`,
    `    }`,
    ``,
    `    private static List<String> claimStringList(Map<String, Object> payload, String path) {`,
    `        List<String> out = new ArrayList<>();`,
    `        Object value = navigate(payload, path);`,
    `        if (value instanceof List<?> list) {`,
    `            for (Object item : list) {`,
    `                if (item != null) {`,
    `                    out.add(String.valueOf(item));`,
    `                }`,
    `            }`,
    `        }`,
    `        return out;`,
    `    }`,
    `}`,
    ``,
  );
}

// ---------------------------------------------------------------------------
// AuthController — the session probe + (under OIDC) the redirect handshake.
//
//   GET /auth/me                       — returns the verified User (the probe
//                                        the frontend `auth: ui` guard reads);
//                                        protected (NOT in the bypass list).
//   GET /auth/login|callback|logout    — the OIDC authorization-code flow;
//                                        only mounted under an auth { oidc }
//                                        block.  No login form — the IdP hosts
//                                        the credential pages.
//
// @Hidden keeps the whole controller out of the springdoc OpenAPI document
// (cross-backend parity — Hono/.NET keep /auth/* out of their contracts too).
// ---------------------------------------------------------------------------

function renderAuthController(pkg: string, auth: AuthIR | undefined): string {
  const handshake = auth ? renderHandshakeMethods(auth) : [];
  const handshakeImports = auth
    ? [
        `import java.net.URI;`,
        `import java.net.URLEncoder;`,
        `import java.net.http.HttpClient;`,
        `import java.net.http.HttpRequest;`,
        `import java.net.http.HttpResponse;`,
        `import java.nio.charset.StandardCharsets;`,
        `import java.util.Map;`,
        `import java.util.UUID;`,
        ``,
        `import com.fasterxml.jackson.databind.JsonNode;`,
        `import com.fasterxml.jackson.databind.ObjectMapper;`,
        ``,
      ]
    : [];
  const handshakeParamImports = auth
    ? [
        `import jakarta.servlet.http.Cookie;`,
        `import jakarta.servlet.http.HttpServletResponse;`,
        ``,
        `import org.springframework.web.bind.annotation.CookieValue;`,
        `import org.springframework.web.bind.annotation.RequestParam;`,
      ]
    : [];
  return lines(
    `package ${pkg};`,
    ``,
    ...handshakeImports,
    `import io.swagger.v3.oas.annotations.Hidden;`,
    ``,
    `import org.springframework.http.ResponseEntity;`,
    `import org.springframework.web.bind.annotation.GetMapping;`,
    `import org.springframework.web.bind.annotation.RestController;`,
    ...(handshakeParamImports.length ? [``, ...handshakeParamImports] : []),
    ``,
    `/** Session probe (/auth/me) + the OIDC redirect handshake.  @Hidden`,
    ` *  keeps these out of the OpenAPI contract (they are probes/redirects,`,
    ` *  not business operations — cross-backend parity). */`,
    `@Hidden`,
    `@RestController`,
    `public class AuthController {`,
    `    private final CurrentUserAccessor accessor;`,
    ``,
    `    public AuthController(CurrentUserAccessor accessor) {`,
    `        this.accessor = accessor;`,
    `    }`,
    ``,
    `    /** The frontend guard's session probe.  UserFilter has already`,
    `     *  resolved (or rejected) the principal by the time this runs. */`,
    `    @GetMapping("${AUTH_BASE_PATH}/me")`,
    `    public ResponseEntity<?> me() {`,
    `        User user = accessor.user();`,
    `        if (user == null) {`,
    `            return ResponseEntity.status(401).body("unauthorized");`,
    `        }`,
    `        return ResponseEntity.ok(user);`,
    `    }`,
    ...handshake,
    `}`,
    ``,
  );
}

function renderHandshakeMethods(auth: AuthIR): string[] {
  // Env override first — same contract as the verifier's ISSUER above.
  const issuerExpr = envOr("OIDC_ISSUER", auth.oidc.issuer);
  const clientIdExpr = envOr("OIDC_CLIENT_ID", auth.oidc.clientId);
  // A public client has no secret: leave it nullable so the token request
  // omits client_secret when unset.
  const clientSecretExpr = auth.oidc.clientSecret
    ? javaAuthValue(auth.oidc.clientSecret)
    : `System.getenv("OIDC_CLIENT_SECRET")`;
  const scopes = auth.oidc.scopes.length ? auth.oidc.scopes : ["openid"];
  const scopesLiteral = JSON.stringify(scopes.join(" "));
  return [
    ``,
    `    // --- OIDC redirect handshake (D-AUTH-OIDC) -------------------------`,
    `    private static final String ISSUER = stripTrailingSlashes(${issuerExpr});`,
    `    private static final String CLIENT_ID = orEmpty(${clientIdExpr});`,
    `    private static final String CLIENT_SECRET = ${clientSecretExpr};`,
    `    private static final String SCOPES = ${scopesLiteral};`,
    `    private static final String REDIRECT_URI = orDefault(`,
    `        System.getenv("OIDC_REDIRECT_URI"), "http://localhost:8080${AUTH_BASE_PATH}/callback");`,
    `    private static final String POST_LOGIN = orDefault(`,
    `        System.getenv("OIDC_POST_LOGIN_REDIRECT"), "/");`,
    `    private static final ObjectMapper MAPPER = new ObjectMapper();`,
    ``,
    `    /** Start the authorization-code flow: redirect to the IdP's authorize`,
    `     *  endpoint with a CSRF state cookie. */`,
    `    @GetMapping("${AUTH_BASE_PATH}/login")`,
    `    public ResponseEntity<Void> login(HttpServletResponse response) throws Exception {`,
    `        JsonNode config = discovery();`,
    `        String authorize = config.get("authorization_endpoint").asText();`,
    `        String state = UUID.randomUUID().toString().replace("-", "");`,
    `        response.addCookie(stateCookie("oidc_state", state));`,
    `        String url = authorize + (authorize.contains("?") ? "&" : "?")`,
    `            + "response_type=code"`,
    `            + "&client_id=" + enc(CLIENT_ID)`,
    `            + "&redirect_uri=" + enc(REDIRECT_URI)`,
    `            + "&scope=" + enc(SCOPES)`,
    `            + "&state=" + enc(state);`,
    `        return ResponseEntity.status(302).location(URI.create(url)).build();`,
    `    }`,
    ``,
    `    /** Exchange the code for a token + issue the local session cookie. */`,
    `    @GetMapping("${AUTH_BASE_PATH}/callback")`,
    `    public ResponseEntity<?> callback(`,
    `            @RequestParam(required = false) String code,`,
    `            @RequestParam(required = false) String state,`,
    `            @CookieValue(value = "oidc_state", required = false) String expected,`,
    `            HttpServletResponse response) {`,
    `        if (code == null || state == null || !state.equals(expected)) {`,
    `            return ResponseEntity.status(400).body(Map.of("error", "invalid_state"));`,
    `        }`,
    `        try {`,
    `            JsonNode config = discovery();`,
    `            String tokenEndpoint = config.get("token_endpoint").asText();`,
    `            String form = "grant_type=authorization_code"`,
    `                + "&code=" + enc(code)`,
    `                + "&redirect_uri=" + enc(REDIRECT_URI)`,
    `                + "&client_id=" + enc(CLIENT_ID)`,
    `                + (CLIENT_SECRET == null ? "" : "&client_secret=" + enc(CLIENT_SECRET));`,
    `            HttpRequest req = HttpRequest.newBuilder(URI.create(tokenEndpoint))`,
    `                .header("content-type", "application/x-www-form-urlencoded")`,
    `                .POST(HttpRequest.BodyPublishers.ofString(form))`,
    `                .build();`,
    `            HttpResponse<String> resp =`,
    `                HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());`,
    `            if (resp.statusCode() / 100 != 2) {`,
    `                return ResponseEntity.status(401).body(Map.of("error", "token_exchange_failed"));`,
    `            }`,
    `            String accessToken = MAPPER.readTree(resp.body()).get("access_token").asText();`,
    `            response.addCookie(sessionCookie("session", accessToken));`,
    `            response.addCookie(expiredCookie("oidc_state"));`,
    `            return ResponseEntity.status(302).location(URI.create(POST_LOGIN)).build();`,
    `        } catch (Exception e) {`,
    `            return ResponseEntity.status(401).body(Map.of("error", "token_exchange_failed"));`,
    `        }`,
    `    }`,
    ``,
    `    @GetMapping("${AUTH_BASE_PATH}/logout")`,
    `    public ResponseEntity<Void> logout(HttpServletResponse response) {`,
    `        response.addCookie(expiredCookie("session"));`,
    `        return ResponseEntity.status(302).location(URI.create(POST_LOGIN)).build();`,
    `    }`,
    ``,
    `    private static JsonNode discovery() throws Exception {`,
    `        HttpRequest req = HttpRequest.newBuilder(`,
    `                URI.create(ISSUER + "/.well-known/openid-configuration"))`,
    `            .GET().build();`,
    `        HttpResponse<String> resp =`,
    `            HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());`,
    `        return MAPPER.readTree(resp.body());`,
    `    }`,
    ``,
    `    private static Cookie stateCookie(String name, String value) {`,
    `        Cookie c = new Cookie(name, value);`,
    `        c.setHttpOnly(true);`,
    `        c.setPath("/");`,
    `        c.setAttribute("SameSite", "Lax");`,
    `        return c;`,
    `    }`,
    ``,
    `    private static Cookie sessionCookie(String name, String value) {`,
    `        return stateCookie(name, value);`,
    `    }`,
    ``,
    `    private static Cookie expiredCookie(String name) {`,
    `        Cookie c = stateCookie(name, "");`,
    `        c.setMaxAge(0);`,
    `        return c;`,
    `    }`,
    ``,
    `    private static String enc(String value) {`,
    `        return URLEncoder.encode(value, StandardCharsets.UTF_8);`,
    `    }`,
    ``,
    `    private static String stripTrailingSlashes(String s) {`,
    `        return s == null ? "" : s.replaceAll("/+$", "");`,
    `    }`,
    ``,
    `    private static String orEmpty(String s) {`,
    `        return s == null ? "" : s;`,
    `    }`,
    ``,
    `    private static String orDefault(String s, String fallback) {`,
    `        return s == null ? fallback : s;`,
    `    }`,
  ];
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
