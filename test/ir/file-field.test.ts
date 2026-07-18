// `File` primitive (M-T1.2 / M-T4.6 §5.3) — a passive wire-only leaf whose
// bytes live in an object store.  Three concerns:
//   1. PARSING — `File` field type + `storage x { type: localDisk }` parse;
//      `File` is a reserved primitive keyword (like `json`/`s3`), so a bare
//      lowercase field named `file` still parses (only capital `File` and
//      `localDisk` are keywords).
//   2. VALIDATE — a File-bearing aggregate on a deployable with no objectStore
//      dataSource is `loom.file-field-needs-object-storage`.
//   3. IR — a `File` property lands in `wireShape` as the primitive `File`.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { wireFieldsForAggregate } from "../../src/ir/enrich/wire-projection.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allAggregates } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

function fileSystem(opts: { objectStore: boolean }): string {
  return `
system Uploads {
  subdomain Media {
    context Docs {
      aggregate Attachment {
        title: string
        blob: File
        thumbnail: File?
      }
      repository Attachments for Attachment { }
    }
  }
  api DocsApi from Media
  storage pg { type: postgres }
  storage uploads { type: localDisk }
  resource docsState { for: Docs, kind: state, use: pg }
  resource docsFiles { for: Docs, kind: objectStore, use: uploads }
  deployable api {
    platform: node
    contexts: [Docs]
    dataSources: [docsState${opts.objectStore ? ", docsFiles" : ""}]
    serves: DocsApi
    port: 4200
  }
}
`;
}

async function irErrors(source: string, code: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === code)
    .map((d) => d.message);
}

describe("File primitive — parsing", () => {
  it("a `File` field and a `type: localDisk` storage parse without error", async () => {
    const { errors } = await parseString(fileSystem({ objectStore: true }), { validate: false });
    expect(errors).toEqual([]);
  });

  it("a lowercase field named `file` still parses (only capital `File` is a keyword)", async () => {
    const { errors } = await parseString(
      `
      context X {
        aggregate Doc {
          file: string
        }
        repository Docs for Doc { }
      }
    `,
      { validate: false },
    );
    expect(errors).toEqual([]);
  });
});

describe("File primitive — object-storage validation", () => {
  it("rejects a File-bearing aggregate on a deployable with no objectStore", async () => {
    const errs = await irErrors(
      fileSystem({ objectStore: false }),
      "loom.file-field-needs-object-storage",
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("Attachment");
    expect(errs[0]).toContain("File");
  });

  it("accepts a File-bearing aggregate when an objectStore dataSource is bound", async () => {
    const errs = await irErrors(
      fileSystem({ objectStore: true }),
      "loom.file-field-needs-object-storage",
    );
    expect(errs).toEqual([]);
  });
});

describe("File primitive — wire shape", () => {
  it("a `File` property lands in wireShape as the primitive `File`", async () => {
    const { model } = await parseString(fileSystem({ objectStore: true }), { validate: false });
    const loom = enrichLoomModel(lowerModel(model));
    const attachment = allAggregates(loom).find((a) => a.name === "Attachment");
    expect(attachment).toBeDefined();
    // wireShape is derived on demand (not stamped) — recompute it.
    const wire = wireFieldsForAggregate(attachment!);
    const blob = wire.find((f) => f.name === "blob");
    expect(blob?.type).toEqual({ kind: "primitive", name: "File" });
    const thumb = wire.find((f) => f.name === "thumbnail");
    // `File?` folds nullability onto the wire field, leaf stays primitive File.
    expect(thumb?.optional).toBe(true);
  });
});
