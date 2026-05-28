import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// The playground storybook examples are single-file `system` sources the
// example picker offers in `web/src/examples/index.ts`.  Each is a full
// Hono + React deployable pair the Preview iframe boots, so they must
// parse clean and generate a system without throwing.
//
// This is the fast-suite gate the slow `generated-react-build.yml` matrix
// (LOOM_REACT_BUILD=1) can't be: the `module → subdomain` rename (PR #680)
// silently rewrote `modules: Stories` → `contexts: [Stories]` in all eight
// storybooks, but `Stories` is the *subdomain* — the bounded context is
// named `Storybook` — so every storybook stopped resolving and every
// `*-preview-runtime` e2e failed at the generate step.  Nothing in the
// default `npm test` caught it.  This does.
const storybooks = [
  "web/src/examples/storybook-mantine.ddd",
  "web/src/examples/storybook-mantine-v9.ddd",
  "web/src/examples/storybook-shadcn.ddd",
  "web/src/examples/storybook-shadcn-v4.ddd",
  "web/src/examples/storybook-mui.ddd",
  "web/src/examples/storybook-mui-v7.ddd",
  "web/src/examples/storybook-chakra.ddd",
  "web/src/examples/storybook-chakra-v3.ddd",
];

async function buildDoc(file: string) {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], {
    validation: true,
  });
  return doc;
}

describe("playground storybook examples", () => {
  it.each(storybooks)("%s parses without errors", async (file) => {
    const doc = await buildDoc(file);
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
    expect(errors.map((d) => `${d.range.start.line + 1}: ${d.message}`)).toEqual([]);
  });

  it.each(storybooks)("%s generates a system", async (file) => {
    const doc = await buildDoc(file);
    const model = doc.parseResult.value as Model;
    const { files } = generateSystems(model);
    // A Hono + React deployable pair emits both a backend entrypoint and a
    // docker-compose at the system root.
    expect(files.has("docker-compose.yml")).toBe(true);
    expect(files.size).toBeGreaterThan(0);
  });
});
