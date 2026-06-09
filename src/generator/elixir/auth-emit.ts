import type { DeployableIR, FieldIR, SystemIR, UserIR } from "../../ir/types/loom-ir.js";
import { snake } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Phoenix LiveView auth scaffolding — emitted per deployable when
// `deployable.auth?.required === true`.
//
// Two files:
//
//   lib/<app>_web/auth.ex       — Plug module; decodes the Authorization
//                                 Bearer token and populates
//                                 `conn.assigns.current_user` from the
//                                 system's `user { }` block shape.
//                                 verify_token/1 is a TODO stub — users
//                                 implement it themselves (matches hono's
//                                 registerUserVerifier pattern).
//
//   lib/<app>_web/live_auth.ex  — Phoenix.LiveView on_mount hook that
//                                 mirrors Auth for the WebSocket path.
//                                 v0 stub reads current_user from the
//                                 session map; users extend as needed.
//
// The router wiring (plug + live_session on_mount) is applied in
// renderRouter inside index.ts via the `authEnabled` flag.
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
   *  uses this to splice the Auth plug + LiveAuth on_mount. */
  enabled: boolean;
}

export function emitAuth(args: AuthEmitArgs): AuthEmitResult {
  const { sys, deployable, appName, appModule } = args;
  const files = new Map<string, string>();

  if (!deployable.auth?.required) {
    return { files, enabled: false };
  }

  const webModule = `${appModule}Web`;

  files.set(`lib/${appName}_web/auth.ex`, renderAuthPlug(sys.user, webModule));

  files.set(`lib/${appName}_web/live_auth.ex`, renderLiveAuth(webModule));

  return { files, enabled: true };
}

// ---------------------------------------------------------------------------
// Auth plug — Bearer token path (HTTP API + browser requests that carry
// an Authorization header).
// ---------------------------------------------------------------------------

function renderAuthPlug(user: UserIR | undefined, webModule: string): string {
  const buildUserBody = renderBuildUser(user);

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

  The \`verify_token/1\` private function is a TODO stub — implement it
  to decode the JWT with your preferred library (e.g. JOSE, joken).
  """

  @behaviour Plug
  import Plug.Conn

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _opts) do
    if bypass_path?(conn.request_path) do
      conn
    else
      case get_req_header(conn, "authorization") do
        ["Bearer " <> token | _] ->
          case verify_token(token) do
            {:ok, claims} ->
              assign(conn, :current_user, build_user(claims))

            _ ->
              send_unauthorized(conn)
          end

        _ ->
          send_unauthorized(conn)
      end
    end
  end

  # Bypass list — the openapi spec endpoint must serve without a token
  # so the cross-platform parity check (and any unauth'd scraping of the
  # contract) works.  /health is also routed outside the :api pipeline
  # but listed here as a belt-and-suspenders against future router moves.
  defp bypass_path?("/api/openapi.json"), do: true
  defp bypass_path?("/health"), do: true
  defp bypass_path?("/ready"), do: true
  defp bypass_path?(_), do: false

  # Sends a proper 401 body + halts — without send_resp/3 the underlying
  # cowboy adapter raises Plug.Conn.NotSentError and the response surfaces
  # as a 500.  Halting after the send stops downstream plugs from running
  # but keeps the response intact.
  defp send_unauthorized(conn) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(401, ~s({"error":"unauthorized"}))
    |> halt()
  end

  # ---------------------------------------------------------------------------
  # User-supplied JWT verifier hook — the user implements this.
  # Default stub returns a built-in admin user so a generated stack boots
  # end-to-end and the parity OpenAPI fetch works.  REPLACE for production
  # with a real JWT decoder (e.g. JOSE / joken) — return {:ok, claims_map}
  # or {:error, reason}.
  # ---------------------------------------------------------------------------

  defp verify_token(token) do
    _ = token
    {:ok, %{
      "id" => "00000000-0000-0000-0000-000000000000",
      "role" => "admin",
      "permissions" => []
    }}
  end

  # ---------------------------------------------------------------------------
  # Maps JWT claims to the system's UserIR shape.
  # Generator emits one claims["<field>"] extraction per UserIR.fields[i].
  # ---------------------------------------------------------------------------

  defp build_user(claims) do
${buildUserBody}  end
end
`;
}

function renderBuildUser(user: UserIR | undefined): string {
  if (!user || user.fields.length === 0) {
    // No user block declared — emit a minimal passthrough map.
    return `    %{id: claims["id"], permissions: claims["permissions"] || []}\n`;
  }

  const fieldLines = user.fields.map((f: FieldIR) => {
    const key = snake(f.name);
    // Arrays / optional arrays get a fallback default of [].
    const isArray =
      f.type.kind === "array" || (f.type.kind === "optional" && f.type.inner.kind === "array");
    const rhs = isArray ? `claims["${key}"] || []` : `claims["${key}"]`;
    return `      ${key}: ${rhs}`;
  });

  return `    %{\n${fieldLines.join(",\n")}\n    }\n`;
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
