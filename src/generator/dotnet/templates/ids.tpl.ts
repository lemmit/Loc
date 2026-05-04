import { csNewIdValue, csValueTypeForId } from "../render-expr.js";

// Per-aggregate / per-part identity record-struct.  `valueType` and
// `newExpr` are determined by `csValueTypeForId` / `csNewIdValue` —
// e.g. guid → `Guid` / `Guid.NewGuid()`, string → `string` /
// `Guid.NewGuid().ToString()`.
export function renderId(name: string, idValueType: string, ns: string): string {
  const valueType = csValueTypeForId(idValueType);
  const newExpr = csNewIdValue(idValueType);
  return `// Auto-generated.
namespace ${ns}.Domain.Ids;

public readonly record struct ${name}Id(${valueType} Value)
{
    public static ${name}Id New() => new(${newExpr});
    public override string ToString() => Value.ToString()!;
}
`;
}
