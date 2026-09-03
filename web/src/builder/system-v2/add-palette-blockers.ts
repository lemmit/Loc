// Which "+" palette entries CANNOT succeed on the current model, and why —
// pure, so the reasons are unit-testable and the palette can render the
// entry disabled with the reason as its tooltip instead of letting the click
// no-op (M-T8.17 slice 4, audit H10).
//
// The templates behind these entries carry a mandatory cross-reference (a
// repository is `for` an aggregate, a channel `carries` an event, a resource
// `use`s a storage, …); `add.ts` / `add-extra.ts` return null when the target
// is absent.  The predicates here mirror those null paths one-for-one, so a
// blocked entry is exactly an entry whose add would have returned null.

import { AstUtils } from "langium";
import type { BoundedContext, Model } from "../../../../src/language/generated/ast.js";
import { listSubdomainNames } from "../system/add";
import type { ViewPath } from "./view-graph";

/** Palette entry key → the reason it is disabled.  Absent = enabled. */
export type PaletteBlockers = ReadonlyMap<string, string>;

function hasType(ast: Model, type: string): boolean {
  for (const n of AstUtils.streamAst(ast)) if (n.$type === type) return true;
  return false;
}

function findContext(ast: Model, name: string): BoundedContext | undefined {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === "BoundedContext" && (n as BoundedContext).name === name) return n as BoundedContext;
  }
  return undefined;
}

export function paletteBlockers(ast: Model, path: ViewPath): PaletteBlockers {
  const out = new Map<string, string>();
  const last = path[path.length - 1];
  if (!last) return out;

  if (last.kind === "system") {
    if (listSubdomainNames(ast).length === 0) {
      out.set("api", "Add a subdomain first — an api serves one.");
    }
    if (!hasType(ast, "BoundedContext")) {
      out.set("resource", "Add a context first — a resource is for one.");
    } else if (!hasType(ast, "Storage")) {
      out.set("resource", "Add a storage first — a resource uses one.");
    }
    if (!hasType(ast, "Channel")) {
      out.set("channelSource", "Add a channel first — a channel source feeds one.");
    }
    if (!hasType(ast, "EventDecl")) {
      out.set("timerSource", "Add an event first — a timer source emits one.");
    }
  }

  if (last.kind === "context") {
    const ctx = findContext(ast, last.name);
    const members = ctx?.members ?? [];
    if (!members.some((m) => m.$type === "Aggregate")) {
      out.set("repository", "Add an aggregate to this context first — a repository is for one.");
    }
    if (!members.some((m) => m.$type === "EventDecl")) {
      out.set("channel", "Add an event to this context first — a channel carries one.");
    }
  }

  return out;
}
