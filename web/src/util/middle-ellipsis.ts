// Middle-ellipsis truncation (M-T8.21 slice 3, audit M17).
//
// CSS `text-overflow: ellipsis` clips the END of a string, which for a path
// (`src/domain/sales/order.ts`) or a titled row keeps the part every sibling
// shares and drops the part that tells them apart.  Keeping both ends —
// `src/dom…order.ts` — is what file managers do; the full value goes on the
// element's `title` so hover shows it.  Pure, so the unit test can pin it.

const ELLIPSIS = "…";

/** Truncate `text` to at most `max` characters by replacing its middle with
 *  `…`.  The tail keeps slightly more than the head (the distinguishing part
 *  of a path is usually its end).  Strings at or under `max` come back
 *  unchanged; `max` under 3 degrades to the ellipsis alone. */
export function middleEllipsis(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max < 3) return ELLIPSIS;
  const keep = max - 1;
  const head = Math.floor(keep / 2);
  const tail = keep - head;
  return `${chars.slice(0, head).join("")}${ELLIPSIS}${chars.slice(chars.length - tail).join("")}`;
}

/** Whether `middleEllipsis(text, max)` would change `text` — i.e. whether a
 *  `title` tooltip carrying the full value is worth rendering. */
export function needsEllipsis(text: string, max: number): boolean {
  return Array.from(text).length > max;
}
