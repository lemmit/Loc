// ---------------------------------------------------------------------------
// Model-patch applier — node-addressed edits over `.ddd` source
// (docs/old/proposals/ai-authoring-loop.md §4).
//
// The AI authoring loop edits *named model nodes*, not byte ranges: a patch
// addresses a node by its canonical address (`<keyword> <Context>.<Decl>[.…]`,
// the same address space as the diagnostic `node` and the outline) and the
// applier splices the change into the source.
//
// Rather than re-print the whole model canonically (which would reformat
// untouched code when the input isn't already canonical), the applier does a
// CST-range text splice: untouched bytes are preserved exactly, so the diff is
// the patch and nothing else (a stronger form of the §4.3 "unrelated nodes
// byte-unchanged" guarantee).  The same in-place-rewrite technique the LSP
// unfold-macro action uses.
//
// Pure language-layer: parses in-memory and walks the AST; no `ir/` edge.
// ---------------------------------------------------------------------------

import { type AstNode, EmptyFileSystem, type LangiumDocument, URI } from "langium";
import type { ModelPatch } from "../diagnostics/contract.js";
import { createDddServices } from "./ddd-module.js";
import {
  isAggregate,
  isBoundedContext,
  isDeployable,
  isEnumDecl,
  isEventDecl,
  isPage,
  isRepository,
  isSubdomain,
  isSystem,
  isValueObject,
  isView,
  isWorkflow,
  type Model,
} from "./generated/ast.js";
import { addressOf } from "./print/outline.js";

export type { ModelPatch };

export interface PatchApplied {
  op: ModelPatch["op"];
  target: string;
}

export interface PatchError {
  patch: ModelPatch;
  message: string;
}

export interface PatchResult {
  /** true iff every patch applied.  On any error nothing is applied and
   *  `text` is the original source (patches are atomic — §8). */
  ok: boolean;
  text: string;
  applied: PatchApplied[];
  errors: PatchError[];
}

/** One resolved text edit. */
interface Edit {
  start: number;
  end: number;
  newText: string;
}

/** A container the `add` op can insert a member into — a node with a free-form
 *  `{ member* }` body where appending before the closing `}` is valid.
 *  Deliberately excludes `Deployable`: its body is a *positional* config
 *  grammar (the `ui:` / `serves:` / `hosts:` slots are ordered), so a generic
 *  append would land out of position and fail to parse. */
function isContainer(node: AstNode): boolean {
  return isBoundedContext(node) || isAggregate(node) || isValueObject(node);
}

/** Walk the declaration tree (the same set `buildOutline` enumerates) building
 *  an address → node index.  Restricted to targetable declarations so a
 *  property's type sub-node can't shadow the aggregate's own address. */
function indexTargets(model: Model): { map: Map<string, AstNode>; ambiguous: Set<string> } {
  const map = new Map<string, AstNode>();
  const ambiguous = new Set<string>();

  const put = (node: AstNode): string | undefined => {
    const a = addressOf(node);
    if (!a) return undefined;
    if (map.has(a)) ambiguous.add(a);
    else map.set(a, node);
    return a;
  };

  // An entity-like declaration (aggregate / value object): index it and its
  // members (skipping members that collapse to the entity's own address, e.g.
  // unnamed invariants).
  const indexEntity = (decl: { members: AstNode[] } & AstNode): void => {
    const declAddr = put(decl);
    for (const mem of decl.members) {
      const memAddr = addressOf(mem);
      if (memAddr && memAddr !== declAddr) put(mem);
    }
  };

  const indexContext = (ctx: AstNode): void => {
    put(ctx);
    if (!("members" in ctx)) return;
    for (const m of (ctx as { members: AstNode[] }).members) {
      if (isAggregate(m) || isValueObject(m)) indexEntity(m);
      else if (isWorkflow(m) || isView(m) || isPage(m)) put(m);
      else if (isEnumDecl(m) || isEventDecl(m) || isRepository(m)) put(m);
    }
  };

  for (const member of model.members) {
    if (isSystem(member)) {
      for (const sm of member.members) {
        if (isBoundedContext(sm)) indexContext(sm);
        else if (isSubdomain(sm)) for (const c of sm.contexts) indexContext(c);
        else if (isDeployable(sm)) put(sm);
      }
    } else if (isBoundedContext(member)) {
      indexContext(member);
    }
  }
  return { map, ambiguous };
}

/** Offset of the start of the line containing `offset`. */
function lineStart(text: string, offset: number): number {
  let i = offset;
  while (i > 0 && text[i - 1] !== "\n") i--;
  return i;
}

/** Build the edit for one resolved patch, or throw with a clear message. */
function editFor(patch: ModelPatch, node: AstNode, text: string): Edit {
  const cst = node.$cstNode;
  if (!cst) throw new Error(`target '${patch.target}' has no source location`);
  const start = cst.offset;
  const end = cst.end;

  if (patch.op === "replace") {
    if (patch.source === undefined) throw new Error(`'replace' requires 'source'`);
    return { start, end, newText: patch.source };
  }

  if (patch.op === "remove") {
    // Consume the declaration's leading indent and one trailing newline so the
    // removal leaves no blank line behind.
    const from = lineStart(text, start);
    let to = end;
    while (to < text.length && text[to] !== "\n") to++;
    if (to < text.length) to++; // include the newline
    return { start: from, end: to, newText: "" };
  }

  if (patch.op === "insert") {
    if (patch.source === undefined) throw new Error(`'insert' requires 'source'`);
    const position = patch.position ?? "after";
    if (position === "header-end") {
      // Insert just before the target declaration's opening `{` (its header) —
      // for header clauses like `inheritanceUsing(ownTable)`.  The existing
      // space before `{` separates the prior token; a trailing space separates
      // `source` from `{`.
      let brace = start;
      while (brace < end && text[brace] !== "{") brace++;
      if (text[brace] !== "{")
        throw new Error(`'${patch.target}' has no '{' header to insert before`);
      return { start: brace, end: brace, newText: `${patch.source} ` };
    }
    // before / after — a sibling line at the target's own indentation.
    const ls = lineStart(text, start);
    let indent = "";
    for (let i = ls; i < start && (text[i] === " " || text[i] === "\t"); i++) indent += text[i];
    if (position === "before") {
      return { start: ls, end: ls, newText: `${indent}${patch.source}\n` };
    }
    let lineEnd = end;
    while (lineEnd < text.length && text[lineEnd] !== "\n") lineEnd++;
    if (lineEnd < text.length) lineEnd++; // past the newline
    return { start: lineEnd, end: lineEnd, newText: `${indent}${patch.source}\n` };
  }

  // add — insert `source` as a new member just before the container's `}`.
  if (patch.source === undefined) throw new Error(`'add' requires 'source'`);
  if (!isContainer(node)) {
    throw new Error(`'add' target '${patch.target}' is not a container (context/aggregate)`);
  }
  let brace = end - 1;
  while (brace > start && text[brace] !== "}") brace--;
  if (text[brace] !== "}") throw new Error(`could not locate body of '${patch.target}'`);
  const braceLine = lineStart(text, brace);
  let baseCol = 0;
  while (braceLine + baseCol < brace && /\s/.test(text[braceLine + baseCol] ?? "")) baseCol++;
  const memberIndent = " ".repeat(baseCol + 2);
  // Own-line brace (canonical multi-line block): insert a member line above it.
  const braceIsOwnLine = text.slice(braceLine, brace).trim() === "";
  if (braceIsOwnLine) {
    return { start: braceLine, end: braceLine, newText: `${memberIndent}${patch.source}\n` };
  }
  // Inline brace: insert before it, pushing the brace to its own line.
  return {
    start: brace,
    end: brace,
    newText: `\n${memberIndent}${patch.source}\n${" ".repeat(baseCol)}`,
  };
}

/** A resolved edit with the LSP-compatible source range it spans. */
export interface PatchTextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

interface Resolved {
  doc: LangiumDocument<Model>;
  edits: { edit: Edit; patch: ModelPatch }[];
  errors: PatchError[];
}

/** Parse the source, resolve every patch target to an offset edit, and reject
 *  overlaps — the shared core of `applyPatches` (offset splice) and
 *  `resolvePatchEdits` (LSP ranges). */
async function resolve(source: string, patches: ModelPatch[]): Promise<Resolved> {
  const services = createDddServices(EmptyFileSystem);
  const factory = services.shared.workspace.LangiumDocumentFactory;
  const doc = factory.fromString<Model>(source, URI.parse("memory:///patch.ddd"));
  await services.shared.workspace.DocumentBuilder.build([doc]);

  const { map, ambiguous } = indexTargets(doc.parseResult.value);
  const errors: PatchError[] = [];
  const edits: { edit: Edit; patch: ModelPatch }[] = [];

  for (const patch of patches) {
    if (ambiguous.has(patch.target)) {
      errors.push({ patch, message: `target '${patch.target}' is ambiguous` });
      continue;
    }
    const node = map.get(patch.target);
    if (!node) {
      errors.push({ patch, message: `target '${patch.target}' not found` });
      continue;
    }
    try {
      edits.push({ edit: editFor(patch, node, source), patch });
    } catch (err) {
      errors.push({ patch, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Reject overlapping edits (e.g. replacing an aggregate and one of its
  // members in the same batch) — the result would be ill-defined.
  const sorted = [...edits].sort((a, b) => a.edit.start - b.edit.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.edit.start < sorted[i - 1]!.edit.end) {
      errors.push({ patch: sorted[i]!.patch, message: `edit overlaps another patch in the batch` });
    }
  }
  return { doc, edits, errors };
}

/**
 * Apply a batch of node-addressed patches to a `.ddd` source string.  Patches
 * are validated against the parsed model first; if any fails to resolve,
 * nothing is applied (atomic) and the original text is returned with the
 * collected errors.  Edits are applied end-to-start so offsets stay valid, and
 * overlapping edits are rejected.
 */
export async function applyPatches(source: string, patches: ModelPatch[]): Promise<PatchResult> {
  const { edits, errors } = await resolve(source, patches);
  if (errors.length > 0) {
    return { ok: false, text: source, applied: [], errors };
  }

  // Apply end-to-start so earlier offsets are unaffected by later splices.
  let text = source;
  for (const { edit } of [...edits].sort((a, b) => b.edit.start - a.edit.start)) {
    text = text.slice(0, edit.start) + edit.newText + text.slice(edit.end);
  }

  return {
    ok: true,
    text,
    applied: patches.map((p) => ({ op: p.op, target: p.target })),
    errors: [],
  };
}

/**
 * Resolve patches to **range-based** edits (LSP `TextEdit` shape) instead of
 * applying them, for editor transports (`ModelPatch → WorkspaceEdit/TextEdit`).
 * Atomic: on any resolution error, `edits` is empty.
 */
export async function resolvePatchEdits(
  source: string,
  patches: ModelPatch[],
): Promise<{ ok: boolean; edits: PatchTextEdit[]; errors: PatchError[] }> {
  const { doc, edits, errors } = await resolve(source, patches);
  if (errors.length > 0) {
    return { ok: false, edits: [], errors };
  }
  const textEdits = edits.map(({ edit }) => ({
    range: {
      start: doc.textDocument.positionAt(edit.start),
      end: doc.textDocument.positionAt(edit.end),
    },
    newText: edit.newText,
  }));
  return { ok: true, edits: textEdits, errors: [] };
}
