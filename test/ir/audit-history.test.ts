// Entity history — the READ side of the `audited` command trail (docs/audit.md).
//
// IR-level half: the derived `find history(id)` injected in the auto-`findAll`
// enrichment slot, the boundary that decides which fields the per-entry diff
// covers, and the gate/`ignoring` stance it inherits from the aggregate's list
// read.
//
// The diff-boundary assertions here are SECURITY assertions, not tidiness ones.
// An audit row's `before`/`after` snapshots are written server-side inside the
// command's transaction, where there is no caller to mask against — so they
// hold raw values for every field, including `secret`, `internal`, and every
// `mask unless` field.  `historyDiffFields` is the only thing standing between
// those snapshots and the wire.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { EnrichedBoundedContextIR, RepositoryIR } from "../../src/ir/types/loom-ir.js";
import {
  aggServesHistory,
  historyDiffFields,
  maskedHistoryFields,
} from "../../src/ir/util/audit-history.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** An audited aggregate carrying one of every access role the diff boundary
 *  has an opinion about, plus a masked field and an unaudited sibling. */
const SRC = `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      aggregate Employee audited with versioned {
        name: string
        salary: decimal mask unless currentUser.permissions.contains(permissions.unmask)
        ssn: string secret
        scratch: string internal
        touchedAt: datetime managed
        create(name: string, salary: decimal, ssn: string, scratch: string, touchedAt: datetime) {
          name := name
          salary := salary
          ssn := ssn
          scratch := scratch
          touchedAt := touchedAt
        }
        operation rename(name: string) { name := name }
      }
      repository Employees for Employee {
        find byName(name: string): Employee? where this.name == name
      }

      aggregate Plain with crudish {
        code: string
      }
    }
  }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  port: 8080  auth: required }
}`;

async function contextOf(src: string): Promise<EnrichedBoundedContextIR> {
  const { model } = await parseString(src, { validate: false });
  const ir = enrichLoomModel(lowerModel(model));
  for (const s of ir.systems) for (const sd of s.subdomains) for (const c of sd.contexts) return c;
  throw new Error("no context");
}

const repoFor = (ctx: EnrichedBoundedContextIR, agg: string): RepositoryIR => {
  const r = ctx.repositories.find((x) => x.aggregateName === agg);
  if (!r) throw new Error(`no repository for ${agg}`);
  return r;
};

describe("entity history — derived find", () => {
  it("injects `history(id)` on an audited aggregate and nowhere else", async () => {
    const ctx = await contextOf(SRC);
    const history = repoFor(ctx, "Employee").historyFind;
    expect(history?.name).toBe("history");
    expect(history?.auditHistory).toBe(true);
    expect(history?.params.map((p) => p.name)).toEqual(["id"]);
    // An unaudited aggregate has no trail to read, so no find is derived.
    expect(repoFor(ctx, "Plain").historyFind).toBeUndefined();
    expect(aggServesHistory(ctx.aggregates.find((a) => a.name === "Plain")!)).toBe(false);
  });

  it("stays out of `finds` — the ~120 generic find consumers must not see it", async () => {
    const ctx = await contextOf(SRC);
    // A generic consumer assumes a find reads the AGGREGATE's table at
    // `/<name>`; history reads `audit_records` at `/{id}/history`.  Membership
    // in `finds` would need a skip-guard at every one of those sites, and a
    // missed guard emits a broken route rather than failing loudly.
    expect(repoFor(ctx, "Employee").finds.map((f) => f.name)).not.toContain("history");
  });

  it("is idempotent — enrich(enrich(m)) derives exactly one history find", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const once = enrichLoomModel(lowerModel(model));
    const twice = enrichLoomModel(once);
    expect(JSON.stringify(twice)).toEqual(JSON.stringify(once));
  });
});

describe("entity history — the diff boundary (security)", () => {
  it("never exposes a `secret` or `internal` field, though the snapshot holds it", async () => {
    const ctx = await contextOf(SRC);
    const names = historyDiffFields(ctx.aggregates.find((a) => a.name === "Employee")!).map(
      (f) => f.name,
    );
    expect(names).not.toContain("ssn");
    expect(names).not.toContain("scratch");
  });

  it("excludes managed stamps and the `version` token — otherwise they ARE the timeline", async () => {
    const ctx = await contextOf(SRC);
    const names = historyDiffFields(ctx.aggregates.find((a) => a.name === "Employee")!).map(
      (f) => f.name,
    );
    // `after` is captured post-save, so a stamp differs on EVERY entry.
    expect(names).not.toContain("touchedAt");
    // `versioned` increments per command — stamp churn by another name.
    expect(names).not.toContain("version");
    // The id never changes.
    expect(names).not.toContain("id");
    // What survives is what a caller can actually influence.
    expect(names).toEqual(["name", "salary"]);
  });

  it("flags the `mask unless` field so its change entry can be dropped per caller", async () => {
    const ctx = await contextOf(SRC);
    const agg = ctx.aggregates.find((a) => a.name === "Employee")!;
    expect(maskedHistoryFields(agg).map((f) => f.name)).toEqual(["salary"]);
    expect(maskedHistoryFields(agg)[0].maskUnless).toBeDefined();
  });
});

describe("entity history — inherited read gate", () => {
  const gated = (clause: string) =>
    SRC.replace(
      "find byName(name: string): Employee? where this.name == name",
      `find all(): Employee[] ${clause}\n        find byName(name: string): Employee? where this.name == name`,
    );

  it("copies the list read's `requires` gate", async () => {
    const ctx = await contextOf(gated('requires currentUser.role == "hr"'));
    const history = repoFor(ctx, "Employee").historyFind;
    // History replays the same rows the list read covers, so it must be no
    // easier to reach.  One place an author writes the gate; history is
    // downstream of it by construction.
    expect(history?.requires).toBeDefined();
    expect(JSON.stringify(history?.requires)).toEqual(
      JSON.stringify(repoFor(ctx, "Employee").finds.find((f) => f.name === "all")?.requires),
    );
  });

  it("copies the list read's `ignoring` stance so capability filters cannot diverge", async () => {
    const ctx = await contextOf(gated("ignoring *"));
    expect(repoFor(ctx, "Employee").historyFind?.bypassAll).toBe(true);
  });

  it("carries no gate when the list read carries none (the ungated case is a phase-⑦ error)", async () => {
    const ctx = await contextOf(SRC);
    expect(repoFor(ctx, "Employee").historyFind?.requires).toBeUndefined();
  });
});

describe("entity history — denyByDefault", () => {
  const withEnforcement = (src: string) =>
    src.replace("  user {", "  auth { enforcement: denyByDefault }\n  user {");

  const codesFor = async (src: string): Promise<string[]> => {
    const { model } = await parseString(src, { validate: false });
    return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
  };

  it("errors when an audited aggregate's history is reachable ungated", async () => {
    // `find all` itself is exempt from `loom.default-deny-ungated` (compiler-
    // synthesized, no author line).  History is synthesized too, but the author
    // HAS a surface for it — declaring the list read's gate — and an ungated
    // CHANGE history is a worse default than an ungated current-state read: one
    // request yields who changed what, when, across the row's whole lifetime.
    expect(await codesFor(withEnforcement(SRC))).toContain("loom.audit-history-ungated");
  });

  it("clears once the list read is gated — history inherits it", async () => {
    const gated = withEnforcement(SRC).replace(
      "find byName(name: string): Employee? where this.name == name",
      'find all(): Employee[] requires currentUser.role == "hr"\n        find byName(name: string): Employee? requires currentUser.role == "hr" where this.name == name',
    );
    expect(await codesFor(gated)).not.toContain("loom.audit-history-ungated");
  });

  it("stays silent under the default `opt` enforcement", async () => {
    expect(await codesFor(SRC)).not.toContain("loom.audit-history-ungated");
  });
});
