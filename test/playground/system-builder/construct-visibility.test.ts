import { type AstNode, AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import { spliceNode } from "../../../web/src/builder/edit-engine.js";
import { listBodies, workflowBodyStatements } from "../../../web/src/builder/system/body.js";
import { renameByAstType } from "../../../web/src/builder/system-v2/rename-extra.js";
import {
  buildViewGraph,
  findWorkflow,
  type VNode,
} from "../../../web/src/builder/system-v2/view-graph.js";
import { parseRaw as parse, parseRawOk } from "../../_helpers/index.js";

// One source carrying EVERY construct the v2 modeller newly renders, so the
// per-level assertions below all read from the same model. Written the way a
// user would write it (not minimised per-assertion) — the point of the wave is
// that a realistic file has nothing invisible left in it.
const SRC = `system Shop {
  user {
    id: string
    orgId: string
  }
  auth {
    provider: keycloak,
    enforcement: denyByDefault
  }
  tenancy by user.orgId of Tenant
  theme {
    primary: "#2f6feb"
  }
  storage Db {
    type: postgres
  }
  resource Blobs {
    for: Sales,
    kind: objectStore,
    use: Db
  }
  channelSource Bus {
    for: orders,
    use: Db
  }
  timerSource Nightly {
    for: Placed,
    cron: "0 0 * * *"
  }
  capability trackable {
    trackedAt: string
  }
  layout Shell {
    header { "top" }
    main
  }
  subdomain Selling {
    permissions {
      read
      edit implies read
      admin implies [read, edit]
    }
    context Sales {
      enum Status {
        Draft
        Sent
      }
      command PlaceOrder {
        sku: string
      }
      payload OrderResult = OrderOk | OrderFailed
      event Placed {
      }
      aggregate Tenant {
        title: string
      }
      aggregate Order with trackable {
        sku: string
        status: string
        secretNote: string mask unless currentUser.id == "root"
        unique(sku)
        create place(sku: string) {
          status := "draft"
        }
        destroy cancel() {
          status := "void"
        }
        apply(e: Placed) {
          status := "placed"
        }
        operation confirm() requires permissions.edit when status == "draft" {
          status := "Confirmed"
        }
        filter this.status != "void"
        stamp onCreate {
          status := "draft"
        }
        implements trackable
        test "confirming an order" {
        }
      }
      repository Orders for Order {
        find byId(id: int): Order? requires permissions.read where this.id == id
        find open(): Order[] where true
      }
      projection OrderRow(limit: int) keyed by sku {
        total: decimal
        on(e: Placed) {
          total := 1
        }
        from Order as o
        requires permissions.read
        join Tenant as t on o.sku
        select total = o.sku
      }
      domainService Pricing {
        operation quote(x: int): decimal {
          return 1
        }
        test "quotes" {
        }
      }
      channel OrderEvents {
        carries: Placed,
        delivery: queue,
        retention: log,
        key: sku
      }
      criterion ActiveOrder of Order as a = a.status
      retrieval OpenOrders of Order {
        where: this.status
        sort: [this.sku asc]
        loads: [this.status]
      }
      seed demo {
        Order { sku: "a" }
        Order { sku: "b" }
      }
      commandHandler PlaceIt(cmd: PlaceOrder): OrderResult {
        return 1
      }
      queryHandler GetIt(q: PlaceOrder): OrderResult {
        return 1
      }
      policy {
        allow deep on Order
        deny write on Tenant
      }
      policy canEdit(o: Order): bool = true
      filter this.status
      stamp onUpdate {
        status := "touched"
      }
      implements trackable
      test "context-level check" for Order {
      }
      workflow Fulfil {
        create(cmd: PlaceOrder) {
          let a = 1
        }
        handle approve(id: int) {
          let b = 2
          let c = 3
        }
        on(e: Placed) {
          let d = 4
        }
        apply(e: Placed) {
          let g = 5
        }
      }
    }
  }
  deployable api { platform: node, contexts: [Sales], port: 3000 }
  test e2e "smoke" against api {
  }
}

migration "rename-sku" {
  Order.sku -> code
}`;

const AST = parse(SRC);

const children = (g: ReturnType<typeof buildViewGraph>): VNode[] =>
  g.nodes.filter((n) => !n.isRoot);

const byId = (g: ReturnType<typeof buildViewGraph>, id: string): VNode => {
  const n = g.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id} in [${g.nodes.map((x) => x.id).join(", ")}]`);
  return n;
};

const ctxGraph = () => buildViewGraph(AST, [{ kind: "context", name: "Sales" }]);
const aggGraph = () => buildViewGraph(AST, [{ kind: "aggregate", name: "Order" }]);

describe("Model v2 — the fixture", () => {
  it("parses (every construct the visibility wave renders is real syntax)", () => {
    expect(parseRawOk(SRC)).toBe(true);
  });
});

describe("Model v2 — context-level constructs render as nodes", () => {
  it("surfaces every declaration-shelf ContextMember kind exactly once", () => {
    const kinds = children(ctxGraph())
      .map((n) => n.kind)
      .filter((k) => !["aggregate", "valueobject", "event", "repository", "workflow"].includes(k));
    expect([...new Set(kinds)].sort()).toEqual(
      [
        "channel",
        "commandhandler",
        "criterion",
        "domainservice",
        "enum",
        "filter",
        "implements",
        "payload",
        "policy",
        "projection",
        "queryhandler",
        "retrieval",
        "seed",
        "stamp",
        "test",
      ].sort(),
    );
  });

  it("projection shows from / join / select / keyed by, and drills in", () => {
    const n = byId(ctxGraph(), "projection:OrderRow");
    expect(n.name).toBe("OrderRow");
    expect(n.summary).toEqual([
      "from Order as o",
      "join Tenant as t",
      "select total",
      "keyed by sku",
      "1 fold",
    ]);
    expect(n.drillable).toBe(true);
  });

  it("domainService lists its operation names and drills in", () => {
    const n = byId(ctxGraph(), "domainservice:Pricing");
    expect(n.summary).toEqual(["operations: quote", "1 test"]);
    expect(n.drillable).toBe(true);
  });

  it("channel shows carried events + delivery", () => {
    expect(byId(ctxGraph(), "channel:OrderEvents").summary).toEqual([
      "carries: Placed",
      "delivery: queue",
      "retention: log",
      "key: sku",
    ]);
  });

  it("criterion shows its of-type and an expression preview", () => {
    expect(byId(ctxGraph(), "criterion:ActiveOrder").summary).toEqual([
      "of Order",
      "as a",
      "= a.status",
    ]);
  });

  it("retrieval shows its of-type plus where / sort / loads presence", () => {
    expect(byId(ctxGraph(), "retrieval:OpenOrders").summary).toEqual([
      "of Order",
      "where this.status",
      "1 sort term",
      "1 load path",
    ]);
  });

  it("payload shows the payload keyword and its union alternatives", () => {
    expect(byId(ctxGraph(), "payload:OrderResult").summary).toEqual([
      "kind: payload",
      "= OrderOk | OrderFailed",
    ]);
  });

  it("a record-form payload shows a field count instead of variants", () => {
    expect(byId(ctxGraph(), "payload:PlaceOrder").summary).toEqual(["kind: command", "1 field"]);
  });

  it("enum lists its cases", () => {
    expect(byId(ctxGraph(), "enum:Status").summary).toEqual(["cases: Draft, Sent"]);
  });

  it("seed shows the dataset name and row count", () => {
    const n = byId(ctxGraph(), "seed:0");
    expect(n.name).toBe("demo");
    expect(n.summary).toEqual(["2 rows"]);
  });

  it("command / query handlers show their signature", () => {
    expect(byId(ctxGraph(), "commandhandler:PlaceIt").summary).toEqual([
      "(cmd: PlaceOrder): OrderResult",
      "1 stmt",
    ]);
    expect(byId(ctxGraph(), "queryhandler:GetIt").summary).toEqual([
      "(q: PlaceOrder): OrderResult",
      "1 stmt",
    ]);
  });

  it("context-scope filter / stamp / implements / test render read-only", () => {
    const g = ctxGraph();
    expect(byId(g, "filter:0").name).toBe("this.status");
    expect(byId(g, "stamp:0")).toMatchObject({ name: "onUpdate", summary: ["1 assignment"] });
    expect(byId(g, "implements:trackable").name).toBe("trackable");
    expect(byId(g, "test:0")).toMatchObject({
      name: "context-level check",
      summary: ["for Order", "0 steps"],
    });
  });

  it("the declaration shelf sits below the workflow / aggregate / event spine", () => {
    const g = ctxGraph();
    const agg = byId(g, "aggregate:Order");
    expect(byId(g, "enum:Status").y).toBeGreaterThan(agg.y);
    expect(byId(g, "policy:canEdit").y).toBeGreaterThan(agg.y);
  });

  it("drilling into a domainService lists its operations as read-only leaves", () => {
    const g = buildViewGraph(AST, [
      { kind: "context", name: "Sales" },
      { kind: "domainservice", name: "Pricing" },
    ]);
    expect(g.title).toBe("domainservice Pricing");
    expect(byId(g, "dsoperation:quote")).toMatchObject({
      kind: "dsoperation",
      drillable: false,
      summary: ["(x: int): decimal", "1 stmt"],
    });
  });

  it("drilling into a projection lists its row fields and folds", () => {
    const g = buildViewGraph(AST, [
      { kind: "context", name: "Sales" },
      { kind: "projection", name: "OrderRow" },
    ]);
    expect(g.title).toBe("projection OrderRow");
    expect(
      children(g)
        .map((n) => n.id)
        .sort(),
    ).toEqual(["apply:0", "field:total"]);
    expect(byId(g, "apply:0")).toMatchObject({
      name: "on Placed",
      summary: ["(e: Placed)", "1 stmt"],
    });
  });
});

describe("Model v2 — system-level constructs render as nodes", () => {
  const sysGraph = () => buildViewGraph(AST, [{ kind: "system", name: "Shop" }]);

  it("surfaces every system-scope declaration", () => {
    const kinds = children(sysGraph()).map((n) => n.kind);
    expect(
      [
        "tenancy",
        "auth",
        "user",
        "theme",
        "resource",
        "channelsource",
        "timer",
        "capability",
        "layout",
        "teste2e",
      ].every((k) => kinds.includes(k as VNode["kind"])),
    ).toBe(true);
  });

  it("tenancy shows the claim and the registry aggregate", () => {
    expect(byId(sysGraph(), "tenancy:0").summary).toEqual(["by user.orgId", "of Tenant"]);
  });

  it("auth shows provider + enforcement", () => {
    expect(byId(sysGraph(), "auth:0").summary).toEqual([
      "provider: keycloak",
      "enforcement: denyByDefault",
    ]);
  });

  it("user shows the claim-field count; theme shows its tokens", () => {
    expect(byId(sysGraph(), "user:0").summary).toEqual(["2 claims"]);
    expect(byId(sysGraph(), "theme:0").summary).toEqual(["1 token", "primary"]);
  });

  it("resource shows kind + for-target", () => {
    expect(byId(sysGraph(), "resource:Blobs").summary).toEqual([
      "kind: objectStore",
      "for Sales",
      "use Db",
    ]);
  });

  it("channelSource shows its channel; timerSource shows its event + cadence", () => {
    expect(byId(sysGraph(), "channelsource:Bus").summary).toEqual(["for orders", "use Db"]);
    expect(byId(sysGraph(), "timer:Nightly").summary).toEqual(["for Placed", "cron 0 0 * * *"]);
  });

  it("capability shows its member count; layout shows its slot names", () => {
    expect(byId(sysGraph(), "capability:trackable").summary).toEqual(["1 member"]);
    expect(byId(sysGraph(), "layout:Shell").summary).toEqual(["slots: header, main"]);
  });

  it("test e2e shows its name and against-target", () => {
    expect(byId(sysGraph(), "teste2e:0")).toMatchObject({
      name: "smoke",
      summary: ["against api", "0 steps"],
    });
  });

  it("a file-scope migration block renders at the ROOT view", () => {
    const g = buildViewGraph(AST, []);
    expect(byId(g, "migration:rename-sku")).toMatchObject({
      kind: "migration",
      name: "rename-sku",
      summary: ["1 step"],
    });
  });
});

describe("Model v2 — authz visibility", () => {
  it("a subdomain's permissions catalogue renders with its implies closure", () => {
    const g = buildViewGraph(AST, [{ kind: "subdomain", name: "Selling" }]);
    expect(byId(g, "permissions:0")).toMatchObject({
      kind: "permissions",
      name: "permissions",
      summary: ["read", "edit implies read", "admin implies [read, edit]"],
    });
  });

  it("a block-form policy lists its allow / deny read rules", () => {
    expect(byId(ctxGraph(), "policy:0")).toMatchObject({
      name: "policy",
      summary: ["allow deep on Order", "deny write on Tenant"],
    });
  });

  it("a function-form policy shows its signature and body", () => {
    expect(byId(ctxGraph(), "policy:canEdit").summary).toEqual(["(o: Order): bool", "= true"]);
  });

  it("an operation with `requires` + `when` gets both badges, gate text included", () => {
    expect(byId(aggGraph(), "operation:confirm").badges).toEqual([
      { label: "requires", detail: "permissions.edit" },
      { label: "when", detail: 'status == "draft"' },
    ]);
  });

  it("a masked property gets a `mask` badge carrying the unless-predicate", () => {
    expect(byId(aggGraph(), "field:secretNote").badges).toEqual([
      { label: "mask", detail: 'unless currentUser.id == "root"' },
    ]);
    // An unmasked sibling carries no badge at all.
    expect(byId(aggGraph(), "field:sku").badges).toBeUndefined();
  });

  it("a gated repository find gets a `requires` badge; an open one does not", () => {
    const g = buildViewGraph(AST, [{ kind: "repository", name: "Orders" }]);
    expect(byId(g, "find:byId").badges).toEqual([
      { label: "requires", detail: "permissions.read" },
    ]);
    expect(byId(g, "find:open").badges).toBeUndefined();
  });

  it("a gated projection read gets a `requires` badge too", () => {
    expect(byId(ctxGraph(), "projection:OrderRow").badges).toEqual([
      { label: "requires", detail: "permissions.read" },
    ]);
  });
});

describe("Model v2 — aggregate-level completeness", () => {
  it("renders create / destroy / apply beside the operations", () => {
    const g = aggGraph();
    expect(byId(g, "create:place")).toMatchObject({
      kind: "create",
      name: "place",
      summary: ["(sku: string)", "1 stmt"],
    });
    expect(byId(g, "destroy:cancel")).toMatchObject({ kind: "destroy", summary: ["()", "1 stmt"] });
    expect(byId(g, "apply:0")).toMatchObject({
      kind: "apply",
      name: "apply Placed",
      summary: ["(e: Placed)", "1 stmt"],
    });
  });

  it("renders unique, the with-clause capabilities, filter / stamp / implements / test", () => {
    const g = aggGraph();
    expect(byId(g, "unique:0").name).toBe("(sku)");
    expect(byId(g, "with:0").summary).toEqual(["trackable"]);
    expect(byId(g, "filter:0").name).toBe('this.status != "void"');
    expect(byId(g, "stamp:0").name).toBe("onCreate");
    expect(byId(g, "implements:trackable").name).toBe("trackable");
    expect(byId(g, "test:0").name).toBe("confirming an order");
  });

  it("the declaration shelf sits below the state row, and everything is positioned", () => {
    const g = aggGraph();
    const field = byId(g, "field:sku");
    expect(byId(g, "unique:0").y).toBeGreaterThan(field.y);
    // No child may fall through the layout without coordinates.
    expect(children(g).every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("none of the read-only aggregate constructs claim to be drillable", () => {
    const g = aggGraph();
    for (const id of [
      "create:place",
      "destroy:cancel",
      "apply:0",
      "unique:0",
      "with:0",
      "test:0",
    ]) {
      expect(byId(g, id).drillable).toBe(false);
    }
  });
});

describe("Model v2 — workflow member picker", () => {
  const wf = () => {
    const found = findWorkflow(AST, "Fulfil");
    if (!found) throw new Error("fixture workflow missing");
    return found;
  };

  it("listBodies enumerates the workflow's create / handle / on / apply members", () => {
    expect(listBodies(wf()).map((b) => `${b.key}=${b.count}`)).toEqual([
      "create=1",
      "handle:approve=2",
      "on:Placed=1",
      "apply:Placed=1",
    ]);
  });

  it("each member key resolves to its own statement list", () => {
    for (const b of listBodies(wf())) {
      expect(workflowBodyStatements(wf(), b.key)).toHaveLength(b.count);
    }
  });

  it("the workflow view opens the primary create when no member is picked", () => {
    const g = buildViewGraph(AST, [{ kind: "workflow", name: "Fulfil" }]);
    expect(g.title).toBe("workflow Fulfil()");
    expect(children(g).map((n) => n.id)).toEqual(["stmt:0"]);
  });

  it("picking a member re-renders the statement flow for THAT body", () => {
    const g = buildViewGraph(AST, [{ kind: "workflow", name: "Fulfil" }], {
      workflowMember: "handle:approve",
    });
    expect(g.title).toBe("workflow Fulfil.handle:approve()");
    expect(children(g).map((n) => n.id)).toEqual(["stmt:0", "stmt:1"]);
    expect(children(g).every((n) => n.kind === "stmt")).toBe(true);
    expect(g.edges.filter((e) => e.kind === "next").map((e) => [e.source, e.target])).toEqual([
      ["stmt:0", "stmt:1"],
    ]);
  });

  it("the `on` and `apply` reactors open through the same flow", () => {
    for (const key of ["on:Placed", "apply:Placed"]) {
      const g = buildViewGraph(AST, [{ kind: "workflow", name: "Fulfil" }], {
        workflowMember: key,
      });
      expect(children(g).map((n) => n.id)).toEqual(["stmt:0"]);
    }
  });

  it("an unknown member key yields an empty flow rather than the wrong body", () => {
    const g = buildViewGraph(AST, [{ kind: "workflow", name: "Fulfil" }], {
      workflowMember: "handle:nope",
    });
    expect(children(g)).toEqual([]);
  });
});

// The read-only wave wires rename + delete ONLY where the declaration is
// plainly `ID`-named and splices out as one self-contained range — the same
// `renameByAstType` + `spliceNode` pair `valueobject` already rides. These two
// specs pin that the wiring is real for those kinds, so the claim in the pane's
// `AST_TYPE_BY_VIEW` comment isn't just aspirational.
describe("Model v2 — edits on the plainly-named read-only constructs", () => {
  const NAMED_KINDS: [string, string][] = [
    ["Projection", "OrderRow"],
    ["DomainService", "Pricing"],
    ["Channel", "OrderEvents"],
    ["Criterion", "ActiveOrder"],
    ["Retrieval", "OpenOrders"],
    ["EnumDecl", "Status"],
    ["CommandHandler", "PlaceIt"],
    ["QueryHandler", "GetIt"],
    ["Capability", "trackable"],
    ["Layout", "Shell"],
    ["Resource", "Blobs"],
    ["ChannelSource", "Bus"],
    ["TimerSource", "Nightly"],
  ];

  it.each(
    NAMED_KINDS,
  )("renames a %s by AST type, rewriting the declaration", async (type, name) => {
    const next = await renameByAstType(SRC, type, name, `${name}Renamed`);
    expect(next).not.toBeNull();
    expect(next).toContain(`${name}Renamed`);
    expect(parseRawOk(next as string)).toBe(true);
  });

  it.each(NAMED_KINDS)("deletes a %s by splicing its own range", (type, name) => {
    let target: AstNode | undefined;
    for (const n of AstUtils.streamAst(AST)) {
      if (n.$type === type && (n as { name?: string }).name === name) {
        target = n;
        break;
      }
    }
    expect(target).toBeDefined();
    const next = spliceNode(SRC, target as AstNode, "");
    expect(parseRawOk(next)).toBe(true);
    // The whole declaration — and nothing but it — left the source. (Matching
    // on its own CST text rather than on the name: `capability trackable`'s
    // name also appears in `aggregate Order with trackable {`, which must
    // survive the splice.)
    const declText = (target as AstNode).$cstNode?.text as string;
    expect(next).not.toContain(declText);
    expect(next.length).toBe(SRC.length - declText.length);
  });
});
