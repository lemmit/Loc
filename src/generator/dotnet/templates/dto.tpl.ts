import { hb } from "../hb.js";

// Request DTO record — primitive wire types only.
const REQUEST_DTO_TPL = hb.compile(
  `// Auto-generated.
using System;
using System.Collections.Generic;

namespace {{ns}}.Application.{{plural aggName}}.Requests;

{{#each records}}public sealed record {{name}}({{{ params }}});

{{/each}}`,
);

// Response DTO record — primitive wire types, may include nested response
// records for parts and value objects.  Used as both the query return type
// and the controller's response body.
const RESPONSE_DTO_TPL = hb.compile(
  `// Auto-generated.
using System;
using System.Collections.Generic;

namespace {{ns}}.Application.{{plural aggName}}.Responses;

{{#each records}}public sealed record {{name}}({{{ params }}});

{{/each}}`,
);

export function renderRequestDtos(args: {
  ns: string;
  aggName: string;
  records: Array<{ name: string; params: string }>;
}): string {
  return REQUEST_DTO_TPL(args);
}

export function renderResponseDtos(args: {
  ns: string;
  aggName: string;
  records: Array<{ name: string; params: string }>;
}): string {
  return RESPONSE_DTO_TPL(args);
}
