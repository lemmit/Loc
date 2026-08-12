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

import { problemTitle } from "../../../ir/util/openapi-errors.js";
import { errorTitle } from "../../../util/error-defaults.js";
import { renderPhoenixDomainFault, renderPhoenixLogCall } from "../../_obs/render-phoenix.js";

export function renderVanillaProblemDetailsModule(
  appModule: string,
  hasUniqueKeys = false,
  hasVersioned = false,
  /** Resolved HTTP status for the `unique (...)` breach (`UniquenessConflict`)
   *  and the optimistic-/event-store concurrency conflict (`ConcurrencyConflict`)
   *  — 409 by default, or the api's `httpStatus <Conflict> -> <Code>` override
   *  (M-T3.4a).  Baked into the emitted responders so the runtime status moves
   *  in lockstep with the OpenAPI declaration.  Both default to 409, so an
   *  override-free app stays byte-identical. */
  uniquenessStatus = 409,
  concurrencyStatus = 409,
  /** Resolved HTTP status for the `NotFound` rung — 404 by default, or the api's
   *  `httpStatus NotFound -> <Code>` override (M-T5.20).  `not_found_response/3`
   *  is the SHARED 404 responder every controller delegates to, so resolving it
   *  here is what stops a remap from moving the per-controller arms while this
   *  one stayed a literal. */
  notFoundStatus = 404,
  /** Resolved statuses for the remaining rungs that reach `problem_response/4`
   *  — the `requires` authorization gate (`Forbidden`, 403 by default), the
   *  `when` state gate (`Disallowed`, 409) and the FK-restrict destroy
   *  (`ReferencedInUse`, 409).  They are not written into a response body here;
   *  they key the CATALOG-EVENT classifier below, which used to be a literal
   *  `case status do 403 … 409 … 404` and therefore silently reclassified every
   *  remapped rung as `domain_error` (M-T9.25 round 2, probe 1).  Defaults
   *  reproduce the literal arms exactly ⇒ byte-identical. */
  forbiddenStatus = 403,
  disallowedStatus = 409,
  referencedInUseStatus = 409,
  /** True when this project ships a `priv/gettext` catalog carrying its authored
   *  validation messages (M-T1.11) — a changeset error's `loom_code` then
   *  resolves through gettext for the request locale.  False ⇒ byte-identical to
   *  pre-catalog output. */
  localizeMessages = false,
): string {
  // Optimistic-concurrency 409 (`versioned` capability, D-VERSIONED).  A stale
  // write raises `Ecto.StaleEntryError`, which the repository rescues into
  // `{:error, :conflict}`; the controller maps that onto this responder.  It
  // logs the DISTINCT `conflict` catalog event (not `disallowed`, which the
  // `unique (...)` 409 uses via `problem_response/4`) so a dashboard can tell a
  // concurrency conflict from a business-rule refusal.  Gated on `hasVersioned`
  // so a version-free app is byte-identical (strict additivity).
  // Server-side message localization (M-T1.11).  Phoenix is one of the two
  // backends whose ECOSYSTEM already owns this, so nothing is hand-rolled: the
  // catalog is the same real `priv/gettext` tree the HEEx frontend translates
  // through, and the resolution is gettext's.
  //
  // `pgettext` reconciles the two key models exactly as it does on the frontend
  // half (see `elixir/i18n.ts`): the Loom content-hash code is the msgctxt and
  // the authored English the msgid.  gettext's own "an empty translation renders
  // the msgid" rule IS the fallback, so an untranslated locale returns the
  // authored text with no branch here.
  //
  // The RUNTIME `Gettext.pgettext/4` rather than the same-named MACRO: the
  // msgctxt arrives as a changeset-error metadata value, and the macros require
  // compile-time literals (they are what `mix gettext.extract` reads — the `.pot`
  // this project ships is generated instead).
  const localizeFn = localizeMessages
    ? `

  # Resolve a messaged rule's stable wire code (M-T1.11) against this project's
  # gettext catalog for the request locale, falling back to the authored text.
  defp localize(nil, message), do: message

  defp localize(code, message) do
    Gettext.with_locale(gettext_locale(), fn ->
      Gettext.pgettext(${appModule}Web.Gettext, code, message)
    end)
  end

  # The ambient request locale carries the Accept-Language header VERBATIM
  # (D-CTX-SHAPE — it is the request-stable input, not a catalog-shaped one), so
  # the normalisation to a lookup tag lives here: the first listed language,
  # without its \`;q=\` weight.  An unknown tag is not an error for gettext —
  # it has no translations, so the msgid (the authored English) is returned.
  defp gettext_locale do
    tag =
      ${appModule}.RequestContext.locale()
      |> String.split(",")
      |> List.first("")
      |> String.split(";")
      |> List.first("")
      |> String.trim()
      |> String.downcase()

    if tag == "", do: "en", else: tag
  end`
    : "";
  const conflictFn = hasVersioned
    ? `

  @doc """
  Send a 409 ProblemDetails response for an optimistic-concurrency conflict — a
  \`versioned\` aggregate whose \`optimistic_lock\` guard found the row changed
  since the client read it (\`Ecto.StaleEntryError\`, rescued to
  \`{:error, :conflict}\`).  Logs the \`conflict\` catalog event, distinct from
  the \`unique (...)\` 409 (which logs \`disallowed\` via \`problem_response/4\`).
  """
  def conflict_response(conn) do
    ${renderPhoenixLogCall("conflict", [
      {
        name: "message",
        valueExpr: `"The resource was modified by another request; reload and retry."`,
      },
      { name: "status", valueExpr: `${concurrencyStatus}` },
    ])}
    ${renderPhoenixDomainFault("conflict")}

    body =
      Jason.encode!(%{
        type: "about:blank",
        title: ${JSON.stringify(problemTitle(concurrencyStatus))},
        status: ${concurrencyStatus},
        detail: "The resource was modified by another request; reload and retry.",
        instance: conn.request_path
      })

    trace_id = conn |> get_resp_header("x-request-id") |> List.first("")

    conn
    |> put_resp_content_type("application/problem+json")
    |> put_resp_header("x-request-id", trace_id)
    |> send_resp(${concurrencyStatus}, body)
  end`
    : "";
  // The catalog-event classifier inside `problem_response/4`.  It keys on the
  // RESOLVED rung statuses, not on literal 403/409/404: `problem_response/4` is
  // the shared responder every denial rung funnels through, so a literal `409 ->
  // disallowed` arm reclassified EVERY remapped conflict as `domain_error` while
  // the response body itself moved correctly — the observability half of the
  // rung silently disagreeing with its own wire half, inside one backend.
  //
  // Two rungs can legitimately resolve to the SAME code (they all default to
  // 409), and a duplicate `case` clause is an unreachable-clause warning that
  // `--warnings-as-errors` rejects, so the arms are deduped FIRST-WINS in the
  // declaration order below.  With no override that collapses to exactly the
  // three literal arms this replaced (403 / 409 / 404), in that order ⇒
  // byte-identical.
  const forbiddenArm = `${renderPhoenixLogCall("forbidden", [
    { name: "message", valueExpr: "detail" },
    { name: "status", valueExpr: "status" },
  ])}
        ${renderPhoenixDomainFault("forbidden")}`;
  const disallowedArm = `${renderPhoenixLogCall("disallowed", [
    { name: "message", valueExpr: "detail" },
    { name: "status", valueExpr: "status" },
  ])}
        ${renderPhoenixDomainFault("disallowed")}`;
  const notFoundArm = `${renderPhoenixLogCall("notFound", [
    { name: "status", valueExpr: "status" },
  ])}
        ${renderPhoenixDomainFault("not_found")}`;
  const seenStatuses = new Set<number>();
  const classifyArms = (
    [
      [forbiddenStatus, forbiddenArm],
      // `Disallowed`, `UniquenessConflict` and `ReferencedInUse` all classify as
      // the `disallowed` catalog event — matching the four non-elixir backends,
      // which choose the event at the THROW site (by exception class) and are
      // therefore immune to a status remap by construction.
      [disallowedStatus, disallowedArm],
      [uniquenessStatus, disallowedArm],
      [referencedInUseStatus, disallowedArm],
      [notFoundStatus, notFoundArm],
    ] as const
  )
    .filter(([status]) => {
      if (seenStatuses.has(status)) return false;
      seenStatuses.add(status);
      return true;
    })
    .map(([status, arm]) => `      ${status} ->\n        ${arm}\n`)
    .join("\n");
  const log422 = renderPhoenixLogCall("domainError", [
    { name: "message", valueExpr: `"Validation failed"` },
    { name: "status", valueExpr: "422" },
  ]);
  // The 422 body — shared by the plain (no-`unique`) and the unique-aware forms.
  const body422 = `    ${log422}
    ${renderPhoenixDomainFault("domain_error")}

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
    |> send_resp(422, body)`;
  // A `unique (...)` breach surfaces as a changeset `constraint: :unique` error
  // (Ecto.Changeset.unique_constraint/3), which is a CONFLICT (409), not a 422.
  // Only emit that branch when the app declares a `unique` key, so a unique-free
  // app is byte-identical (strict additivity).
  const conflictDoc = hasUniqueKeys
    ? `

  A changeset carrying a \`unique_constraint\` error (a breached \`unique (...)\`
  domain invariant — the DB unique index raised 23505, which
  \`Ecto.Changeset.unique_constraint/3\` converted into a changeset error tagged
  \`constraint: :unique\`) is a CONFLICT, not a validation failure: it responds
  409 instead of 422 (cross-backend parity with the Hono 23505 → 409 mapping).`
    : "";
  const responseFns = hasUniqueKeys
    ? `  def validation_error_response(conn, %Ecto.Changeset{} = changeset) do
    if unique_conflict?(changeset) do
      problem_response(
        conn,
        ${uniquenessStatus},
        ${JSON.stringify(problemTitle(uniquenessStatus))},
        "A record with these values already exists."
      )
    else
      validation_failed_response(conn, changeset)
    end
  end

  # A unique-constraint violation surfaces as a changeset error whose opts carry
  # \`constraint: :unique\` (added by \`Ecto.Changeset.unique_constraint/3\` when the
  # DB reports 23505).  Validation errors never carry that tag, so its presence
  # unambiguously distinguishes a 409 Conflict from a 422 validation failure.
  defp unique_conflict?(%Ecto.Changeset{errors: errors}) do
    Enum.any?(errors, fn
      {_field, {_msg, opts}} -> Keyword.get(opts, :constraint) == :unique
      _ -> false
    end)
  end

  defp validation_failed_response(conn, %Ecto.Changeset{} = changeset) do
${body422}
  end`
    : `  def validation_error_response(conn, %Ecto.Changeset{} = changeset) do
${body422}
  end`;
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
  extension built from an \`Ecto.Changeset\` errors map.${conflictDoc}
  """
${responseFns}

  @doc """
  Send a 404 ProblemDetails response for a missing record.
  """
  def not_found_response(conn, kind, id) do
    problem_response(conn, ${notFoundStatus}, ${JSON.stringify(errorTitle("NotFound"))}, "#{kind} #{id} not found")
  end

  @doc """
  Send a base ProblemDetails response (no \`errors[]\` extension).
  """
  def problem_response(conn, status, title, detail) do
    # Classify the fault onto the cross-backend catalog event by status, so
    # every fault response (incl. not_found_response/3, which delegates here)
    # surfaces a structured log line matching Hono/.NET/Python. Emitted with
    # each fault's real HTTP status (not normalised).
    # Each fault also feeds domain_faults_total{kind} (via [:loom, :domain, :fault]),
    # except a >=500 internal_error — that's infrastructure, not a domain fault.
    case status do
${classifyArms}
      _ when status >= 500 ->
        ${renderPhoenixLogCall("internalError", [
          { name: "error", valueExpr: "detail" },
          { name: "status", valueExpr: "status" },
        ])}

      _ ->
        ${renderPhoenixLogCall("domainError", [
          { name: "message", valueExpr: "detail" },
          { name: "status", valueExpr: "status" },
        ])}
        ${renderPhoenixDomainFault("domain_error")}
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
  end${conflictFn}

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
        String.replace(acc, "%{#{key}}", error_opt_to_string(value))
      end)

    base = %{pointer: pointer_of([field]), message: ${
      localizeMessages ? "localize(Keyword.get(opts, :loom_code), interpolated)" : "interpolated"
    }}

    # A messaged rule carries a "loom_code" metadata key (the stable
    # content-hash wire code / i18n key) on the changeset error; a message-less
    # rule has none, so the code field is omitted (byte-identical body).
    case Keyword.get(opts, :loom_code) do
      nil -> base
      code -> Map.put(base, :code, code)
    end
  end

  defp render_changeset_error(_), do: nil${localizeFn}

  # Interpolate an Ecto error opt value into the message.  Enum.reduce above
  # evaluates this for EVERY opt (even ones whose placeholder isn't in the
  # message), and a cast/cast_assoc failure carries composite-type opts
  # (type: {:array, :string}, type: {:parameterized, ...}) that don't implement
  # String.Chars — a bare to_string/1 on the tuple raises Protocol.UndefinedError,
  # turning a 422 into a 500.  Stringify binaries / atoms / numbers directly;
  # inspect anything else.
  defp error_opt_to_string(value) when is_binary(value), do: value
  defp error_opt_to_string(value) when is_atom(value) or is_number(value), do: to_string(value)
  defp error_opt_to_string(value), do: inspect(value)

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
