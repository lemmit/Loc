// The workflow instance-READ gate (`workflow X requires <expr> { … }`) on all
// five backends — M-T3.15 §A2.
//
// `GET /workflows/<wf>/instances` and `.../instances/{id}` publish every
// instance's correlation id and state. They were ungated on every backend and
// invisible to `validateDefaultDeny` — the last member of the system-read class
// still in the "ungated" column after #2523 moved the folded projection out of
// it.
//
// They were also UNGATEABLE, which is why an emitter fix alone was never the
// answer: a workflow had no author-facing surface to hang a read gate on.
// Commands carry `requires` in their bodies; finds and projections carry it on
// the declaration header. This adds the header clause and enforces it.
//
// The contract pinned here, per backend:
//   1. BOTH instance routes gate — an ungated list is the same leak with half
//      the surface, and an ungated by-id read lets a caller confirm that a
//      correlation id exists.
//   2. The gate precedes the read, so a denied caller never reaches the store.
//   3. The COMMAND route keeps its own body gate. The two are independent: this
//      fixture gates the command on `clerk` and the reads on `supervisor`
//      precisely so a backend that conflated them would fail here.
//
// The negative case is pinned too — an ungated workflow emits no gate
// machinery at all, so this cannot pass by gating unconditionally.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const READ_GATE = ' requires currentUser.role == "supervisor"';

const system = (platform: string, gate: string) => `system Shop {
  user { id: string role: string }
  subdomain Sales {
    context Orders {
      aggregate Order { code: string }
      repository Orders for Order { }
      workflow Fulfilment${gate} {
        orderId: Order id
        stage: string
        create start(order: Order id) {
          requires currentUser.role == "clerk"
          orderId := order
          stage := "started"
        }
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable d { platform: ${platform} contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 auth: required }
}`;

async function fileEndingWith(platform: string, gate: string, suffix: string): Promise<string> {
  const files = await generateSystemFiles(system(platform, gate));
  for (const [path, content] of files) if (path.endsWith(suffix)) return content;
  throw new Error(`no generated file ending with ${suffix} (platform ${platform})`);
}

/** Per backend: the file carrying the instance reads, the emitted 403 guard,
 *  and — per route — where the handler starts and the store read it performs.
 *  Assertions are scoped to the slice at `at`, so an anchor cannot be satisfied
 *  by an identical string in a sibling handler. */
const BACKENDS = [
  {
    name: "node",
    file: "http/workflows.ts",
    guard:
      'if (!(currentUser.role === "supervisor")) throw new ForbiddenError("Forbidden: workflow Fulfilment instances");',
    list: {
      at: 'operationId: "allFulfilmentInstances"',
      read: "db.select().from(schema.fulfilments)",
    },
    byKey: {
      at: 'operationId: "getFulfilmentInstanceById"',
      read: "db.select().from(schema.fulfilments)",
    },
  },
  {
    name: "dotnet",
    file: "OrdersWorkflowInstancesController.cs",
    guard:
      'if (!(currentUser.Role == "supervisor")) throw new ForbiddenException("Forbidden: workflow Fulfilment instances");',
    list: { at: "AllFulfilmentInstances()", read: "AsNoTracking().ToListAsync()" },
    byKey: { at: "GetFulfilmentInstanceById(", read: "FirstOrDefaultAsync(" },
  },
  {
    name: "java",
    file: "OrdersWorkflowInstancesController.java",
    guard:
      'if (!(Objects.equals(currentUser.role(), "supervisor"))) throw new ForbiddenException("Forbidden: workflow Fulfilment instances");',
    list: { at: "allFulfilmentInstances()", read: ".findAll()" },
    byKey: { at: "getFulfilmentInstanceById(", read: ".findById(" },
  },
  {
    name: "python",
    file: "http/workflows_routes.py",
    guard: 'raise ForbiddenError("Forbidden: workflow Fulfilment instances")',
    list: { at: "async def fulfilment_instances(", read: "session.execute(select(FulfilmentRow))" },
    byKey: { at: "async def fulfilment_instance(", read: "session.get(FulfilmentRow, id)" },
  },
  {
    name: "elixir",
    file: "controllers/workflow_instances_controller.ex",
    guard: '"Forbidden: workflow Fulfilment instances"',
    list: { at: "def fulfilment_instances(", read: "Repo.all(" },
    byKey: { at: "def fulfilment_instance(", read: "Repo.get(" },
  },
] as const;

describe("workflow instance-read gate", () => {
  for (const b of BACKENDS) {
    it(`${b.name}: gates BOTH instance routes, each before its read`, async () => {
      const out = await fileEndingWith(b.name, READ_GATE, b.file);
      const occurrences = out.split(b.guard).length - 1;
      expect(occurrences, `expected 2 gates on ${b.name}, got ${occurrences}`).toBe(2);
      for (const route of [b.list, b.byKey]) {
        const start = out.indexOf(route.at);
        expect(start, `handler '${route.at}' not found on ${b.name}`).toBeGreaterThan(-1);
        const body = out.slice(start);
        const gateAt = body.indexOf(b.guard);
        const readAt = body.indexOf(route.read);
        expect(gateAt, `no gate in '${route.at}' on ${b.name}`).toBeGreaterThan(-1);
        expect(readAt, `no read in '${route.at}' on ${b.name}`).toBeGreaterThan(-1);
        expect(readAt).toBeGreaterThan(gateAt);
      }
    });
  }

  for (const b of BACKENDS) {
    it(`${b.name}: an UNGATED workflow emits no instance gate`, async () => {
      const out = await fileEndingWith(b.name, "", b.file);
      expect(out).not.toContain("Forbidden: workflow Fulfilment instances");
      expect(out).not.toContain('"supervisor"');
    });
  }

  it("the read gate is independent of the command gate", async () => {
    // The command is gated on `clerk`, the reads on `supervisor`. A backend
    // that reused one predicate for both — or let the header gate swallow the
    // command — would show the wrong role at one of the two sites.
    const out = await fileEndingWith("node", READ_GATE, "http/workflows.ts");
    const cmdAt = out.indexOf('operationId: "fulfilmentWorkflow"');
    const listAt = out.indexOf('operationId: "allFulfilmentInstances"');
    expect(cmdAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(cmdAt);
    const command = out.slice(cmdAt, listAt);
    expect(command).toContain('currentUser.role === "clerk"');
    expect(command).not.toContain('"supervisor"');
    expect(out.slice(listAt)).not.toContain('"clerk"');
  });

  it("declares the 403 it can answer, not just enforces it", async () => {
    expect(await fileEndingWith("node", READ_GATE, "http/workflows.ts")).toContain(
      '403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemDetails } } },',
    );
    expect(
      await fileEndingWith("dotnet", READ_GATE, "OrdersWorkflowInstancesController.cs"),
    ).toContain("[ProducesResponseType(typeof(ProblemDetails), 403)]");
    expect(await fileEndingWith("python", READ_GATE, "http/workflows_routes.py")).toContain(
      '403: {"model": ProblemDetails, "description": "Forbidden"}',
    );
  });
});
