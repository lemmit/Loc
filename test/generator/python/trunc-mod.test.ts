import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// M-T9.24 A3 — cross-backend `%` semantics on Python.
//
// Python's `%` FLOORS: the result takes the sign of the DIVISOR, so
// `-5 % 3 == 1`.  TS/JS, C#, Java and Elixir (which deliberately emits
// `rem/2`) all TRUNCATE towards zero — the result takes the sign of the
// DIVIDEND, so `-5 % 3 == -2`.  Python was the sole outlier, which made the
// same `.ddd` expression mean two different things depending on the backend.
//
// The renderer now lowers `%` to the emitted `trunc_mod` helper.  Wiring is a
// central pass over the finished file map, so this suite checks BOTH halves:
// the call reaches every emitter that can render a `%`, and each of those
// modules carries the import (a missing one is an import-time `NameError`,
// i.e. a silent boot break).
// ---------------------------------------------------------------------------

const SOURCE = `
system ModProbe {
  subdomain Ops {
    context Ops {

      valueobject Slot {
        offset: int
        function bucket(): int { return offset % 7 }
      }

      aggregate Job with crudish {
        seq: int
        bay: Slot
        derived parity: int = seq % 2
        invariant seq % 3 >= 0

        function ring(): int { return seq % 12 }

        operation advance(by: int) {
          let next = (seq + by) % 24
          seq := next
        }
      }

      repository Jobs for Job {
        find bySeq(s: int): Job? where this.seq == s
      }

      domainService Sharding {
        operation shardOf(n: int): int {
          return n % 16
        }
      }

      workflow Rebalance transactional {
        create(total: int) {
          let bucket = Sharding.shardOf(total % 8)
          let s2 = Slot { offset: 1 }
          let j = Job.create({ seq: bucket, bay: s2 })
        }
      }
    }
  }

  api ModApi from Ops
  storage primary { type: postgres }
  resource opsState { for: Ops, kind: state, use: primary }
  deployable svc {
    platform: python
    contexts: [Ops]
    dataSources: [opsState]
    serves: ModApi
    port: 4000
  }
}
`;

const IMPORT = "from app.domain.numeric import trunc_mod";

async function build(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SOURCE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python `%` truncates towards zero (cross-backend parity)", () => {
  it("lowers `%` to trunc_mod in every domain-expression emitter", async () => {
    const files = await build();
    // derived + invariant + function + operation body (aggregate emitter)
    expect(files.get("svc/app/domain/job.py")).toContain("trunc_mod(self._seq, 2)");
    // value-object function emitter
    expect(files.get("svc/app/domain/value_objects.py")).toContain("trunc_mod(self.offset, 7)");
    // domain-service emitter
    expect(files.get("svc/app/domain/services/sharding.py")).toContain("trunc_mod(n, 16)");
    // workflow step emitter
    expect(files.get("svc/app/http/workflows_routes.py")).toContain("trunc_mod(total, 8)");
    // the invariant re-check on the wire boundary (route module)
    expect(files.get("svc/app/http/job_routes.py")).toContain("trunc_mod(self.seq, 3)");
    // the native operator is gone from the domain module
    expect(files.get("svc/app/domain/job.py")).not.toMatch(/\bself\._seq % /);
  });

  it("emits the helper and imports it in every module that calls it", async () => {
    const files = await build();
    const helper = files.get("svc/app/domain/numeric.py");
    expect(helper).toBeDefined();
    expect(helper).toContain("def trunc_mod(a: _N, b: _N) -> _N:");

    for (const [path, content] of files) {
      if (!path.startsWith("svc/") || !/\btrunc_mod\(/.test(content)) continue;
      if (path === "svc/app/domain/numeric.py") continue;
      expect(content, `${path} calls trunc_mod without importing it`).toContain(IMPORT);
    }
  });

  it("does not emit the helper for a project with no `%`", async () => {
    const { model, errors } = await parseString(SOURCE.replace(/ % \d+/g, " + 1"));
    if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
    const files = generateSystems(model).files;
    expect(files.has("svc/app/domain/numeric.py")).toBe(false);
    for (const [, content] of files) expect(content).not.toContain(IMPORT);
  });
});
