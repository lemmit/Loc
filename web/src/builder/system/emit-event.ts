import { AstUtils, GrammarUtils, type AstNode } from "langium";
import type {
  Aggregate,
  EmitStmt,
  Model,
  Operation,
  Statement,
  Workflow,
} from "../../../../src/language/generated/ast.js";
import { isWorkflowCreateDecl } from "../../../../src/language/generated/ast.js";

/** A2-S5f: sequential workflow statements live in the primary `create(...)`
 *  starter; the emit editor scopes to that body (reactor emits are separate). */
function wfStatements(wf: Workflow): readonly Statement[] {
  const creates = wf.members.filter(isWorkflowCreateDecl);
  return (creates.find((c) => !c.name) ?? creates[0])?.body ?? [];
}
import { applyEdits } from "../edit-engine";
import { parseDdd } from "../parse";
import type { NodeKind } from "./model";

// ---------------------------------------------------------------------------
// Emit-event editing — repoint an `emit Event { … }` statement at a different
// event. The event is a cross-reference (`emit.event`), so — like reference
// rebinding — we rewrite just the event-name token in place (the field values
// and everything else stay verbatim), then re-parse to validate.
// ---------------------------------------------------------------------------

export function eventNames(ast: Model): string[] {
  const out: string[] = [];
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "EventDecl") {
      const name = (n as { name?: unknown }).name;
      if (typeof name === "string") out.push(name);
    }
  }
  return out;
}

export interface EmitRef {
  /** Operation name (aggregate emits) or undefined (workflow body). */
  op?: string;
  index: number;
  event: string;
  /** Stable option value: `${op ?? ""}:${index}`. */
  value: string;
  label: string;
}

function collectEmits(body: readonly Statement[], op: string | undefined, out: EmitRef[]): void {
  body.forEach((stmt, index) => {
    if (stmt.$type !== "EmitStmt") return;
    const event = (stmt as EmitStmt).event?.$refText ?? "";
    out.push({ op, index, event, value: `${op ?? ""}:${index}`, label: `${op ? `${op}: ` : ""}emit ${event}` });
  });
}

/** Every `emit` statement on an aggregate's operations or a workflow's body. */
export function listEmits(node: AstNode): EmitRef[] {
  const out: EmitRef[] = [];
  if (node.$type === "Aggregate") {
    for (const m of (node as Aggregate).members) {
      if (m.$type === "Operation") collectEmits((m as Operation).body, (m as Operation).name, out);
    }
  } else if (node.$type === "Workflow") {
    // A workflow body is a `WorkflowMember[]`; collect emits from its statement
    // members (emits inside `on(...)` reactor bodies are a later concern).
    collectEmits(wfStatements(node as Workflow), undefined, out);
  }
  return out;
}

function emitBodyOf(ast: Model, kind: NodeKind, owner: string, op: string | undefined): readonly Statement[] | null {
  const wantType = kind === "workflow" ? "Workflow" : "Aggregate";
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === wantType && (n as { name?: unknown }).name === owner) {
      if (kind === "workflow") return wfStatements(n as Workflow);
      const operation = (n as Aggregate).members.find((m): m is Operation => m.$type === "Operation" && (m as Operation).name === op);
      return operation?.body ?? null;
    }
  }
  return null;
}

export function setEmitEvent(
  source: string,
  kind: NodeKind,
  owner: string,
  op: string | undefined,
  index: number,
  eventName: string,
): string | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  const stmt = emitBodyOf(fresh.ast, kind, owner, op)?.[index];
  if (!stmt || stmt.$type !== "EmitStmt") return null;
  const cst = GrammarUtils.findNodeForProperty(stmt.$cstNode, "event");
  if (!cst) return null;
  const next = applyEdits(source, [{ offset: cst.offset, end: cst.end, newText: eventName }]);
  return parseDdd(next).parserErrors.length === 0 ? next : null;
}
