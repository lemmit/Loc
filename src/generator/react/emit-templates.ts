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
 * Wire schema for the \`money\` primitive.
 *
 * Inbound JSON: a decimal-formatted string (\`"123.4500"\`).  Parses
 * to a \`decimal.js\` Decimal instance.  Format violations and parse
 * failures both surface as typed Zod issues — invalid input becomes
 * a form-level error attached to the field, not an uncaught throw.
 */
export const moneySchema = z.string().transform((s, ctx) => {
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
// Frontend ACL shared utilities — see docs/proposals/frontend-acl.md.
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
// See docs/proposals/frontend-acl.md.

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
 * docs/proposals/exception-less.md).  Called from the form walker's
 * generated catch block.  Returns an outcome so the caller switches
 * inline on global / unhandled paths (pack-native toast emitted by
 * the design pack template).  Pure logic, no pack specifics.
 */
export const REACT_LIB_APPLY_SERVER_ERRORS_TS = `// Auto-generated.  Do not edit by hand.
// See docs/proposals/frontend-acl.md.

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
  const r = (error as { response?: { status?: number; data?: ProblemDetails } }).response;
  if (r?.status !== 422 || !r.data) return { kind: "unhandled" };

  const pd = r.data;
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

export const E2E_FIXTURES_TS = `// Auto-generated.
import { test as base, expect } from "@playwright/test";

// biome-ignore lint/suspicious/noConfusingVoidType: Playwright fixtures use \`void\` to mean "no value".
export const test = base.extend<{ _consoleCapture: void }>({
  _consoleCapture: [
    async ({ page }, use, testInfo) => {
      const lines: string[] = [];
      page.on("console", (msg) => lines.push(\`[\${msg.type()}] \${msg.text()}\`));
      page.on("pageerror", (err) =>
        lines.push(\`[pageerror] \${err.stack ?? err.message}\`),
      );
      await use();
      if (testInfo.status !== testInfo.expectedStatus && lines.length > 0) {
        await testInfo.attach("console-logs", {
          body: lines.join("\\n"),
          contentType: "text/plain",
        });
      }
    },
    { auto: true },
  ],
});

export { expect };
`;

export const PLAYWRIGHT_CONFIG_TS = `// Auto-generated.
import { defineConfig, devices } from "@playwright/test";

// Tests target a running web_app — typically the docker-compose
// service on port 3001.  Override via E2E_BASE_URL.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\\.spec\\.ts$/,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3001",
    // Keep the full trace (console + network + DOM snapshots) and a
    // screenshot on every failure so a red test is debuggable from the
    // report alone, alongside the console-logs attachment from fixtures.ts.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
`;

// The Playwright suite has its own package.json so the runtime image
// builds fast (no @playwright/test in the production install).  Run
// it from inside ./e2e with `npm install && npx playwright test`.
export const E2E_PACKAGE_JSON =
  JSON.stringify(
    {
      name: "loom-react-app-e2e",
      version: "0.0.0",
      type: "module",
      private: true,
      scripts: {
        test: "playwright test",
        "test:install": "playwright install --with-deps chromium",
      },
      devDependencies: {
        "@playwright/test": "^1.49.0",
        "@types/node": "^22.0.0",
        typescript: "^5.7.0",
      },
    },
    null,
    2,
  ) + "\n";

export const E2E_TSCONFIG_JSON =
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ["node"],
      },
      include: ["**/*.ts", "../src/api/**/*.ts"],
    },
    null,
    2,
  ) + "\n";
