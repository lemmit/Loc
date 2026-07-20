// Regression: the observability metric calls (`HttpMetrics.Record` /
// `.RecordDomainFault`) are emitted into files whose own namespace is
// `<ns>.Api` (DomainExceptionFilter) or `<ns>.Middleware`
// (RequestLoggingMiddleware).  When a deployable is named `api`, the project
// root namespace is `Api`, so `<ns>.Api` = `Api.Api` — the root `Api` namespace
// then CONTAINS a nested `Api`, and a bare `Api.Observability.HttpMetrics`
// reference binds its leading `Api` to that nested `Api.Api`, resolving to the
// non-existent `Api.Api.Observability` (CS0234) and breaking `dotnet build`.
// The emitters defend against this by ROOT-qualifying every such reference with
// `global::`, which always binds to the project root regardless of the
// enclosing namespace.  This pins that invariant at the emitter level; the
// `build-generated-dotnet` / `behavioral-dotnet` gates (which emit a `deployable
// api`, i.e. root ns `Api`) are the compile-level guard.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

async function buildModel(file: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

// Any `<Ns>.Observability.HttpMetrics.<call>(` that is NOT root-qualified — the
// capture-prone form.  `global::Ns.Observability.HttpMetrics` is excluded by the
// lookbehind; a bare `Ns.Observability.HttpMetrics` is a regression.
const UNQUALIFIED_HTTP_METRICS = /(?<!global::)\b\w+\.Observability\.HttpMetrics\.\w+\(/;

describe(".NET observability namespace qualification", () => {
  it("root-qualifies every HttpMetrics reference with `global::`", async () => {
    const files = generateDotnet(await buildModel("examples/sales.ddd"));

    // DomainExceptionFilter lives in `<ns>.Api` and emits domain-fault counters.
    const filter = files.get("Api/DomainExceptionFilter.cs")!;
    expect(filter).toMatch(/^namespace \w+\.Api;/m);
    expect(filter).toContain("global::");
    expect(filter).toMatch(/global::\w+\.Observability\.HttpMetrics\.RecordDomainFault\(/);
    expect(filter).not.toMatch(UNQUALIFIED_HTTP_METRICS);

    // RequestLoggingMiddleware lives in `<ns>.Middleware` and records the
    // request-end metric.
    const mw = files.get("Middleware/RequestLoggingMiddleware.cs")!;
    expect(mw).toMatch(/^namespace \w+\.Middleware;/m);
    expect(mw).toMatch(/global::\w+\.Observability\.HttpMetrics\.Record\(/);
    expect(mw).not.toMatch(UNQUALIFIED_HTTP_METRICS);
  });
});
