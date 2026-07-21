import { plural } from "../../../util/naming.js";

// Mediator command/query records + their handler scaffolds.  Body is
// pre-rendered upstream — we just splice it into the handler.

export function renderCommand(args: {
  ns: string;
  aggName: string;
  commandName: string;
  commandParams: string;
  returnType?: string;
  /** Extra `using` namespaces — e.g. `Domain.<Plural>` so an exception-less
   *  command's `ICommand<DomainUnion>` result type resolves. */
  extraUsings?: string[];
}): string {
  const sig = args.returnType ? `ICommand<${args.returnType}>` : "ICommand";
  const extra = (args.extraUsings ?? []).map((u) => `using ${u};\n`).join("");
  return `// Auto-generated.
using Mediator;
using ${args.ns}.Domain.Ids;
using ${args.ns}.Domain.ValueObjects;
using ${args.ns}.Domain.Enums;
${extra}
namespace ${args.ns}.Application.${plural(args.aggName)}.Commands;

public sealed record ${args.commandName}(${args.commandParams}) : ${sig};
`;
}

export function renderCommandHandler(args: {
  ns: string;
  aggName: string;
  handlerName: string;
  commandName: string;
  returnType?: string;
  body: string;
  /** Additional constructor-injected dependencies — used by the
   * extern dispatcher to inject the user's `IXAggHandler`. */
  extraDeps?: { type: string; field: string }[];
  /** Extra `using` namespaces to add to the file's import list. */
  extraUsings?: string[];
}): string {
  const ret = args.returnType ?? "Unit";
  const deps = args.extraDeps ?? [];
  const allFields = [
    `    private readonly I${args.aggName}Repository _repo;`,
    ...deps.map((d) => `    private readonly ${d.type} ${d.field};`),
  ];
  const ctorParams = [
    `I${args.aggName}Repository repo`,
    ...deps.map((d) => `${d.type} ${d.field.replace(/^_/, "")}`),
  ].join(", ");
  const ctorBody = [
    "_repo = repo",
    ...deps.map((d) => `${d.field} = ${d.field.replace(/^_/, "")}`),
  ].join("; ");
  const extraUsings = (args.extraUsings ?? []).map((u) => `using ${u};`).join("\n");
  return `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using ${args.ns}.Domain.${plural(args.aggName)};
using ${args.ns}.Domain.Common;
using ${args.ns}.Domain.Ids;
using ${args.ns}.Domain.ValueObjects;
using ${args.ns}.Domain.Enums;
${extraUsings ? extraUsings + "\n" : ""}
namespace ${args.ns}.Application.${plural(args.aggName)}.Commands;

public sealed class ${args.handlerName} : ICommandHandler<${args.commandName}, ${ret}>
{
${allFields.join("\n")}
    public ${args.handlerName}(${ctorParams})
    {
        ${ctorBody};
    }

    public async ValueTask<${ret}> Handle(${args.commandName} command, CancellationToken cancellationToken)
    {
${args.body}    }
}
`;
}

export function renderQuery(args: {
  ns: string;
  aggName: string;
  queryName: string;
  queryParams: string;
  returnType: string;
  /** Extra `using` namespaces (e.g. Domain.Common for a `Paged<T>` return). */
  extraUsings?: string[];
}): string {
  const extra = (args.extraUsings ?? []).map((u) => `using ${u};`).join("\n");
  return `// Auto-generated.
using Mediator;
using ${args.ns}.Domain.Ids;
using ${args.ns}.Domain.Enums;
using ${args.ns}.Application.${plural(args.aggName)}.Responses;
${extra ? extra + "\n" : ""}
namespace ${args.ns}.Application.${plural(args.aggName)}.Queries;

public sealed record ${args.queryName}(${args.queryParams}) : IQuery<${args.returnType}>;
`;
}

export function renderQueryHandler(args: {
  ns: string;
  aggName: string;
  handlerName: string;
  queryName: string;
  returnType: string;
  body: string;
  /** Additional constructor-injected dependencies — used by slice
   *  1C to inject `ICurrentUserAccessor` for finds whose
   *  filter references currentUser. */
  extraDeps?: { type: string; field: string }[];
  /** Extra `using` namespaces to add to the file's import list. */
  extraUsings?: string[];
}): string {
  const deps = args.extraDeps ?? [];
  const allFields = [
    `    private readonly I${args.aggName}Repository _repo;`,
    ...deps.map((d) => `    private readonly ${d.type} ${d.field};`),
  ];
  const ctorParams = [
    `I${args.aggName}Repository repo`,
    ...deps.map((d) => `${d.type} ${d.field.replace(/^_/, "")}`),
  ].join(", ");
  const ctorBody = [
    "_repo = repo",
    ...deps.map((d) => `${d.field} = ${d.field.replace(/^_/, "")}`),
  ].join("; ");
  const extraUsings = (args.extraUsings ?? []).map((u) => `using ${u};`).join("\n");
  return `// Auto-generated.
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using ${args.ns}.Domain.${plural(args.aggName)};
using ${args.ns}.Domain.Ids;
using ${args.ns}.Domain.ValueObjects;
using ${args.ns}.Domain.Enums;
using ${args.ns}.Application.${plural(args.aggName)}.Responses;
${extraUsings ? extraUsings + "\n" : ""}
namespace ${args.ns}.Application.${plural(args.aggName)}.Queries;

public sealed class ${args.handlerName} : IQueryHandler<${args.queryName}, ${args.returnType}>
{
${allFields.join("\n")}
    public ${args.handlerName}(${ctorParams})
    {
        ${ctorBody};
    }

    public async ValueTask<${args.returnType}> Handle(${args.queryName} query, CancellationToken cancellationToken)
    {
${args.body}    }
}
`;
}
