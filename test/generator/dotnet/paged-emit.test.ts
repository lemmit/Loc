// Generator coverage for paged finds on the .NET backend
// (payload-transport-layer.md, P3b emission — .NET slice).  A
// `find x(): <Agg> paged` emits: a `Paged<T>` record (Domain.Common), a
// repository `CountAsync` + `Skip`/`Take` method returning `Paged<Agg>`, a CQRS
// query/handler that maps to `Paged<AggResponse>`, and a controller action with
// page/pageSize query params.  The generated project compiles under
// `build-generated-dotnet` (examples/paged-dotnet.ddd); these unit tests pin
// the emitted C# shape.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    aggregate Order { ref: string  region: string }
    repository Orders for Order {
      find recent(): Order paged
      find inRegion(region: string): Order paged where this.region == region
    }
  }
`;

async function files(): Promise<Map<string, string>> {
  return generateDotnet(await parseValid(SRC));
}

describe(".NET generator — paged finds (P3b)", () => {
  it("emits the shared Paged<T> record into Domain.Common", async () => {
    const common = (await files()).get("Domain/Common/DomainException.cs")!;
    expect(common).toContain(
      "public sealed record Paged<T>(IReadOnlyList<T> Items, int Page, int PageSize, int Total, int TotalPages);",
    );
  });

  it("repository method: CountAsync + Skip/Take returning Paged<Agg>, where threaded into both", async () => {
    const repo = (await files()).get("Infrastructure/Repositories/OrderRepository.cs")!;
    expect(repo).toContain(
      "public async Task<Paged<Order>> Recent(int page, int pageSize, string sort, string dir, CancellationToken cancellationToken = default)",
    );
    expect(repo).toContain("var offset = (page - 1) * pageSize;");
    expect(repo).toContain("var total = await _db.Orders.CountAsync(cancellationToken);");
    // Server-side sort (M-T2.6): a wire→CLR whitelist switch + an EF.Property
    // OrderBy/OrderByDescending page query, then Skip/Take.
    expect(repo).toContain(
      'var sortColumn = sort switch { "ref" => "Ref", "region" => "Region", _ => "Id" };',
    );
    expect(repo).toContain(
      'var ordered = dir == "desc" ? _db.Orders.OrderByDescending(e => EF.Property<object>(e, sortColumn)) : _db.Orders.OrderBy(e => EF.Property<object>(e, sortColumn));',
    );
    expect(repo).toContain(
      "var items = await ordered.Skip(offset).Take(pageSize).ToListAsync(cancellationToken);",
    );
    expect(repo).toContain("return new Paged<Order>(items, page, pageSize, total, totalPages);");
    // where-clause threaded into both the count and the (ordered) page query.
    expect(repo).toContain(
      "await _db.Orders.Where(x => x.Region == region).CountAsync(cancellationToken);",
    );
    expect(repo).toContain(
      "_db.Orders.Where(x => x.Region == region).OrderBy(e => EF.Property<object>(e, sortColumn))",
    );
  });

  it("interface declares the paged method signature", async () => {
    const iface = (await files()).get("Domain/Orders/IOrderRepository.cs")!;
    expect(iface).toContain(
      "Task<Paged<Order>> Recent(int page, int pageSize, string sort, string dir, CancellationToken cancellationToken = default);",
    );
  });

  it("CQRS query + handler map Paged<Order> → Paged<OrderResponse>", async () => {
    const query = (await files()).get("Application/Orders/Queries/RecentQuery.cs")!;
    expect(query).toContain(
      "public sealed record RecentQuery(int Page, int PageSize, string Sort, string Dir) : IQuery<Paged<OrderResponse>>;",
    );
    const handler = (await files()).get("Application/Orders/Queries/RecentHandler.cs")!;
    expect(handler).toContain(
      "var domain = await _repo.Recent(query.Page, query.PageSize, query.Sort, query.Dir, cancellationToken);",
    );
    expect(handler).toContain("return new Paged<OrderResponse>(domain.Items.Select(d =>");
    expect(handler).toContain(
      ").ToList(), domain.Page, domain.PageSize, domain.Total, domain.TotalPages);",
    );
  });

  it("controller action returns Paged<OrderResponse> with page/pageSize query params", async () => {
    const ctrl = (await files()).get("Api/OrdersController.cs")!;
    expect(ctrl).toContain("[ProducesResponseType(typeof(Paged<OrderResponse>), 200)]");
    expect(ctrl).toContain(
      'public async Task<ActionResult<Paged<OrderResponse>>> RecentOrder([FromQuery] int page = 1, [FromQuery] int pageSize = 20, [FromQuery] string sort = "id", [FromQuery] string dir = "asc")',
    );
    expect(ctrl).toContain(
      "var result = await _mediator.Send(new RecentQuery(page, pageSize, sort, dir));",
    );
  });
});
