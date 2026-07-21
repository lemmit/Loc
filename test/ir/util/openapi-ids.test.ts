import { describe, expect, it } from "vitest";

import {
  camelId,
  opCreate,
  opFind,
  opGetById,
  opList,
  opOperation,
  opWorkflow,
  snakeId,
} from "../../../src/ir/util/openapi-ids.js";

// The conformance gate normalises operationIds case-insensitively (lower
// + strip separators).  Mirror that here so the assertions express the
// behavioural contract: the same token array must normalise equal across
// every backend idiom.
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

describe("openapi-ids canonical tokens", () => {
  // Each row: [tokens, expected camel (Hono/.NET), expected snake (Phoenix)].
  // The camel column pins byte-identical parity with Hono's pre-existing
  // scheme for the showcase aggregates / ops / finds / workflows.
  const cases: Array<[readonly string[], string, string]> = [
    [opCreate("Project"), "createProject", "create_project"],
    [opGetById("Project"), "getProjectById", "get_project_by_id"],
    [opList("Project"), "allProject", "all_project"],
    [opOperation("Project", "rename"), "renameProject", "rename_project"],
    [opOperation("Project", "addPipeline"), "addPipelineProject", "add_pipeline_project"],
    [opOperation("Project", "syncFromVcs"), "syncFromVcsProject", "sync_from_vcs_project"],
    [opFind("Project", "byName"), "byNameProject", "by_name_project"],
    [opFind("Build", "bySha"), "byShaBuild", "by_sha_build"],
    [opWorkflow("registerProject"), "registerProjectWorkflow", "register_project_workflow"],
  ];

  for (const [tokens, expectCamel, expectSnake] of cases) {
    it(`[${tokens}] → camel=${expectCamel} snake=${expectSnake}`, () => {
      expect(camelId(tokens)).toBe(expectCamel);
      expect(snakeId(tokens)).toBe(expectSnake);
    });

    it(`[${tokens}] camel/snake normalise equal`, () => {
      expect(norm(camelId(tokens))).toBe(norm(snakeId(tokens)));
    });
  }
});
