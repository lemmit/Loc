// Regression coverage for the traversal gaps closed by migrating the ≥5
// hand-copied IR walkers onto the one shared, exhaustive child-walker
// (`src/ir/util/walk.ts`).  Each `it` pins a child slot a prior copy dropped:
//
//   - `currentUser` inside a `match` arm — `exprUsesCurrentUser` (loom-ir.ts)
//     used to skip `match` arms entirely, so the auth param was never threaded.
//   - a `repo-read` inside a `match` arm — the domain-service read-port walker
//     (`domain-service-read-ports.ts`) missed `match`/`convert`/`list`, so the
//     port never materialised and the emitted call referenced a nonexistent
//     handle.
//   - a `files.put` nested in a `for-each` body — `deriveNeeds`
//     (`enrich/enrichments.ts`) walked only the primary top-level statement
//     list, so the capability need (and its `validateNeedCapabilities` gate)
//     was silently skipped.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { ExprIR, TypeIR } from "../../src/ir/types/loom-ir.js";
import { allContexts, exprUsesCurrentUser } from "../../src/ir/types/loom-ir.js";
import { readPortsForOperation } from "../../src/ir/util/domain-service-read-ports.js";
import { buildLoomModel } from "../_helpers/index.js";
import { parseString } from "../_helpers/parse.js";

describe("shared walker migration — currentUser inside a match arm", () => {
  const USER: TypeIR = { kind: "entity", name: "User" };
  const currentUser: ExprIR = { kind: "ref", name: "currentUser", refKind: "current-user" };

  it("detects `currentUser` used in a match-arm value (threads the auth param)", () => {
    // A `match` whose arm value reads `currentUser.role` — the exact shape the
    // pre-migration `exprUsesCurrentUser` switch skipped (it had no `match`
    // arm), so the auth param was never threaded into the generated signature.
    const node: ExprIR = {
      kind: "match",
      arms: [
        {
          cond: { kind: "literal", lit: "bool", value: "true" },
          value: {
            kind: "member",
            receiver: currentUser,
            member: "role",
            receiverType: USER,
            memberType: { kind: "primitive", name: "string" },
          },
        },
      ],
      variantArms: [],
      otherwise: { kind: "literal", lit: "string", value: "none" },
    };
    expect(exprUsesCurrentUser(node)).toBe(true);
  });

  it("detects `currentUser` inside a `convert(...)` value (another missed child slot)", () => {
    const node: ExprIR = {
      kind: "convert",
      target: "string",
      from: undefined,
      value: {
        kind: "member",
        receiver: currentUser,
        member: "id",
        receiverType: USER,
        memberType: { kind: "primitive", name: "guid" },
      },
    };
    expect(exprUsesCurrentUser(node)).toBe(true);
  });
});

describe("shared walker migration — repo-read inside a match arm", () => {
  it("derives a read-port for a `repo-read` nested in a match arm", async () => {
    const loom = await buildLoomModel(`
      context Banking {
        aggregate Account {
          holder: string
        }
        repository Accounts for Account {
          find byHolder(holder: string): Account? where this.holder == holder
        }
        domainService Lookup {
          operation pick(holder: string, useAlt: bool): Account? {
            return match {
              (useAlt) => Accounts.byHolder(holder),
              else => Accounts.byHolder(holder)
            }
          }
        }
      }
    `);
    const svc = allContexts(loom)[0]!.domainServices.find((s) => s.name === "Lookup")!;
    const op = svc.operations.find((o) => o.name === "pick")!;
    // Pre-migration the read-port walker missed `match`, so this was empty and
    // the emitted signature/call site referenced a repository never passed in.
    expect(readPortsForOperation(op)).toEqual([{ repo: "Accounts", aggregate: "Account" }]);
  });
});

describe("shared walker migration — files.put nested in a for-each body", () => {
  const SRC = `
    system Sys {
      subdomain Sales { context Sales {
        aggregate Order { name: string }
        repository Orders for Order { }
        criterion Named of Order = name != ""
        retrieval AllOrders of Order = Named
        workflow Archive {
          create(name: string) {
            let os = Orders.run(AllOrders)
            for o in os {
              salesFiles.put("k/" + o.name, o.name)
            }
          }
        }
      } }
      storage pg { type: postgres }
      storage files { type: s3, config: { bucket: "b" } }
      resource salesState { for: Sales, kind: state, use: pg }
      resource salesFiles { for: Sales, kind: objectStore, use: files }
      deployable api { platform: node, contexts: [Sales], dataSources: [salesState, salesFiles], port: 3000 }
    }
  `;

  it("derives the objectStore capability need for the nested put", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const sys = enrichLoomModel(lowerModel(model)).systems[0]!;
    // Pre-migration `deriveNeeds` walked only the primary top-level statement
    // list, so a `files.put` inside the loop body produced no need at all.
    const need = sys.needs.find((n) => n.contextName === "Sales" && n.kind === "objectStore");
    expect(need).toBeDefined();
    expect(need!.capabilities).toContain("blob");
  });
});
