// The LIST read's `requires` gate, on all five backends at once — because the
// interesting property is that they AGREE, and for a long time they did not.
//
// Every aggregate serves one list endpoint (`GET /<aggs>`), backed by the
// repository find named `all`.  Usually that find is the one enrichment injects,
// but an author may declare their own and gate it:
//
//     repository Orders for Order {
//       find all(): Order[] requires currentUser.role == "admin"
//     }
//
// node/Hono and .NET emit a route per repository find, so `all` was just
// another entry and picked the gate up for free.  Java, Python and Elixir each
// special-case `all` OUT of their named-find loop (the list endpoint has a
// bespoke shape — paging controls, the `<Agg>Paged` envelope, Phoenix's
// `index`) and each then emitted that bespoke route without ever reading the
// find's `requires`.  Same `.ddd`, 403 on two backends and wide open on three —
// and every compile tier stayed green, because a missing guard is not a syntax
// error anywhere.
//
// Both spellings are pinned: the bare `T[]` list and the `paged` carrier, since
// each backend renders the two through different arms and the gate has to land
// in both.  The negative case is pinned too: an ungated aggregate emits no gate
// machinery at all (no principal binding, no accessor injection, no 403), so
// this can't pass by emitting a gate unconditionally.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const GATE = 'requires currentUser.role == "admin"';

const system = (platform: string, findClause: string) => `system Shop {
  user { id: string role: string }
  subdomain Sales {
    context Orders {
      aggregate Order { code: string }
      repository Orders for Order {
        ${findClause}
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api { platform: ${platform} contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 auth: required }
}`;

async function fileEndingWith(
  platform: string,
  findClause: string,
  suffix: string,
): Promise<string> {
  const files = await generateSystemFiles(system(platform, findClause));
  for (const [path, content] of files) if (path.endsWith(suffix)) return content;
  throw new Error(`no generated file ending with ${suffix} (platform ${platform})`);
}

/** The five (platform, file, gate-guard, list-read call) tuples.  `guard` is the
 *  exact emitted 403 check; `read` is the query it must precede. */
const BACKENDS = [
  {
    name: "node",
    file: "http/order.routes.ts",
    guard: (): string => 'if (!(currentUser.role === "admin")) throw new ForbiddenError(',
    read: "repo.all(",
  },
  {
    name: "dotnet",
    file: "Queries/AllHandler.cs",
    guard: (): string =>
      'if (!(currentUser.Role == "admin")) throw new ForbiddenException("Forbidden: find all");',
    read: "_repo.",
  },
  {
    name: "java",
    file: "OrdersController.java",
    guard: (): string =>
      'if (!(Objects.equals(currentUser.role(), "admin"))) throw new ForbiddenException("Forbidden: find all");',
    read: "service.allOrder(",
  },
  {
    name: "python",
    file: "http/order_routes.py",
    guard: (): string => 'raise ForbiddenError("Forbidden: find all")',
    read: "repo.all(",
  },
  {
    name: "elixir",
    file: "controllers/order_controller.ex",
    guard: (): string => '"Forbidden: find all"',
    read: "Orders.list_orders(",
  },
] as const;

for (const shape of ["bare", "paged"] as const) {
  const decl = shape === "bare" ? "find all(): Order[] " : "find all(): Order paged ";
  describe(`list-read \`requires\` gate — ${shape} list`, () => {
    for (const b of BACKENDS) {
      it(`${b.name}: 403s BEFORE the list query runs`, async () => {
        const out = await fileEndingWith(b.name, `${decl}${GATE}`, b.file);
        const gateAt = out.indexOf(b.guard());
        expect(gateAt, `gate not emitted on ${b.name}`).toBeGreaterThan(-1);
        const readAt = out.indexOf(b.read);
        expect(readAt, `list read not found on ${b.name}`).toBeGreaterThan(-1);
        // The guard runs first.  On node/python/elixir the gate and the read
        // share one handler; on dotnet/java they are the handler's first and
        // last statements.  Either way the order is the whole point: a gate
        // that ran after the query would already have read the rows.
        expect(readAt).toBeGreaterThan(gateAt);
      });
    }
  });
}

describe("an UNGATED list read emits no gate machinery", () => {
  // The mutation control.  Without this, emitting a gate unconditionally would
  // pass every assertion above.
  for (const b of BACKENDS) {
    it(`${b.name}: no 403, no principal binding`, async () => {
      const out = await fileEndingWith(b.name, "find all(): Order[]", b.file);
      expect(out).not.toContain("Forbidden: find all");
      expect(out).not.toContain('"admin"');
    });
  }
});
