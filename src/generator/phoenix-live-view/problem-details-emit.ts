// Shared ProblemDetails helper module for the generated Phoenix backend.
//
// Activates the dormant `applied` path in the frontend ACL for Phoenix:
// when an Ash code-interface call raises `Ash.Error.Invalid` (the common
// envelope for changeset / action / attribute validation failures), the
// controller's `Plug.ErrorHandler` callback dispatches into the helper
// here, which emits the same RFC 7807 §3.2 `errors[]` extension shape as
// Hono (#782) and .NET (#829).  The frontend ACL's `applyServerErrors`
// works against any of the three backends without per-target code.
//
// One emission per project at `lib/<app>_web/problem_details.ex`.  Both
// the per-aggregate controllers (Plug.ErrorHandler arm) and the workflows
// controller (extended `error_response/2` arm) import it.
//
// See docs/proposals/validation-error-extension.md (Phase C) and
// docs/proposals/frontend-acl.md.

/** Render the shared ProblemDetails helper module.  Emitted once per
 *  project; per-controller code imports the public functions
 *  (`validation_error_response/2`, `problem_response/4`) instead of
 *  building the response inline. */
export function renderProblemDetailsModule(appModule: string): string {
  return `# Auto-generated.  Do not edit by hand.
defmodule ${appModule}Web.ProblemDetails do
  @moduledoc """
  Shared RFC 7807 ProblemDetails responders for the API.

  Two public entry points:
    * \`validation_error_response/2\` — emits 422 with the §3.2 \`errors[]\`
      extension consumed by the frontend ACL's \`applyServerErrors\`.
      Called from each aggregate controller's \`handle_errors/2\` callback
      (Plug.ErrorHandler) when an Ash code-interface call raises
      \`Ash.Error.Invalid\`, and from the workflows controller's
      \`error_response/2\` when a workflow returns an Ash.Error.Invalid
      tuple.
    * \`problem_response/4\` — emits the base ProblemDetails shape (no
      \`errors[]\`) for non-validation faults (DomainException → 400,
      ForbiddenException → 403, AggregateNotFoundError → 404).  Used by
      the per-controller \`error_response/2\` for forbidden / not-found /
      generic domain errors.

  Wire format matches Hono (#782) and .NET (#829) byte-for-byte:
  \`application/problem+json\` content type, \`about:blank\` type,
  \`x-request-id\` trace correlation on the response header (not the
  body), and JSON pointers (RFC 6901) inside the \`errors[]\` extension.
  """

  import Plug.Conn

  @doc \"\"\"
  Send a 422 ProblemDetails response carrying the §3.2 \`errors[]\`
  extension built from an \`Ash.Error.Invalid\` struct's nested errors.

  The frontend ACL's \`applyServerErrors\` reads each \`{ pointer, message }\`
  entry, decodes the JSON pointer to a flat RHF field key, and calls
  \`setError\` so the error renders inline next to the right input.
  \"\"\"
  def validation_error_response(conn, %Ash.Error.Invalid{errors: errors}) do
    do_validation_response(conn, errors)
  end

  def validation_error_response(conn, %{__exception__: true} = err) do
    # Defensive: an Ash error wrapper that isn't \`Ash.Error.Invalid\` still
    # carries a list of inner errors at \`.errors\` in the common case
    # (Ash.Error.Forbidden / Ash.Error.Framework / etc.).  Treat anything
    # with an \`errors\` list as a validation envelope; fall back to a
    # generic 400 otherwise.
    errors = Map.get(err, :errors, []) |> List.wrap()

    if errors == [] do
      problem_response(conn, 400, "Bad Request", Exception.message(err))
    else
      do_validation_response(conn, errors)
    end
  end

  def validation_error_response(conn, errors) when is_list(errors) do
    do_validation_response(conn, errors)
  end

  defp do_validation_response(conn, errors) do
    pointer_errors =
      errors
      |> List.flatten()
      |> Enum.map(&render_error/1)
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

  @doc \"\"\"
  Send a base ProblemDetails response (no \`errors[]\` extension).  Used
  by every non-validation fault arm in the per-controller
  \`error_response/2\` helper.
  \"\"\"
  def problem_response(conn, status, title, detail) do
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
  # Internal helpers — error tree walk + RFC 6901 pointer encoding.
  # ---------------------------------------------------------------------------

  # Render one Ash error struct as a \`%{pointer, message}\` map.  Ash
  # error structs typically carry a \`path\` (list of atoms) and a
  # \`field\` (atom) or \`fields\` (list of atoms) — we concatenate them
  # to form the pointer source list.  Unknown shapes fall through to
  # an empty-path pointer (\`""\` = root error) so the frontend at
  # least gets the message even when the field can't be resolved.
  defp render_error(%{__exception__: true} = err) do
    segments = error_segments(err)
    message = safe_message(err)
    %{pointer: pointer_of(segments), message: message}
  end

  defp render_error(%{message: message} = err) do
    segments = error_segments(err)
    %{pointer: pointer_of(segments), message: message}
  end

  defp render_error(other) do
    %{pointer: "", message: inspect(other)}
  end

  defp error_segments(err) do
    path = err |> Map.get(:path, []) |> List.wrap()
    fields = err |> Map.get(:field) |> List.wrap()
    fields = if fields == [], do: err |> Map.get(:fields, []) |> List.wrap(), else: fields
    path ++ fields
  end

  defp safe_message(err) do
    try do
      Exception.message(err)
    rescue
      _ ->
        Map.get(err, :message, "Validation failed")
    end
  end

  # Build an RFC 6901 JSON pointer from a list of path segments.  Each
  # atom segment is camelCased (matching the JsonCamelCase wire shape
  # the resources emit); each numeric segment is stringified as-is.
  # Inside each segment, RFC 6901 escapes apply (\`~\` → \`~0\`,
  # \`/\` → \`~1\`).  Empty list → empty pointer (root error).
  defp pointer_of([]), do: ""

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

  # snake_case → camelCase (matches \`${appModule}.JasonCamelCase\`'s
  # \`camelize_string/1\`).  Pure-numeric segments stay as-is so array
  # indices like \`/items/0/qty\` round-trip cleanly.
  defp camelize(str) do
    case String.split(str, "_") do
      [head] -> head
      [head | rest] -> head <> Enum.map_join(rest, "", &String.capitalize/1)
    end
  end
end
`;
}
