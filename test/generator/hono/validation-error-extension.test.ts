// Hono backend — validation-error extension emission.
//
// Verifies that the Hono backend emits the RFC 7807 §3.2 `errors[]`
// extension shape consumed by the frontend ACL's `applyServerErrors`
// (see docs/old/proposals/frontend-acl.md +
// docs/old/proposals/validation-error-extension.md).
//
// What this protects (Phase A — runtime only):
//  - A single shared `http/problem-details.ts` module is emitted (not
//    duplicated per router file).
//  - Per-router files import `ProblemDetails` + `newApp` from it; the
//    inline ProblemDetails Zod schema is gone.
//  - `new OpenAPIHono()` is replaced with `newApp()` so the validation
//    `defaultHook` is wired into every router.
//  - The hook source itself contains the locked invariants the frontend
//    ACL relies on: 422 status, JSON pointer encoding, RFC 6901 segment
//    escapes, `application/problem+json` content type, `errors[]` array
//    in the response body.
//
// What is intentionally NOT asserted here (deferred to Phase B+C of
// validation-error-extension.md when .NET + Phoenix catch up):
//  - The §3.2 `errors[]` extension as a declared field on the OpenAPI
//    `ProblemDetails` component schema.
//  - The `422` HTTP code on OpenAPI route response declarations.
//
// Both are deferred so the cross-backend OpenAPI parity gate
// (`test/_helpers/openapi-normalize.ts`) keeps `fieldSet("ProblemDetails")`
// + per-operation `errorResponses()` byte-equal across all three
// backends.  The runtime body Hono emits is more specific than its
// OpenAPI schema admits; the frontend ACL reads the body directly and
// gets the extension without an OpenAPI declaration.
//
// Behavioural correctness of the runtime hook itself (decoding a
// ZodError into the wire shape) lives in the Hono runtime test suite;
// here we assert the emitted source is structurally correct.

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

function honoRootOf(files: Map<string, string>): string {
  const indexKey = [...files.keys()].find((k) => k.endsWith("/http/index.ts"))!;
  return indexKey.slice(0, -"/http/index.ts".length);
}

describe("Hono validation-error extension — emission", () => {
  it("emits http/problem-details.ts once per Hono deployable", async () => {
    const { files } = generateSystems(await buildAcme());
    const indexKeys = [...files.keys()].filter((k) => k.endsWith("/http/index.ts"));
    expect(indexKeys.length).toBeGreaterThan(0);
    for (const indexKey of indexKeys) {
      const root = indexKey.slice(0, -"/http/index.ts".length);
      expect(files.has(`${root}/http/problem-details.ts`)).toBe(true);
    }
  });

  it("problem-details.ts exports ProblemDetails with the 5 base RFC 7807 fields", async () => {
    const { files } = generateSystems(await buildAcme());
    const root = honoRootOf(files);
    const src = files.get(`${root}/http/problem-details.ts`)!;
    // Base ProblemDetails fields per RFC 7807.
    expect(src).toMatch(/type:\s*z\.string\(\)\.nullish\(\)/);
    expect(src).toMatch(/title:\s*z\.string\(\)\.nullish\(\)/);
    expect(src).toMatch(/status:\s*z\.number\(\)\.int\(\)\.nullish\(\)/);
    expect(src).toMatch(/detail:\s*z\.string\(\)\.nullish\(\)/);
    expect(src).toMatch(/instance:\s*z\.string\(\)\.nullish\(\)/);
    // Registered under the OpenAPI component name "ProblemDetails" so
    // cross-backend parity diffs stay stable.
    expect(src).toMatch(/\.openapi\("ProblemDetails"\)/);
    // §3.2 errors[] extension is now declared on the OpenAPI component
    // schema (Phase D — all three backends move in lockstep so the
    // cross-backend parity gate stays green).  See
    // docs/old/proposals/validation-error-extension.md.
    expect(src).toMatch(
      /errors:\s*z\.array\(z\.object\(\{\s*pointer:\s*z\.string\(\),\s*message:\s*z\.string\(\)\s*\}\)\)\.nullish\(\)/,
    );
  });

  it("problem-details.ts implements the validation defaultHook with RFC 6901 pointers", async () => {
    const { files } = generateSystems(await buildAcme());
    const root = honoRootOf(files);
    const src = files.get(`${root}/http/problem-details.ts`)!;
    // The hook returns 422 (RFC 7807 standard for input validation).
    expect(src).toMatch(/422/);
    expect(src).toMatch(/"Validation failed"/);
    // Body wire format pinned: about:blank type, application/problem+json content.
    expect(src).toMatch(/"about:blank"/);
    expect(src).toMatch(/"application\/problem\+json"/);
    // x-request-id correlation header.
    expect(src).toMatch(/"x-request-id":\s*trace_id/);
    // RFC 6901 segment escaping — `~` → `~0`, `/` → `~1`.
    expect(src).toMatch(/replace\(\/~\/g,\s*"~0"\)/);
    expect(src).toMatch(/replace\(\/\\\/\/g,\s*"~1"\)/);
    // Empty-path → empty pointer (root error per RFC 6901).
    expect(src).toMatch(/path\.length === 0/);
    // String path segments are escaped; number/symbol segments are
    // stringified.  (The path element type is `PropertyKey` so the hook
    // typechecks under both zod 3 and zod 4 — zod 4's issue path includes
    // `symbol`.)
    expect(src).toMatch(/typeof seg === "string"/);
    // newApp() factory — the public surface used by all router files.
    expect(src).toMatch(/export function newApp\(\)/);
    expect(src).toMatch(/new OpenAPIHono\(\{\s*defaultHook\s*\}\)/);
    // The runtime body INCLUDES the §3.2 errors[] extension — that's
    // the field-level contract the frontend ACL reads.  OpenAPI schema
    // doesn't declare it yet (parity-deferred), but the JSON body the
    // hook builds carries it.  The hook builds `errors` as a local
    // const via `(result.error?.issues ?? []).map(...)` and shorthand-
    // splats it into the JSON.stringify body.
    expect(src).toMatch(/const errors = \(result\.error\?\.issues \?\? \[\]\)\.map/);
    expect(src).toMatch(/pointer:\s*pointerOf\(issue\.path\)/);
    expect(src).toMatch(/message:\s*issue\.message/);
    // The shorthand `errors` (= the local const) is included in the
    // emitted JSON body — that's the field the frontend ACL reads.
    expect(src).toMatch(/instance:\s*c\.req\.path,\s*errors,/);
  });

  it("router files import ProblemDetails + newApp from problem-details", async () => {
    const { files } = generateSystems(await buildAcme());
    const root = honoRootOf(files);
    // Spot-check every emitted router file under http/.
    const routerFiles = [...files.keys()].filter(
      (k) =>
        k.startsWith(`${root}/http/`) &&
        k.endsWith(".ts") &&
        !k.endsWith("/problem-details.ts") &&
        !k.endsWith("/index.ts"),
    );
    expect(routerFiles.length).toBeGreaterThan(0);
    for (const k of routerFiles) {
      const src = files.get(k)!;
      expect(src, `router ${k} should import from problem-details`).toMatch(
        /from "\.\/problem-details"/,
      );
      // Inline ProblemDetails schema should be gone.
      expect(src).not.toMatch(/const ProblemDetails = z\.object\(\{ type:/);
    }
  });

  it("router files construct OpenAPIHono via newApp() (default hook wired)", async () => {
    const { files } = generateSystems(await buildAcme());
    const root = honoRootOf(files);
    const routerFiles = [...files.keys()].filter(
      (k) =>
        k.startsWith(`${root}/http/`) &&
        k.endsWith(".ts") &&
        !k.endsWith("/problem-details.ts") &&
        !k.endsWith("/index.ts"),
    );
    for (const k of routerFiles) {
      const src = files.get(k)!;
      // The default-constructed OpenAPIHono path bypasses the validation
      // hook — must not survive.
      expect(src, `router ${k} should NOT bypass the hook`).not.toMatch(
        /const app = new OpenAPIHono\(\);/,
      );
      // The factory carries the hook.
      expect(src).toMatch(/const app = newApp\(\);/);
    }
  });

  it("OpenAPI route declarations carry 422 alongside 400 for body-bearing routes", async () => {
    // Phase D shipped: all three backends now declare 422 in lockstep via
    // the central matrix in src/ir/util/openapi-errors.ts.  Hono's
    // create / operation / workflow routes declare 422 ProblemDetails
    // alongside 400.  See docs/old/proposals/validation-error-extension.md.
    const { files } = generateSystems(await buildAcme());
    const root = honoRootOf(files);
    const customerSrc = files.get(`${root}/http/customer.routes.ts`)!;
    const fourHundreds = customerSrc.match(
      /400:\s*\{ description: "Bad Request", content: \{ "application\/problem\+json": \{ schema: ProblemDetails \} \} \}/g,
    );
    const fourTwentyTwos = customerSrc.match(
      /422:\s*\{ description: "Unprocessable Entity", content: \{ "application\/problem\+json": \{ schema: ProblemDetails \} \} \}/g,
    );
    expect(fourHundreds, "expected at least one 400 declaration").not.toBeNull();
    expect(fourTwentyTwos, "expected at least one 422 declaration").not.toBeNull();
    // Every 400 (body-bearing route) pairs with a 422 (validation arm
    // of the same route).
    expect(fourTwentyTwos!.length).toBe(fourHundreds!.length);
  });
});
