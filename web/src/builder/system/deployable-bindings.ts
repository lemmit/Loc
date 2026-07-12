import { AstUtils, type AstNode } from "langium";
import type { Deployable, Model } from "../../../../src/language/generated/ast.js";
import { printStructural } from "../../../../src/language/print/index.js";
import { parseDdd } from "../parse";
import { spliceNode } from "../edit-engine";

// ---------------------------------------------------------------------------
// Deployable composition bindings — the multi-valued / single references a
// deployable carries: `contexts:`, `dataSources:`, `serves:`, `targets:`, and
// the sugar `ui:`.  Edited by mutating the parsed Deployable's binding arrays
// / refs and reprinting via the structural printer (which reads `$refText`),
// so no linking is needed.  The advanced `ui: W { … }` compose / legacy block
// forms are left to the text editor — `uiKind` reports them so the UI hides
// the picker.
// ---------------------------------------------------------------------------

function nodeNames(ast: Model, type: string): string[] {
  const out: string[] = [];
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === type) {
      const name = (n as { name?: unknown }).name;
      if (typeof name === "string") out.push(name);
    }
  }
  return out;
}

export const subdomainNames = (ast: Model): string[] => nodeNames(ast, "Subdomain");
export const boundedContextNames = (ast: Model): string[] => nodeNames(ast, "BoundedContext");
export const dataSourceNames = (ast: Model): string[] => nodeNames(ast, "Resource");
export const apiNames = (ast: Model): string[] => nodeNames(ast, "Api");
export const uiNames = (ast: Model): string[] => nodeNames(ast, "Ui");
export const deployableNames = (ast: Model): string[] => nodeNames(ast, "Deployable");

function asDeployable(node: AstNode): Deployable | null {
  return node.$type === "Deployable" ? (node as Deployable) : null;
}

// --- read helpers ----------------------------------------------------------

export function deployableContexts(node: AstNode): string[] {
  return asDeployable(node)?.contextRefs.map((b) => b.$refText) ?? [];
}
export function deployableDataSources(node: AstNode): string[] {
  return asDeployable(node)?.dataSourceRefs.map((b) => b.$refText) ?? [];
}
export function deployableServes(node: AstNode): string[] {
  return asDeployable(node)?.serves.map((s) => s.$refText) ?? [];
}
export function deployableTargets(node: AstNode): string | null {
  return asDeployable(node)?.targets?.$refText ?? null;
}
/** "sugar" → editable single ui ref; "compose" → advanced (text-only);
 *  "none" → no ui binding. */
export function uiKind(node: AstNode): "sugar" | "compose" | "none" {
  const d = asDeployable(node);
  if (!d) return "none";
  if (d.uiCompose) return "compose";
  return d.uiSugar ? "sugar" : "none";
}
export function deployableUi(node: AstNode): string | null {
  return asDeployable(node)?.uiSugar?.ref.$refText ?? null;
}

// --- mutating ops ----------------------------------------------------------

function commit(source: string, name: string, mutate: (d: Deployable) => void): string | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  let target: Deployable | null = null;
  for (const n of AstUtils.streamAst(fresh.ast)) {
    if (n.$type === "Deployable" && (n as Deployable).name === name) { target = n as Deployable; break; }
  }
  if (!target) return null;
  mutate(target);
  const next = spliceNode(source, target, printStructural(target));
  return parseDdd(next).parserErrors.length === 0 ? next : null;
}

const ref = (refText: string): never => ({ $refText: refText }) as never;

export function setDeployableContexts(source: string, name: string, contexts: string[]): string | null {
  return commit(source, name, (d) => {
    d.contextRefs = contexts.map(ref) as never;
  });
}
export function setDeployableDataSources(source: string, name: string, dataSources: string[]): string | null {
  return commit(source, name, (d) => {
    d.dataSourceRefs = dataSources.map(ref) as never;
  });
}
export function setDeployableServes(source: string, name: string, apis: string[]): string | null {
  return commit(source, name, (d) => { d.serves = apis.map(ref); });
}
export function setDeployableTargets(source: string, name: string, target: string | null): string | null {
  return commit(source, name, (d) => { d.targets = target ? ref(target) : undefined; });
}
export function setDeployableUi(source: string, name: string, ui: string | null): string | null {
  return commit(source, name, (d) => {
    d.uiCompose = undefined;
    d.uiSugar = ui ? ({ $type: "UiSugarBinding", ref: ref(ui) } as never) : undefined;
  });
}
