// -------------------------------------------------------------------------
// MikroORM emission — thin barrel.  Packet 2.6 (wave-2) split the former
// 3.5k-line monolith by shape (relational / document / embedded / event-
// sourced), plus the entity/column, filter/where-clause and connection-
// config layers each shape's repository renderer draws on.  Every name
// this module exported before the split is re-exported here unchanged, so
// `from ".../emit/mikroorm.js"` call sites needed no edits.
// -------------------------------------------------------------------------

export {
  MIKRO_DEPS,
  MIKRO_INDEX_IMPORTS,
  mikroConnectionSetup,
  renderMikroConfig,
} from "./mikroorm-config.js";
export { renderMikroDocumentRepository } from "./mikroorm-document.js";
export { renderMikroEmbeddedRepository } from "./mikroorm-embedded.js";
export {
  eventRowClassOf,
  MIKRO_OUTBOX_ROW_CLASS,
  MIKRO_TIMER_RUNS_ROW_CLASS,
  mikroProjectionRowClass,
  mikroWorkflowRowClass,
  renderMikroEntities,
} from "./mikroorm-entities.js";
export { renderMikroEventSourcedRepository } from "./mikroorm-event-sourced.js";
export {
  MIKRO_INTRINSIC_SQL,
  whereToMikroFilter,
} from "./mikroorm-filter.js";
export {
  renderMikroBaseReader,
  renderMikroRepository,
  renderMikroTpcBaseReader,
} from "./mikroorm-relational.js";
