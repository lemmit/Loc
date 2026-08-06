import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// vanilla Phoenix — a RETURNING operation bumps the `versioned` counter.
//
// `versioned` declares `version: int token = 1`, incremented per command
// (`src/macros/prelude.ts`).  The NAMED-operation path in `context-emit.ts`
// already emits `change(%{version: record.version + 1})` — its own comment says
// that "brings the relational/embedded path in line" with the document path.
// The RETURNING-operation path (an exception-less `: T or Error` op) emitted a
// bare `change(%{})`: it persisted the field write and left `version` untouched.
//
// NOT the RS-20 shape.  Java's `@Version` misses a bump because Hibernate tracks
// ROW DIRTINESS, so it only diverges when nothing actually changed; here the
// write is a real change and the bump is simply absent from one emitter arm.
// Elixir alone, against a capability the other four backends honour — a fix, not
// a waiver.
//
// Found 2026-08-05 by the caller-census drain: `corpus/operation-returns`'
// `accept()` (`reserved := true`, returning `: string or NotFound`) read back
// `version: 2` where every other backend read 3.
// ---------------------------------------------------------------------------

const versionedSrc = (extra: string) => `
system RU {
  subdomain D {
    context Shop {
      error NotFound { resource: string }
      aggregate Order ${extra} {
        code: string
        reserved: bool
        operation accept(): string or NotFound { reserved := true  return code }
        operation reject(): string or NotFound { return NotFound { resource: code } }
        operation touch() { reserved := false }
      }
      repository Orders for Order { }
    }
  }
  api A from D
  storage pg { type: postgres }
  resource s { for: Shop, kind: state, use: pg }
  deployable d { platform: elixir, contexts: [Shop], dataSources: [s], port: 4000 }
}
`;

const ctxModule = async (src: string): Promise<string> => {
  const files = await generateSystemFiles(src);
  const hit = [...files.entries()].find(([p]) => p.endsWith("shop.ex"));
  expect(hit, "no shop.ex").toBeDefined();
  return hit![1];
};

describe("vanilla Phoenix — returning-op version bump", () => {
  it("a returning op on a versioned aggregate bumps `version`, like a named op", async () => {
    const mod = await ctxModule(versionedSrc("with crudish"));

    // Premise: BOTH op kinds are emitted on the same aggregate, so the
    // comparison below is between the two PATHS and not between two fixtures.
    expect(mod).toContain("def accept_order(%D.Shop.Order{} = record, params)");
    expect(mod).toContain("def touch_order(%D.Shop.Order{} = record, params)");

    // The named-op path bumps (it always did) …
    const touch = mod.slice(mod.indexOf("def touch_order(%D.Shop.Order{}"));
    expect(touch.slice(0, touch.indexOf("\n  end"))).toContain(
      "Ecto.Changeset.change(%{version: record.version + 1})",
    );
    // … and now so does the returning-op path.
    const accept = mod.slice(mod.indexOf("def accept_order(%D.Shop.Order{}"));
    const acceptBody = accept.slice(0, accept.indexOf("\n  end"));
    expect(acceptBody).toContain("Ecto.Changeset.change(%{version: record.version + 1})");
    expect(acceptBody).not.toContain("Ecto.Changeset.change(%{})");
    // The write itself is unchanged.
    expect(acceptBody).toContain("Ecto.Changeset.force_change(:reserved, record.reserved)");
  });

  it("a returning op that WRITES NOTHING gains no changeset, and so no bump", async () => {
    // Scope guard.  The bump rides the persist pipeline, so it must appear only
    // where there IS one — a returning op with no assignment (here the
    // error-variant `reject`) short-circuits before any changeset, and a fix
    // that bumped unconditionally would show up as a version write on a command
    // that never touches the row.
    //
    // (An unversioned aggregate is NOT the guard to write: `versioned` is
    // applied by default to every non-`eventLog` aggregate — `applyDefaultVersioning`
    // in `src/macros/expander.ts` — so that branch is unreachable from ordinary
    // source and asserting it would pin a shape the compiler never emits.)
    const mod = await ctxModule(versionedSrc("with crudish"));
    const reject = mod.slice(mod.indexOf("def reject_order(%D.Shop.Order{}"));
    const rejectBody = reject.slice(0, reject.indexOf("\n  end"));
    expect(rejectBody).toContain('{:error, "NotFound"');
    expect(rejectBody).not.toContain("Ecto.Changeset");
    expect(rejectBody).not.toContain("record.version + 1");
  });
});
