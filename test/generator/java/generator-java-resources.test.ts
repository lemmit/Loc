// ---------------------------------------------------------------------------
// Java backend — resource clients (Phase 4c): one static class per
// consumable sourceType the deployable wires (S3 via the AWS SDK v2,
// RabbitMQ via amqp-client, restApi via java.net.http.HttpClient — no
// dep), with one synchronous method per (resource, verb); the
// render layer's `resource-op` arm dispatches
// `<Cls>.<resourceName><Verb>(…)` and workflow `resource-call`
// statements render through it.  Gradle deps merge per adapter.
// The restApi path is boot-verified end-to-end against a local stub
// via test/e2e/fixtures/java-build/resources.ddd (GET + POST observed
// with the JSON body; env URL override honored).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/e2e/fixtures/java-build/resources.ddd", "utf8");

const ROOT = "rc_api/src/main/java/com/loom/rcapi";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — resource clients", () => {
  it("emits one client class per consumable sourceType under <base>.resources", async () => {
    const files_ = await files();
    const s3 = files_.get(`${ROOT}/resources/S3Resources.java`)!;
    expect(s3).toContain("public static void salesFilesPut(String key, String body) {");
    expect(s3).toContain("public static String salesFilesGet(String key) {");
    expect(s3).toContain("public static String salesFilesSignedUrl(String key) {");
    expect(s3).toContain('System.getenv().getOrDefault("SALES_FILES_URL_BUCKET", "app-files")');
    const mq = files_.get(`${ROOT}/resources/RabbitmqResources.java`)!;
    expect(mq).toContain("public static void salesJobsEnqueue(Object message) {");
    expect(mq).toContain("public static void salesJobsPublish(String topic, Object message) {");
    const api = files_.get(`${ROOT}/resources/RestApiResources.java`)!;
    expect(api).toContain("public static JsonNode crmGet(String path) {");
    expect(api).toContain("public static JsonNode crmPost(String path, Object body) {");
    expect(api).toContain('System.getenv().getOrDefault("CRM_URL", "http://crm:9000")');
  });

  it("workflow bodies dispatch resource-ops through the client classes", async () => {
    const wf = (await files()).get(`${ROOT}/application/workflows/SalesWorkflows.java`)!;
    expect(wf).toContain('var prev = S3Resources.salesFilesGet("orders/" + name);');
    expect(wf).toContain('S3Resources.salesFilesPut("orders/" + name, name);');
    expect(wf).toContain("RabbitmqResources.salesJobsEnqueue(name);");
    expect(wf).toContain('var info = RestApiResources.crmGet("/customers");');
    expect(wf).toContain("import com.loom.rcapi.resources.*;");
  });

  it("merges adapter Gradle deps into build.gradle.kts (restApi adds none)", async () => {
    const build = (await files()).get("rc_api/build.gradle.kts")!;
    expect(build).toContain('implementation("software.amazon.awssdk:s3:');
    expect(build).toContain('implementation("com.rabbitmq:amqp-client:');
  });

  it("emits no resource files for a deployable wiring none", async () => {
    const noRes = `
system RC {
  subdomain D {
    context Sales {
      aggregate Order with crudish { name: string }
      repository Orders for Order { }
    }
  }
  api A from D
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable rcApi {
    platform: java
    contexts: [Sales]
    dataSources: [salesState]
    serves: A
    port: 8081
  }
}
`;
    const files_ = await generateSystemFiles(noRes);
    expect([...files_.keys()].some((k) => k.includes("/com/loom/rcapi/resources/"))).toBe(false);
    expect(files_.get("rc_api/build.gradle.kts")!).not.toContain("awssdk");
  });
});
