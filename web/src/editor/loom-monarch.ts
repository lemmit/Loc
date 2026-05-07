import type { languages } from "monaco-editor";

// Monarch tokenizer for Loom DDD.  Loom's full grammar lives in
// `src/language/ddd.langium`; this is a coarse approximation just
// good enough to colour the editor.  Semantic correctness is owned
// by the LSP worker — Monarch only paints.
//
// Keep keyword lists in sync with `ddd.langium`.  When you add a
// keyword to the grammar, mirror it here or it'll render plain.
export const loomLanguageId = "loom-ddd";

export const loomLanguage: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".loom",

  keywords: [
    "system",
    "module",
    "context",
    "aggregate",
    "entity",
    "valueobject",
    "enum",
    "event",
    "repository",
    "deployable",
    "function",
    "operation",
    "derived",
    "invariant",
    "precondition",
    "contains",
    "find",
    "for",
    "against",
    "test",
    "e2e",
    "ui",
    "platform",
    "modules",
    "targets",
    "port",
    "auth",
    "required",
    "view",
    "workflow",
    "extern",
    "emit",
    "new",
    "let",
    "if",
    "else",
    "when",
    "where",
    "return",
    "true",
    "false",
    "null",
    "this",
    "now",
    "expect",
    "user",
    "claim",
    "requires",
  ],

  typeKeywords: [
    "int",
    "long",
    "decimal",
    "string",
    "bool",
    "guid",
    "datetime",
    "Id",
  ],

  operators: [
    ":=",
    "+=",
    "-=",
    "==",
    "!=",
    "<=",
    ">=",
    "&&",
    "||",
    "=>",
    "=",
    "<",
    ">",
    "+",
    "-",
    "*",
    "/",
    "!",
    ".",
    "?",
  ],

  symbols: /[=><!~?:&|+\-*/^%.]+/,

  tokenizer: {
    root: [
      [/[A-Z][A-Za-z0-9_]*/, { cases: { "@typeKeywords": "type", "@default": "type.identifier" } }],
      [
        /[a-z_$][\w$]*/,
        {
          cases: {
            "@keywords": "keyword",
            "@typeKeywords": "type",
            "@default": "identifier",
          },
        },
      ],
      { include: "@whitespace" },
      [/[{}()[\]]/, "@brackets"],
      [/[<>](?!@symbols)/, "@brackets"],
      [
        /@symbols/,
        { cases: { "@operators": "operator", "@default": "" } },
      ],
      [/\d+\.\d+([eE][-+]?\d+)?/, "number.float"],
      [/\d+/, "number"],
      [/[;,]/, "delimiter"],
      [/"([^"\\]|\\.)*$/, "string.invalid"],
      [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
    ],

    whitespace: [
      [/[ \t\r\n]+/, ""],
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@blockComment"],
    ],

    blockComment: [
      [/[^/*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[/*]/, "comment"],
    ],

    string: [
      [/[^\\"]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
    ],
  },
};

export const loomLanguageConfig: languages.LanguageConfiguration = {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
    ["<", ">"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
};
