// ---------------------------------------------------------------------------
// A declared find with an ENUM param on a non-relational java aggregate emitted
// a repository impl that does not compile.
//
//     find byGrade(grade: Grade): Widget[] …      // on `shape: document`
//
//   → public List<Widget> byGrade(Grade grade) {  // WidgetRepositoryImpl.java
//     javac: cannot find symbol / symbol: class Grade
//
// `renderJavaType` spells an enum param as the bare enum name, and the RELATIONAL
// impl imports `<base>.domain.enums.*` for exactly that reason
// (`emit/repository.ts:305`).  The document and event-store impls assembled their
// own import list and both omitted it — so a model that compiles on the default
// saving shape stops compiling when the aggregate is `shape: document` or
// `persistedAs: eventLog`, with zero diagnostics.
//
// FOUND BY COMPILING, not by reading: the F2-W-07 fixture was run through
// `gradle testClasses bootJar` in `gradle:9-jdk25` and failed here, on a file
// that fix never touched.  The defect predates it and is independent of paging —
// a NON-paged list find fails identically.
//
// This is a static test because the compile tier cannot reach the shape: no
// corpus fixture pairs a non-relational saving shape with an enum-typed find
// param.  Adding the import is the fix; asserting it is the pin.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const src = (shape: string, ret: string): string => `
system PG {
  subdomain S {
    context C {
      enum Grade { A, B }
      aggregate Widget ${shape}with crudish {
        grade: Grade
      }
      repository Widgets for Widget {
        find byGrade(grade: Grade): ${ret} where this.grade == grade
      }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable dj { platform: java, contexts: [C], dataSources: [st], serves: A, port: 4000 }
}`;

async function repoImpl(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  const hit = [...files.entries()].find(([p]) => p.endsWith("WidgetRepositoryImpl.java"));
  if (!hit)
    throw new Error(`no WidgetRepositoryImpl; got:\n${[...files.keys()].sort().join("\n")}`);
  return hit[1];
}

describe("non-relational java repository impls import the enums they name", () => {
  // Each case asserts the SIGNATURE that names the type as well as the import —
  // an import assertion alone would still pass if the param stopped being
  // emitted at all, which is the "the check never reached the thing it names"
  // failure shape.
  const cases: [string, string, string][] = [
    ["document", "shape: document, ", "Widget[]"],
    ["document (paged)", "shape: document, ", "Widget paged"],
    ["relational (the sibling that was already right)", "", "Widget[]"],
  ];

  for (const [name, shape, ret] of cases) {
    it(`${name}: names Grade in the signature and imports it`, async () => {
      const impl = await repoImpl(src(shape, ret));
      expect(impl, "the find must still take the enum param").toContain("Grade grade");
      expect(impl, "…and nothing else in the file declares Grade").toContain(
        "import com.loom.dj.domain.enums.*;",
      );
    });
  }

  // The event-store impl assembles its own import list too, and had the same
  // omission.  It needs a real decide-and-emit aggregate (an event-sourced body
  // may not assign `this`), so it gets its own fixture rather than a `shape:`
  // swap on the one above.
  it("event-sourced: the same import, on the event-store impl", async () => {
    const impl = await repoImpl(`
system PG {
  subdomain S {
    context C {
      enum Grade { A, B }
      event Graded { widget: Widget id, grade: Grade }
      aggregate Widget persistedAs: eventLog {
        grade: Grade
        create make(grade: Grade) { emit Graded { widget: id, grade: grade } }
        apply(e: Graded) { grade := e.grade }
      }
      repository Widgets for Widget {
        find byGrade(grade: Grade): Widget? where this.grade == grade
      }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: C, kind: eventLog, use: pg }
  deployable dj { platform: java, contexts: [C], dataSources: [st], serves: A, port: 4000 }
}`);
    expect(impl).toContain("Grade grade");
    expect(impl).toContain("import com.loom.dj.domain.enums.*;");
  });
});
