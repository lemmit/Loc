// -------------------------------------------------------------------------
// Comparison operand-order normalization — ONE place that answers "which side
// of this comparison is the column, and what does the operator become if it
// has to move".
//
// Every SQL-shaped predicate lowerer has a column position and a value
// position: Drizzle emits `lt(<col>, <value>)`, MikroORM emits
// `{ <col>: { $lt: <value> } }`, and neither vocabulary has a place to put a
// literal on the left.  A predicate written `where 100 < this.qty` is a
// perfectly ordinary queryable shape (`firstNonQueryableNode` walks a
// comparison's operands symmetrically), so each lowerer has to move the column
// to the left — and MIRROR the operator while doing it, or the emitted read
// answers the exact opposite question.
//
// Each adapter re-deciding that independently is what produced two bugs at
// once: Drizzle picked the column off either side but kept `<` as `lt`
// (silently inverted reads), and MikroORM required the column on the left and
// threw, turning a validator-accepted model into a runtime-throwing stub.  So
// the decision lives here, and adapters supply only their own notion of "this
// operand renders as a column".
//
// Platform-neutral (IR-level): the lowerers under `src/generator/` call it,
// `sql-pg-expr.ts` needs no help (it renders both operands symmetrically), and
// a future adapter inherits the commute instead of re-deriving it.
// -------------------------------------------------------------------------

/** The operator a comparison becomes when its operands swap sides.
 *  `a < b` ⇔ `b > a`; equality/inequality are symmetric, so they map to
 *  themselves. */
export const MIRRORED_COMPARE_OP: Readonly<Record<string, string>> = {
  "==": "==",
  "!=": "!=",
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
};

/** A comparison re-expressed with its column operand on the LEFT: `op` is the
 *  (possibly mirrored) operator, `column` the operand the caller's predicate
 *  accepted as a column, `value` the other side. */
export interface OrientedComparison<T> {
  op: string;
  column: T;
  value: T;
  /** True when the operands were swapped (and `op` therefore mirrored). */
  commuted: boolean;
}

/**
 * Orient a comparison so its column operand is on the left.
 *
 * `isColumnSide` is the adapter's own test — whatever it accepts in column
 * position (a `this.<field>` ref, a VO subfield, an intrinsic over a column).
 * The LEFT operand is tried first, so a predicate already written
 * column-on-left is returned untouched and byte-identical.
 *
 * Returns null when neither operand is a column, or when the operator has no
 * mirror (not a comparison) and the column sits on the right — the caller then
 * takes its own unsupported-shape path.
 */
export function orientComparison<T>(
  op: string,
  left: T,
  right: T,
  isColumnSide: (operand: T) => boolean,
): OrientedComparison<T> | null {
  if (isColumnSide(left)) return { op, column: left, value: right, commuted: false };
  if (!isColumnSide(right)) return null;
  const mirrored = MIRRORED_COMPARE_OP[op];
  if (mirrored === undefined) return null;
  return { op: mirrored, column: right, value: left, commuted: true };
}
