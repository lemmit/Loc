// -------------------------------------------------------------------------
// MikroORM CLI config, outbox-drain / save-transaction line builders, and
// connection setup + package deps.  Split out of mikroorm.ts by packet 2.6
// (wave-2) — mechanical move, no logic change.
// -------------------------------------------------------------------------

import { lines } from "../../../util/code-builder.js";

// ---------------------------------------------------------------------------
// mikro-orm.config.ts — the standard MikroORM config module.
// ---------------------------------------------------------------------------

export function renderMikroConfig(): string {
  return (
    lines(
      "// Auto-generated.  MikroORM configuration (persistence: mikroorm).",
      `import { defineConfig } from "@mikro-orm/postgresql";`,
      `import { entities } from "./db/entities";`,
      "",
      "if (!process.env.DATABASE_URL) {",
      "  throw new Error(",
      '    "DATABASE_URL is required.  Set it in the environment " +',
      '      "(e.g. postgres://user:pass@host:5432/db).",',
      "  );",
      "}",
      "",
      "export default defineConfig({",
      "  clientUrl: process.env.DATABASE_URL,",
      "  entities,",
      "  // No RequestContext middleware in the generated server, so repositories",
      "  // fork the EntityManager per call instead of relying on the global EM.",
      "  allowGlobalContext: true,",
      "});",
    ) + "\n"
  );
}

/** index.ts bootstrap lines — replaces the drizzle pool/db block. Initialises
 *  MikroORM, applies the schema (dev), exposes `db` as the EntityManager. */
/** Wrap a repository `save`'s WRITE statements in one real database
 *  transaction.
 *
 *  Every mikro save used to open only `this.em.fork({ keepTransactionContext:
 *  true })`, and there is no `RequestContext` middleware in the generated
 *  server (see `mikroConfig`'s `allowGlobalContext` comment), so on an ordinary
 *  route that flag has nothing to keep: the root upsert, the association writes
 *  and the containment writes each ran on their own implicit transaction.  A
 *  multi-statement save that failed part-way therefore left the root row
 *  written and its children not — while the drizzle sibling has always run the
 *  same statements inside `this.db.transaction(...)` (G2667-C4).
 *
 *  `em.transactional` defaults to `TransactionPropagation.NESTED` (MikroORM 6
 *  `TransactionManager.handle`), so this composes with the ambient
 *  `db.transactional(...)` the audited / provenanced routes open: an existing
 *  transaction context yields a SAVEPOINT rather than a competing transaction,
 *  and the callback's forked EM is the handle its writes must go through —
 *  which is why the callback parameter takes the name `em` and the fork is no
 *  longer bound to a local.  The read half (the `findOne` behind the CAS
 *  version guard) is inside the same transaction on purpose: a read-then-write
 *  guard outside one is a race by construction. */
/** The two lines that DRAIN the aggregate's pending events ahead of the save
 *  transaction, so the durable ones can be recorded on that transaction's own
 *  handle and only the rest are dispatched after it commits.  The drizzle
 *  sibling (repository-save-builder.ts) has always emitted this pair; the mikro
 *  save dispatched straight off `aggregate.pullEvents()` after the tx closed, so
 *  the outbox insert (which the mikro dispatcher's `dispatch` arm performs on a
 *  `keepTransactionContext` fork) committed SEPARATELY on any route that opens
 *  no ambient transaction — i.e. every ordinary mutation route.  A crash in
 *  that window lost a durable event with the aggregate already written. */

export const MIKRO_OUTBOX_DRAIN_LINES: readonly string[] = [
  `    const pendingEvents = aggregate.pullEvents();`,
  `    let dispatchAfterCommit = pendingEvents;`,
];

/** The capture call itself, emitted as the LAST statement inside the save
 *  transaction: `tx` is the forked EntityManager `em.transactional` hands the
 *  callback, so the outbox rows commit (or roll back) with the aggregate rows.
 *  Optional-chained — a project with no durable channel wires a dispatcher
 *  without the hook, and then every event stays on the after-commit path,
 *  byte-identical in behaviour to before. */

export const MIKRO_OUTBOX_RECORD_LINE = `    dispatchAfterCommit = (await this.events.recordDurable?.(pendingEvents, em)) ?? pendingEvents;`;

export function mikroSaveTxLines(writeLines: readonly (string | null)[]): (string | null)[] {
  return [
    `    await this.em.fork({ keepTransactionContext: true }).transactional(async (em) => {`,
    ...writeLines.map((l) => (l === null || l === "" ? l : `  ${l}`)),
    `    });`,
  ];
}

export function mikroConnectionSetup(): readonly string[] {
  return [
    `const orm = await MikroORM.init(mikroConfig);`,
    `// Dev-friendly schema bootstrap: create/alter tables from the entity`,
    `// metadata on boot.  System-mode compose isolates each deployable to its`,
    `// own database, so this runs cleanly.  Replace with 'mikro-orm migration:up'`,
    `// for production.`,
    `//`,
    `// \`safe: true\` is NOT cosmetic.  \`updateSchema()\` defaults to`,
    `// \`dropTables: true\` over an UNPRUNED introspection, so every table the`,
    `// entity metadata does not describe is diffed as removed and dropped — on`,
    `// the SECOND boot onward.  That reaches real infrastructure this backend`,
    `// creates outside the model: the timer scheduler's \`loom_timer_runs\``,
    `// watermark, pg-boss's entire \`pgboss\` schema (jobs included), and the`,
    `// first-boot seed marker \`__loom_seed\`.  Losing the watermark silently`,
    `// disables the cron coalesce-once catch-up (a fresh baseline is written`,
    `// instead of replaying the missed boundary), and losing \`pgboss\` destroys`,
    `// queued jobs — with two replicas, the later boot drops the schema out from`,
    `// under the running one.  Safe mode still creates missing tables and adds`,
    `// columns; it only refuses to destroy.  (Drizzle has no equivalent:`,
    `// \`drizzle-kit migrate\` never drops unknown tables.)`,
    `await orm.schema.updateSchema({ safe: true });`,
    `const db = orm.em;`,
  ];
}

/** Drizzle import lines in index.ts to swap out, and the MikroORM ones to swap
 *  in, when the deployable selects mikroorm. */

export const MIKRO_INDEX_IMPORTS: readonly string[] = [
  `import { MikroORM } from "@mikro-orm/postgresql";`,
  `import mikroConfig from "./mikro-orm.config";`,
];

/** package.json dependency rows (JSON-shaped, like the drizzle adapter). */

export const MIKRO_DEPS: readonly string[] = [
  `"@mikro-orm/core": "^6.4.0",`,
  `"@mikro-orm/postgresql": "^6.4.0",`,
];
