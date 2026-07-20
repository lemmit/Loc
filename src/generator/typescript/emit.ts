// Barrel: re-export per-construct emitters.  The original monolithic
// file was split so each emitter lives next to the AST node it serves.
// Keep imports stable for callers of this module.

export { type OpFragment, renderAggregate } from "./emit/aggregate.js";
export { renderEvents } from "./emit/events.js";
export { renderIds } from "./emit/ids.js";
export { renderHttpIndex } from "./emit/routes.js";
export {
  joinColumnName,
  joinTableConstName,
  renderSchema,
  valueObjectColumnNames,
} from "./emit/schema.js";
export { renderServiceTestsFile, renderTestsFile, renderVoTestsFile } from "./emit/tests.js";
export { renderEnumsAndValueObjects } from "./emit/value-objects.js";
