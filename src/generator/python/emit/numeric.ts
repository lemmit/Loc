// ---------------------------------------------------------------------------
// `app/domain/numeric.py` — cross-backend numeric semantics for the Python
// backend.
//
// Python's `%` is the only FLOORED modulo among Loom's five backends: its
// result takes the sign of the DIVISOR, so `-5 % 3 == 1`.  TS/JS, C#, Java and
// Elixir (which deliberately emits `rem/2`, not `Integer.mod/2`) all TRUNCATE
// towards zero — the result takes the sign of the DIVIDEND, so `-5 % 3 == -2`.
// A `.ddd` expression must mean the same thing on every backend, so the Python
// renderer lowers `%` to `trunc_mod(...)` from this module rather than to the
// native operator (`render-expr.ts` → `renderBinary`).
//
// Wiring is a single CENTRAL pass over the finished file map
// (`wireTruncModHelper`), not a per-emitter import line.  `%` can appear in a
// derived field, an invariant (which the aggregate module, the Pydantic wire
// validator AND the route module each re-render), a VO function, a domain
// service, a workflow step, a seed, a unit test — a dozen emitters, each with
// its own preamble builder.  Missing one would emit a `NameError` at import
// time, i.e. a silent boot break.  One pass over the emitted text is complete
// by construction: if the call is in the file, the import is too.
// ---------------------------------------------------------------------------

/** The generated helper module.  Value-restricted TypeVar (not `float`) so
 *  `trunc_mod(int, int)` stays `int` under `mypy --strict` — a plain `float`
 *  return would poison every int-typed field it feeds. */
export const NUMERIC_PY = `"""Numeric helpers with cross-backend semantics.  Auto-generated."""

from typing import TypeVar

_N = TypeVar("_N", int, float)


def trunc_mod(a: _N, b: _N) -> _N:
    """Remainder that TRUNCATES towards zero, like C / Java / C# / JS \`%\`.

    Python's native \`%\` floors instead, taking the sign of the divisor
    (\`-5 % 3 == 1\`); every other Loom backend takes the sign of the dividend
    (\`-5 % 3 == -2\`).  This keeps the answer identical across backends.
    """
    m = a % b
    if m != 0 and (a < 0) != (b < 0):
        return m - b
    return m
`;

const HELPER_PATH = "app/domain/numeric.py";
const IMPORT_LINE = "from app.domain.numeric import trunc_mod";
const CALLS = /\btrunc_mod\(/;

/**
 * Emit `app/domain/numeric.py` and give every module that CALLS `trunc_mod`
 * the import — a no-op when nothing in the project uses `%`.
 *
 * The import lands directly after the module docstring, at the head of the
 * import block.  Generated projects pin ruff's lint scope to `E4/E7/E9 + F`
 * (see the emitted `pyproject.toml`), so isort's grouping rule (`I001`) is not
 * in play and placement only has to be syntactically valid.
 */
export function wireTruncModHelper(out: Map<string, string>): void {
  let used = false;
  for (const [path, content] of out) {
    if (path === HELPER_PATH || !CALLS.test(content) || content.includes(IMPORT_LINE)) continue;
    used = true;
    out.set(path, insertImport(content));
  }
  if (used) out.set(HELPER_PATH, NUMERIC_PY);
}

/** Splice the import in after a leading module docstring (every generated
 *  module opens with one), else at the very top. */
function insertImport(content: string): string {
  const lines = content.split("\n");
  // A one-line `"""…"""` docstring is the emitters' universal opener; anything
  // else (no docstring, or a multi-line one) falls back to a top insert, which
  // is still valid Python — it just isn't the file's own docstring any more,
  // so only do it when line 0 clearly isn't one.
  const head = lines[0] ?? "";
  const hasDocstring = head.startsWith('"""') && head.endsWith('"""') && head.length > 5;
  lines.splice(hasDocstring ? 1 : 0, 0, ...(hasDocstring ? ["", IMPORT_LINE] : [IMPORT_LINE, ""]));
  return lines.join("\n");
}
