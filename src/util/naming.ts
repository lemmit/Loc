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

export function indent(text: string, level = 1, unit = "  "): string {
  const pad = unit.repeat(level);
  return text
    .split("\n")
    .map((l) => (l.length === 0 ? l : pad + l))
    .join("\n");
}
