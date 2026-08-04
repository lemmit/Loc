import { Textarea } from "@mantine/core";
import type { JsonBodyEditorProps } from "./JsonBodyEditor";

/** The MOBILE request-body editor: a textarea.
 *
 *  The Monaco version publishes a JSON syntax marker as you type; here the
 *  same feedback is a border + a message under the field, computed from the
 *  same `JSON.parse`.  What is NOT worth 9.56 MB of editor on a phone is the
 *  squiggle that carries it.  See M-T8.15. */
export function PlainJsonBody({ value, onChange }: JsonBodyEditorProps): JSX.Element {
  const error = jsonError(value);
  return (
    <Textarea
      data-testid="req-body"
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      error={error}
      autosize
      minRows={4}
      maxRows={14}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      styles={{
        input: {
          fontFamily: "var(--mantine-font-family-monospace)",
          // 16px keeps iOS from zooming the viewport on focus.
          fontSize: 16,
          whiteSpace: "pre",
          overflowX: "auto",
        },
      }}
    />
  );
}

/** `null` when the body is empty or valid — an empty body is a legitimate
 *  request, not a parse failure. */
function jsonError(text: string): string | null {
  if (text.trim() === "") return null;
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
