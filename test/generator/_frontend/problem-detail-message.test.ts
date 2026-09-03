// The message a user reads is the backend's ProblemDetails `detail`.
//
// Every Loom backend answers `application/problem+json` — RFC 7807's
// `{ type, title, status, detail, instance, errors[] }` — where `detail` is the
// domain sentence ("Project is still referenced and cannot be deleted.",
// "Precondition failed: …") and `title` is only the reason phrase ("Conflict",
// "Unprocessable Entity").  Three layers between that body and the toast each
// dropped it:
//
//   1. `api/api-client.hbs` (shared by react / vue / svelte / angular) extracted
//      the message from `"error" in body` — a key NO backend emits.  The branch
//      was dead, so `ApiError.message` was ALWAYS `r.statusText`.  Every form
//      that toasts `(e as Error).message` therefore showed the reason phrase.
//   2. the same file called `JSON.parse(text)` unguarded and BEFORE the `r.ok`
//      check, so a non-JSON error body (a gateway's HTML 502, a proxy's
//      plain-text 413) threw a `SyntaxError` instead of an `ApiError` — the
//      status was lost and no `instanceof ApiError` branch downstream could
//      classify it.
//   3. `applyServerErrors` (react, and the svelte form runtime's method) built
//      its `{ kind: "global" }` outcome from `title` only, never reading
//      `detail`, so even a form that DID decode the body showed the phrase.
//
// Confirmed independently by field-test finding D1 and by reviews B and C
// (review-C REPORT.md D1 / D12 / D13).
//
// Asserted per-frontend, on the emitted file, because the four JSX/markup hosts
// render the SAME template through four different shell writers — a pack that
// stopped rendering `api-client` would silently drop the fix on one framework.
//
// Mutation-proved, each claim separately:
//   * `problemMessage` reverted to the `"error" in body` extraction → the four
//     client arms fail on `pd.detail`;
//   * `parseBody`'s try/catch removed → the "non-JSON body" arm fails;
//   * `pd.detail || pd.title` → `pd.title` in react's `apply-server-errors.ts` →
//     the react ACL arm fails;
//   * the same revert in the svelte form runtime → the svelte arm fails.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** One aggregate, scaffolded, on the named frontend framework.  The api client
 *  is shell boilerplate — it does not depend on the model — so the smallest
 *  system that mounts a ui is enough. */
function systemFor(framework: string, port: number): string {
  return `
system Detail {
  subdomain People {
    context P {
      aggregate Engineer with crudish {
        handle: string
        invariant handle.length > 0
      }
      repository Engineers for Engineer { }
    }
  }
  api PeopleApi from People
  ui WebApp with scaffold(subdomains: [People]) { api People: PeopleApi }
  storage primarySql { type: postgres }
  resource pState { for: P, kind: state, use: primarySql }
  deployable api {
    platform: node
    contexts: [P]
    dataSources: [pState]
    serves: PeopleApi
    port: ${port}
  }
  deployable web_app {
    platform: ${framework}
    targets: api
    ui: WebApp { People: api }
    port: ${port + 1}
  }
}
`;
}

/** Where each host writes the shared `api-client.hbs` render. */
const CLIENT_PATH: Record<string, { framework: string; port: number; path: string }> = {
  react: { framework: "react", port: 4301, path: "web_app/src/api/client.ts" },
  vue: { framework: "vue", port: 4311, path: "web_app/src/api/client.ts" },
  svelte: { framework: "svelte", port: 4321, path: "web_app/src/lib/api/client.ts" },
  angular: { framework: "angular", port: 4331, path: "web_app/src/api/client.ts" },
};

describe("the API client surfaces ProblemDetails `detail`, not the status text", () => {
  for (const [name, spec] of Object.entries(CLIENT_PATH)) {
    it(`${name} reads detail → title → statusText`, async () => {
      const files = await generateSystemFiles(systemFor(spec.framework, spec.port));
      const client = files.get(spec.path);
      expect(client, `${spec.path} was not emitted`).toBeDefined();
      const src = client!;

      // The precedence itself, in order.
      expect(src).toContain('if (typeof pd.detail === "string" && pd.detail.length > 0)');
      expect(src).toContain('if (typeof pd.title === "string" && pd.title.length > 0)');
      expect(src).toContain("const message = problemMessage(body, r.statusText);");

      // The dead branch that made every message the reason phrase.
      expect(src, "the `error` key branch is dead — no backend emits it").not.toContain(
        '"error" in body',
      );

      // Both call sites (`rawFetch` and the multipart `rawUpload`) go through the
      // one helper.  Pinned as a COUNT: the duplication is what let the bug live
      // at two line numbers, and a fix applied to only one of them would still
      // satisfy a `toContain`.
      expect(src.match(/problemMessage\(body, r\.statusText\)/g)?.length).toBe(2);
    });

    it(`${name} survives a non-JSON error body`, async () => {
      const files = await generateSystemFiles(systemFor(spec.framework, spec.port + 100));
      const src = files.get(spec.path)!;
      // The parse is guarded and happens through the shared helper…
      expect(src).toContain("function parseBody(text: string): unknown {");
      expect(src).toMatch(/try \{\s*return JSON\.parse\(text\) as unknown;\s*\} catch \{/);
      // …and no call site parses inline any more, which is what threw before the
      // `r.ok` check could run.
      expect(src).not.toContain("text ? JSON.parse(text) : null");
      expect(src.match(/parseBody\(text\)/g)?.length).toBe(2);
    });
  }

  it("react's applyServerErrors builds its global message from detail", async () => {
    const files = await generateSystemFiles(systemFor("react", 4401));
    const acl = files.get("web_app/src/lib/apply-server-errors.ts");
    expect(acl, "apply-server-errors.ts was not emitted").toBeDefined();
    // `detail` must be declared on the decoded shape…
    expect(acl).toContain("detail?: string;");
    // …and preferred over `title` for the global outcome.
    expect(acl).toContain("const globalMessage = pd.detail || pd.title;");
    expect(acl).not.toContain('return pd.title ? { kind: "global", title: pd.title }');
  });

  it("svelte's form runtime builds its global message from detail", async () => {
    const files = await generateSystemFiles(systemFor("svelte", 4411));
    const forms = files.get("web_app/src/lib/forms.svelte.ts");
    expect(forms, "forms.svelte.ts was not emitted").toBeDefined();
    expect(forms).toContain("detail?: string");
    expect(forms).toContain('typeof rec.detail === "string" && rec.detail.length > 0');
    // The `title`-only form that shipped the reason phrase.
    expect(forms).not.toContain(
      'if (typeof rec.title === "string") {\n          return { kind: "global" as const, title: rec.title };',
    );
  });
});
