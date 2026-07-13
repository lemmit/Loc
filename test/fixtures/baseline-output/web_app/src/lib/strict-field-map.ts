// Auto-generated.  Do not edit by hand.
// See docs/old/proposals/frontend-acl.md.

type NestedPaths<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends object
        ? `${K}.${NestedPaths<T[K]>}`
        : `${K}`;
    }[keyof T & string]
  : never;

/**
 * Strict bidirectional pin between a payload's nested shape and a form
 * state's flat key set.  Keys MUST be valid dot-notation leaf paths of
 * the payload; values MUST be valid keys of the form state.  Used as a
 * `satisfies` constraint on per-action FieldMap constants.
 */
export type StrictFieldMap<TPayload, TFormState> = {
  readonly [K in NestedPaths<TPayload>]?: keyof TFormState & string;
};
