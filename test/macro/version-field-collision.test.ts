import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// M-T9.24 G2 — a user-declared `version` field collided with auto-versioning.
//
// `applyDefaultVersioning` splices the `versioned` capability (`version:
// int = 1`) into every non-eventLog aggregate.  `mergeScopedMembers` drops the
// injected member on a name collision — but the aggregate was still TAGGED
// `versioned`, so every downstream consumer treated the user's column as the
// optimistic-concurrency counter.  For `version: string` that is a boot-break:
//
//   CREATE TABLE "ops"."releases" ( … "version" TEXT NOT NULL DEFAULT 1, … )
//
// which Postgres rejects outright — the stack never starts.  The Hono
// repository also inserted `version: 1` (a number) into the text column and
// computed `expected + 1` on a string.  Both reproduced with the CLI.
//
// `version: int` IS structurally the field the capability would have spliced,
// so that spelling keeps working unchanged — the splice is skipped (it would
// have been dropped anyway) and the capability tag still applies.
// ---------------------------------------------------------------------------

const system = (versionType: string) => `
system G2Probe {
  subdomain Ops {
    context Ops {
      aggregate Release with crudish {
        version: ${versionType}
        notes: string
      }
      repository Releases for Release { }
    }
  }
  api OpsApi from Ops
  storage primary { type: postgres }
  resource opsState { for: Ops, kind: state, use: primary }
  deployable svc {
    platform: node
    contexts: [Ops]
    dataSources: [opsState]
    serves: OpsApi
    port: 4000
  }
}
`;

describe("user-declared `version` vs auto-versioning", () => {
  it("rejects a non-int `version` field instead of emitting an unbootable schema", async () => {
    const { errors } = await parseString(system("string"));
    const joined = errors.join("\n");
    expect(joined).toContain("'version'");
    expect(joined).toContain("optimistic-concurrency");
    // The message has to be actionable — both ways out are named.
    expect(joined).toContain("releaseVersion");
    expect(joined).toContain("version: int");
  });

  it("still accepts `version: int` and emits the concurrency column unchanged", async () => {
    const { model, errors } = await parseString(system("int"));
    expect(errors).toEqual([]);
    const files = generateSystems(model).files;
    const sql = [...files].find(([p]) => p.endsWith("_ops_initial.sql"))?.[1];
    expect(sql).toContain(`"version" INTEGER NOT NULL DEFAULT 1`);
    const repo = files.get("svc/db/repositories/release-repository.ts");
    // The optimistic-concurrency read/compare/bump is still wired.
    expect(repo).toContain("const expected = expectedVersion ?? aggregate.version;");
    expect(repo).toContain("version: expected + 1");
  });

  it("leaves an aggregate with no `version` field on the normal splice path", async () => {
    const { model, errors } = await parseString(system("int").replace("version: int", ""));
    expect(errors).toEqual([]);
    const sql = [...generateSystems(model).files].find(([p]) =>
      p.endsWith("_ops_initial.sql"),
    )?.[1];
    expect(sql).toContain(`"version" INTEGER NOT NULL DEFAULT 1`);
  });
});

// --- the EXPLICIT application path (G2 follow-up) ---------------------------
//
// `applyDefaultVersioning` returns early when the aggregate already carries the
// `versioned` tag, so its guard never saw an aggregate that asked for the
// capability by name.  `aggregate X with versioned { version: string }` — and
// the context-level `with versioned` fan-out — therefore still produced
// `"version" TEXT NOT NULL DEFAULT 1`, the DDL Postgres rejects at CREATE
// TABLE.  The same rule now runs where the splice actually happens.

describe("`version` collision — explicit `with versioned`", () => {
  const src = (versionField: string, caps: string) => `
    system S {
      subdomain Sub { context Ops {
        aggregate Release ${caps} {
          ${versionField}
          name: string
        }
        repository Releases for Release { }
      } }
    }
  `;

  it("rejects a non-int `version` when the capability was asked for by name", async () => {
    const { errors } = await parseString(src("version: string", "with crudish, versioned"));
    expect(errors.join("\n")).toMatch(/field 'version' on aggregate 'Release' collides/);
  });

  it("rejects it through a context-level application too", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain Sub { context Ops with versioned {
          aggregate Release with crudish {
            version: string
            name: string
          }
          repository Releases for Release { }
        } }
      }
    `);
    expect(errors.join("\n")).toMatch(/field 'version' on aggregate 'Release' collides/);
  });

  it("leaves an explicit `version: int` legal — it IS the concurrency column", async () => {
    const { errors } = await parseString(src("version: int", "with crudish, versioned"));
    expect(errors).toEqual([]);
  });
});
