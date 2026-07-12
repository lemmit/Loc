// Per-aggregate / per-part identity record.  Strongly-typed ids mirror
// the .NET record-structs (and jMolecules' Identity idea).  The record is
// a JPA `@Embeddable` — Hibernate 6.2+ instantiates records natively —
// used as `@EmbeddedId` on entities / `@Embedded` on `X id` reference
// fields, with an `@AttributeOverride` mapping `value` onto the schema's
// column.  Serializable because JPA requires it of id classes.

import { lines } from "../../../util/code-builder.js";
import { javaNewIdValue, javaValueTypeForId } from "../render-expr.js";

export function renderJavaId(name: string, idValueType: string, basePkg: string): string {
  const valueType = javaValueTypeForId(idValueType);
  const newExpr = javaNewIdValue(idValueType);
  const needsUuid = valueType === "UUID" || newExpr.includes("UUID");
  const needsGenerators = newExpr.includes("Generators.");
  return lines(
    `package ${basePkg}.domain.ids;`,
    ``,
    `import java.io.Serializable;`,
    needsUuid ? `import java.util.UUID;` : null,
    needsGenerators ? `import com.fasterxml.uuid.Generators;` : null,
    ``,
    `import jakarta.persistence.Embeddable;`,
    ``,
    `@Embeddable`,
    `public record ${name}Id(${valueType} value) implements Serializable {`,
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
