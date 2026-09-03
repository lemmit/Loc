// A still-referenced DELETE answers `ReferencedInUse` (409 by default) on all
// five backends — including a model that declares no `unique (...)` key.
//
// A cross-aggregate `X id` field becomes a FK column with `ON DELETE RESTRICT`
// (`src/system/migrations-builder.ts`), so hard-deleting a row another aggregate
// still points at fails at the database with Postgres SQLSTATE 23503.  Every
// backend is supposed to translate that into the resolved `ReferencedInUse`
// status — and four do it unconditionally: hono maps 23503 on the delete route,
// EF's `DbUpdateException` is caught in the .NET destroy action, python rescues
// `IntegrityError`, elixir rescues `Ecto.ConstraintError` of type `:foreign_key`.
//
// JAVA did not.  Its 23503 arm lives in the project-wide
// `@RestControllerAdvice`, in the SAME `@ExceptionHandler(DataIntegrityViolationException)`
// as the 23505 unique arm — and the whole handler was gated on `hasUniqueKeys`.
// So a model with a reference and no unique key emitted no integrity handler at
// all, and a still-referenced delete surfaced as a 500 against the 409 its own
// OpenAPI declares.  The field test measured exactly that split (Hono/​python
// 409 + a sentence, java 500).
//
// THE FIXTURE IS THE POINT: `Project` <- `Issue.project`, both REST-deletable,
// and **not one `unique` key in the model**.  A fixture that declared one would
// be satisfied by the pre-existing java gate and pin nothing — which is why the
// second `describe` below asserts the absence of a unique key rather than
// trusting the reader to notice.
//
// Each arm is file-scoped to the emitter that owns the mapping, for the reason
// `not-found-by-id-detail-parity.test.ts` states: a language-wide search is
// satisfied by some other file carrying the same bytes, so it can pass with the
// arm under test fully reverted.
//
// Mutation-proved: with `hasIntegrityHandler` reverted to `hasUniqueKeys` in
// `src/generator/java/emit/api.ts`, the java arm fails ("missing
// `"23503".equals(sqlState(e))`"); the other four stay green, which is the
// cross-backend claim.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** Two aggregates, one referencing the other, both with a canonical destroy —
 *  and NO `unique (...)` key anywhere.  That combination is what the java gate
 *  used to miss. */
function systemFor(platform: string, port: number): string {
  return `
system Refd {
  subdomain M {
    context C {
      aggregate Project with crudish {
        name: string
      }
      repository Projects for Project { }

      aggregate Issue with crudish {
        project: Project id
        title: string
      }
      repository Issues for Issue { }
    }
  }
  api RefdApi from M
  storage primary { type: postgres }
  resource refdState { for: C, kind: state, use: primary }
  deployable api {
    platform: ${platform}
    contexts: [C]
    dataSources: [refdState]
    serves: RefdApi
    port: ${port}
  }
}`;
}

const sourceFor = (files: Map<string, string>, ...exts: string[]): string =>
  [...files.entries()]
    .filter(([k]) => exts.some((e) => k.endsWith(e)))
    .map(([, v]) => v)
    .join("\n");

const EXPECTED: Record<
  string,
  { platform: string; port: number; exts: string[]; needles: string[] }
> = {
  // The delete route reads the SQLSTATE off both the raw and the
  // DrizzleQueryError-wrapped shape, and answers the problem body itself.
  node: {
    platform: "node",
    port: 4101,
    exts: [".routes.ts"],
    needles: ['=== "23503")', 'detail: "Project is still referenced and cannot be deleted."'],
  },
  // EF surfaces the FK violation as DbUpdateException from SaveChanges; the
  // destroy action catches it locally so the shared filter stays untouched.
  dotnet: {
    platform: "dotnet",
    port: 4102,
    exts: ["Controller.cs"],
    needles: [
      "catch (Microsoft.EntityFrameworkCore.DbUpdateException)",
      'Detail = "Project is still referenced and cannot be deleted."',
    ],
  },
  // The arm this file exists for.  `sqlState(e)` is the reader that walks the
  // cause chain; both are emitted only when the integrity handler is.
  java: {
    platform: "java",
    port: 4103,
    exts: ["ApiExceptionAdvice.java"],
    needles: [
      "@ExceptionHandler(DataIntegrityViolationException.class)",
      '"23503".equals(sqlState(e))',
      '"This resource is still referenced and cannot be deleted."',
    ],
  },
  python: {
    platform: "python",
    port: 4104,
    exts: ["_routes.py"],
    needles: ["except IntegrityError:", '"Project is still referenced and cannot be deleted."'],
  },
  elixir: {
    platform: "elixir",
    port: 4105,
    exts: ["_controller.ex"],
    needles: [
      "fk_error in Ecto.ConstraintError",
      "fk_error.type == :foreign_key",
      '"Project is still referenced and cannot be deleted."',
    ],
  },
};

describe("a still-referenced delete resolves to ReferencedInUse on all five backends", () => {
  for (const [name, spec] of Object.entries(EXPECTED)) {
    it(`${name} maps the FK-restrict violation without a unique key in the model`, async () => {
      const files = await generateSystemFiles(systemFor(spec.platform, spec.port));
      const src = sourceFor(files, ...spec.exts);
      expect(src, `${name}: emitted no ${spec.exts.join("/")} file`).not.toBe("");
      for (const needle of spec.needles) {
        expect(src, `${name}: missing ${needle}`).toContain(needle);
      }
    });
  }

  // The fixture's own precondition.  Without it a later edit could add a
  // `unique` key "to make the test more realistic" and silently restore the
  // exact blind spot this file was written for — the java arm would pass on the
  // OLD gate.
  it("the fixture declares no unique key, so java's arm cannot ride the 23505 gate", () => {
    expect(systemFor("java", 4199)).not.toMatch(/\bunique\b/);
  });

  // The 501 status the `problem()` helper's union carries is unrelated here;
  // what matters is that java's advice-level handler is present at all.  Asserted
  // as its own fact because "the import exists" and "the arm exists" have
  // regressed independently before (the import is gated separately).
  it("java imports DataIntegrityViolationException alongside the handler", async () => {
    const src = sourceFor(
      await generateSystemFiles(systemFor("java", 4106)),
      "ApiExceptionAdvice.java",
    );
    expect(src).toContain("import org.springframework.dao.DataIntegrityViolationException;");
    expect(src).toContain("private static String sqlState(Throwable e)");
  });

  // The strict-additivity half: a model that can trip NEITHER integrity rung
  // (no unique key, no reference) still emits no handler, so every existing
  // java project's advice stays byte-identical.
  it("java emits no integrity handler for a model that can trip neither rung", async () => {
    const noRefs = `
system Plain {
  subdomain M {
    context C {
      aggregate Note with crudish { body: string }
      repository Notes for Note { }
    }
  }
  api PlainApi from M
  storage primary { type: postgres }
  resource plainState { for: C, kind: state, use: primary }
  deployable api {
    platform: java
    contexts: [C]
    dataSources: [plainState]
    serves: PlainApi
    port: 4107
  }
}`;
    const src = sourceFor(await generateSystemFiles(noRefs), "ApiExceptionAdvice.java");
    expect(src).not.toBe("");
    expect(src).not.toContain("DataIntegrityViolationException");
    expect(src).not.toContain("sqlState");
  });
});
