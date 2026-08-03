// Safe lookup of an emitted file in a generation result.
//
// The trap this closes:
//
//     const reads = files.get("web/lib/reads.dart") ?? "";
//     expect(reads).not.toContain("class LoomPage<T>");
//
// If the emitter never produced that path, `?? ""` makes the assertion
// VACUOUSLY TRUE — it passes on the empty string whether the emitter is right
// or wrong.  That exact code shipped (#2384): Flutter emits no `reads.dart` for
// a parameterized find, so the assertion had been passing for the wrong reason
// and was hiding a real dangling-import bug underneath.
//
// `pageSource` in `paged-envelope-members.test.ts` already carried the warning
// in a comment — "a path guess that silently misses returns '' — which passes a
// `not.toContain` assertion for the wrong reason" — and one call site in the
// same file did it anyway.  A comment is not a gate; this is.
//
// Use `expectEmitted` whenever the file MUST exist.  A negative assertion
// (`.not.toContain`) against its content is then meaningful, because absence
// fails loudly here instead of silently satisfying the negative.
//
// `vacuous-file-assertion.test.ts` is the companion gate: it fails CI on any
// `?? ""` binding that is asserted ONLY negatively, i.e. with nothing proving
// the file exists.

/** Fetch an emitted file's content, failing loudly (with the nearest candidate
 *  paths) when the path is absent or empty.
 *
 *  Prefer this over `files.get(p) ?? ""` in any test that asserts on the
 *  content — especially a negative assertion, which an empty string satisfies
 *  for free. */
export function expectEmitted(files: ReadonlyMap<string, string>, path: string): string {
  const hit = files.get(path);
  if (hit != null && hit.length > 0) return hit;

  const base = path.slice(path.lastIndexOf("/") + 1);
  const near = [...files.keys()].filter((k) => k.endsWith(base) || k.includes(base));
  const detail =
    hit == null
      ? `not emitted${near.length ? `; did you mean:\n  ${near.slice(0, 8).join("\n  ")}` : ""}`
      : "emitted but EMPTY";
  throw new Error(
    `expectEmitted("${path}") — ${detail}\n` +
      `(${files.size} file(s) generated; asserting on a missing file makes a ` +
      `\`.not.toContain\` pass for the wrong reason — see test/_helpers/emitted.ts)`,
  );
}
