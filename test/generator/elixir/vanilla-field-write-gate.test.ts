import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// Vanilla (plain Ecto/Phoenix) write-side field authorization (`write(...)` /
// `readonly when`, authorization.md §5, M-T3.2 item 6 — the write-side twin of
// `mask unless`). A write-gated field whose name matches a CLIENT-SUPPLIED
// action param rejects with a fail-closed 403 BEFORE the domain call unless the
// ambient principal satisfies the field's predicate. The controller action has
// `conn` in scope, so it reads `current_user` straight off `conn.assigns` (the
// Auth plug populated it) — unlike the read serializer, which had no conn and
// used the process dictionary. Compile-verified separately (mix
// --warnings-as-errors); this pins the emit shape.

const SOURCE = `
system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { setSalary }
    context C {
      aggregate P with crudish, auditable {
        name: string
        salary: decimal write(currentUser.permissions.contains(permissions.setSalary))
      }
    }
  }
  api Api from C
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [C]
    dataSources: [st]
    serves: Api
    port: 4000
    auth: required
  }
}
`;

// A capability-free sibling aggregate (no write gate) — its controller must stay
// byte-identical, i.e. emit no gate at all.
const UNGATED = `
system S {
  user { id: string  role: string }
  subdomain M {
    context C {
      aggregate Q with crudish {
        name: string
        salary: decimal
      }
    }
  }
  api Api from C
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [C]
    dataSources: [st]
    serves: Api
    port: 4000
    auth: required
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

/** Extract a single `def <name>(...) do ... end` action body from a controller,
 *  bounded at the next top-level `def`/`defp` clause (or the module `end`). */
function action(controller: string, header: string): string {
  const start = controller.indexOf(header);
  expect(start, `${header} not emitted`).toBeGreaterThanOrEqual(0);
  const rest = controller.slice(start + header.length);
  const next = rest.search(/\n {2}defp? /);
  return next === -1 ? rest : rest.slice(0, next);
}

const GATE_PRED = 'Enum.member?(current_user.permissions, "m.setSalary")';
const GATE_403 =
  'ProblemDetails.problem_response(conn, 403, "Forbidden", "Forbidden: write salary")';

describe("vanilla write(...) — write-side field gate", () => {
  it("guards the create action with a fail-closed 403 before the domain call", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/controllers/p_controller.ex");
    const create = action(ctrl, "def create(conn, params) do");
    // binds the principal off conn.assigns (not the process dictionary), then a
    // fail-closed cond: nil principal OR failed predicate → 403.
    expect(create).toContain("current_user = Map.get(conn.assigns, :current_user)");
    expect(create).toContain(`not (current_user != nil and (${GATE_PRED})) ->`);
    expect(create).toContain(GATE_403);
    // the guard runs BEFORE the domain create call.
    expect(create.indexOf(GATE_403)).toBeLessThan(create.indexOf("create_p(params"));
  });

  it("guards the generic update action too", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/controllers/p_controller.ex");
    const update = action(ctrl, 'def update(conn, %{"id" => id} = params) do');
    expect(update).toContain("current_user = Map.get(conn.assigns, :current_user)");
    expect(update).toContain(`not (current_user != nil and (${GATE_PRED})) ->`);
    expect(update).toContain(GATE_403);
    expect(update.indexOf(GATE_403)).toBeLessThan(update.indexOf("update_p(record, attrs"));
  });

  it("emits no write gate for an aggregate with no write-gated field", async () => {
    const ctrl = file(await generateSystemFiles(UNGATED), "/controllers/q_controller.ex");
    expect(ctrl).not.toContain("Forbidden: write");
    expect(ctrl).not.toContain("not (current_user != nil");
  });
});
