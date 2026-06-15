// Regression: a `workflow … transactional(serializable)` must honor the
// declared isolation level on every backend.
//
// .NET emits `BeginTransactionAsync(IsolationLevel.Serializable, …)`, but Java
// only put a default `@Transactional` on the workflow service (no isolation =)
// and Python ran the workflow on the default request session — so the
// serializable guarantee the DSL asked for was silently dropped on two
// backends.  Now both honor it (via resolveWorkflowIsolation, matching .NET).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const SRC = (platform: string) => `
system Acme {
  subdomain Sales {
    context S {
      aggregate Order with crudish {
        sku: string
        operation ship() { active := true }
        active: bool
      }
      repository Orders for Order { }
      workflow shipOrder transactional(serializable) {
        create(orderId: Order id) {
          let o = Orders.getById(orderId)
          o.ship()
        }
      }
    }
  }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource sState { for: S, kind: state, use: primarySql }
  deployable api {
    platform: ${platform}
    contexts: [S]
    dataSources: [sState]
    serves: SalesApi
    port: 8080
  }
}
`;

describe("workflow transactional(serializable) — honored on every backend", () => {
  it("Java emits @Transactional(isolation = Isolation.SERIALIZABLE) on the workflow method", async () => {
    const files = await generateSystemFiles(SRC("java"));
    const svc = [...files.entries()].find(([p]) => p.endsWith("SWorkflows.java"))?.[1];
    expect(svc, "S workflow service").toBeDefined();
    expect(svc).toContain("import org.springframework.transaction.annotation.Isolation;");
    expect(svc).toMatch(
      /@Transactional\(isolation = Isolation\.SERIALIZABLE\)\s*\n\s*public void shipOrder/,
    );
  });

  it("Python sets the session isolation level to SERIALIZABLE", async () => {
    const files = await generateSystemFiles(SRC("python"));
    const wf = [...files.entries()].find(([p]) => p.endsWith("workflows_routes.py"))?.[1];
    expect(wf, "workflows_routes.py").toBeDefined();
    expect(wf).toContain('"isolation_level": "SERIALIZABLE"');
  });
});
