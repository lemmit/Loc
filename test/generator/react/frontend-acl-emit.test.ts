// Frontend ACL emission — verifies that the React generator writes the
// two shared utility files (`src/lib/strict-field-map.ts` and
// `src/lib/apply-server-errors.ts`) into every generated React project,
// regardless of pack or example.  See docs/old/proposals/frontend-acl.md
// and docs/old/plans/frontend-acl-implementation.md (Phase 1, Steps 1.1–1.2).
//
// These files are pack-agnostic — Mantine and shadcn projects must emit
// byte-identical copies — and behaviourally inert in Phase 1 (no
// generated code calls into them yet; Phase 2 wires the form walker's
// catch block through `applyServerErrors`).

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

async function buildAcme(): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, "examples/acme.ddd")),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

describe("frontend ACL shared files — emission", () => {
  it("emits src/lib/strict-field-map.ts into every React deployable", async () => {
    const model = await buildAcme();
    const { files } = generateSystems(model);
    const keys = [...files.keys()];
    const reactRoots = keys
      .filter((k) => k.endsWith("/src/main.tsx"))
      .map((k) => k.slice(0, -"/src/main.tsx".length));
    expect(reactRoots.length).toBeGreaterThan(0);
    for (const root of reactRoots) {
      expect(keys).toContain(`${root}/src/lib/strict-field-map.ts`);
    }
  });

  it("emits src/lib/apply-server-errors.ts into every React deployable", async () => {
    const model = await buildAcme();
    const { files } = generateSystems(model);
    const keys = [...files.keys()];
    const reactRoots = keys
      .filter((k) => k.endsWith("/src/main.tsx"))
      .map((k) => k.slice(0, -"/src/main.tsx".length));
    expect(reactRoots.length).toBeGreaterThan(0);
    for (const root of reactRoots) {
      expect(keys).toContain(`${root}/src/lib/apply-server-errors.ts`);
    }
  });
});

describe("frontend ACL shared files — content", () => {
  it("strict-field-map.ts is type-only (no runtime statements after imports)", async () => {
    const { files } = generateSystems(await buildAcme());
    const mainKey = [...files.keys()].find((k) => k.endsWith("/src/main.tsx"))!;
    const reactRoot = mainKey.slice(0, -"/src/main.tsx".length);
    const src = files.get(`${reactRoot}/src/lib/strict-field-map.ts`)!;
    expect(src).toMatch(/type NestedPaths<T>/);
    expect(src).toMatch(/export type StrictFieldMap<TPayload, TFormState>/);
    // No runtime: no `export function`, no `export const` (the file emits
    // only type aliases — must be fully erased from the bundle).
    expect(src).not.toMatch(/export function/);
    expect(src).not.toMatch(/export const/);
  });

  it("apply-server-errors.ts exports applyServerErrors with the locked signature", async () => {
    const { files } = generateSystems(await buildAcme());
    const mainKey = [...files.keys()].find((k) => k.endsWith("/src/main.tsx"))!;
    const reactRoot = mainKey.slice(0, -"/src/main.tsx".length);
    const src = files.get(`${reactRoot}/src/lib/apply-server-errors.ts`)!;
    // The three outcome variants from the proposal — applied / global / unhandled.
    expect(src).toMatch(/kind:\s*"applied"/);
    expect(src).toMatch(/kind:\s*"global";\s*title:\s*string/);
    expect(src).toMatch(/kind:\s*"unhandled"/);
    // The function itself.
    expect(src).toMatch(/export function applyServerErrors</);
    // Imports the type from the sibling file (relative import, no
    // pack-specific path).
    expect(src).toMatch(/from "\.\/strict-field-map"/);
    // Pulls RHF types only (no value imports — RHF would be a runtime
    // bundle cost we don't need; `Path` etc. are types).
    expect(src).toMatch(
      /import type \{ UseFormSetError, FieldValues, Path \} from "react-hook-form"/,
    );
    // 422-gated: we do not consume non-422 errors.  Reads the ApiError shape
    // the generated client actually throws (`{ status, body }`), not an
    // axios-style `.response` envelope (the bug that left this path dormant).
    expect(src).toMatch(/e\?\.status !== 422/);
    expect(src).not.toContain(".response");
    // The JSON pointer → flat key translator is the linchpin of the ACL.
    expect(src).toMatch(/pointerToFlat/);
  });

  it("apply-server-errors.ts has no toast / notifications / pack-specific calls", async () => {
    // Architectural invariant: the runtime helper is pack-agnostic.
    // Pack-native toast emission happens inline at the form walker's
    // catch block via design-pack templates, NOT inside this helper.
    const { files } = generateSystems(await buildAcme());
    const mainKey = [...files.keys()].find((k) => k.endsWith("/src/main.tsx"))!;
    const reactRoot = mainKey.slice(0, -"/src/main.tsx".length);
    const src = files.get(`${reactRoot}/src/lib/apply-server-errors.ts`)!;
    expect(src).not.toMatch(/notifications\./);
    expect(src).not.toMatch(/\btoast\b/);
    expect(src).not.toMatch(/enqueueSnackbar/);
    expect(src).not.toMatch(/useToast/);
  });
});

describe("frontend ACL — wired into emitted form catch blocks (Phase 2)", () => {
  // Verifies the ACL loop is live in the generated React project — every
  // generated form's submit handler calls applyServerErrors with setError
  // and switches on the outcome.  Independent of fixture snapshots so
  // tightening / refactoring the catch shape can't silently disable the
  // loop.

  it("orders/new.tsx (form-of/create) imports and uses applyServerErrors", async () => {
    const { files } = generateSystems(await buildAcme());
    const mainKey = [...files.keys()].find((k) => k.endsWith("/src/main.tsx"))!;
    const reactRoot = mainKey.slice(0, -"/src/main.tsx".length);
    const src = files.get(`${reactRoot}/src/pages/orders/new.tsx`)!;
    expect(src).toMatch(
      /import \{ applyServerErrors \} from "\.\.\/\.\.\/lib\/apply-server-errors"/,
    );
    expect(src).toMatch(/setError/);
    expect(src).toMatch(
      /applyServerErrors\(\{\s*error:\s*e,\s*setError,\s*fieldMap:\s*\{\}\s*as const\s*\}\)/,
    );
    expect(src).toMatch(/outcome\.kind === "global"/);
    expect(src).toMatch(/outcome\.kind === "unhandled"/);
  });

  it("orders/detail.tsx (form-op/modal) imports and uses applyServerErrors", async () => {
    const { files } = generateSystems(await buildAcme());
    const mainKey = [...files.keys()].find((k) => k.endsWith("/src/main.tsx"))!;
    const reactRoot = mainKey.slice(0, -"/src/main.tsx".length);
    const src = files.get(`${reactRoot}/src/pages/orders/detail.tsx`)!;
    expect(src).toMatch(
      /import \{ applyServerErrors \} from "\.\.\/\.\.\/lib\/apply-server-errors"/,
    );
    // Three op-forms on this page (AddLine + Confirm + crudish `update`) —
    // all should be wired.
    const calls = src.match(/applyServerErrors\(\{/g) ?? [];
    expect(calls.length).toBe(3);
    // setError is destructured from useForm in every op-form component.
    // The destructure can carry a nested `formState: { errors }` (the
    // crudish `update` form does), so match the field list with `[^=]`
    // rather than `[^}]` — `[^}]` stops at the first inner `}` and
    // under-counts forms with nested destructuring.
    const setErrorDestructures = src.match(/\{[^=]*\bsetError\b[^=]*\}\s*=\s*useForm</g) ?? [];
    expect(setErrorDestructures.length).toBe(3);
  });

  it("workflows/place_order.tsx (form-runs) imports and uses applyServerErrors", async () => {
    const { files } = generateSystems(await buildAcme());
    const mainKey = [...files.keys()].find((k) => k.endsWith("/src/main.tsx"))!;
    const reactRoot = mainKey.slice(0, -"/src/main.tsx".length);
    const src = files.get(`${reactRoot}/src/pages/workflows/place_order.tsx`)!;
    expect(src).toMatch(
      /import \{ applyServerErrors \} from "\.\.\/\.\.\/lib\/apply-server-errors"/,
    );
    expect(src).toMatch(/setError/);
    expect(src).toMatch(/applyServerErrors\(\{/);
  });

  it("pack-native toast is preserved for global + unhandled outcomes", async () => {
    // Mantine pack — catch block routes outcome.global to notifications.show
    // with outcome.title, and outcome.unhandled to notifications.show with
    // the raw Error message.  Successful-path notification is untouched.
    const { files } = generateSystems(await buildAcme());
    const mainKey = [...files.keys()].find((k) => k.endsWith("/src/main.tsx"))!;
    const reactRoot = mainKey.slice(0, -"/src/main.tsx".length);
    const src = files.get(`${reactRoot}/src/pages/orders/new.tsx`)!;
    expect(src).toMatch(/notifications\.show\(\{ color: "red", message: outcome\.title \}\)/);
    expect(src).toMatch(
      /notifications\.show\(\{ color: "red", message: \(e as Error\)\.message \}\)/,
    );
    expect(src).toMatch(/notifications\.show\(\{ color: "green", message: "Order created" \}\)/);
  });
});

// ---------------------------------------------------------------------------
// Behavioural test for the emitted applyServerErrors runtime.
//
// Static text assertions above prove the function is emitted with the right
// SHAPE. This block transpiles the emitted source and EXECUTES it against
// synthetic ProblemDetails / network-error inputs, proving the loop's
// actual semantics — pointer→flat key translation, setError dispatch,
// outcome branching, fallback behaviour for non-422 errors.
// ---------------------------------------------------------------------------

import ts from "typescript";

interface SetErrorCall {
  field: string;
  options: { type: string; message: string };
}

/** Transpile the emitted apply-server-errors.ts to JS (strip types,
 *  drop type-only imports) and return the live applyServerErrors
 *  function.  Tied to the generated source — any drift in the
 *  emitted text that breaks transpilation or invocation surfaces
 *  here as a test failure. */
function loadApplyServerErrors(
  src: string,
): (args: {
  error: unknown;
  setError: (field: string, options: { type: string; message: string }) => void;
  fieldMap: Record<string, string>;
}) => { kind: "applied" } | { kind: "global"; title: string } | { kind: "unhandled" } {
  // Strip the `import type { … } from "react-hook-form";` line — it's
  // type-only and would fail to resolve in a vm context.  TypeScript's
  // transpiler also elides import-types, so removing manually is a
  // belt-and-braces guard.
  const trimmed = src.replace(/import type[\s\S]*?from\s*"react-hook-form";\s*\n/g, "");
  const js = ts.transpileModule(trimmed, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;

  // Eval the CJS-shaped output in a function that closes over `exports`
  // and `module`, returning the named binding.  No real require shim
  // needed — the source has no value-imports after the type-strip.
  const factory = new Function("exports", "module", `${js}\nreturn exports.applyServerErrors;`);
  const mod = { exports: {} as Record<string, unknown> };
  return factory(mod.exports, mod) as never;
}

function readApplyServerErrorsSrc(files: Map<string, string>): string {
  const mainKey = [...files.keys()].find((k) => k.endsWith("/src/main.tsx"))!;
  const reactRoot = mainKey.slice(0, -"/src/main.tsx".length);
  return files.get(`${reactRoot}/src/lib/apply-server-errors.ts`)!;
}

describe("applyServerErrors — runtime behaviour against synthetic inputs", () => {
  it("returns { kind: 'applied' } and dispatches setError per pointer for a 422 with errors[]", async () => {
    const { files } = generateSystems(await buildAcme());
    const fn = loadApplyServerErrors(readApplyServerErrorsSrc(files));

    const calls: SetErrorCall[] = [];
    const setError = (field: string, options: { type: string; message: string }): void => {
      calls.push({ field, options });
    };

    const outcome = fn({
      error: {
        status: 422,
        body: {
          errors: [
            { pointer: "/price/amount", message: "must be positive" },
            { pointer: "/name", message: "too short" },
          ],
        },
      },
      setError,
      fieldMap: {},
    });

    expect(outcome).toEqual({ kind: "applied" });
    expect(calls).toEqual([
      { field: "price.amount", options: { type: "server", message: "must be positive" } },
      { field: "name", options: { type: "server", message: "too short" } },
    ]);
  });

  it("routes pointers through the fieldMap when explicit mapping exists", async () => {
    // When the wire pointer ('/price.amount' rooted differently) doesn't
    // match the form-state key directly, the FieldMap is the lookup
    // table.  This proves the indirection is wired correctly even
    // though Phase 2's MVP uses an identity (empty) map.
    const { files } = generateSystems(await buildAcme());
    const fn = loadApplyServerErrors(readApplyServerErrorsSrc(files));

    const calls: SetErrorCall[] = [];
    const setError = (field: string, options: { type: string; message: string }): void => {
      calls.push({ field, options });
    };

    fn({
      error: {
        status: 422,
        body: { errors: [{ pointer: "/price/amount", message: "bad" }] },
      },
      setError,
      fieldMap: { "price.amount": "priceAmountFlat" },
    });

    expect(calls).toEqual([
      { field: "priceAmountFlat", options: { type: "server", message: "bad" } },
    ]);
  });

  it("returns { kind: 'global', title } when 422 has a title but no errors[]", async () => {
    const { files } = generateSystems(await buildAcme());
    const fn = loadApplyServerErrors(readApplyServerErrorsSrc(files));
    const calls: SetErrorCall[] = [];

    const outcome = fn({
      error: {
        status: 422,
        body: { title: "Inventory conflict — please retry" },
      },
      setError: (field, options) => calls.push({ field, options }),
      fieldMap: {},
    });

    expect(outcome).toEqual({ kind: "global", title: "Inventory conflict — please retry" });
    expect(calls).toEqual([]);
  });

  it("returns { kind: 'unhandled' } for non-422 status (e.g. 500)", async () => {
    const { files } = generateSystems(await buildAcme());
    const fn = loadApplyServerErrors(readApplyServerErrorsSrc(files));
    const calls: SetErrorCall[] = [];

    const outcome = fn({
      error: { status: 500, body: { title: "Internal Server Error" } },
      setError: (field, options) => calls.push({ field, options }),
      fieldMap: {},
    });

    expect(outcome).toEqual({ kind: "unhandled" });
    expect(calls).toEqual([]);
  });

  it("returns { kind: 'unhandled' } for network failure (no response object)", async () => {
    const { files } = generateSystems(await buildAcme());
    const fn = loadApplyServerErrors(readApplyServerErrorsSrc(files));
    const calls: SetErrorCall[] = [];

    const outcome = fn({
      error: new Error("Network timeout"),
      setError: (field, options) => calls.push({ field, options }),
      fieldMap: {},
    });

    expect(outcome).toEqual({ kind: "unhandled" });
    expect(calls).toEqual([]);
  });

  it("decodes URI-encoded JSON pointer segments correctly", async () => {
    // RFC 6901 percent-escaping inside pointer segments — `/foo%2Fbar`
    // should decode to the flat key `foo/bar`.  Edge case but cheap to
    // assert; protects against pointer-to-flat regressions.
    const { files } = generateSystems(await buildAcme());
    const fn = loadApplyServerErrors(readApplyServerErrorsSrc(files));
    const calls: SetErrorCall[] = [];

    fn({
      error: {
        status: 422,
        body: { errors: [{ pointer: "/foo%2Fbar", message: "x" }] },
      },
      setError: (field, options) => calls.push({ field, options }),
      fieldMap: {},
    });

    expect(calls[0].field).toBe("foo/bar");
  });

  it("falls back to flat pointer when no fieldMap match (identity behaviour)", async () => {
    // The Phase 2 MVP relies on this: empty fieldMap means every
    // pointer routes to itself (after the flatten transform).  Without
    // this fallback, every form would need a populated fieldMap to do
    // anything at all.
    const { files } = generateSystems(await buildAcme());
    const fn = loadApplyServerErrors(readApplyServerErrorsSrc(files));
    const calls: SetErrorCall[] = [];

    fn({
      error: {
        status: 422,
        body: { errors: [{ pointer: "/customerId", message: "x" }] },
      },
      setError: (field, options) => calls.push({ field, options }),
      fieldMap: {},
    });

    expect(calls[0].field).toBe("customerId");
  });
});
