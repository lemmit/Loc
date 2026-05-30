// Frontend ACL emission — verifies that the React generator writes the
// two shared utility files (`src/lib/strict-field-map.ts` and
// `src/lib/apply-server-errors.ts`) into every generated React project,
// regardless of pack or example.  See docs/proposals/frontend-acl.md
// and docs/plans/frontend-acl-implementation.md (Phase 1, Steps 1.1–1.2).
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
    // 422-gated: we do not consume non-422 errors.
    expect(src).toMatch(/r\?\.status !== 422/);
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
