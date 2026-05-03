import { csNewIdValue, csValueTypeForId } from "../render-expr.js";
import { hb } from "../hb.js";

const ID_TPL = hb.compile(
  `// Auto-generated.
namespace {{ns}}.Domain.Ids;

public readonly record struct {{name}}Id({{valueType}} Value)
{
    public static {{name}}Id New() => new({{newExpr}});
    public override string ToString() => Value.ToString()!;
}
`,
);

export function renderId(name: string, idValueType: string, ns: string): string {
  return ID_TPL({
    name,
    valueType: csValueTypeForId(idValueType),
    newExpr: csNewIdValue(idValueType),
    ns,
  });
}
