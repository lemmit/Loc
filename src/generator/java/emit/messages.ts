// ---------------------------------------------------------------------------
// The Java backend's validation-message catalog (M-T1.11).
//
// Java is one of the two backends whose ECOSYSTEM already owns this problem, so
// the emitter does not hand-roll a lookup: the catalog is a real
// `ResourceBundle` (`src/main/resources/messages.properties`), Spring Boot's
// `MessageSourceAutoConfiguration` picks it up off the classpath by its default
// `messages` basename, and `ApiExceptionAdvice` resolves each field error with
// `MessageSource.getMessage(FieldError, locale)`.
//
// That last call is why the Java leg is the cheapest of the five.  A `FieldError`
// IS a `MessageSourceResolvable`: Spring tries the error's codes in order and
// falls back to `getDefaultMessage()` when none resolves — which is exactly the
// contract the wire validators already emit (`rejectValue(field, code,
// message)`, where `code` is the `msg.<hash>` i18n key and `message` the
// authored English).  So a translated bundle wins, an untranslated one silently
// yields the authored text, and the message-less sentinel code (`loom.invariant`)
// resolves to nothing and keeps its default — no branching needed anywhere.
//
// ADDING A LOCALE means a `messages_<locale>.properties` sibling; `ddd i18n
// sync` owns the per-locale source at the SYSTEM level and codegen bakes it in.
// Today only the source language ships, so every request resolves to the
// authored English — the seam is in place with byte-identical wire VALUES.
// ---------------------------------------------------------------------------

import { lines } from "../../../util/code-builder.js";
import type { ValidationMessage } from "../../_i18n/validation-catalog.js";

/** Path of the emitted source-language bundle inside the Gradle project. */
export const JAVA_MESSAGES_BUNDLE_PATH = "src/main/resources/messages.properties";

/** Escape a value for a `.properties` line.  Spring Boot reads message bundles
 *  as UTF-8 (`spring.messages.encoding`, UTF-8 by default), so non-ASCII text
 *  needs no `\\uXXXX` escaping — only the characters `.properties` itself gives
 *  meaning to: a backslash, and a newline that would end the entry.
 *
 *  A leading `=` / `:` / whitespace in the VALUE is harmless (only the KEY side
 *  treats them as separators), and the keys here are `msg.<hash>` — hex-ish and
 *  separator-free by construction. */
function propertiesValue(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

/** `src/main/resources/messages.properties` — the source-language bundle
 *  `MessageSource` resolves each messaged rule's wire `code` against. */
export function renderJavaMessagesBundle(messages: readonly ValidationMessage[]): string {
  return lines(
    "# Validation-message catalog (Loom i18n).",
    "#",
    "# Keys are the stable content-hash codes the wire validators attach to a",
    "# messaged invariant / check / precondition (errors[].code), identical to the",
    "# keys in the system's .loom/messages.en.json and on every other backend.",
    "#",
    "# Spring Boot auto-configures a MessageSource over this bundle (the default",
    "# `messages` basename); ApiExceptionAdvice resolves each FieldError through it",
    "# and falls back to the authored text below when a locale has no entry.  Add a",
    "# locale by adding a messages_<locale>.properties sibling.",
    ...messages.map((m) => `${m.code}=${propertiesValue(m.text)}`),
  );
}
