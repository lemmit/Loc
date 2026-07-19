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

/** Parse a jsonb-string id value back into the id record's `value` type.
 *  The converter's relational element type is `String` (see below), so
 *  every read element arrives as a String — re-typed here per id kind. */
function parseIdValueExpr(idValueType: string, varName: string): string {
  switch (idValueType) {
    case "int":
      return `Integer.parseInt(${varName})`;
    case "long":
      return `Long.parseLong(${varName})`;
    case "string":
      return varName;
    default:
      return `UUID.fromString(${varName})`;
  }
}

/** `shape(embedded)` reference-collection converter (`X id[]` → jsonb
 *  id-array).  A `List<XId>` can't ride Hibernate's `@JdbcTypeCode(JSON)`
 *  path directly: the @Embeddable id routes through the STRUCTURED-JSON
 *  aggregate mapping, which bypasses the Jackson FormatMapper and
 *  mis-serialises the typed-id list.  This `AttributeConverter` unwraps
 *  the list to a plain `List<String>` of the bare id `value`s — a
 *  collection the FormatMapper serialises to `["v1","v2"]`, the SAME
 *  physical jsonb shape the other backends produce (.NET serialises a
 *  Guid via System.Text.Json to a JSON string too; Drizzle / Ecto store
 *  id-array columns as string arrays).  `String` is the relational
 *  element type on purpose: the JSON FormatMapper erases the element
 *  type on READ (it hands back exactly what JSON holds — strings), so a
 *  `List<UUID>` relational type would ClassCast; `parseIdValueExpr`
 *  re-types each string on the way back in.  `@Convert` +
 *  `@JdbcTypeCode(JSON)` compose: the converter defines domain↔relational
 *  (`List<String>`), the jdbc-type-code binds it through jsonb. */
export function renderJavaIdListConverter(
  targetAgg: string,
  idValueType: string,
  basePkg: string,
): string {
  const idClass = `${targetAgg}Id`;
  const needsUuid = idValueType !== "int" && idValueType !== "long" && idValueType !== "string";
  return lines(
    `package ${basePkg}.domain.ids;`,
    ``,
    `import java.util.ArrayList;`,
    `import java.util.List;`,
    needsUuid ? `import java.util.UUID;` : null,
    ``,
    `import jakarta.persistence.AttributeConverter;`,
    `import jakarta.persistence.Converter;`,
    ``,
    `@Converter`,
    `public class ${idClass}JsonListConverter implements AttributeConverter<List<${idClass}>, List<String>> {`,
    `    @Override`,
    `    public List<String> convertToDatabaseColumn(List<${idClass}> attribute) {`,
    `        List<String> out = new ArrayList<>();`,
    `        if (attribute != null) {`,
    `            for (${idClass} __e : attribute) out.add(String.valueOf(__e.value()));`,
    `        }`,
    `        return out;`,
    `    }`,
    ``,
    `    @Override`,
    `    public List<${idClass}> convertToEntityAttribute(List<String> dbData) {`,
    `        List<${idClass}> out = new ArrayList<>();`,
    `        if (dbData != null) {`,
    `            for (String __v : dbData) out.add(new ${idClass}(${parseIdValueExpr(idValueType, "__v")}));`,
    `        }`,
    `        return out;`,
    `    }`,
    `}`,
    ``,
  );
}
