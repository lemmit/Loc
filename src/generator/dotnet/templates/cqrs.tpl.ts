import { hb } from "../hb.js";

const COMMAND_TPL = hb.compile(
  `// Auto-generated.
using Mediator;
using {{ns}}.Domain.Ids;
using {{ns}}.Domain.ValueObjects;
using {{ns}}.Domain.Enums;

namespace {{ns}}.Application.{{plural aggName}}.Commands;

public sealed record {{commandName}}({{commandParams}}) : ICommand{{#if returnType}}<{{returnType}}>{{/if}};
`,
);

const COMMAND_HANDLER_TPL = hb.compile(
  `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using {{ns}}.Domain.{{plural aggName}};
using {{ns}}.Domain.Common;
using {{ns}}.Domain.Ids;
using {{ns}}.Domain.ValueObjects;
using {{ns}}.Domain.Enums;

namespace {{ns}}.Application.{{plural aggName}}.Commands;

public sealed class {{handlerName}} : ICommandHandler<{{commandName}}{{#if returnType}}, {{returnType}}{{else}}, Unit{{/if}}>
{
    private readonly I{{aggName}}Repository _repo;
    public {{handlerName}}(I{{aggName}}Repository repo) => _repo = repo;

    public async ValueTask<{{#if returnType}}{{returnType}}{{else}}Unit{{/if}}> Handle({{commandName}} cmd, CancellationToken ct)
    {
{{{body}}}    }
}
`,
);

const QUERY_TPL = hb.compile(
  `// Auto-generated.
using Mediator;
using {{ns}}.Domain.Ids;
using {{ns}}.Application.{{plural aggName}}.Responses;

namespace {{ns}}.Application.{{plural aggName}}.Queries;

public sealed record {{queryName}}({{queryParams}}) : IQuery<{{{ returnType }}}>;
`,
);

const QUERY_HANDLER_TPL = hb.compile(
  `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using {{ns}}.Domain.{{plural aggName}};
using {{ns}}.Domain.Ids;
using {{ns}}.Domain.ValueObjects;
using {{ns}}.Domain.Enums;
using {{ns}}.Application.{{plural aggName}}.Responses;

namespace {{ns}}.Application.{{plural aggName}}.Queries;

public sealed class {{handlerName}} : IQueryHandler<{{queryName}}, {{{ returnType }}}>
{
    private readonly I{{aggName}}Repository _repo;
    public {{handlerName}}(I{{aggName}}Repository repo) => _repo = repo;

    public async ValueTask<{{{ returnType }}}> Handle({{queryName}} q, CancellationToken ct)
    {
{{{body}}}    }
}
`,
);

export function renderCommand(args: {
  ns: string;
  aggName: string;
  commandName: string;
  commandParams: string;
  returnType?: string;
}): string {
  return COMMAND_TPL(args);
}

export function renderCommandHandler(args: {
  ns: string;
  aggName: string;
  handlerName: string;
  commandName: string;
  returnType?: string;
  body: string;
}): string {
  return COMMAND_HANDLER_TPL(args);
}

export function renderQuery(args: {
  ns: string;
  aggName: string;
  queryName: string;
  queryParams: string;
  returnType: string;
}): string {
  return QUERY_TPL(args);
}

export function renderQueryHandler(args: {
  ns: string;
  aggName: string;
  handlerName: string;
  queryName: string;
  returnType: string;
  body: string;
}): string {
  return QUERY_HANDLER_TPL(args);
}
