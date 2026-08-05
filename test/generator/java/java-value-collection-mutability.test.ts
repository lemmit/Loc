import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// A value-object COLLECTION field (`Money[]`) that reaches a domain field
// through a wire→domain conversion must arrive as a MUTABLE list.
//
// The field is mapped `@ElementCollection`, and Hibernate REPLACES an element
// collection in place on merge: `CollectionType.replaceElements` calls
// `clear()` on the value it was handed.  `Stream.toList()` returns an
// `ImmutableCollections` list, so `clear()` threw `UnsupportedOperationException`
// and **every UPDATE of an aggregate with a value-object collection answered
// 500** — reproduced against a booted `gradle:9-jdk25` jar + Postgres:
//
//   POST /api/invoices/{id}/update
//     → 500 {"detail":"internal", …}
//     java.lang.UnsupportedOperationException
//       at java.util.ImmutableCollections$AbstractImmutableCollection.clear
//       at org.hibernate.type.CollectionType.replaceElements
//       at …DefaultMergeEventListener.entityIsPersistent
//
// CREATE never hit it — a fresh entity is persisted, never merged — which is
// exactly why the compile tier, the create-only e2e and every spec-parity gate
// stayed green.  Found by the caller census's `update` drain, which put the
// first-ever caller on `POST /api/<aggs>/{id}/update`.
//
// The assertion is on the CONVERSION site (`wireToDomain`'s array arm), so it
// covers create, update, operations and workflow starts at once — every path
// that binds a wire collection onto a domain field.

const SRC = `
system Billing {
  subdomain Sales {
    context Invoicing {
      valueobject Money { amount: decimal  currency: string }
      aggregate Invoice with crudish {
        reference: string
        lineItems: Money[]
        surcharges: Money[]?
      }
      repository Invoices for Invoice { }
    }
  }
  api InvoicingApi from Sales
  storage primary { type: postgres }
  resource invoicingState { for: Invoicing, kind: state, use: primary }
  deployable d { platform: java, contexts: [Invoicing], dataSources: [invoicingState], serves: InvoicingApi, port: 4000 }
}
`;

const SERVICE = "d/src/main/java/com/loom/d/features/invoices/InvoiceService.java";
const ENTITY = "d/src/main/java/com/loom/d/features/invoices/Invoice.java";

describe("java generator — value-object collections arrive mutable", () => {
  it("the update path binds a mutable ArrayList, never Stream.toList()", async () => {
    const service = (await generateSystemFiles(SRC)).get(SERVICE)!;
    expect(service, "InvoiceService.java missing").toBeTruthy();
    const update = service.slice(service.indexOf("public void update("));
    expect(update, "no update(...) method emitted").toBeTruthy();
    // The required shape, on both the mandatory and the optional collection.
    expect(update).toContain(
      "var lineItems = new java.util.ArrayList<>(request.lineItems().stream().map(__x -> toMoney(__x)).toList());",
    );
    expect(update).toContain(
      "var surcharges = request.surcharges() == null ? null : new java.util.ArrayList<>(request.surcharges().stream().map(__x -> toMoney(__x)).toList());",
    );
    // …and the defect shape must be gone: a bare `.toList()` assigned straight
    // to a local that is then passed into the aggregate.
    expect(update).not.toMatch(/var \w+ = request\.\w+\(\)\.stream\(\)\.map\([^;]*\)\.toList\(\);/);
  });

  it("the same conversion is used on the create path", async () => {
    const service = (await generateSystemFiles(SRC)).get(SERVICE)!;
    const create = service.slice(0, service.indexOf("public void update("));
    expect(create).toContain(
      "new java.util.ArrayList<>(request.lineItems().stream().map(__x -> toMoney(__x)).toList())",
    );
  });

  it("the field it lands on really is the @ElementCollection Hibernate replaces", async () => {
    // Pins the PREMISE — without this the assertions above could pass while the
    // collection was mapped some other way and the bug lived elsewhere.
    const entity = (await generateSystemFiles(SRC)).get(ENTITY)!;
    expect(entity).toMatch(
      /@ElementCollection\(fetch = FetchType\.EAGER\)[\s\S]*?List<Money> lineItems;/,
    );
    expect(entity).toContain(
      "public void update(String reference, List<Money> lineItems, List<Money> surcharges) {",
    );
    expect(entity).toContain("this.lineItems = lineItems;");
  });
});
