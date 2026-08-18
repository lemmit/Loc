// ---------------------------------------------------------------------------
// Feliz store persistence — the `persist: local|session|url` lifetime ladder
// (frontend-state-management.md §3.1), the Feliz sibling of the four JS
// `store-builder.ts` modules.
//
// A Feliz store has no module of its own: it FOLDS into the single Elmish
// `Model` (each field a namespaced Model field, each action a namespaced `Msg`
// case — see `index.ts`).  Persistence therefore rides that fold rather than
// wrapping a store object:
//
//   * `init`   seeds each persisted field from its backing store — the
//              `StorePersist.load<Store><Field> ()` overrides fed to
//              `renderInit`.
//   * `update` is wrapped by `updateWithPersist`, which mirrors the whole
//              Model back after every message (`StorePersist.save`).  Elmish
//              has no per-field subscribe hook, and the write is idempotent, so
//              "after every message" is the honest equivalent of Zustand's
//              `subscribe`.
//   * `url`    additionally re-decodes on `popstate` through a real Elmish
//              subscription (`storeUrlSub` → the `StoreUrlChanged` Msg), which
//              is what makes back/forward navigation move the state.
//
// WIRE COMPATIBILITY.  Keys and shapes match the React / Vue / Svelte / Angular
// builders byte-for-byte, so the same `localStorage` blob and the same URL
// round-trip across frontends:
//
//   local/session → key `loom.store.<Name>`, value a JSON object keyed by the
//                   BARE field name.  `money` serialises as a JSON string (the
//                   JS side holds a `Decimal`, whose `toJSON` is a string);
//                   plain `decimal` as a JSON number.
//   url           → one query param per BARE field name.  A string/id param is
//                   DROPPED when empty, a bool set only when true, a number
//                   always written (`0` is a real value) — exactly
//                   `encodeFieldToParam` in `react/store-builder.ts`.
//
// The JS boundary is crossed with `[<Fable.Core.Emit>]` helpers rather than
// `Fable.Browser.*` bindings, the same way `realtime.ts` reaches `EventSource`
// — no new package reference, and every helper is TOTAL (a `try`/`catch`
// returning `null`), so a disabled/full Web Storage degrades to the declared
// defaults instead of throwing at init.
// ---------------------------------------------------------------------------

import type { StateFieldIR, StoreIR, UiIR } from "../../ir/types/loom-ir.js";
import {
  type FelizPersistCodec,
  type FelizPersistScalar,
  felizPersistCodec,
} from "../../ir/util/feliz-persist-codec.js";
import { lines } from "../../util/code-builder.js";
import { upperFirst } from "../../util/naming.js";
import { renderFsExpr, storeModelField } from "./fs-expr.js";
import { fsZeroValue } from "./type-fs.js";

/** A store whose lifetime asks for persistence AND whose fields have a codec —
 *  the emit unit.  A field WITHOUT one is refused at the validator
 *  (`loom.store-lifetime-target-unsupported`, its `#field` message variant), so
 *  by the time codegen runs the filter below is a total classification rather
 *  than a silent drop. */
export interface FelizPersistedStore {
  store: StoreIR;
  /** `"local" | "session"` (Web Storage) or `"url"` (query string). */
  tier: "local" | "session" | "url";
  fields: { field: StateFieldIR; codec: FelizPersistCodec }[];
}

/** The ui's stores that carry a non-`memory` lifetime and at least one field. */
export function felizPersistedStores(ui: UiIR): FelizPersistedStore[] {
  const out: FelizPersistedStore[] = [];
  for (const store of ui.stores) {
    const tier =
      store.lifetime === "persistLocal"
        ? "local"
        : store.lifetime === "persistSession"
          ? "session"
          : store.lifetime === "url"
            ? "url"
            : undefined;
    if (tier === undefined) continue;
    const fields: FelizPersistedStore["fields"] = [];
    for (const field of store.state) {
      const codec = felizPersistCodec(field.type);
      if (codec) fields.push({ field, codec });
    }
    if (fields.length > 0) out.push({ store, tier, fields });
  }
  return out;
}

/** The Msg case a `url` store's `popstate` subscription dispatches.  One case
 *  for the whole app: every url store re-decodes together (they all read the
 *  same query string, so splitting them would buy nothing). */
export const STORE_URL_MSG = "StoreUrlChanged";

/** `loadCartCount` — the F# loader for one persisted field. */
function loaderName(store: string, field: string): string {
  return `load${upperFirst(store)}${upperFirst(field)}`;
}

/** The Web Storage key — the SAME key the four JS builders write. */
function storageKey(store: StoreIR): string {
  return `loom.store.${store.name}`;
}

/** The F# expression converting a raw `string` (or `null`) named `raw` into the
 *  field's declared type, defaulting on anything unparseable — the F# twin of
 *  `decodeFieldFromParam` in `react/store-builder.ts`. */
function fromRaw(scalar: FelizPersistScalar, dflt: string): string {
  // The numeric arms are PARENTHESISED: a bare nested `match` on the same line
  // as its enclosing arm reads ambiguously (F# would happily attach the inner
  // `| _ ->` to the outer match), and the parens make the nesting explicit.
  switch (scalar) {
    case "int":
      return `(match System.Int32.TryParse raw with | true, v -> v | _ -> ${dflt})`;
    case "bool":
      return `raw = "true"`;
    case "decimal":
    case "money":
      return `(match System.Decimal.TryParse raw with | true, v -> v | _ -> ${dflt})`;
    default:
      return "raw";
  }
}

/** The `string array` → `'T list` conversion in a list loader.  A string list
 *  is the identity (`List.ofArray`); the other two convert per cell. */
function listFromCells(element: "string" | "int" | "bool"): string {
  switch (element) {
    case "int":
      return "cells |> Array.map (fun raw -> match System.Int32.TryParse raw with | true, v -> v | _ -> 0) |> List.ofArray";
    case "bool":
      return 'cells |> Array.map (fun raw -> raw = "true") |> List.ofArray';
    default:
      return "List.ofArray cells";
  }
}

/** The F# expression rendering a Model field back to its JSON fragment. */
function toJson(codec: FelizPersistCodec, access: string): string {
  if (codec.kind === "list") {
    const cell =
      codec.element === "string"
        ? "jsonString x"
        : codec.element === "bool"
          ? '(if x then "true" else "false")'
          : "string x";
    return `"[" + (${access} |> List.map (fun x -> ${cell}) |> String.concat ",") + "]"`;
  }
  switch (codec.scalar) {
    case "int":
    case "decimal":
      // A JSON NUMBER — matches `storeFieldTsType`'s `number` on the JS side.
      return `string ${access}`;
    case "bool":
      return `(if ${access} then "true" else "false")`;
    case "money":
      // A JSON STRING — the JS side holds a `Decimal`, whose `toJSON` is a string.
      return `jsonString (string ${access})`;
    default:
      return `jsonString ${access}`;
  }
}

/** The query-param write for one field — the F# twin of `encodeFieldToParam`.
 *  Emitted as JS inside the per-store `[<Emit>]` writer, with `$<n>` naming the
 *  positional argument this field occupies. */
function urlParamJs(codec: FelizPersistCodec, key: string, arg: string): string {
  // SINGLE-quoted: this JS is embedded in an F# `[<Emit("…")>]` string literal,
  // so a double quote here would terminate it (the same rule `realtime.ts`'s
  // `TOAST_EMIT_JS` states).  Field names are identifiers, so no escaping.
  const k = `'${key}'`;
  if (codec.kind === "list") {
    // Unreachable: `loom.store-url-field-invalid` refuses an array under `url`.
    return `p.delete(${k});`;
  }
  switch (codec.scalar) {
    case "money":
      return `if(${arg}!=null){p.set(${k},String(${arg}));}else{p.delete(${k});}`;
    case "bool":
      return `if(${arg}){p.set(${k},'true');}else{p.delete(${k});}`;
    case "int":
    case "decimal":
      // A number always serialises — `0` is a real value, not "empty".
      return `p.set(${k},String(${arg}));`;
    default:
      // `(${arg})` is PARENTHESISED, not bare: Fable's `Emit` placeholder
      // scanner swallows a `!` immediately following `$n`, so a bare
      // `$0!==''` compiled to `==''` (verified against `dotnet fable` — the
      // emitted JS was a syntax error).  The parens end the placeholder.
      return `if((${arg})!==''){p.set(${k},${arg});}else{p.delete(${k});}`;
  }
}

/** The `[<Emit>]` prelude — every JS-boundary helper, shared by all stores. */
function emitPrelude(needsWeb: boolean, needsUrl: boolean, needsArray: boolean): string[] {
  const out: string[] = [];
  if (needsWeb) {
    out.push(
      "    /// One field out of the `loom.store.<Name>` JSON blob, as a raw string",
      "    /// (`null` when absent / unparseable) — total, so a disabled Web Storage",
      "    /// degrades to the declared defaults instead of throwing at init.",
      `    [<Fable.Core.Emit("(function(){try{var r=($0==='session'?sessionStorage:localStorage).getItem($1);if(r==null)return null;var v=JSON.parse(r)[$2];if(v==null)return null;return typeof v==='string'?v:JSON.stringify(v);}catch(e){return null;}})()")>]`,
      "    let private webField (backing: string) (key: string) (field: string) : string = jsNative",
      "",
      `    [<Fable.Core.Emit("(function(){try{($0==='session'?sessionStorage:localStorage).setItem($1,$2);}catch(e){}})()")>]`,
      "    let private webWrite (backing: string) (key: string) (json: string) : unit = jsNative",
      "",
    );
  }
  if (needsWeb && needsArray) {
    out.push(
      "    /// An ARRAY field out of the blob, flattened to raw strings (`null` when",
      "    /// absent or not an array) — the element conversion happens in F#.",
      `    [<Fable.Core.Emit("(function(){try{var r=($0==='session'?sessionStorage:localStorage).getItem($1);if(r==null)return null;var v=JSON.parse(r)[$2];return Array.isArray(v)?v.map(String):null;}catch(e){return null;}})()")>]`,
      "    let private webFieldArray (backing: string) (key: string) (field: string) : string array = jsNative",
      "",
    );
  }
  if (needsUrl) {
    out.push(
      "    /// One query param, raw (`null` when absent).",
      `    [<Fable.Core.Emit("(function(){try{return new URLSearchParams(window.location.search).get($0);}catch(e){return null;}})()")>]`,
      "    let private urlParam (name: string) : string = jsNative",
      "",
    );
  }
  out.push(
    "    /// `JSON.stringify` over a string — quoting + escaping, so the blob this",
    "    /// module builds is the same JSON `JSON.stringify(store)` produces.",
    `    [<Fable.Core.Emit("JSON.stringify($0)")>]`,
    "    let private jsonString (s: string) : string = jsNative",
    "",
  );
  return out;
}

/** The F# expression a persisted field falls back to when its backing store
 *  holds nothing (or junk) — the field's own declared `= <init>`, else the
 *  type's zero.  The SAME expression `renderInit` would have emitted, so
 *  turning `memory` into `local` never changes the first-run value. */
function fieldDefault(field: StateFieldIR): string {
  if (!field.init) return fsZeroValue(field.type);
  const rendered = renderFsExpr(field.init, { stateNames: new Set(), locals: new Set() });
  // A numeric literal seeding a `decimal`/`money` cell needs the `m` suffix —
  // Fable rejects the implicit `int → decimal` conversion (`decimalLit` in
  // `update-emit.ts` states the same rule for the non-persisted path).
  const isDecimal =
    field.type.kind === "primitive" &&
    (field.type.name === "decimal" || field.type.name === "money");
  return isDecimal && /^-?\d+(\.\d+)?$/.test(rendered) ? `${rendered}m` : rendered;
}

/** One store's loaders (`load<Store><Field> ()`) — the `init` seed. */
function loaders(p: FelizPersistedStore): string[] {
  const out: string[] = [];
  const key = JSON.stringify(storageKey(p.store));
  for (const { field, codec } of p.fields) {
    const fn = loaderName(p.store.name, field.name);
    const dflt = fieldDefault(field);
    const fieldKey = JSON.stringify(field.name);
    // `isNull` rather than a `| null ->` match arm: Fable lowers the null
    // PATTERN to `=== defaultOf()`, which pins the comparison to exactly `null`,
    // while `isNull` lowers to `== null` and so also catches the `undefined` a
    // missing JSON key can produce.
    if (codec.kind === "list") {
      out.push(
        `    let ${fn} () =`,
        `      let cells = webFieldArray "${p.tier}" ${key} ${fieldKey}`,
        `      if isNull cells then ${dflt} else ${listFromCells(codec.element)}`,
        "",
      );
      continue;
    }
    const read =
      p.tier === "url" ? `urlParam ${fieldKey}` : `webField "${p.tier}" ${key} ${fieldKey}`;
    out.push(
      `    let ${fn} () =`,
      `      let raw = ${read}`,
      `      if isNull raw then ${dflt} else ${fromRaw(codec.scalar, dflt)}`,
      "",
    );
  }
  return out;
}

/** One store's writer — the Web Storage blob, or the query-string mirror. */
function writer(p: FelizPersistedStore): string[] {
  const fn = `save${upperFirst(p.store.name)}`;
  if (p.tier === "url") {
    // The whole store writes in ONE `[<Emit>]` call: `URLSearchParams` has to be
    // read, mutated and serialised as a unit, and the arg list is known here.
    const params = p.fields
      .map(({ field, codec }, i) => urlParamJs(codec, field.name, `$${i}`))
      .join("");
    const js =
      "(function(){try{var p=new URLSearchParams(window.location.search);" +
      params +
      "var qs=p.toString();window.history.replaceState(null,'',qs?('?'+qs):window.location.pathname);}catch(e){}})()";
    // `<field>Arg`, not the bare field name: a DSL field may be spelled with an
    // F# KEYWORD (`type`, `end`, `to`, `done`), which would not bind as a
    // parameter.  The `[<Emit>]` body addresses arguments positionally (`$n`),
    // so the name is for the reader only.
    const sig = p.fields.map(({ field }) => `(${field.name}Arg: ${felizArgType(field)})`).join(" ");
    const args = p.fields
      .map(({ field }) => `model.${storeModelField(p.store.name, field.name)}`)
      .join(" ");
    return [
      `    [<Fable.Core.Emit("${js}")>]`,
      `    let private ${fn}Raw ${sig} : unit = jsNative`,
      "",
      `    let private ${fn} (model: Model) : unit = ${fn}Raw ${args}`,
      "",
    ];
  }
  // One `"<field>":<value>` fragment per field, joined with `,` inside `{ }` —
  // the same object `JSON.stringify(store)` produces on the JS side.  The key
  // is double-encoded on purpose: the inner `JSON.stringify` makes the JSON
  // key, the outer one makes the F# string literal carrying it.
  const parts = p.fields.map(
    ({ field, codec }) =>
      `${JSON.stringify(`${JSON.stringify(field.name)}:`)} + ${toJson(
        codec,
        `model.${storeModelField(p.store.name, field.name)}`,
      )}`,
  );
  return [
    `    let private ${fn} (model: Model) : unit =`,
    `      let json =`,
    `        "{" + String.concat "," [ ${parts.join("; ")} ] + "}"`,
    `      webWrite "${p.tier}" ${JSON.stringify(storageKey(p.store))} json`,
    "",
  ];
}

/** The F# argument type of a url-writer parameter (the Model field's type). */
function felizArgType(field: StateFieldIR): string {
  const codec = felizPersistCodec(field.type);
  if (!codec) return "string";
  if (codec.kind === "list") return "string list";
  switch (codec.scalar) {
    case "int":
      return "int";
    case "bool":
      return "bool";
    case "decimal":
    case "money":
      return "decimal";
    default:
      return "string";
  }
}

/** The whole `StorePersist` module — spliced into `App.fs` between `Model`
 *  (which `save` takes) and `Msg`/`init` (which call into it). */
export function renderStorePersistModule(stores: readonly FelizPersistedStore[]): string[] {
  if (stores.length === 0) return [];
  const needsWeb = stores.some((p) => p.tier !== "url");
  const needsUrl = stores.some((p) => p.tier === "url");
  const needsArray = stores.some((p) => p.fields.some(({ codec }) => codec.kind === "list"));
  const body = [
    ...emitPrelude(needsWeb, needsUrl, needsArray),
    ...stores.flatMap((p) => [...loaders(p), ...writer(p)]),
    "    /// Mirror every persisted store back after a message.  Idempotent, so",
    "    /// running it on every update is equivalent to Zustand's `subscribe`.",
    "    let save (model: Model) : unit =",
    ...stores.map((p) => `      save${upperFirst(p.store.name)} model`),
  ];
  return [
    "",
    "// Store persistence (`persist:` — frontend-state-management.md §3.1).  Stores",
    "// fold into the single Elmish Model, so the lifetime ladder rides the fold:",
    "// `init` seeds each field from its backing store and `updateWithPersist`",
    "// mirrors the Model back after every message.  The keys (`loom.store.<Name>`)",
    "// and the query-param shape match the React / Vue / Svelte / Angular store",
    "// builders, so the same blob and the same URL round-trip across frontends.",
    "module StorePersist =",
    body.join("\n"),
  ];
}

/** Model-field name → the `init` expression that seeds it from storage.  Fed to
 *  `renderInit`, which uses it INSTEAD of the field's declared initializer. */
export function storePersistInitOverrides(
  stores: readonly FelizPersistedStore[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of stores) {
    for (const { field } of p.fields) {
      out.set(
        storeModelField(p.store.name, field.name),
        `StorePersist.${loaderName(p.store.name, field.name)} ()`,
      );
    }
  }
  return out;
}

/** The `StoreUrlChanged` update arm — re-seed every url-store field from the
 *  query string (the back/forward half of the `url` tier). */
export function storeUrlUpdateArm(stores: readonly FelizPersistedStore[]): string | undefined {
  const url = stores.filter((p) => p.tier === "url");
  if (url.length === 0) return undefined;
  const assigns = url
    .flatMap((p) =>
      p.fields.map(
        ({ field }) =>
          `${storeModelField(p.store.name, field.name)} = StorePersist.${loaderName(
            p.store.name,
            field.name,
          )} ()`,
      ),
    )
    .join("; ");
  return `  | ${STORE_URL_MSG} -> { model with ${assigns} }, Cmd.none`;
}

/** The `popstate` subscription for the `url` tier — spliced after `update` (it
 *  dispatches a `Msg`).  Emitted only when a url store exists. */
export function renderStoreUrlSub(stores: readonly FelizPersistedStore[]): string | undefined {
  if (!stores.some((p) => p.tier === "url")) return undefined;
  return lines(
    "// URL → store: re-decode the query string on back/forward (and on a manual",
    "// address edit).  A real Elmish subscription rather than a bare listener, so",
    "// the handler is removed when the program stops.",
    `[<Fable.Core.Emit("window.addEventListener('popstate', $0)")>]`,
    "let private addPopStateListener (handler: unit -> unit) : unit = jsNative",
    "",
    `[<Fable.Core.Emit("window.removeEventListener('popstate', $0)")>]`,
    "let private removePopStateListener (handler: unit -> unit) : unit = jsNative",
    "",
    "let private storeUrlSub (_: Model) : Sub<Msg> =",
    "  let start (dispatch: Msg -> unit) : System.IDisposable =",
    `    let handler = fun () -> dispatch ${STORE_URL_MSG}`,
    "    addPopStateListener handler",
    "    { new System.IDisposable with member _.Dispose() = removePopStateListener handler }",
    '  [ [ "store-url" ], start ]',
  );
}

/** The `update` wrapper `Program` runs instead of `update` — mirrors the Model
 *  back to every persisted store after each message. */
export function renderUpdateWithPersist(): string {
  return lines(
    "// store → storage: mirror the Model back after every message.  Elmish has no",
    "// per-field subscribe hook, and the write is idempotent, so this is the",
    "// honest equivalent of the JS frontends' store `subscribe`.",
    "let updateWithPersist (msg: Msg) (model: Model) =",
    "  let next, cmd = update msg model",
    "  StorePersist.save next",
    "  next, cmd",
  );
}
