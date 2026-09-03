// Auto-generated.  Do not edit by hand.
import { t } from "../i18n";
import { Text, Tooltip, Code, Group, Stack } from "@mantine/core";
import type { ReactNode } from "react";

/** Empty placeholder for null / undefined / "" values.  Rendered as
 *  a dimmed em-dash so empty cells read as "intentionally blank"
 *  rather than as a layout glitch. */
export function EmptyValue() {
  return <Text component="span" c="dimmed">—</Text>;
}

/** True when the value should render as EmptyValue. */
export function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

/** Short id display: first 8 chars + ellipsis, with the full id
 *  surfaced in a tooltip.  Monospace so the prefix lines up across
 *  rows in tables. */
export function IdValue({ id }: { id: string | null | undefined }) {
  if (isEmpty(id)) return <EmptyValue />;
  const s = String(id);
  return (
    <Tooltip label={s} withArrow openDelay={200} position="top-start">
      <Code>{s.slice(0, 8)}…</Code>
    </Tooltip>
  );
}

/** Locale-formatted datetime.  Accepts an ISO string or null.  The
 *  raw ISO is preserved in the tooltip for operators who need the
 *  exact wire value. */
export function DateTimeValue({ iso }: { iso: string | null | undefined }) {
  if (isEmpty(iso)) return <EmptyValue />;
  const s = String(iso);
  let pretty = s;
  try {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      pretty = d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  } catch {
    // fall through with raw string
  }
  return (
    <Tooltip label={s} withArrow openDelay={200} position="top-start">
      <Text component="span">{pretty}</Text>
    </Tooltip>
  );
}

/** Boolean value as Yes / No, dimmed when false so true values are
 *  visually distinguishable at a glance. */
export function BoolValue({ value }: { value: boolean | null | undefined }) {
  if (isEmpty(value)) return <EmptyValue />;
  return value
    ? <Text component="span" fw={500}>{t("pack.mantine.boolTrue.dudzcg", "Yes")}</Text>
    : <Text component="span" c="dimmed">{t("pack.mantine.boolFalse.r5wqai", "No")}</Text>;
}

/** Locale-aware numeric value.  Used for int / long / decimal cells
 *  so 1234567 renders as 1,234,567 (or 1 234 567 in fr-FR etc.).
 *  Decimals keep up to two fractional digits unless the schema's
 *  scale is greater. */
export function NumberValue({ value, decimals = 0 }: { value: number | string | null | undefined; decimals?: number }) {
  if (isEmpty(value)) return <EmptyValue />;
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return <Text component="span">{String(value)}</Text>;
  const fmt = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: Math.max(decimals, 2),
  });
  return <Text component="span" style={{ fontVariantNumeric: "tabular-nums" }}>{fmt.format(n)}</Text>;
}

/** Money value, rendered VERBATIM (M-T1.25): the wire's own digits,
 *  locale-neutral — no Number() coercion, no locale grouping, no
 *  currency symbol, no re-scaling.  `currency` prefixes the CODE the
 *  page source declared (`Money(x, currency: "EUR")`); `decimals`
 *  re-scales the digit string.  Neither is invented here — Loom money
 *  has no currency dimension.  Semantics live in `moneyText` below. */
export function MoneyValue({ value, currency, decimals }: { value: number | string | { toString(): string } | null | undefined; currency?: string; decimals?: number }) {
  if (isEmpty(value)) return <EmptyValue />;
  return <Text component="span" style={{ fontVariantNumeric: "tabular-nums" }}>{moneyText(value as number | string | { toString(): string }, currency, decimals)}</Text>;
}

/** Generic value display with empty-state handling.  Used by
 *  generators when a field doesn't fit a more specific helper. */
export function PlainValue({ value }: { value: unknown }) {
  if (isEmpty(value)) return <Text component="span" c="dimmed">—</Text>;
  return <Text component="span">{String(value)}</Text>;
}

/** Two-column key/value row for detail cards.  Label sits in a
 *  fixed-width left column, value flows to the right.  Rendered as
 *  a flex row so multi-line values wrap cleanly under the label. */
export function KeyValueRow({
  label,
  children,
  "data-testid": testid,
}: {
  label: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <Group wrap="nowrap" align="flex-start" gap="xs">
      <Text component="span" c="dimmed" fw={500} miw={140}>{label}</Text>
      <Stack gap={2} data-testid={testid} style={{ flex: 1, minWidth: 0 }}>{children}</Stack>
    </Group>
  );
}

/** Render a money value's own digits, faithfully (generated — M-T1.25).
 *
 *  Loom money rides the wire as a fixed-scale decimal STRING ("12.3456") and
 *  is a decimal.js instance in form state; both stringify to the same digits.
 *  The default rendering is VERBATIM and locale-neutral — no Number()
 *  coercion, no locale grouping, no currency symbol, no re-scaling — so what
 *  the database stores is what the screen shows.
 *
 *  @param currency  Optional currency CODE, printed verbatim as a prefix
 *                   ("EUR 12.3456").  Only ever what the page source declared.
 *  @param decimals  Optional exact fraction-digit count; re-scales the digit
 *                   string (half away from zero), never through a float.
 */
export function moneyText(
  value: number | string | { toString(): string },
  currency?: string,
  decimals?: number,
): string {
  const raw = typeof value === "string" ? value : String(value);
  const body = decimals === undefined ? raw : scaleDecimalString(raw, decimals);
  return currency ? currency + " " + body : body;
}

/** Re-scale a decimal STRING to exactly `digits` fraction digits.
 *
 *  Operates on the digits themselves — pad with zeros when widening, and when
 *  narrowing round half AWAY FROM ZERO by incrementing the retained digit
 *  string.  This is the rounding family every Loom backend and Postgres itself
 *  uses, and it keeps all 19 significant digits of NUMERIC(19,4) intact (a
 *  float hop would not).  A value that is not a plain decimal literal, or a
 *  negative `digits`, is returned untouched.
 */
export function scaleDecimalString(raw: string, digits: number): string {
  const m = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(raw.trim());
  const n = Math.trunc(digits);
  if (!m || !Number.isFinite(n) || n < 0) {
    return raw;
  }
  const sign = m[1] === "-" ? "-" : "";
  const frac = m[3] ?? "";
  let intPart = m[2];
  let kept = frac.slice(0, n);
  if (frac.length <= n) {
    kept = frac + "0".repeat(n - frac.length);
  } else if (frac.charCodeAt(n) >= 53 /* '5' */) {
    const bumped = bumpDigits(intPart + kept);
    intPart = bumped.slice(0, bumped.length - n);
    kept = bumped.slice(bumped.length - n);
  }
  intPart = intPart.replace(/^0+(?=\d)/, "");
  return sign + intPart + (n > 0 ? "." + kept : "");
}

/** Add one to a string of decimal digits, carrying left and growing a new
 *  leading digit when the whole string was nines ("999" -> "1000"). */
function bumpDigits(s: string): string {
  const out = s.split("");
  let i = out.length - 1;
  for (; i >= 0; i--) {
    if (out[i] === "9") {
      out[i] = "0";
      continue;
    }
    out[i] = String(Number(out[i]) + 1);
    break;
  }
  if (i < 0) {
    out.unshift("1");
  }
  return out.join("");
}
