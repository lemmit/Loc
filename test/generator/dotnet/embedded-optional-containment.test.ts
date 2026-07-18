// B14 (docs/audits/behavioral-parity-bugs-2026-07.md): an OPTIONAL single
// containment (`contains note: Memo?`) on a `shape: embedded` aggregate folds
// into a NULLABLE jsonb column via EF owned-types `.ToJson(...)`.  Three things
// must agree so the unset (null) containment round-trips:
//   1. the owned nav is `IsRequired(false)` (else EF throws materialising the
//      null JSON cell — mirrors the relational path, B8);
//   2. the `<Agg>Response` record declares it `MemoResponse?` (no `[Required]`);
//   3. the query projection guards `found.Note is null ? null : new MemoResponse(...)`
//      (else `found.Note.Id.Value` NREs on the absent containment).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SOURCE = `
system EmbOpt {
  subdomain Shop {
    context Shop {
      aggregate Order shape: embedded, with crudish {
        customer: string
        contains lines: LineItem[]
        contains note: Memo?
        entity LineItem { sku: string  qty: int }
        entity Memo { text: string }
        operation addLine(sku: string, qty: int) { lines += LineItem { sku: sku, qty: qty } }
      }
      repository Orders for Order { }
    }
  }
  api ShopApi from Shop
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable d { platform: dotnet, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}
`;

async function file(re: RegExp): Promise<string> {
  const files = await generateSystemFiles(SOURCE);
  const key = [...files.keys()].find((k) => re.test(k));
  expect(key, `no file matched ${re}`).toBeDefined();
  return files.get(key!)!;
}

describe("B14 — dotnet embedded optional single containment", () => {
  it("marks the embedded owned nav IsRequired(false)", async () => {
    const cfg = await file(/Configurations\/OrderConfiguration\.cs$/);
    expect(cfg).toContain("builder.OwnsOne<Memo>(x => x.Note, o => {");
    expect(cfg).toContain('o.ToJson("note");');
    expect(cfg).toContain("builder.Navigation(x => x.Note).IsRequired(false);");
  });

  it("declares the response containment field nullable (no [Required])", async () => {
    const responses = await file(/Responses\/OrderResponses\.cs$/);
    expect(responses).toContain("MemoResponse? Note");
    expect(responses).not.toContain("[property: Required] MemoResponse Note");
  });

  it("null-guards the containment projection in the read handler", async () => {
    const handler = await file(/Queries\/GetOrderByIdHandler\.cs$/);
    expect(handler).toContain(
      "found.Note is null ? null : new MemoResponse(found.Note.Id.Value, found.Note.Text)",
    );
  });
});
