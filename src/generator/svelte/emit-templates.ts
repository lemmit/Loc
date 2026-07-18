// Static (non-templated) sources the Svelte generator emits verbatim.
// Sibling of src/generator/react/emit-templates.ts.

/** `src/lib/forms.svelte.ts` — the hand-rolled runes + zod form
 *  helper (svelte-frontend-plan.md decision: no third-party form
 *  dependency).  Mirrors the surface the react packs get from
 *  react-hook-form + apply-server-errors: `form.values` (bind:
 *  targets, deep-reactive), `form.errors` (per-field message map
 *  keyed by dotted path), `form.submit(onValid)` (zod parse → error
 *  map fill → submit), `form.applyServerErrors(e)` (RFC 7807
 *  ProblemDetails 422 → per-field errors). */
export const SVELTE_LIB_FORMS = `// Auto-generated.  Do not edit by hand.
import type { z } from "zod";
import { ApiError } from "./api/client";

export interface LoomForm<T> {
  values: T;
  readonly errors: Record<string, string>;
  readonly submitting: boolean;
  reset(): void;
  submit(onValid: (vals: T) => Promise<void> | void): Promise<void>;
  /** Decode an RFC 7807 ProblemDetails 422 body (or any
   *  \`{ errors: { field: msg } }\` shape) into per-field errors.
   *  Returns "fields" when at least one error attached to a field,
   *  "global" with a title for problem bodies without field errors,
   *  and "unhandled" otherwise. */
  applyServerErrors(e: unknown): { kind: "fields" } | { kind: "global"; title: string } | { kind: "unhandled" };
}

export function createForm<S extends z.ZodType>(
  schema: S,
  defaults: z.infer<S>,
): LoomForm<z.infer<S>> {
  let values = $state(structuredClone(defaults) as z.infer<S>);
  let errors = $state<Record<string, string>>({});
  let submitting = $state(false);

  return {
    get values() {
      return values;
    },
    set values(v: z.infer<S>) {
      values = v;
    },
    get errors() {
      return errors;
    },
    get submitting() {
      return submitting;
    },
    reset() {
      values = structuredClone(defaults) as z.infer<S>;
      errors = {};
    },
    async submit(onValid: (vals: z.infer<S>) => Promise<void> | void) {
      const parsed = schema.safeParse(values);
      if (!parsed.success) {
        const next: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          const path = issue.path.join(".");
          if (next[path] === undefined) next[path] = issue.message;
        }
        errors = next;
        return;
      }
      errors = {};
      submitting = true;
      try {
        await onValid(parsed.data);
      } finally {
        submitting = false;
      }
    },
    applyServerErrors(e: unknown) {
      const body = e instanceof ApiError ? e.body : e;
      if (body && typeof body === "object") {
        const rec = body as { errors?: Record<string, string | string[]>; title?: string };
        if (rec.errors && typeof rec.errors === "object") {
          const next: Record<string, string> = { ...errors };
          let any = false;
          for (const [k, v] of Object.entries(rec.errors)) {
            const msg = Array.isArray(v) ? v[0] : v;
            if (typeof msg === "string") {
              // ProblemDetails keys may be PascalCase — align with the
              // camelCase form paths the zod schemas use.
              const path = k.length > 0 ? k[0]!.toLowerCase() + k.slice(1) : k;
              next[path] = msg;
              any = true;
            }
          }
          if (any) {
            errors = next;
            return { kind: "fields" as const };
          }
        }
        if (typeof rec.title === "string") {
          return { kind: "global" as const, title: rec.title };
        }
      }
      return { kind: "unhandled" as const };
    },
  };
}

/** Modal focus trap (a Svelte \`use:\` action).  On mount it moves focus to the
 *  first focusable element inside the node; Tab / Shift+Tab cycle within it;
 *  Escape invokes \`onClose\`; and on teardown focus returns to whatever had it
 *  before the modal opened.  The library dialog components (Radix, vuetify,
 *  Angular Material, HEEx \`.modal\`) provide this natively — the raw-\`<div>\`
 *  op-modals in the shadcnSvelte / flowbite packs need it emitted. */
export function modalTrap(node: HTMLElement, onClose: () => void) {
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusables = (): HTMLElement[] =>
    Array.from(node.querySelectorAll<HTMLElement>(selector)).filter((el) => el.offsetParent !== null);
  (focusables()[0] ?? node).focus();
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusables();
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
  node.addEventListener("keydown", onKeydown);
  return {
    destroy(): void {
      node.removeEventListener("keydown", onKeydown);
      previouslyFocused?.focus?.();
    },
  };
}
`;

/** `src/lib/toast.svelte.ts` — minimal runes toast store + helpers.
 *  The root layout renders the matching container.  Keeps the
 *  default-submit "saved / failed" feedback parity with the react
 *  packs without a notification dependency. */
export const SVELTE_LIB_TOAST = `// Auto-generated.  Do not edit by hand.

export interface Toast {
  id: number;
  kind: "success" | "error";
  message: string;
}

let nextId = 1;
const items = $state<Toast[]>([]);

function push(kind: Toast["kind"], message: string): void {
  const id = nextId++;
  items.push({ id, kind, message });
  setTimeout(() => {
    const i = items.findIndex((t) => t.id === id);
    if (i !== -1) items.splice(i, 1);
  }, 4000);
}

export const toast = {
  get items() {
    return items;
  },
  success(message: string) {
    push("success", message);
  },
  error(message: string) {
    push("error", message);
  },
};
`;

/** `src/lib/schemas.ts` — shared money wire schema.  Byte-compatible
 *  with the react projects' src/lib/schemas.ts (same zod transform). */
export const SVELTE_LIB_SCHEMAS_MONEY = `// Auto-generated.  Do not edit by hand.
import Decimal from "decimal.js";
import { z } from "zod";

/**
 * Schema for the \`money\` primitive, on both of its inbound shapes:
 *
 *   - Wire JSON: a decimal-formatted string (\`"123.4500"\`) — parsed
 *     to a \`decimal.js\` Decimal instance.
 *   - Form state: an already-constructed Decimal — the money input
 *     control converts on change, so the zod resolver sees the
 *     instance, not a string.  Passed through unchanged.
 *
 * Format violations and parse failures both surface as typed Zod
 * issues — invalid input becomes a form-level error attached to the
 * field, not an uncaught throw.
 */
export const moneySchema = z.union([z.instanceof(Decimal), z.string()]).transform((s, ctx) => {
  if (s instanceof Decimal) return s;
  if (!/^-?\\d+(\\.\\d+)?$/.test(s)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: \`Invalid decimal: \${JSON.stringify(s)}\`,
    });
    return z.NEVER;
  }
  try {
    return new Decimal(s);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: \`Invalid decimal: \${JSON.stringify(s)}\`,
    });
    return z.NEVER;
  }
});
`;

/** `src/app.d.ts` — SvelteKit ambient types.  `PageState` carries the
 *  shallow-routing state `navigate(path, { state })` writes. */
export const SVELTE_APP_DTS = `// Auto-generated.  Do not edit by hand.
declare global {
  namespace App {
    interface PageState {
      [key: string]: unknown;
    }
  }
}

export {};
`;

/** `src/routes/+layout.ts` — SPA mode: no SSR, no prerender; the
 *  adapter-static fallback (index.html) serves every deep link. */
export const SVELTE_LAYOUT_TS = `// Auto-generated.  Do not edit by hand.
export const ssr = false;
export const prerender = false;
`;
