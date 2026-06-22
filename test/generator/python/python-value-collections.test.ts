import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — value-object collections (`<VO>[]`).  Unlike a single VO
// field (flattened into the parent row's columns), a VO array persists to an
// id-less relational CHILD TABLE — the value object's flattened columns keyed
// by (parent_fk, ordinal), no surrogate id — exactly as node/.NET/Java do, so
// every SQL backend shares one Postgres DDL.  Save replaces the list
// wholesale (delete + ordinal-ordered reinsert); hydrate SELECTs ordered by
// ordinal and rebuilds the VO list through the VO constructor (which re-checks
// the invariant).  The wire shape stays the array of VO objects — byte
// identical with the other backends.
//
// The fixture mixes a SINGLE VO field (`total: Money`) with VO[] fields
// (`charges: Money[]` + optional `surcharges: Money[]?`): that combination
// exposed the original bug, where VO[] was dropped while the single VO field
// was fine.
// ---------------------------------------------------------------------------

const FIXTURE = `
system Billing {
  subdomain Sales {
    context Invoicing {
      valueobject Money { amount: decimal  currency: string }
      aggregate Invoice with crudish {
        reference: string
        total: Money
        charges: Money[]
        surcharges: Money[]?
      }
      repository Invoices for Invoice { }
    }
  }
  api InvoicingApi from Sales
  deployable d { platform: python  contexts: [Invoicing]  serves: InvoicingApi  port: 4000 }
}
`;

async function build(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python value-object collection — id-less child-table persistence", () => {
  it("emits a child table per VO[] field (flattened VO cols, (parent_fk, ordinal) PK)", async () => {
    const files = await build();
    const schema = files.get("d/app/db/schema.py")!;

    // The single VO field stays flattened on the parent row — NOT a child table.
    expect(schema).toContain("class InvoiceRow(Base):");
    expect(schema).toContain("    total_amount: Mapped[Decimal] = mapped_column(Numeric)");
    expect(schema).toContain("    total_currency: Mapped[str] = mapped_column(Text)");

    // Each VO[] field becomes its own id-less child table.
    expect(schema).toContain("class InvoiceChargesRow(Base):");
    expect(schema).toContain('    __tablename__ = "invoice_charges"');
    expect(schema).toContain("class InvoiceSurchargesRow(Base):");
    expect(schema).toContain('    __tablename__ = "invoice_surcharges"');

    // owner FK + ordinal + the VO's bare flattened columns, composite PK, no id.
    expect(schema).toContain("    invoice_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))");
    expect(schema).toContain("    ordinal: Mapped[int] = mapped_column(Integer)");
    expect(schema).toContain("    amount: Mapped[Decimal] = mapped_column(Numeric)");
    expect(schema).toContain("    currency: Mapped[str] = mapped_column(Text)");
    expect(schema).toContain('PrimaryKeyConstraint("invoice_id", "ordinal")');
    // No surrogate id on the child table.
    expect(schema).not.toMatch(/class InvoiceChargesRow[\s\S]*?id: Mapped\[str\][^\n]*primary_key/);
  });

  it("save replaces each VO[] wholesale (delete + ordinal-ordered reinsert)", async () => {
    const files = await build();
    const repo = files.get("d/app/db/repositories/invoice_repository.py")!;

    expect(repo).toContain(
      "delete(InvoiceChargesRow).where(InvoiceChargesRow.invoice_id == aggregate.id)",
    );
    expect(repo).toContain("for __i, __e in enumerate(aggregate.charges or []):");
    expect(repo).toContain("insert(InvoiceChargesRow).values(");
    expect(repo).toContain("                    invoice_id=aggregate.id,");
    expect(repo).toContain("                    ordinal=__i,");
    expect(repo).toContain("                    amount=Decimal(str(__e.amount)),");
    expect(repo).toContain("                    currency=__e.currency,");
    // Optional VO[]? reduces None to the empty list on save.
    expect(repo).toContain("for __i, __e in enumerate(aggregate.surcharges or []):");
  });

  it("hydrate loads child rows ordered by ordinal and rebuilds the VO list", async () => {
    const files = await build();
    const repo = files.get("d/app/db/repositories/invoice_repository.py")!;

    expect(repo).toContain("select(InvoiceChargesRow)");
    expect(repo).toContain(".where(InvoiceChargesRow.invoice_id == row.id)");
    expect(repo).toContain(".order_by(InvoiceChargesRow.ordinal)");
    expect(repo).toContain(
      "charges=[Money(float(__r.amount), __r.currency) for __r in charges_rows]",
    );
    // The single VO field still hydrates from the flattened parent columns.
    expect(repo).toContain("total=Money(float(row.total_amount), row.total_currency)");
  });

  it("the wire shape stays an array of VO objects (byte-identical)", async () => {
    const files = await build();
    const repo = files.get("d/app/db/repositories/invoice_repository.py")!;
    // to_wire projects the list element-by-element — no child-table leakage.
    expect(repo).toContain(
      '"charges": [{"amount": __e.amount, "currency": __e.currency} for __e in root.charges]',
    );
  });
});
