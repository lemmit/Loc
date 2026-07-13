// Auto-generated.  Do not edit by hand.
// See docs/old/proposals/frontend-acl.md.

import type { UseFormSetError, FieldValues, Path } from "react-hook-form";
import type { StrictFieldMap } from "./strict-field-map";

interface ProblemDetails {
  title?: string;
  errors?: { pointer: string; message: string }[];
}

export interface ApplyServerErrorsArgs<TPayload, TFormState extends FieldValues> {
  readonly error: unknown;
  readonly setError: UseFormSetError<TFormState>;
  readonly fieldMap: StrictFieldMap<TPayload, TFormState>;
}

export type ServerErrorOutcome =
  | { kind: "applied" }
  | { kind: "global"; title: string }
  | { kind: "unhandled" };

export function applyServerErrors<TPayload, TFormState extends FieldValues>({
  error,
  setError,
  fieldMap,
}: ApplyServerErrorsArgs<TPayload, TFormState>): ServerErrorOutcome {
  // The generated API client throws an `ApiError` carrying `status` and the
  // parsed `body` (an RFC 7807 ProblemDetails on a 422).  Read that shape
  // structurally (no import coupling to the client module).
  const e = error as { status?: number; body?: ProblemDetails };
  if (e?.status !== 422 || !e.body) return { kind: "unhandled" };

  const pd = e.body;
  if (Array.isArray(pd.errors) && pd.errors.length > 0) {
    for (const { pointer, message } of pd.errors) {
      const flatKey = pointerToFlat(pointer);
      const target = (fieldMap as Record<string, string | undefined>)[flatKey] ?? flatKey;
      setError(target as Path<TFormState>, { type: "server", message });
    }
    return { kind: "applied" };
  }
  return pd.title ? { kind: "global", title: pd.title } : { kind: "unhandled" };
}

const pointerToFlat = (p: string) =>
  p.startsWith("/") ? p.slice(1).split("/").map(decodeURIComponent).join(".") : p;
