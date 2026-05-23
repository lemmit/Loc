// Barrel: re-export per-construct template renderers from dedicated modules.
// The original monolithic file was split so each template lives next to
// the AST node it serves.  Keep imports stable for callers of this module.

export { renderController, renderExceptionFilter } from "./templates/api.tpl.js";
export { renderAuditableInterceptor } from "./templates/auditable-interceptor.tpl.js";
export { renderCommon, renderNoopDispatcher } from "./templates/common.tpl.js";
export {
  renderCommand,
  renderCommandHandler,
  renderQuery,
  renderQueryHandler,
} from "./templates/cqrs.tpl.js";
export { renderRequestDtos, renderResponseDtos } from "./templates/dto.tpl.js";
export { renderConfiguration, renderDbContext } from "./templates/efcore.tpl.js";
export { renderEntity } from "./templates/entity.tpl.js";
export { renderEnum, renderValueObject } from "./templates/enums-vos.tpl.js";
export { renderEvent, renderIDomainEvent } from "./templates/events.tpl.js";
export { renderId } from "./templates/ids.tpl.js";
export {
  renderCsproj,
  renderDockerfile,
  renderDockerignore,
  renderProgram,
  renderTestCsproj,
} from "./templates/program.tpl.js";
export {
  renderRepositoryImpl,
  renderRepositoryInterface,
} from "./templates/repository.tpl.js";
export { renderTestsFile } from "./templates/tests.tpl.js";
