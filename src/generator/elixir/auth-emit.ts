import type {
  AuthIR,
  AuthValueIR,
  DeployableIR,
  FieldIR,
  SystemIR,
  UserIR,
} from "../../ir/types/loom-ir.js";
import { hierarchyRegistry } from "../../ir/util/tenant-stance.js";
import { AUTH_BASE_PATH } from "../../util/api-base.js";
import { snake, upperFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Phoenix LiveView auth scaffolding — emitted per deployable when
// `deployable.auth?.required === true`.
//
// Files:
//
//   lib/<app>_web/auth.ex            — Plug; decodes the Authorization
//                                      Bearer token into
//                                      `conn.assigns.current_user`.  When the
//                                      system declares an `auth { oidc }`
//                                      block (D-AUTH-OIDC) `verify_token/1` is
//                                      a REAL OIDC verifier (JOSE + the
//                                      issuer's JWKS); without one it's the
//                                      permissive dev stub (matches the Hono /
//                                      .NET dev-stub verifiers so a fresh
//                                      stack boots end-to-end).
//
//   lib/<app>_web/live_auth.ex       — Phoenix.LiveView on_mount hook for the
//                                      WebSocket path (session-based stub).
//
//   lib/<app>_web/controllers/auth_controller.ex
//                                    — GET /auth/me session probe; returns the
//                                      verified `current_user` as JSON (the
//                                      `auth: ui` frontend guard reads it).
//
// The router wiring (plug + live_session on_mount + the /auth scope) is
// applied in renderRouter via the `authEnabled` flag.  The OIDC verifier
// pulls in `{:jose, ...}` + `:inets`/`:ssl` (mix.exs) — see renderMixExs.
// ---------------------------------------------------------------------------

export interface AuthEmitArgs {
  sys: SystemIR;
  deployable: DeployableIR;
  appName: string;
  appModule: string;
}

export interface AuthEmitResult {
  files: Map<string, string>;
  /** True when auth modules were emitted; the router renderer
   *  uses this to splice the Auth plug + LiveAuth on_mount + /auth scope. */
  enabled: boolean;
}

export function emitAuth(args: AuthEmitArgs): AuthEmitResult {
  const { sys, deployable, appName, appModule } = args;
  const files = new Map<string, string>();

  if (!deployable.auth?.required) {
    return { files, enabled: false };
  }

  const webModule = `${appModule}Web`;
  // An `auth { oidc }` block drives the real token verifier; absent it, the
  // dev stub keeps a freshly-generated stack callable out of the box.
  const auth = sys.auth;

  // Hierarchy (multi-tenancy P2.2): when the registry opts into
  // `tenantRegistry` (a `dataKey` column exists), `currentUser.orgPath` becomes
  // a per-request registry read — the caller org's materialized `data_key`,
  // resolved through the registry's Ecto schema module (which carries the
  // `@schema_prefix` + `:binary_id` cast) via the app `Repo`.  Without it (flat
  // tenancy), the P2.1 claim-copy stands.  The plug is constructed once per
  // request, so the read is naturally memoized on `conn.assigns.current_user`.
  const registry = hierarchyRegistry(sys);
  const orgPathRegistry =
    registry && sys.tenancy
      ? orgPathRegistryRef(sys, appModule, sys.tenancy.registryName)
      : undefined;

  files.set(
    `lib/${appName}_web/auth.ex`,
    renderAuthPlug(sys.user, webModule, auth, sys.tenancy?.claimField, orgPathRegistry),
  );
  files.set(`lib/${appName}_web/live_auth.ex`, renderLiveAuth(webModule, auth));
  // OIDC only: the :browser-pipeline plug that seeds the Phoenix session's
  // `current_user` from the verified session cookie so LiveAuth can gate
  // LiveViews (the `auth: ui` frontend guard).  The dev stub needs none —
  // LiveAuth's dev_user fallback grants LiveViews out of the box.
  if (auth) {
    files.set(`lib/${appName}_web/browser_auth.ex`, renderBrowserAuth(webModule));
  }
  files.set(
    `lib/${appName}_web/controllers/auth_controller.ex`,
    renderAuthController(webModule, auth, deployable.port ?? 4000),
  );

  return { files, enabled: true };
}

/** The Ecto modules the P2.2 `orgPath` registry read needs — the registry's
 *  schema module (carrying `@schema_prefix` + the `:binary_id` id cast) and the
 *  app `Repo`.  `undefined` for flat tenancy (P2.1 claim-copy). */
interface OrgPathRegistryRef {
  repoModule: string;
  schemaModule: string;
}

/** Locate the tenant registry aggregate's Ecto schema module —
 *  `<App>.<Context>.<Registry>` (mirrors `schema-emit.ts`:
 *  `${appModule}.${upperFirst(ctx.name)}.${upperFirst(agg.name)}`) — plus the
 *  app `Repo`.  `undefined` when the registry isn't found in any context. */
function orgPathRegistryRef(
  sys: SystemIR,
  appModule: string,
  registryName: string,
): OrgPathRegistryRef | undefined {
  for (const sub of sys.subdomains) {
    for (const ctx of sub.contexts) {
      if (ctx.aggregates.some((a) => a.name === registryName)) {
        return {
          repoModule: `${appModule}.Repo`,
          schemaModule: `${appModule}.${upperFirst(ctx.name)}.${upperFirst(registryName)}`,
        };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Auth plug — Bearer token path (HTTP API + browser requests that carry
// an Authorization header).
// ---------------------------------------------------------------------------

/**
 * The atom key under which the principal's identifier lives in the
 * `build_user/1` map — the field named `id` if the user shape declares one,
 * else the first declared field, else `id` (the no-user-block passthrough
 * always carries `:id`).  Only this id is stamped into the request context,
 * never the whole principal — minimal PII on the logs.
 */
export function actorIdKey(user: UserIR | undefined): string {
  if (!user || user.fields.length === 0) return "id";
  const idField = user.fields.find((f) => f.name.toLowerCase() === "id");
  return snake((idField ?? user.fields[0]).name);
}

/** The IdP claim path projected onto a given `user { … }` field.  An
 *  explicit `claims:` mapping wins; otherwise `id` defaults to the standard
 *  `sub` claim and every other field reads its own (snake) name.  Mirrors the
 *  Hono / .NET `claimPathFor`. */
function claimPathFor(field: string, auth: AuthIR): string {
  const mapped = auth.claims.find((c) => c.field === field);
  if (mapped) return mapped.path;
  return field === "id" ? "sub" : snake(field);
}

function renderAuthPlug(
  user: UserIR | undefined,
  webModule: string,
  auth: AuthIR | undefined,
  orgPathClaim?: string,
  orgPathRegistry?: OrgPathRegistryRef,
): string {
  const buildUserBody = renderBuildUser(user, auth);
  const idKey = actorIdKey(user);
  // Derived `currentUser.orgPath` — the caller's tenant materialized path.
  // Applied as a final `put_org_path/1` step AFTER the principal (and any
  // dev-claims override) is built, so it reflects the final claim value.
  //
  //  - flat tenancy (P2.1): `orgPath` is the claim itself (the root-segment
  //    path — no registry `dataKey` column to read), stringified null-safely.
  //  - hierarchy (P2.2): resolve the caller org's registry `data_key` once per
  //    request (the plug runs per request, so it is memoized on the principal);
  //    fail safe to the claim when the row / dataKey is absent or the claim is
  //    malformed — never crashes.
  const orgPathKey = orgPathClaim ? snake(orgPathClaim) : undefined;
  // `put_root_org/1` runs AFTER `put_org_path/1` in the pipe, deriving
  // `current_user.root_org` (P2.5) from the just-set `:org_path`.
  const orgPathPipe = orgPathKey ? " |> put_org_path() |> put_root_org()" : "";
  const putOrgPathDef = !orgPathKey
    ? ""
    : orgPathRegistry
      ? `
  # Derives \`current_user.org_path\` (multi-tenancy P2.2): the caller org's
  # materialized \`data_key\`, read once per request from the tenant registry via
  # the app \`Repo\`.  The registry's Ecto schema module applies the schema prefix
  # and casts the pinned string claim against the \`:binary_id\` id column (the
  # same cast the registry self-scope filter uses).  Fails safe to the raw claim
  # (the root-segment path) when the row / data_key is absent or the claim is
  # malformed — never crashes the request.
  defp put_org_path(user), do: Map.put(user, :org_path, resolve_org_path(user[:${orgPathKey}]))

  defp resolve_org_path(claim) when is_binary(claim) and claim != "" do
    try do
      case ${orgPathRegistry.repoModule}.one(
             from o in ${orgPathRegistry.schemaModule}, where: o.id == ^claim, select: o.data_key
           ) do
        data_key when is_binary(data_key) and data_key != "" -> data_key
        _ -> claim
      end
    rescue
      _ -> claim
    end
  end

  defp resolve_org_path(claim), do: to_string(claim)
`
      : `
  # Derives \`current_user.org_path\` from the tenancy claim (multi-tenancy P2.1).
  defp put_org_path(user), do: Map.put(user, :org_path, to_string(user[:${orgPathKey}]))
`;
  // `current_user.root_org` (P2.5): the ROOT-org segment — the first segment of
  // `:org_path` (up to the first `.`).  Derived off the already-resolved
  // `:org_path` (pure, no extra read), correct under both flat and hierarchy
  // tenancy; anchors the `global` read level's root-subtree widening.
  const putRootOrgDef = !orgPathKey
    ? ""
    : `
  # Derives \`current_user.root_org\` (multi-tenancy P2.5): the first segment of
  # the materialized \`org_path\`, the anchor for the \`global\` read level.
  defp put_root_org(user), do: Map.put(user, :root_org, root_org_of(user[:org_path]))

  defp root_org_of(path) when is_binary(path) do
    case :binary.split(path, ".") do
      [root | _] -> root
      _ -> path
    end
  end

  defp root_org_of(path), do: to_string(path)
`;
  // The P2.2 registry read needs `from/2`; import it only in hierarchy mode so
  // a flat / no-tenancy plug carries no unused import (--warnings-as-errors).
  const ectoQueryImport =
    orgPathKey && orgPathRegistry ? "\n  import Ecto.Query, only: [from: 2]" : "";
  // DEV STUB only: let a caller override string claims (e.g. tenantId) via a
  // base64-JSON `x-loom-dev-claims` header — the same injection the Hono dev
  // stub honours (dotnet/java/python parity).  Never in OIDC mode: a header
  // must not override verified claims.  Keyed by the declared field name; the
  // value lands on the built principal's snake_case key.
  const devClaimStringFields = (user?.fields ?? []).filter(
    (f) => f.type.kind === "primitive" && f.type.name === "string",
  );
  const devClaimsEnabled = !auth && devClaimStringFields.length > 0;
  const buildUserCall =
    (devClaimsEnabled ? "merge_dev_claims(conn, build_user(claims))" : "build_user(claims)") +
    orgPathPipe;
  const mergeDevClaimsDef = devClaimsEnabled
    ? `
  # DEV STUB only: override string claims (e.g. tenantId) from a base64-encoded
  # JSON \`x-loom-dev-claims\` header — the same injection the Hono dev stub
  # honours.  Keyed by the declared field name; only string values apply.
  defp merge_dev_claims(conn, user) do
    case get_req_header(conn, "x-loom-dev-claims") do
      [raw | _] ->
        with {:ok, json} <- Base.decode64(raw),
             {:ok, claims} <- Jason.decode(json) do
          user
${devClaimStringFields
  .map((f) => `          |> maybe_put_claim(:${snake(f.name)}, claims["${f.name}"])`)
  .join("\n")}
        else
          _ -> user
        end

      _ ->
        user
    end
  end

  defp maybe_put_claim(user, key, value) when is_binary(value), do: Map.put(user, key, value)
  defp maybe_put_claim(user, _key, _value), do: user
`
    : "";
  // OIDC verifier vs dev stub.  The OIDC path additionally needs the JWKS
  // discovery/verification helpers; the dev stub needs none.
  const verifierSection = auth ? renderOidcVerifier(auth) : renderDevStubVerifier();
  const verifierDoc = auth
    ? "validates the inbound JWT against the issuer's JWKS (D-AUTH-OIDC)"
    : "is a permissive DEV STUB — replace verify_token/1 for production";
  // DEV STUB only: expose the built-in admin principal so LiveAuth can grant
  // LiveViews the SAME out-of-the-box identity this plug grants every :api
  // request.  In dev there's no /auth/callback handshake to seed the browser
  // session, so without this the sidebar + every gated page would 302 to
  // /login even though the JSON API authenticates.  OIDC mode omits it — a
  // real login must populate the session.
  const devUserFn = auth
    ? ""
    : `
  # DEV STUB: the built-in admin principal, exposed so LiveAuth grants
  # LiveViews the same identity the :api pipeline grants every request.
  def dev_user, do: build_user(elem(verify_token(nil), 1))${orgPathPipe}
`;
  // OIDC only: the browser LiveView guard reads the verified principal from the
  // `session` cookie (the /auth/callback handshake token) so the :browser
  // pipeline's BrowserAuth plug can seed the Phoenix session before
  // LiveAuth.on_mount gates a LiveView (the `auth: ui` frontend guard).
  const sessionUserFn = auth
    ? `
  @doc """
  The verified principal from the browser \`session\` cookie (the /auth/callback
  handshake token), or nil.  The :browser pipeline's BrowserAuth plug seeds the
  Phoenix session with this so LiveAuth.on_mount can gate LiveViews.
  """
  def session_user(conn) do
    conn = fetch_cookies(conn)

    with token when is_binary(token) and token != "" <- conn.cookies["session"],
         {:ok, claims} <- verify_token(token) do
      build_user(claims)${orgPathPipe}
    else
      _ -> nil
    end
  end
`
    : "";

  // OIDC: the token rides the Authorization header OR the `session` cookie the
  // /auth/callback handshake issued (the browser flow), so read both.  Dev
  // stub: header only (it has no handshake).
  const tokenBlock = auth
    ? `      token = extract_token(conn)`
    : `      token =
        case get_req_header(conn, "authorization") do
          ["Bearer " <> token | _] -> token
          _ -> nil
        end`;

  // OIDC: the /api/auth/login|callback|logout redirect handlers run inside the
  // :api pipeline (so the plug fires) but must be reachable WITHOUT a verified
  // principal — bypass them.  /api/auth/me is deliberately NOT bypassed.
  const handshakeBypass = auth
    ? `  defp bypass_path?("${AUTH_BASE_PATH}/login"), do: true
  defp bypass_path?("${AUTH_BASE_PATH}/callback"), do: true
  defp bypass_path?("${AUTH_BASE_PATH}/logout"), do: true
  defp bypass_path?("${AUTH_BASE_PATH}/refresh"), do: true
`
    : "";

  // OIDC: header-or-cookie extraction helper (the dev stub inlines header-only).
  const extractTokenDef = auth
    ? `
  # The bearer token from the Authorization header, or the \`session\` cookie
  # issued by the /auth/callback handshake (the browser flow).  nil when
  # neither is present.
  defp extract_token(conn) do
    case get_req_header(conn, "authorization") do
      ["Bearer " <> token | _] ->
        token

      _ ->
        conn = fetch_cookies(conn)

        case conn.cookies["session"] do
          token when is_binary(token) and token != "" -> token
          _ -> nil
        end
    end
  end
`
    : "";

  return `# Auto-generated.
defmodule ${webModule}.Auth do
  @moduledoc """
  Plug that decodes the inbound Authorization: Bearer <token> JWT and
  populates \`conn.assigns.current_user\` from the system's user shape.

  Mount in any pipeline that requires authentication:

      pipeline :api do
        plug :accepts, ["json"]
        plug ${webModule}.Auth
      end

  \`verify_token/1\` ${verifierDoc}.
  """

  @behaviour Plug
  import Plug.Conn
  require Logger${ectoQueryImport}

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _opts) do
    if bypass_path?(conn.request_path) do
      conn
    else
${tokenBlock}

      case verify_token(token) do
        {:ok, claims} ->
          user = ${buildUserCall}
          # Principal slice of the execution context: stamp ONLY the actor id
          # into Logger.metadata (the request-context carrier) so audit and log
          # lines can attribute the actor without leaking the rest of the
          # principal (PII) onto every line.  The full principal stays on
          # conn.assigns.current_user.
          Logger.metadata(actor_id: user[:${idKey}])
          assign(conn, :current_user, user)

        _ ->
          send_unauthorized(conn)
      end
    end
  end

  # Bypass list — the openapi spec endpoint must serve without a token
  # so the cross-platform parity check works.  /health and /ready are
  # routed outside the :api pipeline but listed here as belt-and-suspenders.
  defp bypass_path?("/openapi.json"), do: true
  defp bypass_path?("/health"), do: true
  defp bypass_path?("/ready"), do: true
${handshakeBypass}  defp bypass_path?(_), do: false
${extractTokenDef}
  # Sends a proper 401 body + halts — without send_resp/3 the underlying
  # adapter raises Plug.Conn.NotSentError and the response surfaces as a 500.
  defp send_unauthorized(conn) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(401, ~s({"error":"unauthorized"}))
    |> halt()
  end
${devUserFn}${sessionUserFn}
${verifierSection}
  # ---------------------------------------------------------------------------
  # Maps verified JWT claims onto the system's user { } shape.  OIDC walks
  # dotted claim paths (e.g. \`realm_access.roles\`) via get_claim/2; the dev
  # stub reads flat claim keys.
  # ---------------------------------------------------------------------------

  defp build_user(claims) do
${buildUserBody}  end
${mergeDevClaimsDef}${putOrgPathDef}${putRootOrgDef}end
`;
}

// ---------------------------------------------------------------------------
// OIDC verifier section (D-AUTH-OIDC) — the batteries-included fill-in.
// Validates the bearer token's signature against the issuer's JWKS
// (discovered lazily, cached in :persistent_term), then checks iss / exp.
// JWKS fetch uses OTP's built-in :httpc (no extra HTTP-client dep); the
// issuer is read at RUNTIME (a module attribute would freeze the empty
// compile-time env into the release).  A plain-http issuer (the bundled dev
// Keycloak / loopback) is honoured — :httpc imposes no https requirement, so
// dev works out of the box (the inverse of the .NET RequireHttps gotcha).
// ---------------------------------------------------------------------------

function renderOidcVerifier(auth: AuthIR): string {
  // The OIDC_ISSUER env override wins; the DECLARED value is the fallback
  // (12-factor, same contract as every other backend's verifier).
  // Audience parity: when the auth block declares an `audience:`, the token's
  // `aud` must carry it — the other four backends validate it, and a verifier
  // that skips the check accepts tokens the rest of the system rejects.
  const audCheck = auth.oidc.audience
    ? `

    aud_ok =
      case audience() do
        "" -> true
        expected -> Map.get(claims, "aud") |> List.wrap() |> Enum.member?(expected)
      end`
    : "";
  const audOkTerm = auth.oidc.audience ? " and aud_ok" : "";
  const audienceFn = auth.oidc.audience
    ? `
  defp audience, do: ${envOrDeclared("OIDC_AUDIENCE", auth.oidc.audience)}
`
    : "";
  return `  # ---------------------------------------------------------------------------
  # OIDC token verification (D-AUTH-OIDC).
  # ---------------------------------------------------------------------------

  # Trailing-slash-trimmed issuer, read at runtime (NOT a module attribute —
  # that would bake the empty compile-time env into the release).  The env
  # override wins; the declared \`issuer:\` is the fallback (12-factor).
  defp issuer, do: (${envOrDeclared("OIDC_ISSUER", auth.oidc.issuer)}) |> String.trim_trailing("/")
${audienceFn}

  defp verify_token(nil), do: {:error, :no_token}

  defp verify_token(token) when is_binary(token) do
    with {:ok, kid} <- token_kid(token),
         {:ok, jwk} <- signing_key(kid),
         {true, %JOSE.JWT{fields: claims}, _} <-
           JOSE.JWT.verify_strict(jwk, ["RS256", "RS384", "RS512", "ES256", "ES384"], token),
         :ok <- check_claims(claims) do
      {:ok, claims}
    else
      _ -> {:error, :invalid_token}
    end
  end

  # The token's \`kid\` (key id) from its protected header — selects which JWKS
  # key verifies it.
  defp token_kid(token) do
    with [header_b64 | _] <- String.split(token, "."),
         {:ok, json} <- Base.url_decode64(header_b64, padding: false),
         {:ok, %{"kid" => kid}} <- Jason.decode(json) do
      {:ok, kid}
    else
      _ -> :error
    end
  end

  # Key rotation: a kid the cached JWKS doesn't know may be a NEW key the
  # IdP rotated in after we cached — refetch once (rate-limited) and retry
  # before rejecting, so rotation heals without a restart (the other
  # backends' JWKS clients do this out of the box).
  defp signing_key(kid) do
    case find_key(jwks(), kid) || find_key(refreshed_jwks(), kid) do
      nil -> :error
      key_map -> {:ok, JOSE.JWK.from_map(key_map)}
    end
  end

  defp find_key(keys, kid), do: Enum.find(keys, fn key -> key["kid"] == kid end)

  # iss must equal the configured issuer; exp must be in the future.
  defp check_claims(claims) do
    now = System.system_time(:second)
    iss_ok = Map.get(claims, "iss") == issuer()

    exp_ok =
      case Map.get(claims, "exp") do
        exp when is_integer(exp) -> exp > now
        _ -> false
      end${audCheck}

    if iss_ok and exp_ok${audOkTerm}, do: :ok, else: :error
  end

  # The issuer's JWKS keys, discovered via the OIDC discovery document and
  # cached in :persistent_term (lazy, no supervised process).  Only a
  # NON-EMPTY key set is cached: a failed fetch returns [] for this request
  # (verify rejects with 401, never a 500) and the next request retries —
  # caching the empty list would poison every later verify with a permanent
  # 401 (e.g. one request racing the IdP's boot/realm import).
  defp jwks do
    case :persistent_term.get({__MODULE__, :jwks}, nil) do
      nil ->
        case fetch_jwks() do
          [] ->
            []

          keys ->
            :persistent_term.put({__MODULE__, :jwks}, keys)
            keys
        end

      keys ->
        keys
    end
  end

  # Forced refetch on a kid miss, rate-limited to one fetch per 30s (a burst
  # of unknown-kid tokens — e.g. garbage \`kid\`s from an attacker — must not
  # hammer the IdP).  A successful refetch replaces the cache; a failed one
  # leaves the previous keys in place, so known-kid tokens keep verifying
  # through an IdP outage.
  defp refreshed_jwks do
    now = System.system_time(:second)
    last = :persistent_term.get({__MODULE__, :jwks_refreshed_at}, 0)

    if now - last < 30 do
      []
    else
      :persistent_term.put({__MODULE__, :jwks_refreshed_at}, now)

      case fetch_jwks() do
        [] ->
          []

        keys ->
          :persistent_term.put({__MODULE__, :jwks}, keys)
          keys
      end
    end
  end

  defp fetch_jwks do
    with {:ok, %{"jwks_uri" => jwks_uri}} <-
           http_get_json(issuer() <> "/.well-known/openid-configuration"),
         {:ok, %{"keys" => keys}} <- http_get_json(jwks_uri) do
      keys
    else
      _ -> []
    end
  end

  # GET a URL and JSON-decode the body via OTP's :httpc.  For an https issuer
  # the system CA store verifies the peer; plain http (dev) needs no ssl opts.
  defp http_get_json(url) do
    _ = :inets.start()
    _ = :ssl.start()

    http_opts =
      if String.starts_with?(url, "https"),
        do: [ssl: [verify: :verify_peer, cacerts: :public_key.cacerts_get()]],
        else: []

    case :httpc.request(:get, {String.to_charlist(url), []}, http_opts, body_format: :binary) do
      {:ok, {{_, 200, _}, _headers, body}} -> Jason.decode(body)
      _ -> :error
    end
  end

  # Reads a dotted claim path off the (string-keyed) claims map; nil when any
  # segment is missing.  Only the OIDC build_user maps via paths, so this lives
  # in the OIDC section (the dev stub reads flat claim keys directly).
  defp get_claim(claims, path) do
    path
    |> String.split(".")
    |> Enum.reduce(claims, fn
      _key, nil -> nil
      key, acc when is_map(acc) -> Map.get(acc, key)
      _key, _acc -> nil
    end)
  end
`;
}

function renderDevStubVerifier(): string {
  return `  # ---------------------------------------------------------------------------
  # User-supplied JWT verifier hook.  Default DEV STUB accepts every request
  # (nil included) as a built-in admin user so a generated stack boots
  # end-to-end — the same out-of-the-box behaviour as the Hono and .NET
  # dev-stub verifiers.  REPLACE for production with a real JWT decoder, or
  # declare an \`auth { oidc { … } }\` block to get the generated OIDC verifier.
  # ---------------------------------------------------------------------------

  defp verify_token(token) do
    _ = token

    {:ok,
     %{
       "id" => "00000000-0000-0000-0000-000000000000",
       "role" => "admin",
       "permissions" => []
     }}
  end
`;
}

function renderBuildUser(user: UserIR | undefined, auth: AuthIR | undefined): string {
  if (!user || user.fields.length === 0) {
    // No user block declared — emit a minimal passthrough map.
    return `    %{id: claims["sub"], permissions: claims["permissions"] || []}\n`;
  }

  const fieldLines = user.fields.map((f: FieldIR) => {
    const key = snake(f.name);
    const isArray =
      f.type.kind === "array" || (f.type.kind === "optional" && f.type.inner.kind === "array");
    // OIDC: map via the configured claim path (id→sub default).  Dev stub:
    // read the flat claim by field name (the stub map uses field keys).
    const path = auth ? claimPathFor(f.name, auth) : key;
    const read = auth
      ? `get_claim(claims, ${JSON.stringify(path)})`
      : `claims[${JSON.stringify(key)}]`;
    const rhs = isArray ? `${read} || []` : read;
    return `      ${key}: ${rhs}`;
  });

  return `    %{\n${fieldLines.join(",\n")}\n    }\n`;
}

/** Render an `AuthValueIR` (literal | env reference) as an Elixir expression,
 *  read at runtime.  Env reads default to "" so an unset var fails the verify
 *  loudly rather than mis-resolving. */
function elixirAuthValue(v: AuthValueIR | undefined, fallback = '""'): string {
  if (!v) return fallback;
  if (v.kind === "literal") return JSON.stringify(v.value);
  return `System.get_env(${JSON.stringify(v.env)}, "")`;
}

/** `System.get_env(<canonical var>, <declared>)` — the deploy env overrides
 *  the declared auth value (12-factor; the generated compose repoints
 *  OIDC_ISSUER / OIDC_CLIENT_ID at the bundled dev Keycloak).  A declared
 *  env-kind value reading the same var stays a single read; a custom var
 *  becomes the fallback read. */
function envOrDeclared(envVar: string, v: AuthValueIR | undefined): string {
  if (v?.kind === "env" && v.env !== envVar) {
    return `System.get_env(${JSON.stringify(envVar)}) || System.get_env(${JSON.stringify(v.env)}, "")`;
  }
  const fallback = v?.kind === "literal" ? JSON.stringify(v.value) : '""';
  return `System.get_env(${JSON.stringify(envVar)}, ${fallback})`;
}

// ---------------------------------------------------------------------------
// AuthController — GET /auth/me session probe (always), plus the OIDC redirect
// handshake (/auth/login|callback|logout) when an `auth { oidc }` block is
// present.  /auth/me returns the verified principal the Auth plug stamped onto
// conn.assigns (the `auth: ui` frontend guard reads it; works for both the
// OIDC verifier and the dev stub).  The handshake mirrors the Hono / .NET one:
// login starts the authorization-code flow, callback exchanges the code and
// issues the HttpOnly `session` cookie the verifier reads, logout clears it.
// No login form — the IdP hosts the credential pages.
// ---------------------------------------------------------------------------

function renderAuthController(webModule: string, auth: AuthIR | undefined, port: number): string {
  const me = `  @doc "GET /auth/me — the verified principal, or null."
  def me(conn, _params) do
    json(conn, conn.assigns[:current_user])
  end`;

  if (!auth) {
    return `# Auto-generated.
defmodule ${webModule}.AuthController do
  use ${webModule}, :controller

  @moduledoc """
  Session probe for the \`auth: ui\` frontend guard.  GET /auth/me runs
  through the :api pipeline (so ${webModule}.Auth has verified the principal
  or returned 401) and echoes the resolved current_user as JSON.
  """

${me}
end
`;
  }

  // Env override first (12-factor) — same contract as the verifier's
  // issuer/0: the generated compose repoints OIDC_ISSUER / OIDC_CLIENT_ID
  // at the bundled dev Keycloak.
  const issuerExpr = envOrDeclared("OIDC_ISSUER", auth.oidc.issuer);
  const clientIdExpr = envOrDeclared("OIDC_CLIENT_ID", auth.oidc.clientId);
  // A public client has no secret: default to the env read (nil when unset) so
  // base_form/1 omits client_secret rather than sending an empty one.
  const clientSecretExpr = auth.oidc.clientSecret
    ? elixirAuthValue(auth.oidc.clientSecret)
    : `System.get_env("OIDC_CLIENT_SECRET")`;
  // `offline_access` asks the IdP for a refresh token so /refresh can rotate
  // it (M-T3.5).  Idempotent.
  const scopeList = (auth.oidc.scopes.length ? auth.oidc.scopes : ["openid"]).slice();
  if (!scopeList.includes("offline_access")) scopeList.push("offline_access");
  const scopes = scopeList.join(" ");

  return `# Auto-generated.
defmodule ${webModule}.AuthController do
  use ${webModule}, :controller

  @moduledoc """
  Session probe + OIDC redirect handshake (D-AUTH-OIDC).

  GET  /auth/me      — the verified current_user (the \`auth: ui\` guard reads it).
  GET  /auth/login   — starts the authorization-code flow with PKCE (redirect to the IdP).
  GET  /auth/callback — exchanges the code, sets the HttpOnly \`session\` + \`refresh\`
                     cookies ${webModule}.Auth reads, redirects post-login.
  POST /auth/refresh — rotates the refresh token → a fresh session, no IdP round-trip.
  GET  /auth/logout  — clears the \`session\` + \`refresh\` cookies.

  No login form — the IdP hosts the credential pages.
  """

  @scopes ${JSON.stringify(scopes)}

${me}

  @doc "GET /auth/login — redirect to the IdP's authorization endpoint."
  def login(conn, _params) do
    case discovery() do
      {:ok, %{"authorization_endpoint" => authorize}} ->
        state = :crypto.strong_rand_bytes(16) |> Base.url_encode64(padding: false)
        # PKCE (RFC 7636): mint a verifier, send only its S256 challenge to the
        # IdP, stash the verifier in an HttpOnly cookie for /callback.
        verifier = :crypto.strong_rand_bytes(32) |> Base.url_encode64(padding: false)
        challenge = :crypto.hash(:sha256, verifier) |> Base.url_encode64(padding: false)

        query =
          URI.encode_query(%{
            "response_type" => "code",
            "client_id" => client_id(),
            "redirect_uri" => redirect_uri(),
            "scope" => @scopes,
            "state" => state,
            "code_challenge" => challenge,
            "code_challenge_method" => "S256"
          })

        conn
        |> put_resp_cookie("oidc_state", state, http_only: true, same_site: "Lax")
        |> put_resp_cookie("oidc_verifier", verifier, http_only: true, same_site: "Lax")
        |> redirect(external: authorize <> "?" <> query)

      _ ->
        conn |> put_status(502) |> json(%{error: "discovery_failed"})
    end
  end

  @doc "GET /auth/callback — exchange the code, issue the session + refresh cookies."
  def callback(conn, %{"code" => code, "state" => state}) do
    conn = fetch_cookies(conn)
    verifier = conn.cookies["oidc_verifier"]

    if state != "" and state == conn.cookies["oidc_state"] and is_binary(verifier) do
      case exchange_code(code, verifier) do
        {:ok, tokens} ->
          conn
          |> store_tokens(tokens)
          |> delete_resp_cookie("oidc_state")
          |> delete_resp_cookie("oidc_verifier")
          |> redirect_post_login()

        _ ->
          conn |> put_status(401) |> json(%{error: "token_exchange_failed"})
      end
    else
      conn |> put_status(400) |> json(%{error: "invalid_state"})
    end
  end

  def callback(conn, _params) do
    conn |> put_status(400) |> json(%{error: "invalid_request"})
  end

  @doc """
  POST /auth/refresh — silent renewal.  Exchange the stored refresh token for a
  fresh access token WITHOUT another IdP round-trip, and ROTATE it (the IdP
  returns a new refresh token; store_tokens overwrites the cookie → single-use).
  """
  def refresh(conn, _params) do
    conn = fetch_cookies(conn)

    case conn.cookies["refresh"] do
      token when is_binary(token) and token != "" ->
        case exchange_refresh(token) do
          {:ok, tokens} ->
            conn |> store_tokens(tokens) |> json(%{ok: true})

          _ ->
            # Spent or revoked — clear both cookies so the SPA falls back to a
            # full /login instead of looping on a dead token.
            conn
            |> delete_resp_cookie("session")
            |> delete_resp_cookie("refresh")
            |> put_status(401)
            |> json(%{error: "refresh_failed"})
        end

      _ ->
        conn |> put_status(401) |> json(%{error: "no_refresh_token"})
    end
  end

  @doc "GET /auth/logout — clear the session + refresh cookies."
  def logout(conn, _params) do
    conn
    |> delete_resp_cookie("session")
    |> delete_resp_cookie("refresh")
    |> redirect_post_login()
  end

  # Persist the access token as the browser session and the refresh token (when
  # the IdP granted one) for /refresh.  Both HttpOnly — the SPA never sees them.
  defp store_tokens(conn, tokens) do
    conn =
      put_resp_cookie(conn, "session", Map.get(tokens, "access_token", ""),
        http_only: true,
        same_site: "Lax"
      )

    case Map.get(tokens, "refresh_token") do
      refresh when is_binary(refresh) and refresh != "" ->
        put_resp_cookie(conn, "refresh", refresh, http_only: true, same_site: "Lax")

      _ ->
        conn
    end
  end

  # --- OIDC config (read at runtime) -----------------------------------------

  defp issuer, do: (${issuerExpr}) |> String.trim_trailing("/")
  defp client_id, do: ${clientIdExpr}
  defp client_secret, do: ${clientSecretExpr}

  defp redirect_uri,
    do: System.get_env("OIDC_REDIRECT_URI", "http://localhost:${port}${AUTH_BASE_PATH}/callback")

  defp post_login, do: System.get_env("OIDC_POST_LOGIN_REDIRECT", "/")

  # The IdP's own session lives at its end-session endpoint, which the SPA can
  # link to directly; here we only clear the local cookie and bounce home.
  defp redirect_post_login(conn) do
    target = post_login()

    if String.starts_with?(target, "http"),
      do: redirect(conn, external: target),
      else: redirect(conn, to: target)
  end

  # --- OIDC discovery + token exchange (OTP :httpc) --------------------------

  defp discovery, do: http_get_json(issuer() <> "/.well-known/openid-configuration")

  defp exchange_code(code, verifier) do
    token_request(%{
      "grant_type" => "authorization_code",
      "code" => code,
      "redirect_uri" => redirect_uri(),
      "client_id" => client_id(),
      "code_verifier" => verifier
    })
  end

  defp exchange_refresh(refresh_token) do
    token_request(%{
      "grant_type" => "refresh_token",
      "refresh_token" => refresh_token,
      "client_id" => client_id()
    })
  end

  # POST a form-urlencoded token request; {:ok, token_map} on 200, :error otherwise.
  defp token_request(form) do
    with {:ok, %{"token_endpoint" => token_endpoint}} <- discovery() do
      body = URI.encode_query(with_secret(form))

      _ = :inets.start()
      _ = :ssl.start()

      request =
        {String.to_charlist(token_endpoint), [], ~c"application/x-www-form-urlencoded", body}

      case :httpc.request(:post, request, http_opts(token_endpoint), body_format: :binary) do
        {:ok, {{_, 200, _}, _headers, resp}} ->
          case Jason.decode(resp) do
            {:ok, %{"access_token" => token} = tokens} when is_binary(token) -> {:ok, tokens}
            _ -> :error
          end

        _ ->
          :error
      end
    else
      _ -> :error
    end
  end

  defp with_secret(form) do
    case client_secret() do
      secret when is_binary(secret) and secret != "" -> Map.put(form, "client_secret", secret)
      _ -> form
    end
  end

  defp http_get_json(url) do
    _ = :inets.start()
    _ = :ssl.start()

    case :httpc.request(:get, {String.to_charlist(url), []}, http_opts(url), body_format: :binary) do
      {:ok, {{_, 200, _}, _headers, body}} -> Jason.decode(body)
      _ -> :error
    end
  end

  # https issuers verify against the system CA store; plain http (dev) needs no
  # ssl opts — :httpc imposes no https requirement, so the dev IdP works.
  defp http_opts(url) do
    if String.starts_with?(url, "https"),
      do: [ssl: [verify: :verify_peer, cacerts: :public_key.cacerts_get()]],
      else: []
  end
end
`;
}

// ---------------------------------------------------------------------------
// LiveAuth on_mount hook — WebSocket / LiveView path.
// Mirrors Auth but reads from the session instead of an Authorization header.
// ---------------------------------------------------------------------------

function renderLiveAuth(webModule: string, auth: AuthIR | undefined): string {
  // DEV STUB: no /auth/callback handshake seeds the browser session in dev, so
  // fall back to the same built-in admin the :api plug grants every request —
  // LiveViews (the sidebar + every gated page) render out of the box instead
  // of 302-ing to /login.  OIDC mode keeps the strict path: a missing session
  // redirects to /login, where the real handshake populates it.
  const missingSessionArm = auth
    ? `_ -> {:error, :unauthenticated}`
    : `_ -> {:ok, ${webModule}.Auth.dev_user()}`;
  // Where an unauthenticated LiveView bounces.  OIDC → the real login handshake
  // (which 302s to the IdP); dev-stub never reaches this arm (dev_user always
  // grants), so "/" is a harmless placeholder.
  const loginRedirect = auth ? `${AUTH_BASE_PATH}/login` : "/login";
  const verifyDoc = auth
    ? `reads \\\`current_user\\\` from the session map, seeded per-request by the
  :browser pipeline's BrowserAuth plug from the verified /auth/callback session
  cookie.  A missing session bounces to the login handshake.`
    : `reads \\\`current_user\\\` from the session, falling back to the dev-stub
  admin so LiveViews render without a login handshake (symmetric with the
  permissive :api plug).  Replace for production, or declare an
  \\\`auth { oidc }\\\` block to require a real session.`;
  return `# Auto-generated.
defmodule ${webModule}.LiveAuth do
  @moduledoc """
  Phoenix.LiveView on_mount hook that authenticates LiveView connections.

  Mount in a live_session to gate all LiveViews in that scope:

      live_session :default, on_mount: [${webModule}.LiveAuth] do
        live "/", DashboardLive
        ...
      end

  The \`verify_session/1\` private function ${verifyDoc}
  """

  import Phoenix.Component, only: [assign: 3]

  def on_mount(:default, _params, session, socket) do
    case verify_session(session) do
      {:ok, user} -> {:cont, assign(socket, :current_user, user)}
      _ -> {:halt, Phoenix.LiveView.redirect(socket, to: "${loginRedirect}")}
    end
  end

  # ---------------------------------------------------------------------------
  # Mirrors Auth.verify_token but reads from session["current_user"].
  # ---------------------------------------------------------------------------

  defp verify_session(session) do
    case session do
      %{"current_user" => user} -> {:ok, user}
      ${missingSessionArm}
    end
  end
end
`;
}

// ---------------------------------------------------------------------------
// BrowserAuth plug (OIDC only) — the HTTP-request half of the `auth: ui`
// LiveView guard.  Runs in the `:browser` pipeline AFTER `:fetch_session`:
// it verifies the `session` cookie the /auth/callback handshake issued and
// writes the resolved principal into the Phoenix session under
// `"current_user"`, so LiveAuth.on_mount (which reads the session map) sees a
// signed-in user on the live connect.  A missing / invalid cookie leaves the
// session untouched, and LiveAuth bounces the LiveView to the login handshake.
// ---------------------------------------------------------------------------

function renderBrowserAuth(webModule: string): string {
  return `# Auto-generated.
defmodule ${webModule}.BrowserAuth do
  @moduledoc """
  Plug (\`:browser\` pipeline) that seeds the Phoenix session's \`current_user\`
  from the verified \`session\` cookie the /auth/callback handshake issued, so
  \`${webModule}.LiveAuth.on_mount/4\` can gate LiveViews (the \`auth: ui\`
  frontend guard).  Runs after \`:fetch_session\`; a missing / invalid cookie
  leaves the session untouched (LiveAuth then redirects to the login handshake).
  """

  @behaviour Plug
  import Plug.Conn

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _opts) do
    case ${webModule}.Auth.session_user(conn) do
      nil -> conn
      user -> put_session(conn, "current_user", user)
    end
  end
end
`;
}
