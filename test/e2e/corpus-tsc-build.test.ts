import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { generateCorpusCase } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";

// ---------------------------------------------------------------------------
// Phase 1 compile tier (docs/plans/global-test-coverage-plan.md) for the
// reference backend (Hono/TS).  The fast `corpus-coverage` gate proves every
// corpus feature *generates* on `node`; this gate proves the emitted project
// actually *type-checks* under strict `tsc` — upgrading the corpus from a
// generation floor to a compile guarantee, from the SAME single source of
// truth (one `.ddd` per feature, no per-backend duplicate).
//
// Slow (npm install + tsc per feature) — opt-in via LOOM_TS_BUILD=1.  CI shards
// one feature per cell via LOOM_CORPUS_TSC_CASE=<feature-id>.
// ---------------------------------------------------------------------------

const ENABLED = process.env.LOOM_TS_BUILD === "1";
const CASE = process.env.LOOM_CORPUS_TSC_CASE;

// Features that GENERATE on node but don't yet `tsc`-compile under strict mode —
// real Hono generator gaps this compile tier surfaced (the generation gate still
// covers all of them on all six backends; each line is a precise, reproducible
// bug report).  Widen the gate by FIXING the emitter, then dropping the entry.
const TS_COMPILE_SKIP: Record<string, string> = {
  // Required single (non-collection) containment emits null-unsafe repository code
  // (`root.shipment` / `root.note` possibly-null; `Memo | null` passed where `Memo`
  // is expected) — TS18047 / TS2345, db/repositories/*-repository.ts.  Hits both the
  // relational (single-containment) and embedded (embedded) shapes.
  "single-containment": "Hono required single-containment emits null-unsafe repo code (TS18047)",
  embedded: "Hono embedded-shape required single-containment emits null-unsafe repo code (TS18047)",
  // Durable-channel (outbox) workflow casts a union event to `DomainEvent` that
  // strict tsc rejects (TS2352, http/workflows.ts).  The ephemeral saga path
  // (corpus/saga) compiles; only `retention: log` diverges.
  outbox: "Hono outbox workflow casts a union event to DomainEvent (TS2352)",
  // Union-returning find route spreads a non-object union member (TS2698,
  // http/*.routes.ts) when translating the `Order or NotFound` result.
  "union-find-absence": "Hono union-find route spreads a non-object union type (TS2698)",
  // `when` can-query companion route references the gate's enum without importing
  // it (TS2304 'OrderStatus' not found, http/*.routes.ts).
  "state-gate": "Hono when/can-query route omits the enum import (TS2304)",
  // Resource clients import `amqplib` with no bundled type declarations — the
  // generated package.json omits `@types/amqplib` (TS7016, resources/rabbitmq.ts).
  resources: "Hono queue client missing @types/amqplib (TS7016)",
  // Workflow-sourced view references the saga state field out of scope (TS2304
  // 'attempts' not found, http/workflows.ts).
  "workflow-view": "Hono workflow-view references saga state field out of scope (TS2304)",
};

// Every corpus feature the manifest declares to generate on `node`, minus the
// documented compile-tier skips.
const nodeFeatures = CORPUS.filter((f) => f.backends.includes("node"))
  .filter((f) => !(f.id in TS_COMPILE_SKIP))
  .filter((f) => !CASE || f.id === CASE)
  .map((f) => f.id);

describe.skipIf(!ENABLED)("corpus features type-check under strict tsc (Hono/node)", () => {
  it.each(nodeFeatures)("%s — generated node project type-checks", async (featureId) => {
    const files = await generateCorpusCase(featureId, "node");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-corpus-tsc-${featureId}-`));
    try {
      // Write the emitted file map to disk.
      for (const [rel, content] of files) {
        const abs = path.join(outDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
      // The deployable is named `d` → its project lands under `d/`.
      const proj = path.join(outDir, "d");
      expect(
        fs.existsSync(path.join(proj, "package.json")),
        `${featureId}: node project emitted`,
      ).toBe(true);
      execSync("npm install --silent --no-audit --no-fund", {
        cwd: proj,
        stdio: "inherit",
        timeout: 180_000,
      });
      execSync("npx tsc --noEmit", { cwd: proj, stdio: "inherit", timeout: 120_000 });
    } finally {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }, 360_000);
});
