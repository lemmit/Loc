// Phase-⑦ guard: an `auditable` aggregate must not read its own audit stamp
// fields inside the action that triggers the stamp (capability-stamp-dedup).
//
// Both backends stamp at PERSIST time (the .NET AuditableInterceptor at
// SaveChanges; the Java AuditingEntityListener at flush), so a value the body
// stamps is not yet populated while that body runs — reading it would observe a
// default/stale value in production while appearing to work under an
// operation-time prototype.  This check turns that silent gap into a compile
// error (`loom.stamp-read-before-flush`).

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const codes = async (source: string): Promise<string[]> =>
  validateLoomModel(await buildLoomModel(source))
    .filter((d) => d.code === "loom.stamp-read-before-flush")
    .map((d) => d.message);

describe("stamp-read-before-flush (capability-stamp-dedup §7)", () => {
  it("rejects an operation that reads updatedAt (not applied until this flush)", async () => {
    const msgs = await codes(`
      system Demo {
        subdomain M { context C {
          aggregate Order with auditable {
            code: string
            operation touch() { requires this.updatedAt != now() }
          }
        }}
      }
    `);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!).toContain("operation 'touch'");
    expect(msgs[0]!).toContain("persist time");
  });

  it("rejects a create that reads createdAt (unset until the create flush)", async () => {
    const msgs = await codes(`
      system Demo {
        subdomain M { context C {
          aggregate Order with auditable {
            code: string
            seenAt: datetime
            create open(c: string) { code := c  seenAt := this.createdAt }
          }
        }}
      }
    `);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!).toContain("create 'open'");
  });

  it("accepts an operation that reads createdAt (set by the prior create-flush)", async () => {
    const msgs = await codes(`
      system Demo {
        subdomain M { context C {
          aggregate Order with auditable {
            code: string
            firstSeen: datetime
            operation mark() { firstSeen := this.createdAt }
          }
        }}
      }
    `);
    expect(msgs).toEqual([]);
  });

  it("does not fire for a non-auditable aggregate reading an unrelated field", async () => {
    const msgs = await codes(`
      system Demo {
        subdomain M { context C {
          aggregate Order {
            code: string
            updatedAt: datetime
            operation touch() { requires this.updatedAt != now() }
          }
        }}
      }
    `);
    expect(msgs).toEqual([]);
  });
});
