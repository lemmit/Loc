// Java/Spring read-mask redaction (`mask unless`, authorization.md §5, M-T3.2
// item 6). A masked aggregate's response record gains a `fromMasked` mapper that
// redacts each masked field to null unless the ambient principal satisfies the
// predicate (fail-closed); `from` stays unmasked for audit snapshots. Read
// services + explicit handlers project through `fromMasked`. Compile-verified
// separately (gradle, JDK 25); this pins the emit shape.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { generateJavaForContexts } from "../../../src/generator/java/index.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

const SRC = `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      aggregate P with crudish {
        name: string
        salary: decimal mask unless currentUser.permissions.contains(permissions.unmask)
      }
    }
  }
}`;

async function files(): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper<Model>(services.Ddd);
  const doc = await helper(SRC, { validation: true });
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value));
  const contexts = loom.systems.flatMap((s) => s.subdomains.flatMap((sd) => sd.contexts));
  return generateJavaForContexts(contexts, "S");
}

describe("mask unless — Java read redaction", () => {
  it("keeps `from` unmasked and adds a fail-closed `fromMasked` on the response record", async () => {
    const out = await files();
    const resp = [...out.entries()].find(([k]) => k.endsWith("PResponse.java"))?.[1] ?? "";
    // The masked component admits null (boxed / reference type).  BOXED
    // `Double`, not `BigDecimal`: a response `decimal` narrows to the wire's
    // `double` (RS-24 / #2563; #2575 on .NET, M-T6.46 here), and `mask unless`
    // forces the boxed form so the redacted arm can pass null.
    expect(resp).toMatch(/Double salary/);
    expect(resp).not.toContain("BigDecimal");
    // `from` stays unmasked (audit before/after snapshots project through it).
    expect(resp).toMatch(
      /public static PResponse from\(P value\) \{\s*\n\s*return new PResponse\(/,
    );
    // `fromMasked` binds the ambient principal statically and redacts fail-closed.
    expect(resp).toContain("public static PResponse fromMasked(P value)");
    expect(resp).toContain("User __maskUser = CurrentUserAccessor.currentOrNull();");
    expect(resp).toContain("__maskUser != null &&");
    expect(resp).toContain('__maskUser.permissions().contains("m.unmask")');
    // The projected arm narrows before the mask guard chooses it.
    expect(resp).toContain(
      "? value.salary() == null ? null : (value.salary()).doubleValue() : null",
    );
    // imports where the static accessor + principal type live.
    expect(resp).toMatch(/import \S+\.auth\.CurrentUserAccessor;/);
    expect(resp).toMatch(/import \S+\.auth\.User;/);
  });

  it("routes read services through fromMasked", async () => {
    const out = await files();
    const svc = [...out.entries()].find(([k]) => k.endsWith("PService.java"))?.[1] ?? "";
    // Every read (get-by-id, all, finds) redacts via the masked mapper.
    expect(svc).toContain("PResponse::fromMasked");
    // No read routes through the bare (unmasked) `from` mapper.
    expect(svc).not.toMatch(/\.map\(PResponse::from\)/);
  });
});
