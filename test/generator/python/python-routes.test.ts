import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — HTTP layer (plan S7): Pydantic wire DTOs (camelCase
// wire keys, parity component names), APIRouter per aggregate with the
// canonical route set, RFC 7807 handlers incl. the 422 errors[]
// extension, and main.py router wiring.  Verified end-to-end against a
// live Postgres + uvicorn during the slice (create 201/{id}, get 200,
// op 204, precondition 400, missing 404, validation 422 + pointers).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (f: string) =>
  fs.readFileSync(path.resolve(here, `../../e2e/fixtures/python-build/${f}`), "utf8");

async function build(fixture: string) {
  const { model, errors } = await parseString(load(fixture));
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python wire DTOs", () => {
  it("VO wire models live in wire_models.py with wire-cased fields", async () => {
    const files = await build("shell.ddd");
    const models = files.get("api/app/http/wire_models.py")!;
    expect(models).toContain("class Price(BaseModel):");
    expect(models).toContain("    amount: float");
    expect(models).toContain("    currency: str");
  });

  it("response models mirror the wire shape (camelCase keys, ISO datetimes as str)", async () => {
    const files = await build("domain.ddd");
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain("class OrderResponse(BaseModel):");
    expect(routes).toContain("    placedAt: str");
    // Money crosses as its canonical decimal STRING (cross-backend wire).
    expect(routes).toContain("    unitBudget: str");
    expect(routes).toContain("    watchers: list[str]");
    expect(routes).toContain("    lines: list[OrderLineResponse]");
    // Derived VO rides the response; domain VO + wire model coexist via alias.
    expect(routes).toContain("    total: MoneyModel");
    expect(routes).toContain("from app.http.wire_models import Money as MoneyModel");
  });

  it("request models: create input set + per-op param sets", async () => {
    const files = await build("domain.ddd");
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain("class AddLineOrderRequest(BaseModel):");
    expect(routes).toContain("    price: MoneyModel");
    // Param-less op gets an empty body model.
    expect(routes).toContain("class ConfirmOrderRequest(BaseModel):");
    // Constructible aggregate carries the create request/response pair.
    const customer = files.get("api/app/http/customer_routes.py")!;
    expect(customer).toContain("class CreateCustomerRequest(BaseModel):");
    expect(customer).toContain("    name: str");
  });

  it("derives Field constraints + a @model_validator for invariants → 422 at the boundary", async () => {
    const src = `
system Demo {
  subdomain S {
    context C {
      aggregate Account with crudish {
        handle: string
        email: string
        invariant handle.length > 0
        invariant handle != email
      }
      repository AccountRepo for Account { }
    }
  }
  api AccountApi from S
  deployable pyApi { platform: python contexts: [C] serves: AccountApi port: 8000 }
}
`;
    const { model, errors } = await parseString(src);
    if (errors.length) throw new Error(errors.join("\n"));
    const files = generateSystems(model).files;
    const routes = [...files.entries()].find(([k]) => /account_routes\.py$/i.test(k))?.[1];
    expect(routes).toBeDefined();
    if (!routes) throw new Error("account_routes.py not emitted");
    // Single-field invariant → Pydantic Field constraint (FastAPI 422 on bad input).
    expect(routes).toContain("handle: str = Field(min_length=1)");
    // Cross-field invariant → @model_validator that raises ValueError → 422,
    // instead of falling through to the domain's DomainError → 400.
    expect(routes).toMatch(/from pydantic import .*\bField\b.*\bmodel_validator\b/);
    expect(routes).toMatch(/@model_validator\(mode="after"\)/);
    expect(routes).toContain("if not (self.handle != self.email):");
    expect(routes).toContain('raise ValueError("Invariant violated: handle != email")');
  });
});

describe("python routes", () => {
  it("create route only on constructible aggregates (201 + {id})", async () => {
    const files = await build("domain.ddd");
    const order = files.get("api/app/http/order_routes.py")!;
    const customer = files.get("api/app/http/customer_routes.py")!;
    // Order is not constructible — no POST create route, no domain import.
    expect(order).not.toContain('@router.post("", status_code=201');
    expect(order).not.toContain("from app.domain.order import Order\n");
    // Customer is — full create route.
    expect(customer).toContain(
      '@router.post("", status_code=201, response_model=CreateCustomerResponse, operation_id="createCustomer", responses={400: {"model": ProblemDetails, "description": "Bad Request"}, 422: {"model": ProblemDetails, "description": "Unprocessable Entity"}})',
    );
    expect(customer).toContain(
      "created = Customer.create(name=body.name, is_deleted=body.isDeleted)",
    );
    expect(customer).toContain('return {"id": created.id}');
  });

  it("operation routes load, invoke with coerced args, save, 204", async () => {
    const files = await build("domain.ddd");
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain(
      '@router.post("/{id}/add_line", status_code=204, operation_id="addLineOrder", responses={400: {"model": ProblemDetails, "description": "Bad Request"}, 404: {"model": ProblemDetails, "description": "Not Found"}, 422: {"model": ProblemDetails, "description": "Unprocessable Entity"}})',
    );
    expect(routes).toContain("found = await repo.get_by_id(OrderId(id))");
    expect(routes).toContain(
      "found.add_line(body.qty, Money(body.price.amount, body.price.currency))",
    );
    expect(routes).toContain("await repo.save(found)");
    expect(routes).toContain("return Response(status_code=204)");
  });

  it("all + byId routes project through to_wire with parity operationIds", async () => {
    const files = await build("domain.ddd");
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain(
      '@router.get("", response_model=OrderListResponse, operation_id="allOrder")',
    );
    expect(routes).toContain(
      '@router.get("/{id}", response_model=OrderResponse, operation_id="getOrderById", responses={404: {"model": ProblemDetails, "description": "Not Found"}})',
    );
    expect(routes).toContain("return repo.to_wire(await repo.get_by_id(OrderId(id)))");
  });

  it("routers mount at the plural slug and main.py wires them + error handlers", async () => {
    const files = await build("domain.ddd");
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain('router = APIRouter(prefix="/orders", tags=["orders"])');
    const main = files.get("api/app/main.py")!;
    expect(main).toContain("from app.http.order_routes import router as order_router");
    expect(main).toContain('app.include_router(order_router, prefix="/api")');
    expect(main).toContain("install_error_handlers(app)");
  });

  it("problem.py carries the RFC 7807 envelope + 422 errors[] pointers", async () => {
    const files = await build("shell.ddd");
    const problem = files.get("api/app/http/problem.py")!;
    expect(problem).toContain('"type": "about:blank",');
    expect(problem).toContain('"instance": request.url.path,');
    expect(problem).toContain("@app.exception_handler(DomainError)");
    expect(problem).toContain("@app.exception_handler(AggregateNotFoundError)");
    expect(problem).toContain("@app.exception_handler(RequestValidationError)");
    expect(problem).toContain('{"pointer": _pointer(tuple(e["loc"])), "message": str(e["msg"])}');
  });
});
