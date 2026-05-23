// Barrel: re-export per-construct template renderers.  The original
// monolithic file was split so each template lives next to the AST node
// it serves.  Keep imports stable for callers of this module.

export { renderAggregate } from "./templates/aggregate.tpl.js";
export { renderEvents } from "./templates/events.tpl.js";
export { renderIds } from "./templates/ids.tpl.js";
export { renderHttpIndex } from "./templates/routes.tpl.js";
export {
  joinColumnName,
  joinTableConstName,
  renderSchema,
  valueObjectColumnNames,
} from "./templates/schema.tpl.js";
export { renderTestsFile } from "./templates/tests.tpl.js";
export { renderEnumsAndValueObjects } from "./templates/value-objects.tpl.js";
