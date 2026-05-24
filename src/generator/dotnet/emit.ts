// Barrel: re-export per-construct emitters from dedicated modules.
// The original monolithic file was split so each emitter lives next to
// the AST node it serves.  Keep imports stable for callers of this module.

export { renderController, renderExceptionFilter } from "./emit/api.js";
export { renderAuditableInterceptor } from "./emit/auditable-interceptor.tpl.js";
export { renderCommon, renderNoopDispatcher } from "./emit/common.js";
export {
  renderCommand,
  renderCommandHandler,
  renderQuery,
  renderQueryHandler,
} from "./emit/cqrs.js";
export { renderRequestDtos, renderResponseDtos } from "./emit/dto.js";
export { renderConfiguration, renderDbContext } from "./emit/efcore.js";
export { renderEntity } from "./emit/entity.js";
export { renderEnum, renderValueObject } from "./emit/enums-vos.js";
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
  renderRepositoryImpl,
  renderRepositoryInterface,
} from "./emit/repository.js";
export { renderTestsFile } from "./emit/tests.js";
