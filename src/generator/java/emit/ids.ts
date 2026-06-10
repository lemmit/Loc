// Per-aggregate / per-part identity record.  Strongly-typed ids mirror
// the .NET record-structs (and jMolecules' Identity idea); the JPA
// AttributeConverter that maps them to columns ships with the
// persistence slice.

import { lines } from "../../../util/code-builder.js";
import { javaNewIdValue, javaValueTypeForId } from "../render-expr.js";

export function renderJavaId(name: string, idValueType: string, basePkg: string): string {
  const valueType = javaValueTypeForId(idValueType);
  const newExpr = javaNewIdValue(idValueType);
  const needsUuid = valueType === "UUID" || newExpr.startsWith("UUID.");
  return lines(
    `package ${basePkg}.domain.ids;`,
    ``,
    needsUuid ? `import java.util.UUID;` : null,
    needsUuid ? `` : null,
    `public record ${name}Id(${valueType} value) {`,
    `    public static ${name}Id newId() {`,
    `        return new ${name}Id(${newExpr});`,
    `    }`,
    ``,
    `    @Override`,
    `    public String toString() {`,
    `        return String.valueOf(value);`,
    `    }`,
    `}`,
    ``,
  );
}
