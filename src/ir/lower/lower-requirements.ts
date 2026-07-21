// -------------------------------------------------------------------------
// Requirement / solution / test-case lowering (traceability layer) — the
// top-level `requirement`/`solution`/`testCase` members + code-ref kind
// classification.  Pure leaf consumed by lowerProject in ./lower.ts.
// -------------------------------------------------------------------------

import type { Reference } from "langium";
import type {
  Expression,
  Requirement,
  Solution,
  Targetable,
  TestCase,
} from "../../language/generated/ast.js";
import type {
  CodeRefIR,
  CodeRefKind,
  RequirementIR,
  RequirementStatus,
  RequirementType,
  SolutionIR,
  TestCaseIR,
} from "../types/loom-ir.js";

// ---------------------------------------------------------------------------
// Traceability lowering
// ---------------------------------------------------------------------------

const REQUIREMENT_TYPES: ReadonlySet<string> = new Set<RequirementType>([
  "UserStory",
  "UseCase",
  "AcceptanceCriteria",
  "BusinessReq",
]);

const REQUIREMENT_STATUSES: ReadonlySet<string> = new Set<RequirementStatus>([
  "Draft",
  "Approved",
  "InProgress",
  "Done",
]);

/** Reads a scalar value out of a requirement prop-bag entry.  Bare
 *  identifiers (`UserStory`) lower to a NameRef whose `.name` we want;
 *  quoted titles to a StringLit; priorities to an IntLit.  Returns the
 *  raw string / number, or undefined for shapes we don't recognise
 *  (the validator reports those). */
function requirementPropValue(expr: Expression | undefined): string | number | undefined {
  if (!expr) return undefined;
  switch (expr.$type) {
    case "NameRef":
      return (expr as { name: string }).name;
    case "StringLit":
      return (expr as { value: string }).value;
    case "IntLit":
      return (expr as { value: number }).value;
    default:
      return undefined;
  }
}

export function lowerRequirement(r: Requirement): RequirementIR {
  let type: RequirementType = "UserStory";
  let title = "";
  let status: RequirementStatus | undefined;
  let priority: number | undefined;
  for (const p of r.props) {
    const v = requirementPropValue(p.value);
    switch (p.name) {
      case "type":
        if (typeof v === "string" && REQUIREMENT_TYPES.has(v)) type = v as RequirementType;
        break;
      case "title":
        if (typeof v === "string") title = v;
        break;
      case "status":
        if (typeof v === "string" && REQUIREMENT_STATUSES.has(v)) status = v as RequirementStatus;
        break;
      case "priority":
        if (typeof v === "number") priority = v;
        break;
    }
  }
  return { id: r.name, type, title, status, priority, parentId: r.parent?.ref?.name };
}

export function lowerSolution(s: Solution): SolutionIR {
  return {
    id: s.name,
    forRequirement: s.requirement?.ref?.name ?? "",
    title: s.title ?? "",
    entitles: lowerCodeRefs(s.entitles),
  };
}

export function lowerTestCase(t: TestCase): TestCaseIR {
  return {
    id: t.name,
    verifies: t.requirement?.ref?.name ?? "",
    title: t.title ?? "",
    covers: lowerCodeRefs(t.covers),
  };
}

function lowerCodeRefs(refs: readonly Reference<Targetable>[]): CodeRefIR[] {
  const out: CodeRefIR[] = [];
  for (const ref of refs) {
    const node = ref.ref;
    if (!node) continue; // unresolved — reported by the linker/validator
    out.push({ qualifiedName: ref.$refText, kind: codeRefKindOf(node) });
  }
  return out;
}

function codeRefKindOf(node: Targetable): CodeRefKind {
  switch (node.$type) {
    case "Subdomain":
      return "subdomain";
    case "BoundedContext":
      return "context";
    case "Aggregate":
      return "aggregate";
    case "Operation":
      return "operation";
    case "ValueObject":
      return "valueobject";
    case "EventDecl":
      return "event";
    case "Repository":
      return "repository";
    case "Workflow":
      return "workflow";
    case "Deployable":
      return "deployable";
    case "Api":
      return "api";
  }
}
