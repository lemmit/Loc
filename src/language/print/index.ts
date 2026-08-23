// `.ddd` source printer — AST → text for the constructs the visual Builders
// edit.  Importing this module wires the expr↔stmt printers together.
export { addressOf, buildOutline, isAddressable } from "./outline.js";
export { atColumn, printExpr, withColumn, withIndent } from "./print-expr.js";
export { printStmt } from "./print-stmt.js";
export { joinDecls, printStructural } from "./print-structural.js";
