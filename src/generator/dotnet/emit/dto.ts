import { plural } from "../../../util/naming.js";

// Request + response DTO records.  Both are flat record-types in the
// `Application.<Aggregates>.Requests` / `.Responses` namespaces.
// Params are rendered upstream — we just splice them into the record
// header.

export function renderRequestDtos(args: {
  ns: string;
  aggName: string;
  records: Array<{ name: string; params: string }>;
}): string {
  return renderDtoFile(args, "Requests");
}

export function renderResponseDtos(args: {
  ns: string;
  aggName: string;
  records: Array<{ name: string; params: string }>;
}): string {
  return renderDtoFile(args, "Responses");
}

function renderDtoFile(
  args: {
    ns: string;
    aggName: string;
    records: Array<{ name: string; params: string }>;
  },
  group: "Requests" | "Responses",
): string {
  const recs = args.records.map((r) => `public sealed record ${r.name}(${r.params});\n\n`).join("");
  // `using …Domain.Enums` lets a DTO field carry the enum TYPE (paired
  // with a global JsonStringEnumConverter for string-on-the-wire) so
  // Swashbuckle emits a named enum schema.  The `Domain/Enums/_namespace.cs`
  // marker guarantees the namespace always resolves, even with no enums.
  return `// Auto-generated.
using System;
using System.Collections.Generic;
using ${args.ns}.Domain.Enums;

namespace ${args.ns}.Application.${plural(args.aggName)}.${group};

${recs}`;
}
