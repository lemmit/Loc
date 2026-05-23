// Text emitters for the Requirements pane's form editor.
//
// The page-builder edit flow (see `web/src/builder/BuilderPane.tsx`) is:
//   1. read `ctx.getSource()`;
//   2. emit fresh text for the changed construct;
//   3. `spliceNode(source, originalNode, newText)` replaces the original
//      node's CST range (preserving everything else — comments, blank
//      lines, hand-spacing — byte-for-byte).
//
// These helpers cover step 2 for Requirement / Solution / TestCase.  They
// take typed patch shapes (what the form actually owns) and emit text in
// canonical key order, matching the style of `src/language/print/print-
// structural.ts` (2-space indent, newline-joined items, `header { … }`).

const INDENT = "  ";

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => (l.length > 0 ? INDENT + l : l))
    .join("\n");
}

function block(header: string, items: readonly string[]): string {
  if (items.length === 0) return `${header} {}`;
  return `${header} {\n${indent(items.join("\n"))}\n}`;
}

function quote(s: string): string {
  return JSON.stringify(s);
}

export type RequirementType = "UserStory" | "UseCase" | "AcceptanceCriteria" | "BusinessReq";
export type RequirementStatus = "Draft" | "Approved" | "InProgress" | "Done";

export interface RequirementSpec {
  name: string;
  parent?: string;
  type: RequirementType;
  title: string;
  status?: RequirementStatus;
  priority?: number;
}

/** Print a complete `requirement <name> [parent <id>] { ... }` block in
 *  canonical key order: type, title, status, priority. */
export function printRequirementText(spec: RequirementSpec): string {
  const header = spec.parent
    ? `requirement ${spec.name} parent ${spec.parent}`
    : `requirement ${spec.name}`;
  const items: string[] = [];
  items.push(`type: ${spec.type}`);
  items.push(`title: ${quote(spec.title)}`);
  if (spec.status !== undefined) items.push(`status: ${spec.status}`);
  if (spec.priority !== undefined) items.push(`priority: ${spec.priority}`);
  return block(header, items);
}

export interface SolutionSpec {
  name: string;
  forRequirement: string;
  title?: string;
  /** Qualified names — exactly the `$refText` form. */
  entitles: readonly string[];
}

export function printSolutionText(spec: SolutionSpec): string {
  const items: string[] = [];
  if (spec.title !== undefined) items.push(`title: ${quote(spec.title)}`);
  if (spec.entitles.length > 0) {
    items.push(`entitles [${spec.entitles.join(", ")}]`);
  }
  return block(`solution ${spec.name} for ${spec.forRequirement}`, items);
}

export interface TestCaseSpec {
  name: string;
  verifies: string;
  title?: string;
  /** Qualified names — exactly the `$refText` form. */
  covers: readonly string[];
}

export function printTestCaseText(spec: TestCaseSpec): string {
  const items: string[] = [];
  if (spec.title !== undefined) items.push(`title: ${quote(spec.title)}`);
  if (spec.covers.length > 0) {
    items.push(`covers [${spec.covers.join(", ")}]`);
  }
  return block(`testCase ${spec.name} verifies ${spec.verifies}`, items);
}
