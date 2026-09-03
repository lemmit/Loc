import { describe, expect, it } from "vitest";
import {
  isKnownProvider,
  KNOWN_PROVIDERS,
  lookupPreset,
  OIDC_PRESETS,
  type OidcPreset,
} from "../../src/util/auth-providers.js";

// `src/util/auth-providers.ts` is the one table both halves of the auth pipeline
// read: the language validator (`validators/auth.ts`) uses `isKnownProvider` /
// `KNOWN_PROVIDERS` to accept-or-reject a `provider:` bareword and to require an
// `oidc { issuer }` where the preset has none, and IR lowering
// (`lower/lower-auth.ts`) uses `lookupPreset` to materialise the issuer +
// scopes.  The property that matters is that those three exports describe the
// SAME set: a provider the validator accepts must resolve to a preset at
// lowering, and a preset with no issuer must be exactly one the validator
// demands an `oidc { issuer }` for.

/** Every preset that ships without a fixed issuer — the self-hosted /
 *  per-tenant IdPs the model must supply an `oidc { issuer }` for. */
const DOCUMENTED_SELF_HOSTED = ["auth0", "okta", "zitadel", "cognito", "keycloak", "custom"];

/** Every preset with a fixed, publicly-known issuer. */
const DOCUMENTED_HOSTED = ["google", "microsoft", "entra"];

describe("auth providers — KNOWN_PROVIDERS is the table's key set", () => {
  it("is exactly the keys of OIDC_PRESETS", () => {
    expect([...KNOWN_PROVIDERS].sort()).toEqual(Object.keys(OIDC_PRESETS).sort());
  });

  it("is the documented hosted + self-hosted split, and nothing else", () => {
    expect([...KNOWN_PROVIDERS].sort()).toEqual(
      [...DOCUMENTED_HOSTED, ...DOCUMENTED_SELF_HOSTED].sort(),
    );
  });

  it("has no duplicates", () => {
    expect([...new Set(KNOWN_PROVIDERS)]).toHaveLength(KNOWN_PROVIDERS.length);
  });

  it("does NOT ship `github` — it is OAuth2, not OIDC (no id_token / JWKS)", () => {
    expect(isKnownProvider("github")).toBe(false);
    expect(KNOWN_PROVIDERS).not.toContain("github");
  });
});

describe("auth providers — lookupPreset resolves exactly the known providers", () => {
  it("returns a preset for every KNOWN_PROVIDERS entry, and isKnownProvider agrees", () => {
    for (const name of KNOWN_PROVIDERS) {
      expect(isKnownProvider(name)).toBe(true);
      const preset = lookupPreset(name);
      expect(preset).toBeDefined();
      expect(preset).toBe(OIDC_PRESETS[name]); // same record, not a copy
    }
  });

  it("returns undefined for names outside the table, and isKnownProvider agrees", () => {
    for (const name of ["github", "gitlab", "Google", "keycloak ", "", "oidc"]) {
      expect(isKnownProvider(name)).toBe(false);
      expect(lookupPreset(name)).toBeUndefined();
    }
  });

  it("is case-sensitive (the grammar's `provider:` bareword is matched verbatim)", () => {
    expect(isKnownProvider("Keycloak")).toBe(false);
    expect(lookupPreset("KEYCLOAK")).toBeUndefined();
  });
});

describe("auth providers — every preset is well-formed", () => {
  it("carries a string issuer, a non-empty scopes list, and a boolean requiresIssuer", () => {
    for (const name of KNOWN_PROVIDERS) {
      const preset = lookupPreset(name) as OidcPreset;
      expect(typeof preset.issuer).toBe("string");
      expect(Array.isArray(preset.scopes)).toBe(true);
      expect(preset.scopes.length).toBeGreaterThan(0);
      expect(typeof preset.requiresIssuer).toBe("boolean");
    }
  });

  it("every preset requests the OIDC-mandatory `openid` scope", () => {
    for (const name of KNOWN_PROVIDERS) {
      expect(lookupPreset(name)!.scopes).toContain("openid");
    }
  });

  it("a fixed issuer is an absolute https URL", () => {
    for (const name of KNOWN_PROVIDERS) {
      const { issuer } = lookupPreset(name)!;
      if (issuer === "") continue;
      expect(issuer).toMatch(/^https:\/\//);
      expect(issuer.endsWith("/")).toBe(false); // issuers are compared verbatim
    }
  });
});

describe("auth providers — issuer-less presets are exactly the ones needing `oidc { issuer }`", () => {
  it('`requiresIssuer` ⟺ `issuer === ""` (the validator\'s demand and the table agree)', () => {
    for (const name of KNOWN_PROVIDERS) {
      const preset = lookupPreset(name)!;
      expect(preset.requiresIssuer).toBe(preset.issuer === "");
    }
  });

  it("the issuer-less set is the documented self-hosted / per-tenant list", () => {
    const issuerless = KNOWN_PROVIDERS.filter((n) => lookupPreset(n)!.issuer === "").sort();
    expect(issuerless).toEqual([...DOCUMENTED_SELF_HOSTED].sort());
  });

  it("the hosted presets carry a real issuer and never demand one from the model", () => {
    for (const name of DOCUMENTED_HOSTED) {
      const preset = lookupPreset(name)!;
      expect(preset.issuer).not.toBe("");
      expect(preset.requiresIssuer).toBe(false);
    }
  });

  it("`microsoft` and `entra` are aliases of the same Entra ID issuer", () => {
    expect(lookupPreset("entra")!.issuer).toBe(lookupPreset("microsoft")!.issuer);
  });

  it("`custom` is the no-preset escape hatch: no issuer, model supplies everything", () => {
    expect(lookupPreset("custom")).toMatchObject({ issuer: "", requiresIssuer: true });
  });
});

describe("auth providers — inherited-key handling (defect, see below)", () => {
  // DEFECT (handed off, not fixed here — this packet is test-only).
  //
  //   src/util/auth-providers.ts:61-63
  //     export function lookupPreset(name: string): OidcPreset | undefined {
  //       return OIDC_PRESETS[name];
  //     }
  //
  // `OIDC_PRESETS` is a plain object literal, so a bare index reaches
  // `Object.prototype`: `lookupPreset("constructor")` returns the `Object`
  // CONSTRUCTOR typed as `OidcPreset`, and `lookupPreset("__proto__")` returns
  // `Object.prototype` — while `isKnownProvider` (src/util/auth-providers.ts:57-59,
  // `Object.hasOwn`) correctly says `false`.  The two exports therefore disagree
  // for inherited keys.
  //
  // Reachable: `provider=ID` (src/language/ddd.langium:168) admits any
  // identifier, and `lowerAuth` (src/ir/lower/lower-auth.ts:21) calls
  // `lookupPreset(node.provider)` with NO `isKnownProvider` guard — lowering
  // still runs on the validator's error path.  Impact today is contained
  // (`preset?.issuer` / `preset?.scopes` are `undefined` on `Object`, so it
  // degrades to the no-preset behaviour) but it is one field name away from
  // materialising a prototype value into an `OidcConfigIR`.
  //
  // PROPOSED PATCH (src/util/auth-providers.ts):
  //     export function lookupPreset(name: string): OidcPreset | undefined {
  //       return Object.hasOwn(OIDC_PRESETS, name) ? OIDC_PRESETS[name] : undefined;
  //     }
  //   — one line, makes `lookupPreset` and `isKnownProvider` agree by
  //   construction.  Flip this `it.fails` to `it` when it lands.
  it.fails("lookupPreset returns undefined for inherited Object.prototype keys", () => {
    for (const name of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      expect(isKnownProvider(name)).toBe(false);
      expect(lookupPreset(name)).toBeUndefined();
    }
  });

  it("isKnownProvider itself is already prototype-safe (Object.hasOwn)", () => {
    for (const name of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      expect(isKnownProvider(name)).toBe(false);
    }
  });
});
