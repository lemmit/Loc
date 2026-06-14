// ---------------------------------------------------------------------------
// Java backend — lifecycle stamps (`stamp onCreate`/`onUpdate`, the
// audit / softDelete capability stamps).  Non-principal state stamps
// become package-private `_stampOnCreate` / `_stampOnUpdate` methods
// (`this.<field> = <value>`) the service calls before save — closing
// the prior silent-drop (createdAt was taken from the request).
// Principal-referencing (`currentUser`) stamps and stamps on
// event-sourced aggregates stay fail-fast gated
// (loom.java-stamp-unsupported).  Boot-verified end-to-end against
// Postgres via test/e2e/fixtures/java-build/stamps.ddd (create + update
// override bogus client timestamps with now()).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SRC = readFileSync("test/e2e/fixtures/java-build/stamps.ddd", "utf8");
const ROOT = "api1/src/main/java/com/loom/api1";

describe("java generator — lifecycle stamps", () => {
  it("emits _stampOnCreate / _stampOnUpdate entity methods over the stamp fields", async () => {
    const entity = (await generateSystemFiles(SRC)).get(`${ROOT}/features/orders/Order.java`)!;
    expect(entity).toContain("    void _stampOnCreate() {");
    expect(entity).toContain("        this.createdAt = Instant.now();");
    expect(entity).toContain("    void _stampOnUpdate() {");
    expect(entity).toContain("        this.updatedAt = Instant.now();");
  });

  it("the service calls the stamps before save (create + the crudish update op)", async () => {
    const svc = (await generateSystemFiles(SRC)).get(`${ROOT}/features/orders/OrderService.java`)!;
    expect(svc).toContain("        aggregate._stampOnCreate();");
    expect(svc).toContain("        aggregate._stampOnUpdate();");
    // The stamp runs immediately before the persist.
    expect(svc).toMatch(/aggregate\._stampOnCreate\(\);\s*\n\s*repository\.save\(aggregate\);/);
  });

  it("a currentUser stamp on an auth deployable resolves to the principal id", async () => {
    const principal = readFileSync("test/e2e/fixtures/java-build/stamps-principal.ddd", "utf8");
    const files = await generateSystemFiles(principal);
    const entity = files.get("api1/src/main/java/com/loom/api1/features/orders/Order.java")!;
    expect(entity).toContain("    void _stampOnCreate(User currentUser) {");
    expect(entity).toContain("        this.createdBy = currentUser.id();");
    const svc = files.get("api1/src/main/java/com/loom/api1/features/orders/OrderService.java")!;
    expect(svc).toContain("        var currentUser = currentUserAccessor.user();");
    expect(svc).toContain("        aggregate._stampOnCreate(currentUser);");
  });

  it("gates a currentUser stamp on a deployable WITHOUT auth fail-fast", async () => {
    // stamps.ddd's deployable has no `auth: required` — a currentUser
    // stamp there has no request-scoped principal to thread.
    const principal = SRC.replace(
      "stamp onCreate { createdAt := now() }",
      "stamp onCreate { createdAt := now()  createdBy := currentUser }",
    )
      .replace("createdAt: datetime", "createdAt: datetime\n        createdBy: guid")
      .replace("system ST {", "system ST {\n  user { id: guid  name: string }");
    const loom = await buildLoomModel(principal);
    const errors = validateLoomModel(loom).filter((d) => d.code === "loom.java-stamp-unsupported");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("no auth");
  });
});
