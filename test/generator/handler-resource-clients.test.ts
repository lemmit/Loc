// A resource-op inside a `commandHandler` / `queryHandler` BODY — the second
// of the two sites `loom.resource-op-outside-workflow` declares LEGAL (the
// other is a workflow body; #2618 excluded domainService operations after
// finding no emitter threaded a client in).
//
// The gate said legal; four of five emitters could not render it.  Measured on
// fresh `main` before the fix, from the fixture below:
//
//   node   — `http/<api>-routes.ts` got `(await salesFiles$put(…))` in a file
//            importing no resource client → TS2304.
//   python — `app/application/<handler>.py` got `await sales_files_put(…)`
//            likewise unimported → ruff F821 / NameError at request time.
//   .NET   — THREW "Resource operation 'salesFiles.put' reached the .NET
//            renderer without a resource class mapping" out of
//            explicit-handlers-emit.ts (its `renderArg` passed
//            `resourceClasses: undefined`) — a generate-time crash.
//   java   — THREW the Java twin out of its explicit-handlers-emit.ts.
//   elixir — already correct: it renders a fully-qualified
//            `D.Resources.S3.sales_files_put(…)`, so it needs no import.
//
// Each backend's WORKFLOW leg already had this wiring; these assertions pin
// that the HANDLER leg reaches the same clients, per backend and per verb, so
// a future refactor cannot re-drop one of the two legs.
//
// The compile-tier proof is the `handler-resource-ops` corpus fixture (this
// same shape), which builds on all five under tsc --noEmit / dotnet build
// /warnaserror / gradle testClasses / ruff + mypy --strict / mix compile.
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const src = (platform: string): string => `
system HRC {
  subdomain D {
    context Sales {
      aggregate Order with crudish { name: string }
      repository Orders for Order {
        find byName(name: string): Order[] where this.name == name
      }
      commandHandler ArchiveOrder(name: string): int {
        let matches = Orders.byName(name)
        salesFiles.put("orders/" + name, name)
        salesJobs.enqueue(name)
        mail.send(name, "Order archived", "gone")
        return matches.count
      }
      queryHandler PeekArchive(name: string): int {
        let matches = Orders.byName(name)
        let archived = salesFiles.get("orders/" + name)
        return matches.count
      }
    }
  }
  api A from D {
    route POST "/archive/{name}" -> Sales.ArchiveOrder
    route GET  "/archive/{name}" -> Sales.PeekArchive
  }
  storage pg { type: postgres }
  storage files { type: s3, config: { bucket: "app-files" } }
  storage jobs { type: rabbitmq }
  storage mailServer { type: smtp, config: { from: "no-reply@hrc.test" } }
  resource salesState { for: Sales, kind: state, use: pg }
  resource salesFiles { for: Sales, kind: objectStore, use: files }
  resource salesJobs { for: Sales, kind: queue, use: jobs }
  resource mail { for: Sales, kind: mailer, use: mailServer }
  deployable d {
    platform: ${platform}
    contexts: [Sales]
    dataSources: [salesState, salesFiles, salesJobs, mail]
    serves: A
    port: 4000
  }
}
`;

/** The one emitted file whose path ends with `suffix`. */
function fileEndingWith(m: Map<string, string>, suffix: string): string {
  const key = [...m.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted (have: ${[...m.keys()].join(", ")})`).toBeDefined();
  return m.get(key!)!;
}

describe("a resource-op in a commandHandler / queryHandler body reaches its client", () => {
  it("node: the api router imports every `<resource>$<verb>` helper it calls", async () => {
    const router = fileEndingWith(await generateSystemFiles(src("node")), "http/a-routes.ts");
    // The calls the body renders …
    expect(router).toContain("salesFiles$put(");
    expect(router).toContain("salesJobs$enqueue(");
    expect(router).toContain("mail$send(");
    expect(router).toContain("salesFiles$get(");
    // … each backed by an import from the right sourceType client module.
    // Both objectStore verbs share ONE import line (grouped by module).
    expect(router).toContain(
      'import { salesFiles$get, salesFiles$put } from "../resources/s3";',
    );
    expect(router).toContain('import { salesJobs$enqueue } from "../resources/rabbitmq";');
    expect(router).toContain('import { mail$send } from "../resources/smtp";');
  });

  it("node: a handler doing no resource I/O imports no client", async () => {
    const plain = `
system Plain {
  subdomain D {
    context Sales {
      aggregate Order with crudish { name: string }
      repository Orders for Order { find byName(name: string): Order[] where this.name == name }
      queryHandler Count(name: string): int {
        let matches = Orders.byName(name)
        return matches.count
      }
    }
  }
  api A from D { route GET "/count/{name}" -> Sales.Count }
  storage pg { type: postgres }
  storage files { type: s3, config: { bucket: "b" } }
  resource salesState { for: Sales, kind: state, use: pg }
  resource salesFiles { for: Sales, kind: objectStore, use: files }
  deployable d { platform: node, contexts: [Sales], dataSources: [salesState, salesFiles], serves: A, port: 4000 }
}
`;
    const router = fileEndingWith(await generateSystemFiles(plain), "http/a-routes.ts");
    // A dead import would trip the generated-code Biome gate, so the import is
    // derived from what the bodies actually call — not from what is bound.
    expect(router).not.toContain("../resources/");
  });

  it(".NET: the handler class calls the routed helper class and usings Resources", async () => {
    const files = await generateSystemFiles(src("dotnet"));
    const cmd = fileEndingWith(files, "Commands/ArchiveOrderHandler.cs");
    expect(cmd).toContain("using D.Resources;");
    expect(cmd).toContain("await S3Resources.SalesFiles_Put(");
    expect(cmd).toContain("await RabbitmqResources.SalesJobs_Enqueue(");
    expect(cmd).toContain("await SmtpResources.Mail_Send(");
    const qry = fileEndingWith(files, "Queries/PeekArchiveHandler.cs");
    expect(qry).toContain("using D.Resources;");
    expect(qry).toContain("await S3Resources.SalesFiles_Get(");
  });

  it(".NET: a handler doing no resource I/O gets no Resources using (CS8019)", async () => {
    const files = await generateSystemFiles(src("dotnet"));
    // The crudish aggregate's own auto-derived handlers touch no resource.
    const create = fileEndingWith(files, "Commands/CreateOrderHandler.cs");
    expect(create).not.toContain("using D.Resources;");
  });

  it("java: the handler bean calls the routed client class and imports the package", async () => {
    const files = await generateSystemFiles(src("java"));
    const cmd = fileEndingWith(files, "ArchiveOrderHandler.java");
    expect(cmd).toContain("import com.loom.d.resources.*;");
    expect(cmd).toContain("S3Resources.salesFilesPut(");
    expect(cmd).toContain("RabbitmqResources.salesJobsEnqueue(");
    expect(cmd).toContain("SmtpResources.mailSend(");
    const qry = fileEndingWith(files, "PeekArchiveHandler.java");
    expect(qry).toContain("import com.loom.d.resources.*;");
    expect(qry).toContain("S3Resources.salesFilesGet(");
  });

  it("python: the handler module imports every `<resource>_<verb>` helper it awaits", async () => {
    const files = await generateSystemFiles(src("python"));
    const cmd = fileEndingWith(files, "app/application/archive_order.py");
    expect(cmd).toContain("from app.resources.s3 import sales_files_put");
    expect(cmd).toContain("from app.resources.rabbitmq import sales_jobs_enqueue");
    expect(cmd).toContain("from app.resources.smtp import mail_send");
    expect(cmd).toContain("await sales_files_put(");
    const qry = fileEndingWith(files, "app/application/peek_archive.py");
    expect(qry).toContain("from app.resources.s3 import sales_files_get");
    // The command leg's verbs must NOT leak into the query leg's imports —
    // ruff F401 would fail the generated project.
    expect(qry).not.toContain("sales_jobs_enqueue");
    expect(qry).not.toContain("mail_send");
  });

  it("elixir: the handler fully-qualifies its resource module (no import needed)", async () => {
    const files = await generateSystemFiles(src("elixir"));
    const cmd = fileEndingWith(files, "handlers/archive_order.ex");
    expect(cmd).toContain("D.Resources.S3.sales_files_put(");
    expect(cmd).toContain("D.Resources.Rabbitmq.sales_jobs_enqueue(");
    expect(cmd).toContain("D.Resources.Smtp.mail_send(");
  });
});
