// `loom.sensitive-wire-unsupported` (M-T3.8, diagnostic slice) — `sensitive(...)`
// protects the DEBUG surface and not the API surface, and until this gate
// nothing said so.
//
// `FieldIR.sensitivity` is documented in the IR as "captured at the declaration
// site only — neither the wire-shape, the DTO emitters, nor sink type-checking
// read it yet".  The one consequence that ships is the synthesized `derived
// inspect` printing `<redacted>` (enrichments.ts), plus the Elixir `@derive
// Inspect` opt-out.  The response DTO every backend builds from the wire shape
// has no sensitivity arm, so a `sensitive(pii)` field is serialized in
// cleartext to any caller allowed to read the aggregate — and `ddd parse`
// reported `0 error(s), 0 warning(s)` on exactly that model.
//
// The gate is a WARNING (the source is not wrong, and the exit code is
// unchanged), and it suppresses itself wherever the author already HAS the
// guarantee: `mask unless` redacts at the response boundary on all five
// backends, and `internal` / `secret` are filtered out of the read projection
// entirely.  Those three suppressions are what keep it from being noise, so
// each is pinned below.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.sensitive-wire-unsupported";

const sys = (fields: string) => `
system Payroll {
  subdomain HR {
    context People {
      aggregate Person with crudish {
${fields}
      }
      repository People for Person { }
    }
  }
}`;

async function diags(fields: string) {
  const { model, errors } = await parseString(sys(fields));
  if (errors.length) throw new Error(`unexpected parse errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const hits = (ds: Awaited<ReturnType<typeof diags>>) => ds.filter((d) => d.code === CODE);

describe("loom.sensitive-wire-unsupported", () => {
  it("warns on a sensitive field the wire actually serves", async () => {
    const ds = await diags(`        name: string
        ssn: string sensitive(pii)`);
    const found = hits(ds);
    expect(found.length, JSON.stringify(ds, null, 1)).toBe(1);
    expect(found[0]!.severity).toBe("warning");
    expect(found[0]!.source).toBe("Payroll/People/Person.ssn");
  });

  it("the message names the ONE thing that ships and the thing that does not", async () => {
    const [d] = hits(await diags(`        ssn: string sensitive(pii)`));
    // The honoured half — so the author knows the tag is not inert.
    expect(d!.message).toMatch(/inspect/);
    expect(d!.message).toMatch(/redacted/);
    // The unhonoured half, in the words that matter.
    expect(d!.message).toMatch(/cleartext/);
    // And a remedy that works TODAY, which is the whole point of an honest gate.
    expect(d!.message).toMatch(/mask unless/);
  });

  it("says nothing about an untagged field", async () => {
    expect(hits(await diags(`        name: string`))).toEqual([]);
  });

  it("suppresses when `mask unless` already redacts the field on a read", async () => {
    const ds = await diags(
      `        salary: money sensitive(pii) mask unless currentUser.role == "hr"`,
    );
    expect(hits(ds), JSON.stringify(ds, null, 1)).toEqual([]);
  });

  it("suppresses on `secret` — write-only, never disclosed in any read", async () => {
    const ds = await diags(`        apiKey: string secret sensitive(credential)`);
    expect(hits(ds), JSON.stringify(ds, null, 1)).toEqual([]);
  });

  it("suppresses on `internal` — never exposed via the API", async () => {
    const ds = await diags(`        riskScore: int internal sensitive(pii)`);
    expect(hits(ds), JSON.stringify(ds, null, 1)).toEqual([]);
  });

  it("reports each exposed sensitive field once, in declaration order", async () => {
    const ds = await diags(`        ssn: string sensitive(pii)
        email: string sensitive(pii, contact)
        salary: money sensitive(pii) mask unless currentUser.role == "hr"`);
    expect(hits(ds).map((d) => d.source)).toEqual([
      "Payroll/People/Person.ssn",
      "Payroll/People/Person.email",
    ]);
  });

  it("names every declared tag, so a multi-tag field is not reported as one", async () => {
    const [d] = hits(await diags(`        email: string sensitive(pii, contact)`));
    expect(d!.message).toMatch(/sensitive\(contact, pii\)|sensitive\(pii, contact\)/);
  });

  it("never gates the build — it is a warning, so no error joins it", async () => {
    const ds = await diags(`        ssn: string sensitive(pii)`);
    expect(ds.filter((d) => d.severity === "error")).toEqual([]);
  });
});
