// OIDC provider presets (D-AUTH-OIDC).
//
// `auth { provider: <name> }` names one of these; lowering resolves it
// into the concrete `OidcConfigIR` endpoints so backends never special-
// case a provider name — they always consume an `issuer` (+ scopes).
// Hosted IdPs with a fixed issuer carry it here; self-hosted / per-tenant
// IdPs (`keycloak`, `auth0`, `okta`, …) set `requiresIssuer` and get their
// `issuer` from the model's `oidc { issuer: … }` block.  `custom` is the
// no-preset escape hatch (raw `oidc { … }`).  An explicit `oidc { … }`
// field always overrides the preset.
//
// Lives in `src/util/` because both the validator (language layer) and
// the lowerer (ir layer) consume it; neither may import "upward".

export interface OidcPreset {
  /** Fixed issuer URL, or `""` when the model must supply one. */
  issuer: string;
  /** Default scopes, used unless the model's `oidc { scopes: … }`
   *  overrides. */
  scopes: string[];
  /** True for self-hosted / per-tenant IdPs whose issuer is not
   *  knowable ahead of time — the model must declare `oidc { issuer }`. */
  requiresIssuer: boolean;
}

const STD_SCOPES = ["openid", "email", "profile"];

/** The shipped provider presets.  `github` is intentionally absent — it
 *  is OAuth2, not OIDC (no `id_token` / JWKS), and is deferred. */
export const OIDC_PRESETS: Readonly<Record<string, OidcPreset>> = {
  google: {
    issuer: "https://accounts.google.com",
    scopes: STD_SCOPES,
    requiresIssuer: false,
  },
  microsoft: {
    issuer: "https://login.microsoftonline.com/common/v2.0",
    scopes: STD_SCOPES,
    requiresIssuer: false,
  },
  entra: {
    issuer: "https://login.microsoftonline.com/common/v2.0",
    scopes: STD_SCOPES,
    requiresIssuer: false,
  },
  auth0: { issuer: "", scopes: STD_SCOPES, requiresIssuer: true },
  okta: { issuer: "", scopes: STD_SCOPES, requiresIssuer: true },
  zitadel: { issuer: "", scopes: STD_SCOPES, requiresIssuer: true },
  cognito: { issuer: "", scopes: STD_SCOPES, requiresIssuer: true },
  keycloak: { issuer: "", scopes: STD_SCOPES, requiresIssuer: true },
  custom: { issuer: "", scopes: STD_SCOPES, requiresIssuer: true },
};

/** Provider names admissible after `provider:`. */
export const KNOWN_PROVIDERS: readonly string[] = Object.keys(OIDC_PRESETS);

export function isKnownProvider(name: string): boolean {
  return Object.hasOwn(OIDC_PRESETS, name);
}

export function lookupPreset(name: string): OidcPreset | undefined {
  return OIDC_PRESETS[name];
}
