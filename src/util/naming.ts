export function pascal(input: string): string {
  if (!input) return input;
  return input[0]!.toUpperCase() + input.slice(1);
}

export function camel(input: string): string {
  if (!input) return input;
  return input[0]!.toLowerCase() + input.slice(1);
}

export function snake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export function plural(input: string): string {
  if (input.endsWith("y") && !/[aeiou]y$/.test(input)) {
    return input.slice(0, -1) + "ies";
  }
  if (/(s|x|z|ch|sh)$/.test(input)) return input + "es";
  return input + "s";
}

/** Convert an identifier (camelCase, PascalCase, snake_case) into a
 *  human-friendly Title Case label suitable for UI display.
 *  Examples: "customerId" → "Customer Id"; "placedAt" → "Placed At";
 *  "addLine" → "Add Line"; "order_total" → "Order Total".
 *  Common acronyms are passed through capitalised, not split. */
export function humanize(input: string): string {
  if (!input) return input;
  const words = input
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/);
  return words.map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join(" ");
}

export function indent(text: string, level = 1, unit = "  "): string {
  const pad = unit.repeat(level);
  return text
    .split("\n")
    .map((l) => (l.length === 0 ? l : pad + l))
    .join("\n");
}
