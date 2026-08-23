import type { ApiRoute } from "../api-emit.js";

// ---------------------------------------------------------------------------
// File upload/download endpoints (M-T1.2 slice 2d) — the app-level HTTP
// `POST /files` + `GET /files/:key` the JSX frontends hit (distinct from the
// HEEx LiveView `allow_upload` channel path).  Root-mounted (`!root:`, not under
// `/api`) to match the frontend api-client (`api.upload("/files")`, the
// `FileRef.url = "/files/<key>"` anchor) and the other backends.  Stores the raw
// bytes via the bound objectStore's `<fn>_put_bytes` / `_get_bytes` adapter.
// ---------------------------------------------------------------------------

/** Emit `lib/<app>_web/controllers/files_controller.ex` and return its two
 *  root-scoped routes.  `resourceModule` is the bound store's helper module
 *  (e.g. `MyApp.Resources.LocalDisk`); `resourceFn` its per-resource verb
 *  prefix (the snake resource name). */
export function emitVanillaFilesController(
  appName: string,
  appModule: string,
  resourceModule: string,
  resourceFn: string,
  out: Map<string, string>,
): ApiRoute[] {
  const webModule = `${appModule}Web`;
  out.set(
    `lib/${appName}_web/controllers/files_controller.ex`,
    `# Auto-generated.
defmodule ${webModule}.FilesController do
  use ${webModule}, :controller

  @moduledoc """
  App-level file upload/download over the bound objectStore (M-T1.2).
  \`POST /files\` stores the uploaded bytes and returns a FileRef; \`GET /files/:key\`
  streams the object back with its stored content-type.
  """

  def upload(conn, %{"file" => %Plug.Upload{path: path, content_type: content_type}}) do
    key = Ecto.UUID.generate()
    body = File.read!(path)
    ct = content_type || "application/octet-stream"
    ${resourceModule}.${resourceFn}_put_bytes(key, body, ct)

    conn
    |> put_status(201)
    |> json(%{
      "url" => "/files/" <> key,
      "key" => key,
      "contentType" => ct,
      "size" => byte_size(body)
    })
  end

  def upload(conn, _params) do
    conn
    |> put_status(400)
    |> json(%{"error" => "expected a 'file' upload"})
  end

  def download(conn, %{"key" => key}) do
    case ${resourceModule}.${resourceFn}_get_bytes(key) do
      {body, content_type} ->
        conn
        |> put_resp_content_type(content_type)
        |> send_resp(200, body)

      nil ->
        # RFC 7807 through the shared responder — this used to answer
        # %{"error" => "not found"} as application/json, a second error contract
        # on a wire already committed to problem+json (and a different one again
        # on each of the other four backends).  The status stays a literal 404:
        # a bucket key is not an aggregate id, so this is not the remappable
        # \`NotFound\` rung.
        ${webModule}.ProblemDetails.problem_response(
          conn,
          404,
          "Not Found",
          "No stored object for that key"
        )
    end
  end
end
`,
  );
  return [
    { method: "post", path: "!root:/files", controller: "FilesController", action: ":upload" },
    {
      method: "get",
      path: "!root:/files/:key",
      controller: "FilesController",
      action: ":download",
    },
  ];
}
