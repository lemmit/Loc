// ---------------------------------------------------------------------------
// A wire `== null` means ABSENT — and every native-chain constraint says which
// field it is about, in words (field-test findings A1, D2).
//
// Loom has ONE absence value; JavaScript has two.  A wire-optional field
// arrives as `undefined` when the key is OMITTED from the request body and as
// `null` when it is sent explicitly — `z.number().int().nullish()` admits both
// — but `zod-refine.ts` rendered every `==` as `===`, so
//
//     invariant estimate == null || estimate >= 0
//
// emitted `data.estimate === null || data.estimate >= 0`, which is FALSE for
// the omitted key.  `POST /api/tasks` without `estimate` answered 422 on Hono
// while .NET and Python answered 201 (their deserializers materialize an
// absent field as their single null), so the wire contract disagreed across
// backends and every scaffolded create form over such an aggregate was dead.
//
// The second half: the single-field NATIVE chain carried no zod message at
// all, so a `code.length >= 2 && code.length <= 5` violation reached the user
// as zod's `"Invalid input"`.
//
// Both halves are pinned SEMANTICALLY here — the emitted schema is transpiled
// and EXECUTED against the repo's zod (the harness `money-schema-runtime.test.ts`
// established) — because a text assertion on `== null` proves the bytes, not
// the behaviour the bytes have to produce.
// ---------------------------------------------------------------------------

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateSystemFiles } from "../_helpers/generate.js";

const SOURCE = `
  system Absent {
    subdomain Work {
      context Tracking {
        aggregate Task {
          title: string
          code: string
          estimate: int?
          status: TaskStatus
          // The null-guard shape: legal only because \`estimate\` is optional.
          invariant estimate == null || estimate >= 0
          // A message-LESS single-field range — the native-chain carrier.
          invariant code.length >= 2 && code.length <= 5
          // A non-null equality, so the strict-vs-loose choice is pinned in
          // BOTH directions by the same fixture.
          invariant status != TaskStatus.Archived || estimate == null
          create(title: string, code: string, estimate: int?, status: TaskStatus) {
            title := title
            code := code
            estimate := estimate
            status := status
          }
        }
        enum TaskStatus { Open Archived }
        repository Tasks for Task { }
      }
    }
    api TrackingApi from Work
    ui Console with scaffold(subdomains: [Work]) {
      api Tracking: TrackingApi
    }
    storage db { type: postgres }
    resource st { for: Tracking, kind: state, use: db }
    deployable nodeApi { platform: node contexts: [Tracking] dataSources: [st] serves: TrackingApi port: 8080 }
    deployable webApp {
      platform: react
      targets: nodeApi
      ui: Console { Tracking: nodeApi }
      port: 3000
    }
  }
`;

let cache: Map<string, string> | undefined;
async function gen(): Promise<Map<string, string>> {
  if (!cache) cache = await generateSystemFiles(SOURCE);
  return cache;
}

async function file(suffix: string): Promise<string> {
  const all = await gen();
  const hit = [...all.keys()].find((k) => k.endsWith(suffix));
  if (!hit) throw new Error(`no emitted file ends with ${suffix}\n${[...all.keys()].join("\n")}`);
  return all.get(hit)!;
}

/** `@hono/zod-openapi`'s metadata extension — pure documentation, no
 *  validation behaviour — which plain zod does not carry, so it is stripped
 *  before the declaration is evaluated. */
const OPENAPI_CALL = /\.openapi\((?:"[^"]*"|\{[^}]*\})\)/g;

/** Lift one `const <name> = z.object({ … });` declaration out of an emitted
 *  file, together with the enum schemas it references, and evaluate the lot
 *  against the repo's zod. */
function loadSchema(src: string, name: string): z.ZodType {
  const decl = new RegExp(`const ${name} = z\\.object\\(\\{[\\s\\S]*?\\n\\}\\)[^\\n]*;`).exec(src);
  if (!decl) throw new Error(`no \`const ${name} = z.object({…})\` in:\n${src.slice(0, 2000)}`);
  const enums = [...src.matchAll(/^const \w+Schema = z\.enum\(\[[^\]]*\]\)[^\n]*;$/gm)].map(
    (m) => m[0],
  );
  const stripped = [...enums, decl[0]].join("\n").replace(OPENAPI_CALL, "");
  const js = ts.transpileModule(stripped, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function("z", `${js}\nreturn ${name};`)(z) as z.ZodType;
}

const BODY = { title: "Ship it", code: "ABC", status: "Open" };

describe("wire null-guard invariants treat an omitted optional as absent", () => {
  it("the emitted create schema ACCEPTS a body with the optional key omitted", async () => {
    const schema = loadSchema(await file("node_api/http/task.routes.ts"), "CreateTaskRequest");
    const parsed = schema.safeParse(BODY);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("…and an explicit null, which is the same value in the DSL", async () => {
    const schema = loadSchema(await file("node_api/http/task.routes.ts"), "CreateTaskRequest");
    expect(schema.safeParse({ ...BODY, estimate: null }).success).toBe(true);
  });

  it("…while a PRESENT value still has to satisfy the guarded half", async () => {
    const schema = loadSchema(await file("node_api/http/task.routes.ts"), "CreateTaskRequest");
    const bad = schema.safeParse({ ...BODY, estimate: -1 });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(["estimate"]);
    expect(schema.safeParse({ ...BODY, estimate: 3 }).success).toBe(true);
  });

  it("renders the null comparison LOOSE and every other comparison strict", async () => {
    const routes = await file("node_api/http/task.routes.ts");
    expect(routes).toContain("data.estimate == null");
    expect(routes).not.toContain("data.estimate === null");
    // The enum comparison in the same invariant keeps strict equality — the
    // loosening is scoped to the `null` literal, not to `==` in general.
    expect(routes).toContain('data.status !== "Archived"');
  });

  it("the frontend form schema carries the same rule (one renderer, two surfaces)", async () => {
    const api = await file("web_app/src/api/task.ts");
    expect(api).toContain("data.estimate == null");
    expect(api).not.toContain("data.estimate === null");
  });
});

describe("every native-chain constraint denies with a human message", () => {
  it("a code-point length range names the field and its bounds", async () => {
    const schema = loadSchema(await file("node_api/http/task.routes.ts"), "CreateTaskRequest");
    const bad = schema.safeParse({ ...BODY, code: "A" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.message)).toContain("Code must be 2 to 5 characters");
    // The zod default the user actually saw before this fix.
    expect(bad.error?.issues.map((i) => i.message)).not.toContain("Invalid input");
  });

  it("the frontend form schema carries the same text", async () => {
    const api = await file("web_app/src/api/task.ts");
    expect(api).toContain('{ message: "Code must be 2 to 5 characters" }');
  });
});
