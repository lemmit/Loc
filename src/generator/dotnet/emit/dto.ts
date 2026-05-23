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
  return `// Auto-generated.
using System;
using System.Collections.Generic;

namespace ${args.ns}.Application.${plural(args.aggName)}.${group};

${recs}`;
}
