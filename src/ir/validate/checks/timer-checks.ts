// -------------------------------------------------------------------------
// Timer-source checks (scheduling.md, M-T4.1) — `timerSource` fires a plain
// event on a wall-clock cadence, which workflows react to via the existing
// `on`/`create … by` triggers.  These gates keep the "time as an event source"
// model safe: the for-event must be a dedicated infrastructure tick (not a
// domain event some aggregate also emits), the owning deployable must bind a
// relational `state` resource (the single-fire advisory lock needs Postgres),
// exactly one cadence field is set and is well-formed, and something actually
// reacts to the tick.
// -------------------------------------------------------------------------

import { descriptorFor } from "../../../platform/metadata.js";
import type {
  BoundedContextIR,
  StmtIR,
  SubdomainIR,
  SystemIR,
  TimerSourceIR,
  WorkflowStmtIR,
} from "../../types/loom-ir.js";
import { walkStmtChildren, walkWorkflowStmtChildren } from "../../util/walk.js";
import type { LoomDiagnostic } from "./diagnostic.js";

/** Every event name that appears as an `emit` operand anywhere in a context —
 *  aggregate operation/create/destroy bodies and workflow bodies.  A timer's
 *  for-event must NOT be in this set (it is infrastructure-emitted only). */
function collectEmittedEvents(ctx: BoundedContextIR): Set<string> {
  const out = new Set<string>();
  const scanStmt = (s: StmtIR): void => {
    if (s.kind === "emit") out.add(s.eventName);
    walkStmtChildren(
      s,
      () => {},
      (child) => scanStmt(child),
    );
  };
  const scanWfStmt = (s: WorkflowStmtIR): void => {
    if (s.kind === "emit") out.add(s.eventName);
    walkWorkflowStmtChildren(s, { workflowStmt: (child) => scanWfStmt(child) });
  };
  for (const agg of ctx.aggregates) {
    const ops = [...agg.operations, ...(agg.creates ?? []), ...(agg.destroys ?? [])];
    for (const op of ops) for (const s of op.statements) scanStmt(s);
  }
  for (const wf of ctx.workflows ?? []) {
    for (const c of wf.creates) for (const s of c.statements) scanWfStmt(s);
    for (const on of wf.subscriptions ?? []) for (const s of on.statements) scanWfStmt(s);
    for (const h of wf.handlers ?? []) for (const s of h.statements) scanWfStmt(s);
    for (const s of wf.statements) scanWfStmt(s);
  }
  return out;
}

/** Every event name any workflow in the context reacts to — via an `on(e)`
 *  subscription or an event-triggered `create(e) by …`. */
function collectReactedEvents(ctx: BoundedContextIR): Set<string> {
  const out = new Set<string>();
  for (const wf of ctx.workflows ?? []) {
    for (const on of wf.subscriptions ?? []) out.add(on.event);
    for (const c of wf.creates) if (c.triggerKind === "event" && c.eventRef) out.add(c.eventRef);
  }
  return out;
}

/** Resolve the deployable that owns a timer's emission — the DB owner of the
 *  for-event's context.  Derived from the subdomain's enrichment-computed
 *  `migrationsOwner` (the single-fire lock owner and the DB owner coincide). */
function timerOwnerDeployable(sys: SystemIR, ts: TimerSourceIR): string | undefined {
  const sub = sys.subdomains.find((s: SubdomainIR) =>
    s.contexts.some((c) => c.name === ts.context),
  );
  return sub?.migrationsOwner;
}

export function validateTimerSources(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const timers = sys.timerSources ?? [];
  if (timers.length === 0) return;

  // Index every context by name (cheap, reused across timers).
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const sub of sys.subdomains) for (const c of sub.contexts) ctxByName.set(c.name, c);

  for (const ts of timers) {
    const ctx = ctxByName.get(ts.context);
    const eventDecl = ctx?.events.find((e) => e.name === ts.event);

    // ── loom.timer-event-shape ──────────────────────────────────────────────
    if (ctx && eventDecl) {
      const emitted = collectEmittedEvents(ctx);
      if (emitted.has(ts.event)) {
        diags.push({
          severity: "error",
          code: "loom.timer-event-shape",
          message: `timerSource '${ts.name}' fires '${ts.event}', which is already emitted by domain logic in context '${ctx.name}'. A timer's 'for:' event must be infrastructure-emitted only — declare a dedicated tick event (e.g. 'event ${ts.event}Tick { at: datetime }').`,
          source: sys.name,
        });
      }
      const hasAt = eventDecl.fields.some(
        (f) => f.name === "at" && f.type.kind === "primitive" && f.type.name === "datetime",
      );
      if (!hasAt) {
        diags.push({
          severity: "warning",
          code: "loom.timer-event-shape",
          message: `tick event '${ts.event}' (fired by timerSource '${ts.name}') has no 'at: datetime' field; the reacting workflow body cannot read the fire time.`,
          source: sys.name,
        });
      }
    }

    // (Cadence well-formedness — both/neither set, cron range, every floor +
    // cron-expressibility — is an AST-level check in
    // `src/language/validators/timer.ts`, where both raw grammar fields are
    // still visible.  Lowering discriminates the cadence to one, so "both set"
    // would be invisible here.)

    // ── loom.timer-needs-state ──────────────────────────────────────────────
    const owner = timerOwnerDeployable(sys, ts);
    const ownerDeployable = sys.deployables.find((d) => d.name === owner);
    if (ownerDeployable) {
      const needsDb = descriptorFor(ownerDeployable.platform).needsDb;
      if (!needsDb) {
        diags.push({
          severity: "error",
          code: "loom.timer-needs-state",
          message: `timerSource '${ts.name}' is owned by deployable '${owner}', whose platform binds no relational state. Single-fire delivery needs a Postgres advisory lock — host the context on a database-backed backend.`,
          source: sys.name,
        });
      }
    } else {
      diags.push({
        severity: "error",
        code: "loom.timer-needs-state",
        message: `timerSource '${ts.name}' fires an event in context '${ts.context}', which no database-backed deployable owns. Single-fire delivery needs a Postgres advisory lock — host the context on a backend that binds a relational 'state' resource.`,
        source: sys.name,
      });
    }

    // ── loom.timer-source-unbound (warning) ─────────────────────────────────
    if (ctx) {
      const reacted = collectReactedEvents(ctx);
      if (!reacted.has(ts.event)) {
        diags.push({
          severity: "warning",
          code: "loom.timer-source-unbound",
          message: `timerSource '${ts.name}' fires '${ts.event}', but no workflow reacts to it ('on(_: ${ts.event})' / 'create(_: ${ts.event}) by …'). The timer will run and emit into the void.`,
          source: sys.name,
        });
      }
    }
  }
}
