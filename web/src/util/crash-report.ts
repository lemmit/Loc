// ---------------------------------------------------------------------------
// Crash report assembly — the pure half of "the clipboard is the transport".
//
// The playground is a static GitHub Pages site: there is no backend to beacon
// to, and M-T8.14 slice 4 (an opt-in anonymous beacon) is deliberately
// deferred.  So the report is INERT DATA the user copies: this module turns
// the `loom.diag` breadcrumb ring into a deterministic markdown artifact, and
// builds a prefilled GitHub issue-form URL from it.  Nothing here sends
// anything anywhere.
//
// Redaction is normative (M-T8.14 "Privacy / redaction rules"):
//
//   1. NEVER include `.ddd` or generated source text.  The workspace appears
//      only as a fingerprint: path, byte length, truncated SHA-256.
//   2. NEVER read browser storage.  This module takes an explicit ALLOWLIST
//      of inputs and performs no ambient read whatsoever — which is what
//      structurally guarantees the BYOK provider key (held under the agent
//      settings entry, see `agent/provider.ts`) cannot leak into a report.
//      A unit test pins that this file neither names that entry nor touches
//      storage at all.
//   3. Credential SHAPES are scrubbed from every free-text field before
//      assembly, and query/hash are stripped from every URL — the share hash
//      encodes the whole model.
//   4. The UA string is kept (browser/OS triage).  No IP, cookie, or
//      fingerprint.
//
// Deliberately react-free and DOM-free: the root vitest suite runs without
// `web/node_modules`, so anything unit-tested has to be importable there
// (same convention as `web/src/builder/live-source-tick.ts`).
// ---------------------------------------------------------------------------

import type { BuildInfo } from "./build-info.js";
import { formatBuild } from "./build-info.js";
import { isCrashReason, type DiagSnapshot } from "./diagnostics.js";

/** One workspace file, as a shape — never as content. */
export interface WorkspaceFingerprintEntry {
  path: string;
  bytes: number;
  /** First 12 hex chars of the SHA-256 of the content. */
  sha: string;
}

/** The complete allowlist of things a report may contain.  Anything not on
 *  this record cannot reach a report — there is no ambient read. */
export interface CrashReportInput {
  /** The `loom.diag` ring, oldest-first (as stored). */
  snapshots: DiagSnapshot[];
  build: BuildInfo;
  ua?: string;
  viewport?: { w: number; h: number };
  /** Page URL; query + hash are stripped during assembly. */
  url?: string;
  workspace?: WorkspaceFingerprintEntry[];
  /** ISO timestamp for the "generated" row.  Explicit so reports are
   *  byte-deterministic under test. */
  generatedAt?: string;
  /** Cap on rendered snapshots (newest kept).  Default: all. */
  maxSnapshots?: number;
  /** Cap on stack frames per crash.  Default {@link DEFAULT_STACK_FRAMES}. */
  maxStackFrames?: number;
}

/** Full-fidelity budget — the clipboard artifact. */
export const DEFAULT_STACK_FRAMES = 30;
/** URL-constrained budget (see {@link crashIssueUrl}). */
export const URL_SNAPSHOTS = 4;
export const URL_STACK_FRAMES = 15;

/** Encoded-URL ceiling.  Browsers and GitHub both tolerate more than this,
 *  but ~8k is the practical floor across the stack, so we budget under it. */
export const ISSUE_URL_BUDGET = 6000;

export const TRUNCATION_NOTE = "_(truncated — full report on the clipboard)_";

/** The issue form the URL prefills.  Issue FORMS ignore `?body=`; the prefill
 *  has to name the form's field id, which is `report`. */
export const ISSUE_REPO = "lemmit/Loc";
export const ISSUE_TEMPLATE = "crash-report.yml";
export const ISSUE_LABEL = "crash-report";

// --- redaction -------------------------------------------------------------

/** Drop query + hash from a URL-ish string.  The playground encodes the whole
 *  model into the location hash, so a bare `location.href` is source text. */
export function stripUrl(url: string): string {
  const noHash = url.split("#")[0] ?? url;
  return noHash.split("?")[0] ?? noHash;
}

const URL_RE = /\bhttps?:\/\/[^\s"'`<>)\]]+/g;

const REDACTED = "[redacted]";

// Ordered: the URL pass runs first (so `?token=…` dies with the query), then
// bare credential shapes anywhere in free text.
const CREDENTIAL_PATTERNS: { re: RegExp; to: string }[] = [
  // OpenAI / Anthropic / OpenRouter style — covers `sk-`, `sk-ant-`, `sk-or-`.
  { re: /\bsk-[A-Za-z0-9_-]{6,}/g, to: REDACTED },
  // GitHub tokens (classic PAT, OAuth, user-to-server, server, refresh) + fine-grained.
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, to: REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, to: REDACTED },
  // AWS access key id.
  { re: /\bAKIA[0-9A-Z]{12,}/g, to: REDACTED },
  // Slack.
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, to: REDACTED },
  // JWT (three base64url segments) — bearer payloads often land in messages.
  {
    re: /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
    to: REDACTED,
  },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi, to: `Bearer ${REDACTED}` },
  // `key=…` / `token: …` / `apiKey="…"` in any free text.
  {
    re: /\b(api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|secret|password|passwd|pwd|authorization)(\s*[=:]\s*)["']?[^\s"'&,;)}\]]{3,}/gi,
    to: `$1$2${REDACTED}`,
  },
];

/** Scrub credential shapes and URL query/hash out of free text.  Total and
 *  idempotent — safe to apply to anything before it enters a report. */
export function redact(text: string): string {
  let out = text.replace(URL_RE, (m) => stripUrl(m));
  for (const { re, to } of CREDENTIAL_PATTERNS) {
    // Fresh lastIndex each call — the patterns are module-level /g literals.
    re.lastIndex = 0;
    out = out.replace(re, to);
  }
  return out;
}

// --- workspace fingerprint -------------------------------------------------

/** Hash workspace files into shape-only entries.  Async because it uses
 *  WebCrypto; the report builder itself stays sync and pure. */
export async function fingerprintFiles(
  files: ReadonlyArray<{ path: string; content: string }>,
): Promise<WorkspaceFingerprintEntry[]> {
  const out: WorkspaceFingerprintEntry[] = [];
  for (const f of files) {
    const bytes = new TextEncoder().encode(f.content);
    let sha = "";
    try {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      sha = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 12);
    } catch {
      // No WebCrypto (insecure context): the shape alone is still useful.
      sha = "unavailable";
    }
    out.push({ path: f.path, bytes: bytes.length, sha });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// --- assembly --------------------------------------------------------------

function fence(body: string): string[] {
  return ["```", body, "```"];
}

function firstLines(text: string, max: number): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return `${lines.slice(0, max).join("\n")}\n  … ${lines.length - max} more frame(s) truncated`;
}

function pressureLine(s: DiagSnapshot): string {
  const parts: string[] = [];
  if (s.mem) parts.push(`heap ${s.mem.usedMB}/${s.mem.limitMB} MB`);
  if (s.storage) {
    parts.push(`storage ${s.storage.usageMB}/${s.storage.quotaMB} MB (${s.storage.pct}%)`);
  }
  parts.push(`hash ${s.hashLen}b`);
  return parts.join(" · ");
}

/** Assemble the report.  Pure, deterministic, total — the same input always
 *  produces byte-identical output. */
export function buildCrashReport(input: CrashReportInput): string {
  const stackFrames = input.maxStackFrames ?? DEFAULT_STACK_FRAMES;
  const ordered = [...input.snapshots].reverse(); // newest-first
  const capped =
    input.maxSnapshots != null ? ordered.slice(0, input.maxSnapshots) : ordered;
  const dropped = ordered.length - capped.length;

  const crashes = capped.filter((s) => isCrashReason(s.reason));
  const breadcrumbs = capped.filter((s) => !isCrashReason(s.reason));

  const out: string[] = [];
  out.push("### Loom playground crash report");
  out.push("");
  out.push("| field | value |");
  out.push("| --- | --- |");
  out.push(`| build | \`${formatBuild(input.build)}\` |`);
  if (input.generatedAt) out.push(`| generated | \`${input.generatedAt}\` |`);
  if (input.url) out.push(`| url | \`${redact(stripUrl(input.url))}\` |`);
  if (input.viewport) {
    out.push(`| viewport | \`${input.viewport.w}×${input.viewport.h}\` |`);
  }
  if (input.ua) out.push(`| browser | \`${redact(input.ua)}\` |`);
  out.push(`| ring | ${input.snapshots.length} snapshot(s), ${crashes.length} error(s) |`);
  out.push("");

  out.push("#### Crashes (newest first)");
  out.push("");
  if (crashes.length === 0) {
    out.push("_No error-class entries in the ring._");
    out.push("");
  }
  crashes.forEach((s, i) => {
    out.push(`##### ${i + 1}. \`${s.reason}\` — ${s.t}`);
    const d = s.detail;
    if (d?.pane) out.push(`- pane: \`${redact(d.pane)}\``);
    if (s.build && s.build.sha !== input.build.sha) {
      out.push(`- captured on build: \`${formatBuild(s.build)}\``);
    }
    out.push(`- message: ${d?.message ? `\`${redact(d.message)}\`` : "_(none captured)_"}`);
    out.push(`- pressure: ${pressureLine(s)}`);
    out.push("");
    if (d?.stack) {
      out.push("stack:");
      out.push(...fence(redact(firstLines(d.stack, stackFrames))));
      out.push("");
    }
    if (d?.componentStack) {
      out.push("component stack:");
      out.push(...fence(redact(firstLines(d.componentStack, stackFrames))));
      out.push("");
    }
  });

  out.push("#### Breadcrumbs");
  out.push("");
  if (breadcrumbs.length === 0) {
    out.push("_None._");
  } else {
    for (const s of breadcrumbs) {
      out.push(`- \`${s.t}\` \`${s.reason}\` — ${pressureLine(s)}`);
    }
  }
  out.push("");

  if (input.workspace && input.workspace.length > 0) {
    out.push("#### Workspace fingerprint");
    out.push("");
    out.push("| file | bytes | sha256 |");
    out.push("| --- | --- | --- |");
    for (const f of input.workspace) {
      out.push(`| \`${redact(stripUrl(f.path))}\` | ${f.bytes} | \`${f.sha}\` |`);
    }
    out.push("");
  }

  if (dropped > 0) {
    out.push(`${TRUNCATION_NOTE} — ${dropped} older snapshot(s) omitted.`);
    out.push("");
  }

  out.push(
    "_Contains no `.ddd` or generated source text, no credentials and no API keys — files appear as path + length + hash only._",
  );
  return `${out.join("\n")}\n`;
}

// --- the GitHub exit -------------------------------------------------------

function issueUrlFor(report: string, repo: string): string {
  const params = new URLSearchParams({
    template: ISSUE_TEMPLATE,
    labels: ISSUE_LABEL,
    report,
  });
  return `https://github.com/${repo}/issues/new?${params.toString()}`;
}

/** A prefilled GitHub issue-form URL, shrunk until it fits the budget.
 *
 *  Shrink order (cheapest signal lost first): the URL variant starts at 4
 *  snapshots / 15 stack frames, then sheds the OLDEST snapshots, then hard-
 *  truncates the tail.  `buildCrashReport` (unbounded) stays the clipboard
 *  artifact, so nothing is lost — only the prefill is abridged. */
export function crashIssueUrl(
  input: CrashReportInput,
  repo: string = ISSUE_REPO,
  budget: number = ISSUE_URL_BUDGET,
): string {
  for (let snaps = URL_SNAPSHOTS; snaps >= 1; snaps--) {
    const report = buildCrashReport({
      ...input,
      maxSnapshots: Math.min(snaps, input.snapshots.length || 1),
      maxStackFrames: URL_STACK_FRAMES,
    });
    const url = issueUrlFor(report, repo);
    if (url.length <= budget) return url;
  }
  // Even one snapshot overflows (a pathological stack): keep the head of the
  // report and say so.  The clipboard copy is still complete.
  const full = buildCrashReport({
    ...input,
    maxSnapshots: 1,
    maxStackFrames: URL_STACK_FRAMES,
  });
  const overhead = issueUrlFor("", repo).length;
  // encodeURIComponent can triple a character, so shrink by characters until
  // the encoded URL fits rather than guessing a ratio.
  let keep = Math.max(0, Math.floor((budget - overhead) / 3));
  let url = issueUrlFor(`${full.slice(0, keep)}\n\n${TRUNCATION_NOTE}\n`, repo);
  while (url.length > budget && keep > 0) {
    keep = Math.floor(keep * 0.8);
    url = issueUrlFor(`${full.slice(0, keep)}\n\n${TRUNCATION_NOTE}\n`, repo);
  }
  return url;
}
