// ---------------------------------------------------------------------------
// Entity history — the READ side of the `audited` command trail, Java / Spring
// Boot.  (docs/audit.md; the shape + diff boundary + masking rules live at IR
// level in `src/ir/util/audit-history.ts`, shared with every backend, so the
// wire bytes match `test/behavioral/wire-golden/audit-history.json` by
// construction rather than by re-derivation here.)
//
// Four emitted pieces, mirroring the Hono / FastAPI ports one-for-one:
//
//   1. `api/AuditEntry.java` + `api/AuditFieldChange.java` — the shared wire
//      records.  Shape-only, so one copy serves every audited aggregate.
//   2. `api/AuditHistory.java` — the two pure helpers (`snapshotValue` /
//      `valueChanged`).  Both take `Object`, because the snapshot columns are
//      `jsonb` bound to a bare `Object` on the JPA row, which Hibernate
//      surfaces as a `Map` of plain JSON values — the same object binding every
//      backend uses over the one shared `auditTableShape` column definition.
//   3. A per-aggregate `<agg>AuditEntry(row)` mapper, emitted as a private
//      static method on the application service — this is where `mask unless`
//      composes in, because the mapper is the only place a CALLER enters the
//      picture (the snapshots were written server-side inside the command's
//      transaction, with no caller to mask against, so they hold RAW values for
//      every field).
//   4. The `history<Agg>(id)` service method + its `GET /{id}/history`
//      controller route.
//
// A masked field's change entry is DROPPED, never emitted-and-redacted: a
// redacted-but-present entry still discloses THAT the field changed, when, and
// by whom.  Fail-closed on a null principal, exactly like `<Agg>Response
// .fromMasked` — the principal is read off the STATIC
// `CurrentUserAccessor.currentOrNull()`, so an unauthenticated request drops
// every masked field's entries.
// ---------------------------------------------------------------------------

import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  FindIR,
  RepositoryIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { maskedHistoryFields, unmaskedHistoryFields } from "../../../ir/util/audit-history.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import { renderJavaExpr } from "../render-expr.js";
import { javaNotFoundThrow } from "./common.js";

/** The derived history read for this aggregate, or undefined when it serves
 *  none.  Read off the enrichment-derived `historyFind` (which sits BESIDE
 *  `finds`, carrying the inherited `requires` gate and `ignoring` stance)
 *  rather than re-deriving "is this audited" per emitter — so the endpoint's
 *  authorization can't drift from the aggregate's list read. */
export function javaHistoryFind(repo: RepositoryIR | undefined): FindIR | undefined {
  return repo?.historyFind;
}

/** True when any served context has an aggregate that serves history — gates
 *  the shared wire records + helper class + the repository's history query, so
 *  an audited-but-history-less project stays byte-identical. */
export function contextsServeHistory(contexts: readonly EnrichedBoundedContextIR[]): boolean {
  return contexts.some((c) => c.repositories.some((r) => r.historyFind !== undefined));
}

/** Name of the per-aggregate row → entry mapper (a private static on the
 *  service). */
export function javaHistoryMapperName(agg: EnrichedAggregateIR): string {
  return `${lowerFirst(agg.name)}AuditEntry`;
}

/** Package the shared history wire records + helpers live in — `<base>.api`,
 *  the `api-common` category's home under BOTH directory layouts, so the one
 *  copy is reachable from every aggregate's service and controller however
 *  they are routed. */
export function javaAuditApiPkg(basePkg: string): string {
  return `${basePkg}.api`;
}

/** `AuditFieldChange` — one field-level change derived from an entry's two
 *  snapshots at READ time.  `before`/`after` are `Object` (opaque JSON):
 *  whatever the aggregate's wire DTO held for that key.  Both sides are
 *  nullable and both are meaningful — a `create` has no `before`, a `destroy`
 *  no `after`. */
export function renderJavaAuditFieldChange(basePkg: string): string {
  return lines(
    `package ${javaAuditApiPkg(basePkg)};`,
    ``,
    `/** One field-level change between an entry's two snapshots.`,
    ` *`,
    ` *  \`before\`/\`after\` are opaque JSON — whatever the aggregate's wire DTO`,
    ` *  held for that key.  Both are nullable and both are meaningful: a`,
    ` *  \`create\` has no \`before\`, a \`destroy\` no \`after\`. */`,
    `public record AuditFieldChange(String field, Object before, Object after) {`,
    `}`,
    ``,
  );
}

/** `AuditEntry` — one entry in an entity's history.
 *
 *  Deliberately NOT carrying the raw `before`/`after` snapshots: they are
 *  stored UNMASKED (written inside the command's transaction, where there is no
 *  caller to mask against), so publishing them whole would need a recursive
 *  redaction pass over arbitrary JSON with no schema to guarantee it reached
 *  every masked key.  The derived `changes` list is a typed, field-keyed
 *  projection where the masking rule is exact and checkable. */
export function renderJavaAuditEntry(basePkg: string): string {
  return lines(
    `package ${javaAuditApiPkg(basePkg)};`,
    ``,
    `import java.util.List;`,
    ``,
    `/** One entry in an entity's history — one SUCCESSFUL command (a failed`,
    ` *  command's transaction rolls back, taking its audit row with it), so this`,
    ` *  answers "what changed", not "who tried". */`,
    `public record AuditEntry(String auditId, String at, String action, String operationId,`,
    `        Object actor, String correlationId, List<AuditFieldChange> changes) {`,
    `}`,
    ``,
  );
}

/** `AuditHistory` — the two pure helpers every per-aggregate mapper calls.
 *
 *  The `audit_records` snapshot columns are `jsonb` (one shared definition,
 *  `auditTableShape` in `src/system/migrations-builder.ts`) bound to a bare
 *  `Object` on the JPA row, which Hibernate's JSON FormatMapper surfaces as a
 *  `Map` of plain JSON values.  So both helpers work on that Map directly —
 *  index it, and compare with `Objects.equals`, which on plain JSON values IS
 *  content comparison (a value object or containment array compares by content
 *  rather than by identity, which is what a reader expects of "changed").
 *
 *  An asymmetric lifecycle side is a REAL null, not the string `"null"`: a
 *  `create` has no `before` object at all and a `destroy` no `after`, so every
 *  key on that side reads as absent. */
export function renderJavaAuditHistorySupport(basePkg: string): string {
  return lines(
    `package ${javaAuditApiPkg(basePkg)};`,
    ``,
    `import java.util.Map;`,
    `import java.util.Objects;`,
    ``,
    `/** Read-time helpers over an audit row's two snapshots (docs/audit.md).`,
    ` *  The diff is derived here and never stored — a stored diff is a cache with`,
    ` *  no invalidation story, and the snapshots already contain everything it`,
    ` *  says. */`,
    `public final class AuditHistory {`,
    `    private AuditHistory() {`,
    `    }`,
    ``,
    `    /** Read one key out of a snapshot.  A missing key and an absent snapshot`,
    `     *  are the same thing here — a \`create\` row has no \`before\` object at`,
    `     *  all, and its fields must read as null rather than throw. */`,
    `    public static Object snapshotValue(Object snapshot, String key) {`,
    `        return snapshot instanceof Map<?, ?> map ? map.get(key) : null;`,
    `    }`,
    ``,
    `    /** Did this key actually move between the two snapshots?  Both sides are`,
    `     *  plain JSON values off the same jsonb binding, so equality here IS`,
    `     *  content comparison. */`,
    `    public static boolean valueChanged(Object before, Object after) {`,
    `        return !Objects.equals(before, after);`,
    `    }`,
    `}`,
    ``,
  );
}

/** The per-aggregate row → entry mapper, emitted as a private static on the
 *  application service.  Unmasked diff fields run through one loop; each masked
 *  field gets its own predicate-guarded block, so a caller who fails the
 *  predicate sees no entry for it at all.
 *
 *  `at` is projected through `toInstant().toString()` — the same ISO-8601
 *  spelling every other `datetime` wire field takes on this backend
 *  (`Instant.toString()`), and the same instant node's `.toISOString()`
 *  produces, whatever the JVM's default offset. */
export function renderJavaHistoryMapper(agg: EnrichedAggregateIR): string[] {
  const unmasked = unmaskedHistoryFields(agg);
  const masked = maskedHistoryFields(agg);
  const out: string[] = [
    `    /** One \`audit_records\` row → one history entry.  The diff is derived`,
    `     *  HERE, at read time, from the row's two snapshots — never stored. */`,
    `    private static AuditEntry ${javaHistoryMapperName(agg)}(AuditRecord row) {`,
    `        var changes = new ArrayList<AuditFieldChange>();`,
  ];
  if (unmasked.length > 0) {
    const keys = unmasked.map((f) => JSON.stringify(f.name)).join(", ");
    out.push(
      `        for (var key : List.of(${keys})) {`,
      `            var __b = AuditHistory.snapshotValue(row.before(), key);`,
      `            var __a = AuditHistory.snapshotValue(row.after(), key);`,
      `            if (AuditHistory.valueChanged(__b, __a)) changes.add(new AuditFieldChange(key, __b, __a));`,
      `        }`,
    );
  }
  if (masked.length > 0) {
    // The ambient principal, read off the STATIC accessor (a static mapper
    // injects no bean) — an unauthenticated request yields null and every
    // masked entry drops.  The same fail-closed binding `fromMasked` uses.
    out.push(`        User __maskUser = CurrentUserAccessor.currentOrNull();`);
  }
  for (const f of masked) {
    // The SAME `mask unless` predicate the entity read applies via
    // `fromMasked`, so history can never disclose a field the entity read would
    // have hidden.
    const pred = renderJavaExpr(f.maskUnless!, {
      thisName: "row",
      currentUserExpr: "__maskUser",
    });
    const key = JSON.stringify(f.name);
    out.push(
      `        // \`${f.name}\`: \`mask unless\` — the change entry is DROPPED, not redacted.`,
      `        // A redacted-but-present entry would still disclose that it changed, when,`,
      `        // and by whom, which is the disclosure the mask exists to prevent.`,
      `        if (__maskUser != null && (${pred})) {`,
      `            var __b = AuditHistory.snapshotValue(row.before(), ${key});`,
      `            var __a = AuditHistory.snapshotValue(row.after(), ${key});`,
      `            if (AuditHistory.valueChanged(__b, __a)) changes.add(new AuditFieldChange(${key}, __b, __a));`,
      `        }`,
    );
  }
  out.push(
    `        return new AuditEntry(row.auditId(), row.at().toInstant().toString(), row.action(),`,
    `            row.operationId(), row.actor(), row.correlationId(), changes);`,
    `    }`,
    ``,
  );
  return out;
}

/** The `history<Agg>(id)` application method.
 *
 *  Guard (2) of the three (docs/audit.md): ENTITY reachability.
 *  `audit_records` is machinery — it carries `target_type`/`target_id` and NO
 *  tenant column, so there is nothing on it for a capability query-filter to
 *  scope.  Scoping therefore rides the ENTITY: the row is resolved through the
 *  ordinary read-scoped `findById`, which already carries every capability
 *  predicate (`tenantOwned`'s tenant floor included).  A row the caller cannot
 *  read yields 404 — the same answer the entity read gives, so history
 *  discloses nothing about another tenant's rows, not even their existence. */
export function renderJavaHistoryServiceMethod(
  agg: EnrichedAggregateIR,
  idClass: string,
): string[] {
  return [
    `    /** \`GET /{id}/history\` — the per-entity audit trail (docs/audit.md).`,
    `     *  Ordered oldest-first: a timeline reads forwards, and \`at\` plus the`,
    `     *  \`(target_type, target_id)\` index make it the natural scan order. */`,
    `    @Transactional(readOnly = true)`,
    `    public List<AuditEntry> history${agg.name}(${idClass} id) {`,
    // Reachability BEFORE the trail read — a row this caller cannot see must
    // 404 rather than yield a readable timeline.
    `        repository.findById(id).orElseThrow(() ->`,
    `            ${javaNotFoundThrow(agg.name)});`,
    `        return auditRecords.findByTargetTypeAndTargetIdOrderByAtAsc(${JSON.stringify(agg.name)}, id.value().toString())`,
    `            .stream().map(${agg.name}Service::${javaHistoryMapperName(agg)}).toList();`,
    `    }`,
    ``,
  ];
}

/** The `GET /{id}/history` controller route.
 *
 *  Guard (1): the inherited `requires` gate → 403 BEFORE any query runs, so
 *  history is never easier to reach than the entity read it replays.  (Guard
 *  (2) reachability and guard (3) the mask live in the service / mapper.) */
export function renderJavaHistoryRoute(
  agg: EnrichedAggregateIR,
  find: FindIR,
  idJava: string,
  idClass: string,
): string[] {
  const gate: string[] = [];
  if (find.requires) {
    if (exprUsesCurrentUser(find.requires)) {
      gate.push(`        var currentUser = currentUserAccessor.user();`);
    }
    gate.push(
      `        if (!(${renderJavaExpr(find.requires, { thisName: "this" })})) throw new ForbiddenException(${JSON.stringify(
        "Forbidden: find history",
      )});`,
    );
  }
  return [
    `    @GetMapping("/{id}/history")`,
    `    public List<AuditEntry> history${agg.name}(@PathVariable ${idJava} id) {`,
    ...gate,
    `        return service.history${agg.name}(new ${idClass}(id));`,
    `    }`,
    ``,
  ];
}
