// Entity history on Elixir/Phoenix (plain Ecto) — the read side of the
// `audited` trail (docs/audit.md).  The RUNTIME contract is proven by the
// behavioral leg (`node run-elixir.mjs audit-history` diffs the booted app's
// responses against the node-minted wire golden), and `mix compile
// --warnings-as-errors` proves the emitted project is sound.  This suite is the
// fast per-PR net over the emission SHAPE, and specifically over the guards — a
// masking or scoping regression should fail here in seconds rather than waiting
// for a backend boot.
//
// Mirrors `test/generator/audit-history-node.test.ts` and
// `test/generator/python/audit-history-python.test.ts` assertion-for-assertion:
// the three guards are the same three guards, because the shape, the diff
// boundary and the masking rule are platform-neutral
// (`src/ir/util/audit-history.ts`) and only their spelling is per-backend.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

/** Audited, with a masked field, a lifecycle stamp and a `versioned` counter —
 *  one of each thing the diff boundary has to suppress — plus a gated list read
 *  for history to inherit. */
const MASKED = `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      aggregate Employee audited with versioned, auditable {
        name: string
        salary: decimal mask unless currentUser.permissions.contains(permissions.unmask)
        create(name: string, salary: decimal) {
          name := name
          salary := salary
        }
        operation rename(name: string) { name := name }
      }
      repository Employees for Employee {
        find all(): Employee[] requires currentUser.role == "hr"
      }
    }
  }
  api A from M
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: elixir  contexts: [C]  dataSources: [st]  serves: A  port: 8080  auth: required }
}`;

/** The same system with a scaffolded LiveView ui mounted on the SAME elixir
 *  deployable — the in-process read seam (`QueryView { of: <Agg>.history(id) }`
 *  on the scaffolded Detail page), which has no HTTP request and therefore no
 *  ambient principal. */
const MASKED_UI = MASKED.replace(
  "  api A from M",
  "  ui W with scaffold(contexts: [C]) { }\n  api A from M",
).replace("serves: A  port: 8080", "serves: A  ui: W  port: 8080");

async function emit(src: string): Promise<Map<string, string>> {
  const { model } = await parseString(src);
  return generateSystems(model).files;
}

const fileEndingWith = (files: Map<string, string>, suffix: string): string => {
  for (const [p, c] of files) if (p.endsWith(suffix)) return c;
  throw new Error(`no file ending in ${suffix}; have ${[...files.keys()].join(", ")}`);
};

describe("entity history — elixir route surface", () => {
  it("serves GET /<plural>/:id/history off the derived find", async () => {
    const files = await emit(MASKED);
    const router = fileEndingWith(files, "lib/api_web/router.ex");
    expect(router).toContain('get "/employees/:id/history", EmployeeController, :history');
    const controller = fileEndingWith(files, "controllers/employee_controller.ex");
    expect(controller).toContain('def history(conn, %{"id" => id}) do');
    expect(controller).toContain('Api.Audit.History.for_target(Api.Repo, "Employee", id)');
  });

  it("queries audit_records on the indexed (target_type, target_id) pair, oldest first", async () => {
    const mod = fileEndingWith(await emit(MASKED), "lib/api/audit/history.ex");
    expect(mod).toContain("r.target_type == ^target_type and r.target_id == ^target_id");
    // Oldest first — a timeline reads forwards.  The `audit_id` tiebreak is
    // load-bearing HERE and on no other backend: Ecto's `:utc_datetime`
    // truncates `at` to the second, so two commands inside one second would
    // otherwise come back in planner order.
    expect(mod).toContain("order_by: [asc: r.at, asc: r.audit_id]");
  });

  it("emits the shared shape module once, with no aggregate knowledge in it", async () => {
    const mod = fileEndingWith(await emit(MASKED), "lib/api/audit/history.ex");
    expect(mod).toContain("defmodule Api.Audit.History do");
    expect(mod).toContain("def value_changed?(");
    expect(mod).toContain("def snapshot_value(");
    expect(mod).not.toContain("Employee");
  });

  it("declares the route in its own OpenAPI, so spec and router agree", async () => {
    // This backend has twice shipped a route its published spec disagreed with
    // (the PATCH-vs-POST `update` path, the unmounted `can_<op>` probe), and
    // `conformance-parity` cannot see it because it diffs SPECS.  The route and
    // the PathItem ride ONE predicate (`servesHistory`); this pins that.
    const files = await emit(MASKED);
    const spec = fileEndingWith(files, "lib/api_web/api/a_spec.ex");
    expect(spec).toContain('"/employees/{id}/history" => %OpenApiSpex.PathItem{');
    // Same operationId helper the node port uses — one name across backends.
    expect(spec).toContain('operationId: "historyEmployee"');
    // The gate exists, so the 403 it produces is declared.
    expect(spec).toMatch(/history"[\s\S]*?403 => %OpenApiSpex\.Response\{/);
    // The body schema is built from the platform-neutral `auditEntryWireShape`,
    // so the published keys cannot drift from the mapper's.
    const schema = fileEndingWith(files, "api/schemas/audit_entry.ex");
    expect(schema).toContain('title: "AuditEntry"');
    expect(schema).toContain("changes: %OpenApiSpex.Schema{type: :array");
    expect(schema).toContain("required: [:auditId, :at, :action, :operationId, :changes]");
  });
});

describe("entity history — elixir negative authz", () => {
  it("DROPS a masked field's change entry rather than redacting it", async () => {
    const controller = fileEndingWith(await emit(MASKED), "controllers/employee_controller.ex");
    // Unmasked fields go through the unconditional loop; `salary` must not.
    expect(controller).toContain('Enum.flat_map(["name"], fn key ->');
    expect(controller).not.toContain('Enum.flat_map(["name", "salary"], fn key ->');
    // Its entry is appended only inside the predicate guard, so a caller who
    // fails the predicate sees no entry at all — a redacted-but-present entry
    // would still disclose that it changed, when, and by whom.
    expect(controller).toMatch(
      /if current_user != nil and \([^\n]*permissions[^\n]*\) do\n(?:.*\n)*?\s+changes \+\+ \[%\{"field" => "salary"/,
    );
    // ...and never as a redaction-style nulled entry.
    expect(controller).not.toContain('%{"field" => "salary", "before" => nil, "after" => nil}');
  });

  it("is fail-closed on an unauthenticated caller", async () => {
    const controller = fileEndingWith(await emit(MASKED), "controllers/employee_controller.ex");
    const mapper = controller.slice(controller.indexOf("defp employee_audit_entry"));
    // The SAME ambient principal the redacting `serialize/1` masks against
    // (`Process.get(:loom_current_user)`, stashed by the Auth plug) — no
    // principal → nil → the `current_user != nil` guard short-circuits and every
    // masked entry drops.
    expect(mapper).toContain("current_user = Process.get(:loom_current_user)");
    expect(mapper).toContain("if current_user != nil and (");
  });

  it("inherits the list read's gate — 403 before any query runs", async () => {
    const controller = fileEndingWith(await emit(MASKED), "controllers/employee_controller.ex");
    const handler = controller.slice(controller.indexOf('def history(conn, %{"id" => id})'));
    expect(handler).toContain('if not (current_user.role == "hr") do');
    expect(handler).toContain(
      'ProblemDetails.problem_response(conn, 403, "Forbidden", "Forbidden: history Employee")',
    );
    // The gate runs BEFORE the entity read and before the audit table is
    // touched, so a denied caller cannot even probe for the row's existence.
    expect(handler.indexOf("403")).toBeLessThan(handler.indexOf("C.get_employee(id)"));
    expect(handler.indexOf("403")).toBeLessThan(handler.indexOf("Audit.History.for_target"));
  });

  it("scopes by entity reachability, so a filtered-out row 404s instead of leaking", async () => {
    const controller = fileEndingWith(await emit(MASKED), "controllers/employee_controller.ex");
    const handler = controller.slice(controller.indexOf('def history(conn, %{"id" => id})'));
    // `audit_records` carries no tenant column, so there is nothing on it for a
    // capability filter to scope.  The handler resolves the ENTITY first —
    // `get_<agg>` already carries every capability predicate — and only reads
    // the trail for a row this caller can see.
    expect(handler).toContain("case C.get_employee(id) do");
    expect(handler).toContain('ProblemDetails.not_found_response(conn, "Employee", id)');
    expect(handler.indexOf("C.get_employee(id)")).toBeLessThan(
      handler.indexOf("Audit.History.for_target"),
    );
  });

  it("never lets a stamp, the version counter, or the id into the diff", async () => {
    const controller = fileEndingWith(await emit(MASKED), "controllers/employee_controller.ex");
    const mapper = controller.slice(controller.indexOf("defp employee_audit_entry"));
    const keyLoop = mapper.slice(0, mapper.indexOf('"auditId" =>'));
    // `auditable` stamps these post-save and `versioned` bumps `version` on
    // every command — left in, they would be most of the timeline.
    expect(keyLoop).not.toContain("updatedAt");
    expect(keyLoop).not.toContain("createdAt");
    expect(keyLoop).not.toContain('"version"');
    expect(keyLoop).not.toContain('"id"');
  });
});

describe("entity history — aggregates that serve none", () => {
  it("emits no history route, action or module when nothing is audited", async () => {
    const files = await emit(MASKED.replace("aggregate Employee audited", "aggregate Employee"));
    expect([...files.keys()].some((p) => p.endsWith("lib/api/audit/history.ex"))).toBe(false);
    expect([...files.keys()].some((p) => p.endsWith("api/schemas/audit_entry.ex"))).toBe(false);
    expect(fileEndingWith(files, "lib/api_web/router.ex")).not.toContain("/history");
    expect(fileEndingWith(files, "controllers/employee_controller.ex")).not.toContain(
      "def history(conn",
    );
    expect(fileEndingWith(files, "lib/api_web/api/a_spec.ex")).not.toContain("/history");
  });
});

// ---------------------------------------------------------------------------
// The LiveView read seam.  A Phoenix deployable that also mounts the ui hosts
// its contexts in the SAME OTP app, so the scaffolded Detail page's History
// section reads `audit_records` in-process — no api client, no fetch.  Before
// this, `HISTORY_CAPABLE_FRAMEWORKS` excluded `phoenixLiveView` and the whole
// view was dropped, leaving a labelled EMPTY History card on every audited
// aggregate with no compile-time signal anywhere.
//
// What has to hold is that the in-process seam applies the SAME three guards
// the controller action does — a second front door authorized on one seam only
// is exactly the hole the projection loader's gate exists to prevent.
// ---------------------------------------------------------------------------
describe("entity history — the LiveView (in-process) read seam", () => {
  const liveView = async (): Promise<string> =>
    fileEndingWith(await emit(MASKED_UI), "live/employee_detail_live.ex");

  it("loads the trail through its own loader, not the aggregate's list", async () => {
    const live = await liveView();
    expect(live).toContain("load_employee_history(socket, socket.assigns.id)");
    expect(live).toContain('Api.Audit.History.for_target(Api.Repo, "Employee", id)');
    // The misbinding the skip existed to prevent: the trail is not the list.
    expect(live).not.toContain("list_employees()");
  });

  it("carries guard 1 — the find's gate, evaluated BEFORE any query", async () => {
    const live = await liveView();
    const loader = live.slice(live.indexOf("defp load_employee_history"));
    expect(loader).toContain('current_user.role == "hr"');
    expect(loader.indexOf('current_user.role == "hr"')).toBeLessThan(
      loader.indexOf("C.get_employee("),
    );
    // A denial takes the `:error` sentinel the view's error arm renders — the
    // LiveView shape of the route's 403.
    expect(loader).toContain(":error");
  });

  it("carries guard 2 — reachability rides the entity read", async () => {
    const loader = (await liveView()).split("defp load_employee_history")[1] ?? "";
    expect(loader).toContain("case Api.C.get_employee(id) do");
    expect(loader.indexOf("Api.C.get_employee(id)")).toBeLessThan(
      loader.indexOf("Audit.History.for_target"),
    );
  });

  it("carries guard 3 — the mask, against the SOCKET's principal", async () => {
    const live = await liveView();
    // The controller reads the ambient principal the Auth plug stashes.  A
    // LiveView is a separate socket process where that is `nil`, so an ambient
    // mapper would drop every masked entry for a caller entitled to see it.
    // The principal is threaded as an ARGUMENT instead.
    expect(live).toContain("defp employee_audit_entry(row, current_user) do");
    expect(live).toContain("fn row -> employee_audit_entry(row, current_user) end");
    expect(live).toContain("current_user = Map.get(socket.assigns, :current_user)");
    const loader = live.slice(live.indexOf("defp load_employee_history"));
    expect(loader).not.toContain("Process.get(:loom_current_user)");
    // …and it is a real mask: the predicate still guards the salary entry.
    expect(live).toContain('changes ++ [%{"field" => "salary"');
  });

  it("renders the trail through the same Timeline the JSX frontends use", async () => {
    const live = await liveView();
    expect(live).toContain('<ol class="loom-timeline"');
    expect(live).toContain("<%= for e <- @employee_history || [] do %>");
    // The assign is named after the AGGREGATE, not the `data:` lambda param —
    // two reads binding `entries` on one page would otherwise collide.
    expect(live).toContain("assign(socket, :employee_history,");
  });

  it("emits neither loader nor mapper when nothing is audited", async () => {
    const files = await emit(MASKED_UI.replace("aggregate Employee audited", "aggregate Employee"));
    const live = fileEndingWith(files, "live/employee_detail_live.ex");
    expect(live).not.toContain("load_employee_history");
    expect(live).not.toContain("employee_audit_entry");
    expect(live).not.toContain("loom-timeline");
  });
});
