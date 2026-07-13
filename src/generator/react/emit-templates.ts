// ---------------------------------------------------------------------------
// Static emitted-source constants for generated React projects — the
// pack-agnostic files written verbatim into every project (src/lib
// frontend-ACL helpers + money schema, and the Playwright e2e harness).
// Extracted from index.ts so the orchestrator stays focused on assembly.
// ---------------------------------------------------------------------------

// Playwright fixture: auto-capture the browser console + uncaught page
// errors and, when a test does not pass, attach them to the report so a
// failure carries the app's own output (not just a screenshot).  Generated
// specs import { test, expect } from "./fixtures" instead of from
// "@playwright/test" so every test gets this for free.
// Shared `moneySchema` helper for React projects — emitted to
// `src/lib/schemas.ts` whenever the served deployable touches money.
// Single canonical wire-shape transform: parses a decimal-formatted
// string to a `decimal.js` Decimal instance and surfaces format /
// parse failures as typed Zod issues so client-side form validation
// reports a structured error rather than throwing an uncaught
// DecimalError.
export const REACT_LIB_SCHEMAS_MONEY_TS = `// Auto-generated.  Do not edit by hand.
import Decimal from "decimal.js";
import { z } from "zod";

/**
 * Schema for the \`money\` primitive, on both of its inbound shapes:
 *
 *   - Wire JSON: a decimal-formatted string (\`"123.4500"\`) — parsed
 *     to a \`decimal.js\` Decimal instance.
 *   - Form state: an already-constructed Decimal — the money input
 *     control converts on change, so the zod resolver sees the
 *     instance, not a string.  Passed through unchanged.
 *
 * Format violations and parse failures both surface as typed Zod
 * issues — invalid input becomes a form-level error attached to the
 * field, not an uncaught throw.
 */
export const moneySchema = z.union([z.instanceof(Decimal), z.string()]).transform((s, ctx) => {
  if (s instanceof Decimal) return s;
  if (!/^-?\\d+(\\.\\d+)?$/.test(s)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: \`Invalid decimal: \${JSON.stringify(s)}\`,
    });
    return z.NEVER;
  }
  try {
    return new Decimal(s);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: \`Invalid decimal: \${JSON.stringify(s)}\`,
    });
    return z.NEVER;
  }
});
`;

// =============================================================================
// Frontend ACL shared utilities — see docs/old/proposals/frontend-acl.md.
//
// Both files are pack-agnostic and emitted into every React project under
// src/lib/.  Per-action FieldMap *instances* are NOT emitted here — they
// live next to their action's schema (currently inside src/api/<agg>.ts,
// or src/lib/schemas/<action>.schema.ts after a future schema split).
// =============================================================================

/**
 * Compile-time type machinery — erased from the runtime bundle.  Pinned
 * to every per-action FieldMap via a `satisfies StrictFieldMap<...>`
 * clause so wire-shape drift surfaces as a TSC error at the schema
 * file, not as a silent error-misrouting at runtime.
 */
export const REACT_LIB_STRICT_FIELD_MAP_TS = `// Auto-generated.  Do not edit by hand.
// See docs/old/proposals/frontend-acl.md.

type NestedPaths<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends object
        ? \`\${K}.\${NestedPaths<T[K]>}\`
        : \`\${K}\`;
    }[keyof T & string]
  : never;

/**
 * Strict bidirectional pin between a payload's nested shape and a form
 * state's flat key set.  Keys MUST be valid dot-notation leaf paths of
 * the payload; values MUST be valid keys of the form state.  Used as a
 * \`satisfies\` constraint on per-action FieldMap constants.
 */
export type StrictFieldMap<TPayload, TFormState> = {
  readonly [K in NestedPaths<TPayload>]?: keyof TFormState & string;
};
`;

/**
 * Runtime decoder for ProblemDetails 422 responses (per
 * docs/old/proposals/exception-less.md).  Called from the form walker's
 * generated catch block.  Returns an outcome so the caller switches
 * inline on global / unhandled paths (pack-native toast emitted by
 * the design pack template).  Pure logic, no pack specifics.
 */
export const REACT_LIB_APPLY_SERVER_ERRORS_TS = `// Auto-generated.  Do not edit by hand.
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
  // The generated API client throws an \`ApiError\` carrying \`status\` and the
  // parsed \`body\` (an RFC 7807 ProblemDetails on a 422).  Read that shape
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
`;

// The Playwright e2e harness scaffolding (fixtures / config /
// package.json / tsconfig) moved to
// `src/generator/_frontend/e2e-harness.ts` — shared with the Svelte
// frontend.  Re-exported so react + system consumers keep this path.
export {
  E2E_FIXTURES_TS,
  E2E_PACKAGE_JSON,
  E2E_TSCONFIG_JSON,
  PLAYWRIGHT_CONFIG_TS,
} from "../_frontend/e2e-harness.js";
