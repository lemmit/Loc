import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — command workflows (plan S15a).  POST /workflows/
// <snake> coerces params, executes the WorkflowStmtIR body over the
// request session, saves let-bound aggregates at exit; repositories
// flush and the session dependency commits once per request, so
// transactional workflows are atomic by construction.  Verified live
// (rename persisted, 404 propagation).  Sagas/dispatcher are S15b.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/domain.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python workflows", () => {
  it("emits the POST route with coerced params + repo wiring + exit saves", async () => {
    const files = await build();
    const wf = files.get("api/app/http/workflows_routes.py")!;
    expect(wf).toContain("class RenameCustomerRequest(BaseModel):");
    expect(wf).toContain(
      '@router.post("/rename_customer", status_code=204, operation_id="renameCustomerWorkflow", responses={400: {"model": ProblemDetails, "description": "Bad Request"}, 422: {"model": ProblemDetails, "description": "Unprocessable Entity"}})',
    );
    // The route runs in a child execution-context frame under the request root
    // (parent_id chaining), so its audit/provenance rows are distinguishable
    // from a direct operation's. The decorator sits below @router.post (closest
    // to the def) so FastAPI registers the wrapped handler.
    expect(wf).toMatch(
      /@router\.post\([^\n]*\n@in_child_context\nasync def rename_customer_workflow/,
    );
    expect(wf).toContain("from app.obs.log import in_child_context, log");
    expect(wf).toContain("customer_id = CustomerId(body.customerId)");
    expect(wf).toContain("customers = CustomerRepository(session, NoopDomainEventDispatcher())");
    expect(wf).toContain("c = await customers.get_by_id(customer_id)");
    expect(wf).toContain("c.rename(new_name)");
    expect(wf).toContain("await customers.save(c)");
    const main = files.get("api/app/main.py")!;
    expect(main).toContain('app.include_router(workflows_router, prefix="/api")');
  });

  it("one transaction per request: repos flush, the dependency commits", async () => {
    const files = await build();
    const engine = files.get("api/app/db/engine.py")!;
    expect(engine).toContain("await session.commit()");
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo).toContain("await self._session.flush()");
    expect(repo).not.toContain("await self._session.commit()");
  });

  it("constructs the repository for a workflow whose only repo use is `if let`", async () => {
    // reposFor must collect the repo from the if-let statement itself (and
    // recurse into then/else) — a workflow like showcase's `touchActive`
    // otherwise references `projects` without ever assigning it (NameError).
    const src = `system IfLetWf {
      subdomain D {
        context Shop {
          criterion ActiveNamed(needle: string) of Project = this.active == true && this.name == needle
          aggregate Project with crudish {
            name: string
            active: bool
            operation touch() {
              active := true
            }
          }
          repository Projects for Project { }
          workflow touchActive {
            create(needle: string) {
              if let p = Projects.find(ActiveNamed(needle)) {
                p.touch()
              }
            }
          }
        }
      }
      api A from D
      storage primary { type: postgres }
      resource st { for: Shop, kind: state, use: primary }
      deployable api1 {
        platform: python
        contexts: [Shop]
        dataSources: [st]
        serves: A
        port: 8081
      }
    }`;
    const { model, errors } = await parseString(src);
    if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
    const wf = generateSystems(model).files.get("api1/app/http/workflows_routes.py")!;
    expect(wf).toContain("async def touch_active_workflow(");
    // The repo handle is constructed before the if-let retrieval uses it.
    expect(wf).toContain("projects = ProjectRepository(session, NoopDomainEventDispatcher())");
    expect(wf).toContain("__p_hits = await projects.run_find_all_by_active_named(needle, limit=1)");
    expect(wf.indexOf("projects = ProjectRepository")).toBeLessThan(
      wf.indexOf("__p_hits = await projects."),
    );
  });
});
