import { EmptyFileSystem } from "langium";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

// Main-thread `.ddd` parsing for the visual Builders.  The Langium services
// are pure TS (no Node I/O with EmptyFileSystem) and already run in the
// LSP/build workers; the Builders own their own instance so they can read the
// AST + CST (offsets) directly on the main thread and re-parse after each edit
// — the playground already re-parses on every keystroke, so this is cheap.
const parser = createDddServices(EmptyFileSystem).Ddd.parser.LangiumParser;

export interface DddParse {
  ast: Model;
  /** Non-empty when the source is syntactically invalid. */
  parserErrors: readonly unknown[];
}

export function parseDdd(text: string): DddParse {
  const result = parser.parse(text);
  return { ast: result.value as Model, parserErrors: result.parserErrors };
}
