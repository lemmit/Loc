/** Repository read/write verb classification — a shared IR-layer predicate set.
 *
 *  Lives in `ir/util/` (not in a lowering leaf) because both the repo-read
 *  matcher (phase ⑤, `lower/repo-read.ts`) and the domain-service validator
 *  (phase ⑦, `validate/checks/domain-service-checks.ts`) consume it: a phase-⑦
 *  check importing a phase-⑤ module's internals is within the `ir/` layer but
 *  against the grain, so the shared predicate lives at the layer its consumers
 *  share (per `pipeline-checklist.md`, "shared predicate helpers go in
 *  `src/ir/util/`"). */

/** The known repository persistence verbs. A named call to one of these inside a
 *  domain-service body is a write, forbidden by `loom.domain-service-no-repo-write`;
 *  every other named repository call (`getById`, a declared `find`) is a read. */
const REPO_WRITE_METHODS: ReadonlySet<string> = new Set([
  "save",
  "insert",
  "update",
  "delete",
  "add",
  "remove",
  "commit",
]);

/** True when a named repository method is a READ — i.e. NOT one of the known
 *  write verbs. `getById` and any declared `find` are reads; `save`/`insert`/
 *  `update`/`delete`/`add`/`remove`/`commit` are writes. */
export function isReadMethod(method: string): boolean {
  return !REPO_WRITE_METHODS.has(method);
}

/** True when a named repository method is a WRITE (persistence mutation) —
 *  the validator's `loom.domain-service-no-repo-write` gate. */
export function isWriteMethod(method: string): boolean {
  return REPO_WRITE_METHODS.has(method);
}
