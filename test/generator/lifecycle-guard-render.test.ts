// The canonical `create` / `destroy` `requires` gate — ENFORCEMENT, on all five
// backends, from the shared corpus fixture.
//
// WHY THIS GATE IS SHAPED THE WAY IT IS.  The first attempt at this emission
// (#2450) shipped a gate that PASSED FOUR SEEDED DEFECTS: a polarity inversion
// on Elixir (twice), on Hono, and on Python, and .NET's destroy gate moved
// BELOW the delete.  Every one of those is a real, plausible emitter bug, and
// every one of them leaves a route that answers 403 in its OpenAPI while letting
// the request through — the exact failure this whole line of work started from.
// A gate that only asks "does the word Forbidden appear near the create" cannot
// see any of them.
//
// So this test asserts two things a presence check cannot:
//
//   1. POLARITY + RECEIVER + MESSAGE, by pinning the gate line BYTE-EXACT.  An
//      inverted condition, a gate rendered against the wrong receiver, a
//      dropped conjunct, and a drifted 7807 `detail` are all one diff away from
//      the expected string, so all four fail here rather than in production.
//      (The strings are per-backend on purpose: five independent observations,
//      not one shared helper that could be wrong in the same way five times.)
//   2. ORDERING, by INDEX arithmetic in the emitted text.  The create gate must
//      precede the factory (a guard that runs after construction is not a
//      gate); the destroy gate must FOLLOW the by-id load (so an unreachable id
//      still answers 404) and PRECEDE the delete and any audit staging (a
//      denial must not roll back work it should never have started).
//
// And it pins the two shapes only a second aggregate can show:
//
//   * `Crate.create` is UNGATED — its emitted create must carry no denial at
//     all, so an emitter that gates every create (or a test that matches too
//     loosely) fails;
//   * `Crate.destroy`'s gate is PRINCIPAL-ONLY — it reads no field of the row,
//     which is the shape that strands an unused receiver binding (`mix compile
//     --warnings-as-errors` rejects it; C1 of the M-T3.16 plan).
//
// The sibling gate in `test/ir/api-surface-parity.test.ts` compares the DECLARED
// error statuses — the half a client reads.  It could not have caught the
// original bug: a backend can publish 403 and still let the request through.
// That is why this one reads the emitted HANDLER rather than the emitted spec.

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { toLoomModel } from "../_helpers/ir.js";
import { parseString } from "../_helpers/parse.js";
import type { Backend } from "../fixtures/corpus/backends.js";
import { generateCorpusCase } from "../fixtures/corpus/harness.js";

const FEATURE = "lifecycle-guard";

/** One emitted region, addressed by the marker that opens it and the marker
 *  that closes it — so an ordering assertion cannot accidentally compare
 *  indices across two different handlers in the same file. */
interface Region {
  /** Emitted path ends with this. */
  readonly file: string;
  readonly from: string;
  readonly to: string;
}

interface GateSpec {
  readonly region: Region;
  /** The emitted gate line, byte-exact (trimmed of leading indentation). */
  readonly gate: string;
  /** Text the gate must appear BEFORE (construction / delete / audit stage). */
  readonly before: readonly string[];
  /** Text the gate must appear AFTER (the by-id load, for a destroy). */
  readonly after?: readonly string[];
}

interface BackendSpec {
  readonly create: GateSpec;
  readonly destroy: GateSpec;
  /** `Crate.create` — ungated; this region must contain no denial. */
  readonly ungatedCreate: Region;
  /** `Crate.destroy` — a principal-ONLY gate. */
  readonly principalOnlyDestroy: GateSpec;
  /** Extra per-backend pins (Phoenix's context placement + both callers). */
  readonly extra?: (files: ReadonlyMap<string, string>) => void;
}

const SPECS: Record<Backend, BackendSpec> = {
  node: {
    create: {
      region: {
        file: "http/shipment.routes.ts",
        from: 'operationId: "createShipment"',
        to: "\n  );",
      },
      gate: 'if (!((currentUser.permissions).includes("ops.manage"))) throw new ForbiddenError("Forbidden: currentUser.permissions.contains(permissions.manage)");',
      before: ["const created = Shipment.create(", "await repo.save(created);"],
    },
    destroy: {
      region: {
        file: "http/shipment.routes.ts",
        from: 'operationId: "destroyShipment"',
        to: "\n  );",
      },
      gate: 'if (!((currentUser.permissions).includes("ops.manage") && __loaded.quantity === 0)) throw new ForbiddenError("Forbidden: currentUser.permissions.contains(permissions.manage) && quantity == 0");',
      after: ["const __loaded = await repo.getById(Ids.ShipmentId(id));"],
      before: ["await repo.delete(Ids.ShipmentId(id));"],
    },
    ungatedCreate: {
      file: "http/crate.routes.ts",
      from: 'operationId: "createCrate"',
      to: "\n  );",
    },
    principalOnlyDestroy: {
      region: { file: "http/crate.routes.ts", from: 'operationId: "destroyCrate"', to: "\n  );" },
      gate: 'if (!((currentUser.permissions).includes("ops.manage"))) throw new ForbiddenError("Forbidden: currentUser.permissions.contains(permissions.manage)");',
      after: ["await repo.getById(Ids.CrateId(id));"],
      before: ["tx.insert(schema.auditRecords)", "await repoTx.delete(Ids.CrateId(id));"],
    },
  },
  python: {
    create: {
      region: {
        file: "app/http/shipment_routes.py",
        from: "async def create_shipment(",
        to: "\n@router",
      },
      gate:
        'if "ops.manage" not in current_user.permissions:\n' +
        '        raise ForbiddenError("Forbidden: currentUser.permissions.contains(permissions.manage)")',
      before: ["created = Shipment.create("],
    },
    destroy: {
      region: {
        file: "app/http/shipment_routes.py",
        from: "async def destroy_shipment(",
        to: "\n@router",
      },
      gate:
        'if not ("ops.manage" in current_user.permissions and __loaded.quantity == 0):\n' +
        '        raise ForbiddenError("Forbidden: currentUser.permissions.contains(permissions.manage) && quantity == 0")',
      after: ["__loaded = await repo.get_by_id(ShipmentId(id))"],
      before: ["await repo.delete(ShipmentId(id))"],
    },
    ungatedCreate: {
      file: "app/http/crate_routes.py",
      from: "async def create_crate(",
      to: "\n@router",
    },
    principalOnlyDestroy: {
      region: {
        file: "app/http/crate_routes.py",
        from: "async def destroy_crate(",
        to: "\n@router",
      },
      gate:
        'if "ops.manage" not in current_user.permissions:\n' +
        '        raise ForbiddenError("Forbidden: currentUser.permissions.contains(permissions.manage)")',
      after: ["await repo.get_by_id(CrateId(id))"],
      before: ["await repo.record_audit(", "await repo.delete(CrateId(id))"],
    },
  },
  java: {
    create: {
      region: {
        file: "features/shipments/ShipmentService.java",
        from: "public ShipmentId createShipment(",
        to: "\n    }",
      },
      gate: 'if (!(currentUser.permissions().contains("ops.manage"))) throw new ForbiddenException("Forbidden: currentUser.permissions.contains(permissions.manage)");',
      before: ["var aggregate = Shipment.create(", "repository.save(aggregate);"],
    },
    destroy: {
      region: {
        file: "features/shipments/ShipmentService.java",
        from: "public void destroyShipment(",
        to: "\n    }",
      },
      gate: 'if (!(currentUser.permissions().contains("ops.manage") && aggregate.quantity() == 0)) throw new ForbiddenException("Forbidden: currentUser.permissions.contains(permissions.manage) && quantity == 0");',
      after: ["var aggregate = repository.getById(id);"],
      before: ["repository.delete(aggregate);"],
    },
    ungatedCreate: {
      file: "features/crates/CrateService.java",
      from: "public CrateId createCrate(",
      to: "\n    }",
    },
    principalOnlyDestroy: {
      region: {
        file: "features/crates/CrateService.java",
        from: "public void destroyCrate(",
        to: "\n    }",
      },
      gate: 'if (!(currentUser.permissions().contains("ops.manage"))) throw new ForbiddenException("Forbidden: currentUser.permissions.contains(permissions.manage)");',
      after: ["var aggregate = repository.getById(id);"],
      before: ["auditRecords.save(new AuditRecord(", "repository.delete(aggregate);"],
    },
  },
  dotnet: {
    // CQRS: the gate lives in the command HANDLER — the controller is a thin
    // Mediator dispatch that holds neither the principal nor the loaded row.
    create: {
      region: {
        file: "Shipments/Commands/CreateShipmentHandler.cs",
        from: "public async ValueTask<ShipmentId> Handle(",
        to: "\n    }",
      },
      gate:
        'if (!((currentUser.Permissions).Contains("ops.manage")))\n' +
        "        {\n" +
        '            throw new ForbiddenException("Forbidden: currentUser.permissions.contains(permissions.manage)");',
      before: ["var aggregate = Shipment.Create(", "await _repo.SaveAsync(aggregate"],
    },
    destroy: {
      region: {
        file: "Shipments/Commands/DestroyShipmentHandler.cs",
        from: "public async ValueTask<Unit> Handle(",
        to: "\n    }",
      },
      gate:
        'if (!((currentUser.Permissions).Contains("ops.manage") && aggregate.Quantity == 0))\n' +
        "        {\n" +
        '            throw new ForbiddenException("Forbidden: currentUser.permissions.contains(permissions.manage) && quantity == 0");',
      after: ["var aggregate = await _repo.GetByIdAsync(command.Id, cancellationToken)"],
      // The seeded defect #2450's gate could not see: the deny moved BELOW the
      // delete, which denies a deletion that already happened.
      before: ["await _repo.DeleteAsync(aggregate, cancellationToken);"],
    },
    ungatedCreate: {
      file: "Crates/Commands/CreateCrateHandler.cs",
      from: "public async ValueTask<CrateId> Handle(",
      to: "\n    }",
    },
    principalOnlyDestroy: {
      region: {
        file: "Crates/Commands/DestroyCrateHandler.cs",
        from: "public async ValueTask<Unit> Handle(",
        to: "\n    }",
      },
      gate:
        'if (!((currentUser.Permissions).Contains("ops.manage")))\n' +
        "        {\n" +
        '            throw new ForbiddenException("Forbidden: currentUser.permissions.contains(permissions.manage)");',
      after: ["var aggregate = await _repo.GetByIdAsync(command.Id, cancellationToken)"],
      before: [
        "_audit.Stage(new AuditRecord",
        "await _repo.DeleteAsync(aggregate, cancellationToken);",
      ],
    },
  },
  vanilla: {
    // Phoenix gates in the CONTEXT, not the controller: its scaffolded LiveView
    // calls `<Ctx>.create_<agg>` / `destroy_<agg>!` directly, so a
    // controller-level gate has a second front door (plan Appendix A / A1).
    create: {
      region: { file: "lib/d/warehouse.ex", from: "def create_shipment(", to: "\n  end" },
      gate:
        "with :ok <- ensure(not is_nil(current_user) and " +
        '(Enum.member?(current_user.permissions, "ops.manage")), ' +
        '{:forbidden, "Forbidden: currentUser.permissions.contains(permissions.manage)"}) do',
      before: ["create_shipment_unguarded(attrs)"],
    },
    destroy: {
      region: { file: "lib/d/warehouse.ex", from: "def delete_shipment(", to: "\n  end" },
      gate:
        "with :ok <- ensure(not is_nil(current_user) and " +
        '(Enum.member?(current_user.permissions, "ops.manage") and record.quantity == 0), ' +
        '{:forbidden, "Forbidden: currentUser.permissions.contains(permissions.manage) && quantity == 0"}) do',
      before: ["delete_shipment_unguarded(record)"],
    },
    ungatedCreate: { file: "lib/d/warehouse.ex", from: "create_crate(", to: "\n  defdelegate" },
    principalOnlyDestroy: {
      region: { file: "lib/d/warehouse.ex", from: "def delete_crate(", to: "\n  end" },
      gate:
        "with :ok <- ensure(not is_nil(current_user) and " +
        '(Enum.member?(current_user.permissions, "ops.manage")), ' +
        '{:forbidden, "Forbidden: currentUser.permissions.contains(permissions.manage)"}) do',
      before: ["delete_crate_unguarded(record)"],
    },
    extra: (files) => {
      const ctx = read(files, "lib/d/warehouse.ex");
      // The CONTEXT-placement pin, stated as the thing that would break if the
      // gate moved back to the controller: the gated seams are real functions
      // taking a principal, not bare `defdelegate`s to the repository.
      // The PLAIN name specifically — `create_shipment_unguarded` IS a
      // delegate, deliberately (see the in-process note below), so the pin has
      // to be anchored on the arity-opening paren or it forbids the seam split
      // it is meant to allow.
      expect(ctx).not.toMatch(/defdelegate create_shipment\(/);
      expect(ctx).not.toMatch(/defdelegate delete_shipment\(/);
      expect(ctx).toContain("def create_shipment(attrs, current_user \\\\ nil) do");
      expect(ctx).toContain("def delete_shipment(record, current_user \\\\ nil) do");
      // The DestroyForm seam (`destroy_<agg>!/2`) gates too, and raises on
      // denial — a bang function's contract, and the same fail-closed answer its
      // existing missing-row path gives.
      const bang = region(ctx, "def destroy_shipment!(", "\n  end");
      expect(bang).toContain("{:error, {:forbidden, detail}} -> raise detail");
      expect(indexOfOrThrow(bang, "ensure(")).toBeLessThan(
        indexOfOrThrow(bang, "D.Repo.delete!(record)"),
      );
      // The CONTROLLER's job is now to thread the principal and answer the typed
      // denial — not to hold the gate.
      const controller = read(files, "controllers/shipment_controller.ex");
      expect(controller).toContain("Warehouse.create_shipment(params, current_user)");
      expect(controller).toContain("Warehouse.delete_shipment(record, current_user)");
      expect(controller).toContain("{:error, {:forbidden, detail}} ->");
      // An UNGATED create keeps its delegate byte-for-byte — the control that
      // catches "make every write a guarded function".
      expect(ctx).toContain(
        "defdelegate create_crate(attrs), to: D.Warehouse.CrateRepository, as: :insert",
      );

      // ── the IN-PROCESS caller, and why the seam splits ───────────────────
      // Gating in the context also catches callers that are not requests at
      // all: a workflow `factory-let`, an event dispatch, and the emitted
      // integration tests create aggregates in-process with no principal.  The
      // other four backends call the domain factory directly from the workflow
      // body, so the create gate never applies there — routing those through the
      // guarded seam denied (nil principal) a workflow whose own caller DID hold
      // the permission: the same `.ddd` answering 200 on four backends and
      // 403/500 on one.
      //
      // So the guarded seam keeps the PLAIN name (a caller that guesses it gets
      // the gate) and the in-process entry is `_unguarded` (bypassing has to be
      // said out loud).  Both halves are asserted, because either one alone is a
      // bug: the workflow on the ungated entry, the request doors on the gated
      // one.
      expect(ctx).toContain(
        "defdelegate create_shipment_unguarded(attrs), to: D.Warehouse.ShipmentRepository, as: :insert",
      );
      expect(ctx).toContain(
        "defdelegate delete_shipment_unguarded(record), to: D.Warehouse.ShipmentRepository, as: :delete",
      );
      // The guarded function delegates THROUGH the unguarded one, so there is
      // exactly one write path and the gate cannot be skipped by editing one.
      const guardedCreate = region(ctx, "def create_shipment(attrs,", "\n  end");
      expect(guardedCreate).toContain("create_shipment_unguarded(attrs)");
      expect(indexOfOrThrow(guardedCreate, "ensure(")).toBeLessThan(
        indexOfOrThrow(guardedCreate, "create_shipment_unguarded(attrs)"),
      );
      // The workflow's `factory-let` — an in-process caller — targets the
      // ungated entry.  This is the assertion that fails if the seam collapses
      // back to one function.
      const wf = read(files, "workflows/receiving/start_crate_ready.ex");
      expect(wf).toContain("D.Warehouse.create_shipment_unguarded(");
      expect(wf).not.toContain("D.Warehouse.create_shipment(");
    },
  },
};

/** The one emitted file whose path ends with `suffix`. */
function read(files: ReadonlyMap<string, string>, suffix: string): string {
  const hits = [...files.keys()].filter((p) => p.endsWith(suffix));
  expect(hits, `emitted file ending in ${suffix}`).toHaveLength(1);
  return files.get(hits[0]!)!;
}

/** The slice of `src` from `from` to the next `to` after it — so an ordering
 *  comparison stays inside ONE handler. */
function region(src: string, from: string, to: string): string {
  const start = indexOfOrThrow(src, from);
  const end = src.indexOf(to, start);
  return src.slice(start, end === -1 ? undefined : end);
}

function indexOfOrThrow(src: string, needle: string): number {
  const i = src.indexOf(needle);
  if (i === -1) throw new Error(`not found in emitted source: ${JSON.stringify(needle)}`);
  return i;
}

function assertGate(files: ReadonlyMap<string, string>, spec: GateSpec, label: string): void {
  const src = read(files, spec.region.file);
  const text = region(src, spec.region.from, spec.region.to);
  // (1) the gate, byte-exact — polarity, receiver, message, all in one.
  expect(text, `${label}: the emitted gate line`).toContain(spec.gate);
  // Exactly once: a duplicated gate is double evaluation, not extra safety.
  expect(text.split(spec.gate).length - 1, `${label}: gate occurrences`).toBe(1);
  // (2) ordering, by index.
  const at = indexOfOrThrow(text, spec.gate);
  for (const later of spec.before) {
    expect(at, `${label}: gate must precede ${JSON.stringify(later)}`).toBeLessThan(
      indexOfOrThrow(text, later),
    );
  }
  for (const earlier of spec.after ?? []) {
    expect(at, `${label}: gate must follow ${JSON.stringify(earlier)}`).toBeGreaterThan(
      indexOfOrThrow(text, earlier),
    );
  }
}

/** Every spelling of a denial, across the five backends — used NEGATIVELY, on
 *  the ungated control, so a gate-everything emitter cannot hide behind one
 *  backend's idiom. */
const DENIAL_SPELLINGS = ["ForbiddenError(", "ForbiddenException(", ":forbidden", "403"] as const;

// ── the emission's PRECONDITION, per spelling ──────────────────────────────
// Every backend above renders the create gate with NO receiver in scope: Hono
// and FastAPI put it in a module-scope handler, .NET in a Mediator handler, Java
// in a service method, Elixir in a context function.  That is only sound because
// a guard that reads the instance is REFUSED upstream — so the refusal is part of
// this suite, not just of the validator's.  If it ever regresses, these five
// sources reach the emitters and produce an unbound receiver on all five
// backends (and, for the bare `helper-fn` spelling, a gate that never denies).
//
// One case per SPELLING, because "reads the instance" has five of them and only
// one lowers to a `ref` — the hole the owner review found in the contract check
// (#2487): the predicate keyed on `refKind`, so four spellings walked around it.
const UNREADABLE = "loom.lifecycle-guard-unreadable";

const SPELLINGS: Record<string, string> = {
  "a field ref": "requires quantity == 0",
  "an explicit `this.` receiver": "requires this.quantity == 0",
  "a bare aggregate-`function` call": "requires isEmpty()",
  "a `this.`-qualified call": "requires this.isEmpty()",
  "a function named but not called": "requires isEmpty",
};

describe("the emitters never see an instance-reading create guard", () => {
  for (const [label, guard] of Object.entries(SPELLINGS)) {
    it(`refuses ${label} before codegen`, async () => {
      const { model } = await parseString(
        `
system P {
  user { id: string  role: string }
  subdomain D {
    context Orders {
      aggregate Order {
        code: string
        quantity: int
        function isEmpty(): bool { return quantity == 0 }
        create(code: string) { ${guard} }
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: node contexts: [Orders] dataSources: [st] port: 3000 auth: required }
}`,
        { validate: false },
      );
      const codes = validateLoomModel(toLoomModel(model))
        .filter((d) => d.severity === "error")
        .map((d) => d.code);
      expect(codes, `${label} must be refused, not rendered`).toContain(UNREADABLE);
    });
  }
});

describe("lifecycle `requires` — the emitted gate ENFORCES, per backend", () => {
  for (const [backend, spec] of Object.entries(SPECS) as [Backend, BackendSpec][]) {
    it(`${backend}: a guarded create denies before constructing, a guarded destroy after the load and before the delete`, async () => {
      const files = await generateCorpusCase(FEATURE, backend);
      assertGate(files, spec.create, `${backend} create`);
      assertGate(files, spec.destroy, `${backend} destroy`);
      assertGate(files, spec.principalOnlyDestroy, `${backend} principal-only destroy`);
      // The UNGATED control: `Crate.create` declares no `requires`, so its
      // emitted create must carry no denial in ANY backend's spelling.
      const ungated = region(
        read(files, spec.ungatedCreate.file),
        spec.ungatedCreate.from,
        spec.ungatedCreate.to,
      );
      for (const spelling of DENIAL_SPELLINGS) {
        expect(ungated, `${backend}: ungated create must not deny (${spelling})`).not.toContain(
          spelling,
        );
      }
      spec.extra?.(files);
    });
  }
});
