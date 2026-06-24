// ---------------------------------------------------------------------------
// Vanilla ProblemDetails — `lib/<app>_web/problem_details.ex`.
// Slice 4 of vanilla-foundation-tdd-plan.md (exception-less alignment).
//
// RFC-7807 envelope — `about:blank` type, camelCased JSON pointers in
// `errors[]`, `Validation failed` title, `application/problem+json` content
// type, `x-request-id` header propagation — taking an `Ecto.Changeset` as the
// validation input.  Byte-for-byte identical to the other backends' envelope,
// so the frontend ACL's `applyServerErrors` consumes it identically.
// ---------------------------------------------------------------------------

import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";

export function renderVanillaProblemDetailsModule(appModule: string): string {
  return `# Auto-generated.  Do not edit by hand.
defmodule ${appModule}Web.ProblemDetails do
  @moduledoc """
  Shared RFC 7807 ProblemDetails responders for the Ecto-based
  backend.  Wire format matches the Hono (#782) / .NET (#829)
  backends byte-for-byte:
  \`application/problem+json\` content type, \`about:blank\` type,
  \`x-request-id\` trace correlation on the response header (not in
  the body), and RFC 6901 JSON pointers inside the \`errors[]\`
  extension.

  Three public entry points:

    * \`validation_error_response/2\` — emits 422 with the §3.2
      \`errors[]\` extension built from an \`Ecto.Changeset\` struct's
      \`errors\` map.  The frontend ACL's \`applyServerErrors\`
      decodes each \`{ pointer, message }\` entry to a flat RHF
      field key and calls \`setError\`.

    * \`not_found_response/3\` — 404 ProblemDetails for an absent
      record by id (the most common vanilla error).

    * \`problem_response/4\` — base ProblemDetails shape (no
      \`errors[]\`) for ad-hoc faults (403, 400, etc.).
  """

  import Plug.Conn
  require Logger

  @doc """
  Send a 422 ProblemDetails response carrying the §3.2 \`errors[]\`
  extension built from an \`Ecto.Changeset\` errors map.
  """
  def validation_error_response(conn, %Ecto.Changeset{} = changeset) do
    ${renderPhoenixLogCall("domainError", [
      { name: "message", valueExpr: `"Validation failed"` },
      { name: "status", valueExpr: "422" },
    ])}

    pointer_errors =
      changeset.errors
      |> List.flatten()
      |> Enum.map(&render_changeset_error/1)
      |> Enum.reject(&is_nil/1)

    body =
      Jason.encode!(%{
        type: "about:blank",
        title: "Validation failed",
        status: 422,
        detail: "One or more fields are invalid.",
        instance: conn.request_path,
        errors: pointer_errors
      })

    trace_id = conn |> get_resp_header("x-request-id") |> List.first("")

    conn
    |> put_resp_content_type("application/problem+json")
    |> put_resp_header("x-request-id", trace_id)
    |> send_resp(422, body)
  end

  @doc """
  Send a 404 ProblemDetails response for a missing record.
  """
  def not_found_response(conn, kind, id) do
    problem_response(conn, 404, "Not Found", "#{kind} #{id} not found")
  end

  @doc """
  Send a base ProblemDetails response (no \`errors[]\` extension).
  """
  def problem_response(conn, status, title, detail) do
    # Classify the fault onto the cross-backend catalog event by status, so
    # every fault response (incl. not_found_response/3, which delegates here)
    # surfaces a structured log line matching Hono/.NET/Python. Emitted with
    # each fault's real HTTP status (not normalised).
    case status do
      403 -> ${renderPhoenixLogCall("forbidden", [
        { name: "message", valueExpr: "detail" },
        { name: "status", valueExpr: "status" },
      ])}
      409 -> ${renderPhoenixLogCall("disallowed", [
        { name: "message", valueExpr: "detail" },
        { name: "status", valueExpr: "status" },
      ])}
      404 -> ${renderPhoenixLogCall("notFound", [{ name: "status", valueExpr: "status" }])}
      _ when status >= 500 -> ${renderPhoenixLogCall("internalError", [
        { name: "error", valueExpr: "detail" },
        { name: "status", valueExpr: "status" },
      ])}
      _ -> ${renderPhoenixLogCall("domainError", [
        { name: "message", valueExpr: "detail" },
        { name: "status", valueExpr: "status" },
      ])}
    end

    body =
      Jason.encode!(%{
        type: "about:blank",
        title: title,
        status: status,
        detail: detail,
        instance: conn.request_path
      })

    trace_id = conn |> get_resp_header("x-request-id") |> List.first("")

    conn
    |> put_resp_content_type("application/problem+json")
    |> put_resp_header("x-request-id", trace_id)
    |> send_resp(status, body)
  end

  # ---------------------------------------------------------------------------
  # Internal helpers — Ecto.Changeset error → RFC 6901 pointer + message.
  # ---------------------------------------------------------------------------

  # Ecto.Changeset.errors is a list of \`{field, {message, opts}}\`
  # tuples.  Convert each to the cross-backend \`%{pointer, message}\`
  # map: pointer is "/<camelizedField>", message has the \`%{key}\`
  # placeholders interpolated from \`opts\` (matching the
  # \`Ecto.Changeset.traverse_errors/2\` substitution).
  defp render_changeset_error({field, {msg, opts}}) do
    interpolated =
      Enum.reduce(opts, msg, fn {key, value}, acc ->
        String.replace(acc, "%{#{key}}", to_string(value))
      end)

    %{pointer: pointer_of([field]), message: interpolated}
  end

  defp render_changeset_error(_), do: nil

  # Build an RFC 6901 JSON pointer from a list of path segments.
  # Each atom segment is camelCased (matching the JsonCamelCase wire
  # shape the schemas emit); RFC 6901 escapes apply (\`~\` → \`~0\`,
  # \`/\` → \`~1\`).
  #
  # The only caller passes a one-element list (\`[field]\`), so an empty-list
  # clause would be dead code — Elixir 1.18's compiler flags unreachable
  # clauses, which \`--warnings-as-errors\` rejects.
  defp pointer_of(segments) do
    encoded =
      segments
      |> Enum.map(&segment_to_string/1)
      |> Enum.map(&escape_segment/1)

    "/" <> Enum.join(encoded, "/")
  end

  defp segment_to_string(seg) when is_atom(seg), do: camelize(Atom.to_string(seg))
  defp segment_to_string(seg) when is_integer(seg), do: Integer.to_string(seg)
  defp segment_to_string(seg) when is_binary(seg), do: camelize(seg)
  defp segment_to_string(seg), do: inspect(seg)

  defp escape_segment(seg) do
    seg
    |> String.replace("~", "~0")
    |> String.replace("/", "~1")
  end

  # snake_case → camelCase (byte-for-byte the camelCase key
  # convention every backend's wire JSON uses).
  defp camelize(str) do
    case String.split(str, "_") do
      [head] -> head
      [head | rest] -> head <> Enum.map_join(rest, "", &String.capitalize/1)
    end
  end
end
`;
}
