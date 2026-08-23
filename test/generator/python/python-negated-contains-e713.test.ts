// ruff E713 — `not (x in y)` must be `x not in y` in EVERY negated guard the
// python emitter writes, not just the ones that happened to route through
// `renderPyNegatedGuard`.
//
// `python-build.yml` runs `ruff check` over the generated project, so a single
// `if not ("core" in self.parts):` is a RED per-PR gate — but only for a
// fixture whose `.ddd` puts a `.contains(...)` under a negation.  The helper
// existed; four emitters still wrapped `not (…)` around `renderPyExpr`
// themselves (audit 2026-08-17 finding A15), and two more sites one line away
// from those did the same:
//
//   aggregate invariant, guarded and bare  emit/aggregate.ts
//   value-object invariant, both shapes    emit/value-objects.ts
//   wire-boundary model_validator          emit/wire-constraints.ts
//   audit-history route `requires` gate    routes-builder.ts (historyRoute)
//   operation `when` state gate            routes-builder.ts (whenGate)
//
// Each case below pins the `not in` form AND asserts the E713 form is absent —
// the second half is what actually fails when a site regresses, since a stray
// `not (… in …)` elsewhere in the file would not disturb the first.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const SRC = `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain Sales {
    permissions { readOrders }
    context Orders {
      valueobject Tag {
        parts: string[]
        invariant parts.contains("core") message "needs core"
        invariant parts.contains("aux") when parts.count > 1 message "aux tag required"
      }
      aggregate Order audited with auditable {
        tags: string[]
        code: string
        note: string?
        status: string
        invariant tags.contains("ok") message "must be tagged ok"
        invariant tags.contains("noted") when note != null message "noted tag required"
        create(code: string, tags: string[], status: string) {
          code := code
          tags := tags
          status := status
        }
        operation archive() when tags.contains("archivable") { status := "archived" }
      }
      repository Orders for Order {
        find all(): Order[] requires currentUser.permissions.contains(permissions.readOrders)
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api { platform: python  contexts: [Orders]  dataSources: [ordersState]  serves: SalesApi  port: 3000  auth: required }
}`;

let cache: Map<string, string> | undefined;
async function files(): Promise<Map<string, string>> {
  if (!cache) {
    const { model, errors } = await parseString(SRC);
    if (errors.length) throw new Error(errors.join("\n"));
    cache = generateSystems(model).files;
  }
  return cache;
}

async function fileEndingWith(suffix: string): Promise<string> {
  for (const [p, c] of await files()) if (p.endsWith(suffix)) return c;
  throw new Error(`no generated file ending with ${suffix}`);
}

/** Every line still carrying the E713 shape — `not (<x> in <y>)` over a bare
 *  membership.  Deliberately paren-free inside the group: ruff's E713 fires on
 *  `not` applied to a MEMBERSHIP COMPARISON, so the composed
 *  `not (<guard-neg> or (<pred>))` a guarded wire rule emits is not a finding
 *  (verified with `ruff check --select E713` over the generated project). */
function e713Hits(source: string): string[] {
  return source.split("\n").filter((l) => /\bnot \([^()]*\bin\b[^()]*\)/.test(l));
}

describe("python — negated `contains` emits `not in` (ruff E713)", () => {
  it("aggregate invariants, bare and guarded", async () => {
    const dom = await fileEndingWith("app/domain/order.py");
    expect(dom).toContain('if "ok" not in self._tags:');
    expect(dom).toContain('(self._note is not None) and "noted" not in self._tags:');
    expect(e713Hits(dom)).toEqual([]);
  });

  it("value-object invariants, bare and guarded", async () => {
    const vo = await fileEndingWith("app/domain/value_objects.py");
    expect(vo).toContain('if "core" not in self.parts:');
    expect(vo).toContain('(len(self.parts) > 1) and "aux" not in self.parts:');
    expect(e713Hits(vo)).toEqual([]);
  });

  it("the wire-boundary model_validator", async () => {
    // The value-object rule lands in the shared wire_models.py; the
    // aggregate's create-body rule in the aggregate's own routes module.
    const models = await fileEndingWith("app/http/wire_models.py");
    expect(models).toContain('if "core" not in self.parts:');
    expect(e713Hits(models)).toEqual([]);
    const routes = await fileEndingWith("app/http/order_routes.py");
    expect(routes).toContain('if "ok" not in self.tags:');
  });

  it("the audit-history route `requires` gate and the operation `when` gate", async () => {
    const routes = await fileEndingWith("app/http/order_routes.py");
    const history = routes.slice(routes.indexOf('@router.get("/{id}/history"'));
    expect(history).toContain('if "sales.readOrders" not in current_user_.permissions:');
    expect(routes).toContain('if "archivable" not in found.tags:');
    expect(e713Hits(routes)).toEqual([]);
  });
});
