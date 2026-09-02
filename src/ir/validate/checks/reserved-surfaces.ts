// ---------------------------------------------------------------------------
// `loom.reserved-not-emitted` — the ONE meta-diagnostic for a PARSE-BUT-NO-EMIT
// surface (M-T5.9).
//
// Loom's grammar has repeatedly grown a clause ahead of the emitter that would
// honour it.  The clause parses, the AST validator accepts it, the lowerer
// stamps it onto the IR — and then no generator reads it.  The author gets a
// clean `ddd parse`, byte-identical generated output with and without the
// clause, and a runtime that quietly does the opposite of what the source says:
//
//   `timerSource … in: "America/New_York"`  → the cron fires in UTC.
//   `timerSource … overlap: allow`         → overlapping runs are still skipped.
//   `storage pg { connection: secret(dbUrl) }`
//                                          → the emitted compose/k8s wiring is
//                                            derived HEURISTICALLY from the
//                                            compose host name, never from the
//                                            declared secret.
//
// The repo's standing rule is that a capability no backend emits gets a NAMED
// diagnostic rather than silence (`docs/decisions.md`, and the sibling
// `loom.datasource-knob-unwired` pass a few hundred lines up in
// `system-checks.ts`, which does exactly this for `DataSourceIR`).  What was
// missing is the general home: every new inert surface invented its own code,
// or — far more often — none at all.
//
// This module is that home.  `RESERVED_SURFACES` is the single registry; a new
// parse-but-inert clause adds ONE row here instead of a bespoke gate, and the
// row is self-emptying: when the emitter lands, the row is deleted in the same
// PR and the warning disappears.
//
// SEVERITY is `warning`, deliberately.  A clause the emitters ignore is not
// wrong source — it is source whose promise the toolchain cannot keep yet — so
// it must not break an existing build the way an `error` would.  A surface bad
// enough to refuse outright gets its own error gate instead (the
// `shape:`-on-`eventLog` clash, `loom.shape-on-event-sourced`, is one: there the
// knob does not merely go unread, it contradicts the persistence mode the same
// declaration picked).
// ---------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import type { SystemIR } from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";

/** One parse-but-no-emit surface.  `probe` returns the declared spelling of the
 *  clause when the given system declares it (used verbatim in the message), or
 *  `undefined` when it does not. */
export interface ReservedSurface {
  /** Stable id — what a reader greps for, and what the completeness test pins. */
  readonly id: string;
  /** The clause as an author writes it (`in:`, `overlap:`, `connection:`). */
  readonly clause: string;
  /** What the runtime actually does instead — the honest consequence. */
  readonly consequence: string;
  /** Every declaration in `sys` that spells the clause, as
   *  `{ source, spelling }` pairs. */
  readonly probe: (sys: SystemIR) => { source: string; spelling: string }[];
}

export const RESERVED_SURFACES: readonly ReservedSurface[] = [
  {
    id: "timer-source-timezone",
    clause: "in:",
    consequence:
      "the cron expression is handed to each backend's scheduler with no timezone, so the " +
      "timer fires on the scheduler's own clock (UTC in every generated compose stack)",
    probe: (sys) =>
      sys.timerSources
        .filter((t) => t.timezone !== undefined)
        .map((t) => ({
          source: `${sys.name}/timerSource/${t.name}`,
          spelling: `in: ${JSON.stringify(t.timezone)}`,
        })),
  },
  {
    id: "timer-source-overlap",
    clause: "overlap:",
    consequence:
      "every backend still wraps the tick in its skip-on-contention advisory lock, so a run " +
      "that overlaps the previous one is dropped rather than allowed",
    probe: (sys) =>
      sys.timerSources
        .filter((t) => t.overlap !== undefined)
        .map((t) => ({
          source: `${sys.name}/timerSource/${t.name}`,
          spelling: "overlap: allow",
        })),
  },
  {
    id: "storage-connection",
    clause: "connection:",
    consequence:
      "the generated compose environment and the k8s/Helm secret wiring are derived " +
      "heuristically from the compose service host instead (src/system/kubernetes.ts), so the " +
      "declared source is never the one the deployment reads",
    probe: (sys) =>
      sys.storages
        .filter((s) => s.connection !== undefined)
        .map((s) => ({
          source: `${sys.name}/storage/${s.name}`,
          spelling: `connection: ${connectionSpelling(s.connection!)}`,
        })),
  },
];

function connectionSpelling(c: NonNullable<SystemIR["storages"][number]["connection"]>): string {
  switch (c.kind) {
    case "service":
      return `service(${c.service})`;
    case "env":
      return `env(${JSON.stringify(c.env)})`;
    case "secret":
      return `secret(${c.secret})`;
    case "literal":
      return "literal(…)";
  }
}

/** Warn once per (surface, declaration) for every reserved clause the system
 *  spells.  Registry-driven so a new inert surface is one row, not a gate. */
export function validateReservedSurfaces(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const surface of RESERVED_SURFACES) {
    for (const hit of surface.probe(sys)) {
      diags.push({
        severity: "warning",
        code: "loom.reserved-not-emitted",
        message: diagMessage("loom.reserved-not-emitted", {
          spelling: hit.spelling,
          consequence: surface.consequence,
        }),
        source: hit.source,
      });
    }
  }
}
