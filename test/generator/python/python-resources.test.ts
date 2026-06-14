import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — resource verb clients (F1, resources.md).  A
// workflow / saga `<resource>.<verb>(...)` call resolves to an async
// helper in `app/resources/<sourceType>.py` (objectStore → boto3, queue
// → aio-pika, api → httpx); the workflow imports + awaits it.  Before
// F1 the workflow seam emitted a runtime `NotImplementedError`.
// Verified statically (uv sync + ruff + mypy --strict) by the
// `resources.ddd` corpus case.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/resources.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python resource verb clients", () => {
  it("emits one async client module per sourceType the deployable wires", async () => {
    const files = await build();
    const s3 = files.get("api/app/resources/s3.py")!;
    expect(s3).toContain("import boto3");
    expect(s3).toContain("async def sales_files_put(key: str, body: object) -> None:");
    expect(s3).toContain("async def sales_files_get(key: str) -> object | None:");
    expect(s3).toContain("async def sales_files_signed_url(key: str) -> str:");
    const mq = files.get("api/app/resources/rabbitmq.py")!;
    expect(mq).toContain("import aio_pika");
    expect(mq).toContain("async def sales_jobs_enqueue(message: object) -> None:");
    expect(mq).toContain("async def sales_jobs_publish(topic: str, message: object) -> None:");
    const api = files.get("api/app/resources/rest_api.py")!;
    expect(api).toContain("import httpx");
    expect(api).toContain("async def sales_api_get(path: str) -> object:");
    expect(api).toContain("async def sales_api_post(path: str, body: object) -> object:");
  });

  it("the workflow imports + awaits the verb helpers (no NotImplementedError)", async () => {
    const files = await build();
    const wf = files.get("api/app/http/workflows_routes.py")!;
    expect(wf).toContain("from app.resources.s3 import sales_files_get, sales_files_put");
    expect(wf).toContain("from app.resources.rabbitmq import sales_jobs_enqueue");
    expect(wf).toContain("from app.resources.rest_api import sales_api_get, sales_api_post");
    expect(wf).toContain('await sales_files_put("orders/" + name, name)');
    expect(wf).toContain("await sales_jobs_enqueue(name)");
    expect(wf).toContain('await sales_api_get("/rate")');
    expect(wf).not.toContain("NotImplementedError");
  });

  it("merges the client-library deps into pyproject", async () => {
    const files = await build();
    const pyproject = files.get("api/pyproject.toml")!;
    expect(pyproject).toContain("boto3");
    expect(pyproject).toContain("aio-pika");
    expect(pyproject).toContain("httpx");
    expect(pyproject).toContain("boto3-stubs");
  });

  it("resource-less deployables emit no resources/ dir", async () => {
    const { model, errors } = await parseString(
      FIXTURE.replace(/\s+salesFiles\.put[\s\S]*?salesApi\.post\("\/log", name\)\n/, "\n")
        .replace(/\n {2}resource sales(Files|Jobs|Api)[^\n]*\n/g, "\n")
        .replace(/, salesFiles, salesJobs, salesApi/, ""),
    );
    if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
    const files = generateSystems(model).files;
    expect([...files.keys()].some((k) => k.includes("app/resources/"))).toBe(false);
    const pyproject = files.get("api/pyproject.toml")!;
    expect(pyproject).not.toContain("boto3");
  });
});
