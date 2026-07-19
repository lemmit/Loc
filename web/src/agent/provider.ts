// ---------------------------------------------------------------------------
// BYOK provider config for the live agent chat (M-T8.3).  The playground never
// ships an API key — the user brings their own ("BYOK") and it lives ONLY in
// this browser's localStorage, sent straight to the provider they picked and
// nowhere else.
//
// Genericity by design: every preset here speaks the OpenAI `/chat/completions`
// wire shape (see `openai-transport.ts`), so ONE adapter reaches OpenRouter,
// OpenAI, Groq, Together, a local llama.cpp / Ollama, or any other compatible
// endpoint — and adding a provider is a preset, not code.  A future
// non-OpenAI-shaped backend (an Anthropic-native transport, a server proxy)
// slots in as a second `Complete` implementation behind the same seam; the
// `kind` field is the discriminator that will route to it.
// ---------------------------------------------------------------------------

/** How a provider is reached — the transport implementation to route through.
 *  Only `openai` ships today; `proxy` (a Loom-hosted relay, no BYOK key) and
 *  `anthropic` (native Messages API) are the reserved future seams. */
export type ProviderKind = "openai" | "proxy" | "anthropic";

/** A selectable provider — a base URL + a suggested default model.  All
 *  current presets are OpenAI-`/chat/completions`-compatible (`kind: "openai"`);
 *  `baseUrl` is the API root WITHOUT the trailing `/chat/completions`. */
export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  /** API root, e.g. `https://openrouter.ai/api/v1`.  Empty for `custom` — the
   *  user fills it in. */
  baseUrl: string;
  /** A sensible starting model id; always editable (model catalogs churn). */
  defaultModel: string;
  /** Whether an API key is required (BYOK).  A local llama.cpp needs none. */
  needsKey: boolean;
  /** One-line hint shown under the key field (where to get a key). */
  hint?: string;
}

/** The built-in provider menu.  OpenRouter leads — one key, the widest model
 *  catalog, and the most generic reach.  Every entry is OpenAI-compatible; the
 *  user can always pick "Custom" and point at any other compatible endpoint. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4",
    needsKey: true,
    hint: "Get a key at openrouter.ai/keys — one key, most models.",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    needsKey: true,
    hint: "Get a key at platform.openai.com/api-keys.",
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    needsKey: true,
    hint: "Get a key at console.groq.com/keys.",
  },
  {
    id: "local",
    label: "Local (llama.cpp / Ollama)",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    needsKey: false,
    hint: "Point at any local OpenAI-compatible server (no key needed).",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    kind: "openai",
    baseUrl: "",
    defaultModel: "",
    needsKey: true,
    hint: "Any endpoint speaking POST /chat/completions.",
  },
];

/** Look a preset up by id (falls back to OpenRouter — the first entry). */
export function presetById(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[0];
}

/** The persisted, resolved BYOK configuration.  `providerId` names the preset;
 *  `baseUrl`/`model` are the (possibly user-overridden) effective values, so a
 *  "Custom" provider is fully self-describing. */
export interface AgentSettings {
  providerId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** The starting config — OpenRouter, no key yet. */
export function defaultAgentSettings(): AgentSettings {
  const p = PROVIDER_PRESETS[0];
  return { providerId: p.id, baseUrl: p.baseUrl, model: p.defaultModel, apiKey: "" };
}

const STORAGE_KEY = "loom.agent.settings";

/** True once the settings name a provider that can actually be called — a
 *  base URL, a model, and (unless the provider is keyless) a key. */
export function settingsReady(s: AgentSettings): boolean {
  const preset = presetById(s.providerId);
  if (!s.baseUrl.trim() || !s.model.trim()) return false;
  return preset.needsKey ? s.apiKey.trim().length > 0 : true;
}

/** Load the saved BYOK settings from localStorage, or defaults.  Never throws
 *  (a corrupt/absent store falls back to defaults) and is browser-safe (returns
 *  defaults when there's no `localStorage`, e.g. under SSR or a test). */
export function loadAgentSettings(): AgentSettings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return defaultAgentSettings();
    const parsed = JSON.parse(raw) as Partial<AgentSettings>;
    const base = defaultAgentSettings();
    return {
      providerId: typeof parsed.providerId === "string" ? parsed.providerId : base.providerId,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : base.baseUrl,
      model: typeof parsed.model === "string" ? parsed.model : base.model,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : base.apiKey,
    };
  } catch {
    return defaultAgentSettings();
  }
}

/** Persist the BYOK settings.  No-op (swallowed) when there's no localStorage. */
export function saveAgentSettings(s: AgentSettings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // storage full / disabled — the in-memory settings still work this session.
  }
}
