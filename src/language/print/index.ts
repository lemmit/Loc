// `.ddd` source printer — AST → text for the constructs the visual Builders
// edit.  Importing this module wires the expr↔stmt printers together.
export { addressOf, buildOutline } from "./outline.js";
export { printExpr } from "./print-expr.js";
export { printStmt } from "./print-stmt.js";
export { printStructural } from "./print-structural.js";
