// Barrel: re-export per-construct emitters from dedicated modules.
// The original monolithic file was split so each emitter lives next to
// the AST node it serves.  Keep imports stable for callers of this module.

export {
  renderController,
  renderExceptionFilter,
  renderListWrapperFilter,
  renderProblemDetailsFilter,
  renderRequiredFromCtorParamFilter,
} from "./emit/api.js";
export { renderAuditableInterceptor } from "./emit/auditable-interceptor.tpl.js";
export { renderBaseReaderImpl, renderBaseReaderInterface } from "./emit/base-reader.js";
export { renderCanonicalInstantConverter } from "./emit/canonical-instant.js";
export { renderCommon, renderInProcessDispatcher, renderNoopDispatcher } from "./emit/common.js";
export {
  renderCommand,
  renderCommandHandler,
  renderQuery,
  renderQueryHandler,
} from "./emit/cqrs.js";
export {
  renderDocumentConfiguration,
  renderDocumentPoco,
  renderSnapshots,
} from "./emit/document.js";
export { renderRequestDtos, renderResponseDtos } from "./emit/dto.js";
export {
  aggregateHasTableValueArray,
  renderConfiguration,
  renderDbContext,
  renderOrdinalGenerator,
} from "./emit/efcore.js";
export { renderAbstractBaseEntity, renderEntity } from "./emit/entity.js";
export { renderEnum, renderValueObject } from "./emit/enums-vos.js";
export { renderEventRecordConfiguration, renderEventRecordPoco } from "./emit/event-store.js";
export { renderEvent, renderIDomainEvent } from "./emit/events.js";
export { renderId } from "./emit/ids.js";
export {
  joinDbSetName,
  joinEntityName,
  joinFkPropName,
  renderJoinEntity,
  renderJoinEntityConfiguration,
} from "./emit/join-entities.js";
export {
  renderCsproj,
  renderDockerfile,
  renderDockerignore,
  renderProgram,
  renderTestCsproj,
} from "./emit/program.js";
export {
  renderDocumentRepositoryImpl,
  renderEventSourcedRepositoryImpl,
  renderRepositoryImpl,
  renderRepositoryInterface,
} from "./emit/repository.js";
export { renderServiceTestsFile, renderTestsFile, renderVoTestsFile } from "./emit/tests.js";
