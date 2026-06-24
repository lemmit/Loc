// ---------------------------------------------------------------------------
// Elixir app-name helpers — `toSnakeApp` (deployable name → OTP app / snake
// name) and `toModulePrefix` (snake name → Elixir module prefix).  Pure
// string functions shared by the orchestrator, the persistence/layout
// adapters, and the `vanilla/` emit subtree.
// ---------------------------------------------------------------------------

export function toSnakeApp(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .toLowerCase();
}

export function toModulePrefix(snakeName: string): string {
  return snakeName
    .split("_")
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");
}
