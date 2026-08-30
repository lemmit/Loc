// ---------------------------------------------------------------------------
// The `when` state gate (criterion.md use site 2 / M-T6.38) renders an
// ARBITRARY predicate expression at three places per backend — the domain
// method, the route-layer command path, and the side-effect-free `can_<op>`
// companion — and for a while nothing scanned it for the namespaces it reaches
// into.  A gate like
//
//     operation lock() when this.owner == "system" && this.code.matches("^sys")
//
// therefore emitted `Objects.equals(...)` / `Pattern.compile(...)` with no
// `import java.util.Objects` / `java.util.regex.Pattern` (javac: cannot find
// symbol) and `Regex.IsMatch(...)` with no
// `using System.Text.RegularExpressions` (CS0103) — a `tsc`-green emitter
// producing target source that does not compile (audit 2026-08-24 A17).
//
// Every assertion below pairs the RENDERED call with the import that makes it
// resolve, so a regression that drops one while keeping the other fails.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const SRC = `
system WhenImports {
  subdomain Sales {
    context Orders {
      aggregate Order {
        code: string
        owner: string
        operation lock() when this.owner == "system" && this.code.matches("^sys") {
          owner := "locked"
        }
      }
      repository Orders for Order { }
    }
  }
  api A from Sales
  storage primary { type: postgres }
  resource st { for: Orders, kind: state, use: primary }
  deployable javaApi {
    platform: java
    contexts: [Orders]
    dataSources: [st]
    serves: A
    port: 8082
  }
  deployable netApi {
    platform: dotnet
    contexts: [Orders]
    dataSources: [st]
    serves: A
    port: 8083
  }
}
`;

const JAVA = "java_api/src/main/java/com/loom/javaapi/features/orders";

describe("`when` gate — the predicate's own imports/usings are collected (A17)", () => {
  it("java entity: Objects + Pattern imported, and the regex literal is hoisted", async () => {
    const files = await generateSystemFiles(SRC);
    const entity = files.get(`${JAVA}/Order.java`)!;
    expect(entity).toContain('Objects.equals(this.owner(), "system")');
    expect(entity).toContain("import java.util.Objects;");
    // The gate is a per-call hot path like an invariant, so its regex literal
    // hoists to a `private static final Pattern` rather than recompiling.
    expect(entity).toContain(
      'private static final Pattern MATCHES_PATTERN_0 = Pattern.compile("^sys");',
    );
    expect(entity).toContain("MATCHES_PATTERN_0.matcher(this.code()).find()");
    expect(entity).toContain("import java.util.regex.Pattern;");
  });

  it("java service: the route-layer twin + the can_<op> companion import theirs too", async () => {
    const files = await generateSystemFiles(SRC);
    const service = files.get(`${JAVA}/OrderService.java`)!;
    // Both the gate at `lock()` and the `canLock` companion render the predicate.
    expect(service).toContain('Objects.equals(aggregate.owner(), "system")');
    expect(service).toContain('Pattern.compile("^sys").matcher(aggregate.code()).find()');
    expect(service).toContain("import java.util.Objects;");
    expect(service).toContain("import java.util.regex.Pattern;");
  });

  it("dotnet entity: Regex.IsMatch carries System.Text.RegularExpressions", async () => {
    const files = await generateSystemFiles(SRC);
    const entity = files.get("net_api/Domain/Orders/Order.cs")!;
    expect(entity).toContain('Regex.IsMatch(this.Code, "^sys")');
    expect(entity).toContain("using System.Text.RegularExpressions;");
  });

  it("dotnet command handler + can_<op> query handler carry it as well", async () => {
    const files = await generateSystemFiles(SRC);
    const handler = files.get("net_api/Application/Orders/Commands/LockHandler.cs")!;
    expect(handler).toContain('Regex.IsMatch(aggregate.Code, "^sys")');
    expect(handler).toContain("using System.Text.RegularExpressions;");
    const can = files.get("net_api/Application/Orders/Queries/CanLockHandler.cs")!;
    expect(can).toContain('Regex.IsMatch(aggregate.Code, "^sys")');
    expect(can).toContain("using System.Text.RegularExpressions;");
    // CS0105: the same namespace must not be imported twice in one file.
    for (const file of [handler, can]) {
      const usings = [...file.matchAll(/^using (.+);$/gm)].map((m) => m[1]!);
      expect(new Set(usings).size).toBe(usings.length);
    }
  });
});
