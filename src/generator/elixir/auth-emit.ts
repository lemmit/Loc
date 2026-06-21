import type {
  AuthIR,
  AuthValueIR,
  DeployableIR,
  FieldIR,
  SystemIR,
  UserIR,
} from "../../ir/types/loom-ir.js";
import { AUTH_BASE_PATH } from "../../util/api-base.js";
import { snake } from "../../util/naming.js";

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

  files.set(`lib/${appName}_web/auth.ex`, renderAuthPlug(sys.user, webModule, auth));
  files.set(`lib/${appName}_web/live_auth.ex`, renderLiveAuth(webModule));
  files.set(
    `lib/${appName}_web/controllers/auth_controller.ex`,
    renderAuthController(webModule, auth, deployable.port ?? 4000),
  );

  return { files, enabled: true };
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
): string {
  const buildUserBody = renderBuildUser(user, auth);
  const idKey = actorIdKey(user);
  // OIDC verifier vs dev stub.  The OIDC path additionally needs the JWKS
  // discovery/verification helpers; the dev stub needs none.
  const verifierSection = auth ? renderOidcVerifier() : renderDevStubVerifier();
  const verifierDoc = auth
    ? "validates the inbound JWT against the issuer's JWKS (D-AUTH-OIDC)"
    : "is a permissive DEV STUB — replace verify_token/1 for production";

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
  require Logger

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
          user = build_user(claims)
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

${verifierSection}
  # ---------------------------------------------------------------------------
  # Maps verified JWT claims onto the system's user { } shape.  OIDC walks
  # dotted claim paths (e.g. \`realm_access.roles\`) via get_claim/2; the dev
  # stub reads flat claim keys.
  # ---------------------------------------------------------------------------

  defp build_user(claims) do
${buildUserBody}  end
end
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

function renderOidcVerifier(): string {
  return `  # ---------------------------------------------------------------------------
  # OIDC token verification (D-AUTH-OIDC).
  # ---------------------------------------------------------------------------

  # Trailing-slash-trimmed issuer, read at runtime (NOT a module attribute —
  # that would bake the empty compile-time env into the release).
  defp issuer, do: System.get_env("OIDC_ISSUER", "") |> String.trim_trailing("/")

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

  defp signing_key(kid) do
    case Enum.find(jwks(), fn key -> key["kid"] == kid end) do
      nil -> :error
      key_map -> {:ok, JOSE.JWK.from_map(key_map)}
    end
  end

  # iss must equal the configured issuer; exp must be in the future.
  defp check_claims(claims) do
    now = System.system_time(:second)
    iss_ok = Map.get(claims, "iss") == issuer()

    exp_ok =
      case Map.get(claims, "exp") do
        exp when is_integer(exp) -> exp > now
        _ -> false
      end

    if iss_ok and exp_ok, do: :ok, else: :error
  end

  # The issuer's JWKS keys, discovered via the OIDC discovery document and
  # cached in :persistent_term (lazy, no supervised process).  An empty list
  # on fetch failure → every verify rejects (401), never a 500.
  defp jwks do
    case :persistent_term.get({__MODULE__, :jwks}, nil) do
      nil ->
        keys = fetch_jwks()
        :persistent_term.put({__MODULE__, :jwks}, keys)
        keys

      keys ->
        keys
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

  const issuerExpr = elixirAuthValue(auth.oidc.issuer);
  const clientIdExpr = elixirAuthValue(auth.oidc.clientId);
  // A public client has no secret: default to the env read (nil when unset) so
  // base_form/1 omits client_secret rather than sending an empty one.
  const clientSecretExpr = auth.oidc.clientSecret
    ? elixirAuthValue(auth.oidc.clientSecret)
    : `System.get_env("OIDC_CLIENT_SECRET")`;
  const scopes = (auth.oidc.scopes.length ? auth.oidc.scopes : ["openid"]).join(" ");

  return `# Auto-generated.
defmodule ${webModule}.AuthController do
  use ${webModule}, :controller

  @moduledoc """
  Session probe + OIDC redirect handshake (D-AUTH-OIDC).

  GET /auth/me     — the verified current_user (the \`auth: ui\` guard reads it).
  GET /auth/login  — starts the authorization-code flow (redirect to the IdP).
  GET /auth/callback — exchanges the code, sets the HttpOnly \`session\` cookie
                     ${webModule}.Auth reads, redirects post-login.
  GET /auth/logout — clears the \`session\` cookie.

  No login form — the IdP hosts the credential pages.
  """

  @scopes ${JSON.stringify(scopes)}

${me}

  @doc "GET /auth/login — redirect to the IdP's authorization endpoint."
  def login(conn, _params) do
    case discovery() do
      {:ok, %{"authorization_endpoint" => authorize}} ->
        state = :crypto.strong_rand_bytes(16) |> Base.url_encode64(padding: false)

        query =
          URI.encode_query(%{
            "response_type" => "code",
            "client_id" => client_id(),
            "redirect_uri" => redirect_uri(),
            "scope" => @scopes,
            "state" => state
          })

        conn
        |> put_resp_cookie("oidc_state", state, http_only: true, same_site: "Lax")
        |> redirect(external: authorize <> "?" <> query)

      _ ->
        conn |> put_status(502) |> json(%{error: "discovery_failed"})
    end
  end

  @doc "GET /auth/callback — exchange the code, issue the session cookie."
  def callback(conn, %{"code" => code, "state" => state}) do
    conn = fetch_cookies(conn)

    if state != "" and state == conn.cookies["oidc_state"] do
      case exchange_code(code) do
        {:ok, access_token} ->
          conn
          |> put_resp_cookie("session", access_token, http_only: true, same_site: "Lax")
          |> delete_resp_cookie("oidc_state")
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

  @doc "GET /auth/logout — clear the session cookie."
  def logout(conn, _params) do
    conn
    |> delete_resp_cookie("session")
    |> redirect_post_login()
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

  defp exchange_code(code) do
    with {:ok, %{"token_endpoint" => token_endpoint}} <- discovery() do
      body = URI.encode_query(base_form(code))

      _ = :inets.start()
      _ = :ssl.start()

      request =
        {String.to_charlist(token_endpoint), [], ~c"application/x-www-form-urlencoded", body}

      case :httpc.request(:post, request, http_opts(token_endpoint), body_format: :binary) do
        {:ok, {{_, 200, _}, _headers, resp}} ->
          case Jason.decode(resp) do
            {:ok, %{"access_token" => token}} when is_binary(token) -> {:ok, token}
            _ -> :error
          end

        _ ->
          :error
      end
    else
      _ -> :error
    end
  end

  defp base_form(code) do
    base = %{
      "grant_type" => "authorization_code",
      "code" => code,
      "redirect_uri" => redirect_uri(),
      "client_id" => client_id()
    }

    case client_secret() do
      secret when is_binary(secret) and secret != "" -> Map.put(base, "client_secret", secret)
      _ -> base
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

function renderLiveAuth(webModule: string): string {
  return `# Auto-generated.
defmodule ${webModule}.LiveAuth do
  @moduledoc """
  Phoenix.LiveView on_mount hook that authenticates LiveView connections.

  Mount in a live_session to gate all LiveViews in that scope:

      live_session :default, on_mount: [${webModule}.LiveAuth] do
        live "/", DashboardLive
        ...
      end

  The \`verify_session/1\` private function is a v0 stub that reads
  \`current_user\` directly from the session map.  Extend it to validate
  a session token, load from the database, etc.
  """

  import Phoenix.Component, only: [assign: 3]

  def on_mount(:default, _params, session, socket) do
    case verify_session(session) do
      {:ok, user} -> {:cont, assign(socket, :current_user, user)}
      _ -> {:halt, Phoenix.LiveView.redirect(socket, to: "/login")}
    end
  end

  # ---------------------------------------------------------------------------
  # Mirrors Auth.verify_token but reads from session["token"] /
  # session["current_user"].  v0 stub — extend as needed.
  # ---------------------------------------------------------------------------

  defp verify_session(session) do
    case session do
      %{"current_user" => user} -> {:ok, user}
      _ -> {:error, :unauthenticated}
    end
  end
end
`;
}
