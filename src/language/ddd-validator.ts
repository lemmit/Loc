import { type AstNode, AstUtils, type ValidationAcceptor, type ValidationChecks } from "langium";
import {
  BUILTIN_PACK_LATEST,
  builtinVersionsForFamily,
  packFormatForBuiltin,
  parseBuiltinDesignRef,
} from "../generator/_packs/builtin-formats.js";
import {
  backendVersionsForFamily,
  isRegisteredBackendRef,
  parseBuiltinPlatformRef,
  platformFor,
} from "../platform/registry.js";
import type { DddServices } from "./ddd-module.js";
import {
  type Aggregate,
  type AssignOrCallStmt,
  type Containment,
  type DddAstType,
  type DerivedProp,
  type EmitStmt,
  type EntityPart,
  type FunctionDecl,
  type Invariant,
  isAggregate,
  isAssignOrCallStmt,
  isContainment,
  isDerivedProp,
  isEmitStmt,
  isEntityPart,
  isFunctionDecl,
  isInvariant,
  isLetStmt,
  isOperation,
  isPreconditionStmt,
  isPrimitiveType,
  isProperty,
  isRequiresStmt,
  isValueObject,
  type Operation,
  type Property,
  type Statement,
  type ValueObject,
} from "./generated/ast.js";
import {
  type DddType,
  type Env,
  findFunction,
  findOperation,
  isAssignable,
  lookupRootMember,
  makeEnv,
  paramType,
  resolveTypeRef,
  stepInto,
  T,
  typeOf,
  typeToString,
} from "./type-system.js";

export class DddValidator {
  // Entry: full model walk
  check(model: import("./generated/ast.js").Model, accept: ValidationAcceptor): void {
    // Slice 21.C — validate every `string.matches(regex)` call's
    // argument is a string literal that compiles as a RegExp.
    // Walks the entire AST so the rule applies in invariants,
    // preconditions, derived bodies, function bodies, and guards
    // alike — anywhere the operator can appear.
    this.checkMatchesCalls(model, accept);
    // Slice 3 — match expressions: warn on a missing `else` arm.
    // Type-checking arm conditions is best-effort here (the lowering's
    // type system is the source of truth); structural checks run
    // unconditionally.
    this.checkMatchExpressions(model, accept);
    // Slice A6 — `import helper <name> from "..."` declarations.
    // Reject names that shadow walker stdlib primitives so a typo
    // never silently overrides Stack / Form / etc.  Also flag
    // duplicate helper names within the same UI.
    this.checkUiHelperImports(model, accept);
    // Slice 12 — traceability artifacts.  The grammar admits a
    // permissive requirement prop-bag and any code cross-reference;
    // semantic constraints (allowed keys / enum values / required
    // props / parent acyclicity) are enforced here.
    this.checkTraceability(model, accept);
    for (const m of model.members) {
      if (m.$type === "BoundedContext") {
        this.checkContext(m, accept);
      } else if (m.$type === "System") {
        const deployables = m.members.filter((sm) => sm.$type === "Deployable");
        const themeBlocks = m.members.filter(
          (sm) => sm.$type === "ThemeBlock",
        ) as import("./generated/ast.js").ThemeBlock[];
        if (themeBlocks.length > 1) {
          for (const tb of themeBlocks.slice(1)) {
            accept(
              "error",
              `system '${m.name}' declares more than one 'theme { ... }' block; keep just the first.`,
              { node: tb },
            );
          }
        }
        for (const tb of themeBlocks) this.checkTheme(tb, accept);
        // Slice 3 — page metamodel.  Collect ui blocks first so per-
        // ui checks can see siblings (name uniqueness across uis), and
        // so per-deployable checks can cross-reference the system's
        // ui inventory.
        const uis = m.members.filter(
          (sm) => sm.$type === "Ui",
        ) as import("./generated/ast.js").Ui[];
        const uiNamesSeen = new Map<string, import("./generated/ast.js").Ui>();
        for (const ui of uis) {
          const prior = uiNamesSeen.get(ui.name);
          if (prior) {
            // Rule 1: UI name uniqueness within a system.  Flag the
            // duplicates (not the first declaration).
            accept(
              "error",
              `Duplicate ui block '${ui.name}'; ui names must be unique within a system.`,
              { node: ui, property: "name" },
            );
          } else {
            uiNamesSeen.set(ui.name, ui);
          }
        }

        // Slice 11.25 — Api declaration checks.
        //   - Names unique within the system (`api SalesApi from …` declared twice).
        //   - Source module cross-ref must resolve.
        const apis = m.members.filter(
          (sm) => sm.$type === "Api",
        ) as import("./generated/ast.js").Api[];
        const apiNamesSeen = new Map<string, import("./generated/ast.js").Api>();
        for (const api of apis) {
          const prior = apiNamesSeen.get(api.name);
          if (prior) {
            accept(
              "error",
              `Duplicate api '${api.name}'; api names must be unique within a system.`,
              { node: api, property: "name" },
            );
          } else {
            apiNamesSeen.set(api.name, api);
          }
          if (!api.source?.ref) {
            accept(
              "error",
              `api '${api.name}' references undeclared module '${api.source?.$refText ?? "<missing>"}'.  Declare a 'module ${api.source?.$refText ?? "<Name>"} { … }' at system scope first.`,
              { node: api, property: "source" },
            );
          }
        }

        // Slice 11.27 — Storage declaration checks.
        //   - Names unique within the system.
        //   - Type is one of the v0 enum values (parser ensures shape;
        //     this is a structural sanity-check + future hook for
        //     cross-platform constraints).
        const storages = m.members.filter(
          (sm) => sm.$type === "Storage",
        ) as import("./generated/ast.js").Storage[];
        const storageNamesSeen = new Map<string, import("./generated/ast.js").Storage>();
        for (const s of storages) {
          const prior = storageNamesSeen.get(s.name);
          if (prior) {
            accept(
              "error",
              `Duplicate storage '${s.name}'; storage names must be unique within a system.`,
              { node: s, property: "name" },
            );
          } else {
            storageNamesSeen.set(s.name, s);
          }
        }

        for (const sm of m.members) {
          if (sm.$type === "Module") {
            for (const ctx of sm.contexts) this.checkContext(ctx, accept);
          } else if (sm.$type === "BoundedContext") {
            this.checkContext(sm, accept);
          } else if (sm.$type === "Deployable") {
            this.checkDeployable(
              sm as import("./generated/ast.js").Deployable,
              deployables as import("./generated/ast.js").Deployable[],
              accept,
            );
          } else if (sm.$type === "Ui") {
            this.checkUi(
              sm as import("./generated/ast.js").Ui,
              m as import("./generated/ast.js").System,
              accept,
            );
          }
        }
      }
    }
  }

  /** Validate `requirement` traceability artifacts: the `type`,
   *  `title`, `status` and `priority` keys, and that each declared
   *  `type`/`status` is one of the known enum values. */
  private checkTraceability(
    model: import("./generated/ast.js").Model,
    accept: ValidationAcceptor,
  ): void {
    const ALLOWED_KEYS = new Set(["type", "title", "status", "priority"]);
    const TYPES = new Set(["UserStory", "UseCase", "AcceptanceCriteria", "BusinessReq"]);
    const STATUSES = new Set(["Draft", "Approved", "InProgress", "Done"]);

    const requirements = model.members.filter(
      (m): m is import("./generated/ast.js").Requirement => m.$type === "Requirement",
    );

    for (const req of requirements) {
      const seen = new Set<string>();
      let hasType = false;
      let hasTitle = false;
      for (const p of req.props) {
        if (!ALLOWED_KEYS.has(p.name)) {
          accept(
            "error",
            `Unknown requirement property '${p.name}'; expected one of type, title, status, priority.`,
            { node: p, property: "name" },
          );
          continue;
        }
        if (seen.has(p.name)) {
          accept("error", `Duplicate requirement property '${p.name}'.`, {
            node: p,
            property: "name",
          });
        }
        seen.add(p.name);

        const v = p.value;
        if (p.name === "type") {
          hasType = true;
          const name = v?.$type === "NameRef" ? (v as { name: string }).name : undefined;
          if (!name || !TYPES.has(name)) {
            accept(
              "error",
              `requirement type must be one of UserStory, UseCase, AcceptanceCriteria, BusinessReq.`,
              { node: p, property: "value" },
            );
          }
        } else if (p.name === "status") {
          const name = v?.$type === "NameRef" ? (v as { name: string }).name : undefined;
          if (!name || !STATUSES.has(name)) {
            accept(
              "error",
              `requirement status must be one of Draft, Approved, InProgress, Done.`,
              { node: p, property: "value" },
            );
          }
        } else if (p.name === "title") {
          hasTitle = true;
          if (v?.$type !== "StringLit") {
            accept("error", `requirement title must be a string literal.`, {
              node: p,
              property: "value",
            });
          }
        } else if (p.name === "priority") {
          if (v?.$type !== "IntLit") {
            accept("error", `requirement priority must be an integer.`, {
              node: p,
              property: "value",
            });
          }
        }
      }
      if (!hasType) {
        accept("error", `requirement '${req.name}' is missing the required 'type' property.`, {
          node: req,
          property: "name",
        });
      }
      if (!hasTitle) {
        accept("error", `requirement '${req.name}' is missing the required 'title' property.`, {
          node: req,
          property: "name",
        });
      }
    }

    // Parent acyclicity — walk the parent chain from each requirement
    // and flag the first node that re-enters a requirement already on
    // its own path.
    for (const req of requirements) {
      const path = new Set<string>([req.name]);
      let cur = req.parent?.ref;
      while (cur) {
        if (path.has(cur.name)) {
          accept("error", `requirement '${req.name}' has a cyclic parent chain.`, {
            node: req,
            property: "parent",
          });
          break;
        }
        path.add(cur.name);
        cur = cur.parent?.ref;
      }
    }
  }

  /** Slice A6 — `import helper <name> from "<path>"` at the UI
   *  level.  Validate two invariants:
   *   1. Helper names don't shadow any walker stdlib primitive
   *      (else a typo would silently divert a body call like
   *      `Stack(...)` from the primitive to the helper).
   *   2. No duplicate helper names within the same UI.
   *
   *  The stdlib set is duplicated here from `body-walker.ts`
   *  intentionally — the validator runs before generation and
   *  the cross-module import would inflate the language-server
   *  bundle. */
  private checkUiHelperImports(
    model: import("./generated/ast.js").Model,
    accept: ValidationAcceptor,
  ): void {
    const STDLIB_PRIMITIVES = new Set<string>([
      "Stack",
      "Group",
      "Grid",
      "Container",
      "Tabs",
      "Tab",
      "Toolbar",
      "Empty",
      "Field",
      "NumberField",
      "PasswordField",
      "Toggle",
      "Loader",
      "Anchor",
      "Image",
      "Avatar",
      "Slot",
      "Heading",
      "Text",
      "Button",
      "Card",
      "Stat",
      "Badge",
      "Divider",
      "Table",
      "Column",
      "Money",
      "DateDisplay",
      "EnumBadge",
      "IdLink",
      "Form",
      // Scaffold-archetype call names also reserved (List / Detail
      // dispatch via inferBodyDispatch).
      "List",
      "Detail",
      "Home",
      "WorkflowsIndex",
      "ViewsIndex",
    ]);
    for (const member of model.members) {
      if (member.$type !== "System") continue;
      const sys = member as import("./generated/ast.js").System;
      const uis = sys.members.filter(
        (sm) => sm.$type === "Ui",
      ) as import("./generated/ast.js").Ui[];
      for (const ui of uis) {
        const seen = new Map<string, import("./generated/ast.js").UiHelperImport>();
        for (const um of ui.members) {
          if (um.$type !== "UiHelperImport") continue;
          const h = um as import("./generated/ast.js").UiHelperImport;
          if (STDLIB_PRIMITIVES.has(h.name)) {
            accept(
              "error",
              `Helper '${h.name}' shadows the walker stdlib primitive '${h.name}'. Rename the helper.`,
              { node: h, property: "name" },
            );
          }
          const prior = seen.get(h.name);
          if (prior) {
            accept("error", `Duplicate helper import '${h.name}' in ui '${ui.name}'.`, {
              node: h,
              property: "name",
            });
          } else {
            seen.set(h.name, h);
          }
        }
      }
    }
  }

  private checkTheme(
    block: import("./generated/ast.js").ThemeBlock,
    accept: ValidationAcceptor,
  ): void {
    const knownNames = new Set(["primary", "neutral", "radius", "fontFamily"]);
    const knownRadius = new Set(["none", "sm", "md", "lg", "xl"]);
    // Hex colors: #RGB, #RRGGBB, or #RRGGBBAA.  Everything else
    // ("blue" / "rgb(...)" / "var(--brand)") routes through a future
    // slice if a user asks; rejecting here keeps the surface tight
    // and the Mantine shade-ramp generator simple.
    const hexColor = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
    const seen = new Set<string>();
    for (const p of block.props) {
      // (1) Unknown property name.
      if (!knownNames.has(p.name)) {
        accept(
          "error",
          `unknown theme property '${p.name}'. Known properties: ${[...knownNames].join(", ")}.`,
          { node: p, property: "name" },
        );
        continue;
      }
      // (2) Duplicate property name.
      if (seen.has(p.name)) {
        accept("error", `theme property '${p.name}' declared more than once.`, {
          node: p,
          property: "name",
        });
        continue;
      }
      seen.add(p.name);
      // (3) Per-property value validation.
      if (p.name === "primary" || p.name === "neutral") {
        if (!hexColor.test(p.value)) {
          accept(
            "error",
            `theme '${p.name}' must be a CSS hex color (#RGB, #RRGGBB, or #RRGGBBAA); got '${p.value}'.`,
            { node: p, property: "value" },
          );
        }
      } else if (p.name === "radius") {
        if (!knownRadius.has(p.value)) {
          accept(
            "error",
            `theme 'radius' must be one of ${[...knownRadius].join(" | ")}; got '${p.value}'.`,
            { node: p, property: "value" },
          );
        }
      }
      // fontFamily is a free-form string — pass-through to the
      // Mantine theme.  No validation beyond "non-empty"; a typo'd
      // family name silently falls through to the OS fallback at
      // runtime, which is acceptable.
    }
  }

  private checkDeployable(
    d: import("./generated/ast.js").Deployable,
    siblings: import("./generated/ast.js").Deployable[],
    accept: ValidationAcceptor,
  ): void {
    // Slice 3 — page-metamodel UI binding rules (3, 4).
    // Rule 3: only platforms that mount a UI admit `ui:` — `react`,
    //         `static`, and `phoenixLiveView` (fullstack Ash + Phoenix).
    // Rule 4: every `static` deployable must declare `ui:` (otherwise
    //         it has nothing to serve).
    this.checkDeployablePlatform(d, accept);
    const hasUiBinding = !!(d.uiSugar || d.uiCompose || d.uiBlock);
    if (hasUiBinding && !platformMountsUi(d.platform)) {
      accept(
        "error",
        `'ui:' binding is only valid on platforms that mount a UI ('react', 'static', 'phoenixLiveView', 'dotnet'); got '${d.platform}'.`,
        {
          node: d,
          property: d.uiSugar ? "uiSugar" : d.uiCompose ? "uiCompose" : "uiBlock",
        },
      );
    }
    if (d.platform === "static" && !hasUiBinding) {
      accept(
        "error",
        `Static deployable '${d.name}' must declare a 'ui:' binding — there is nothing to serve without one.`,
        { node: d, property: "name" },
      );
    }
    // Rule 13: framework values must match the deployable's platform.
    // `react`/`static` mount the `react` framework; `phoenixLiveView`
    // mounts the `phoenixLiveView` framework.  The grammar enum admits
    // both values; this rule rejects cross-pairing
    // (e.g. `platform: react` + `framework: phoenixLiveView`).
    const framework = d.uiBlock?.framework;
    if (framework && d.uiBlock) {
      const expected = expectedFrameworkFor(d.platform, hasUiBinding);
      if (expected && framework !== expected) {
        accept(
          "error",
          `Framework '${framework}' does not match platform '${d.platform}' (expected '${expected}'). Drop the framework override or align it with the platform.`,
          {
            node: d.uiBlock,
            property: "framework",
            code: "loom.framework-mismatch",
            data: { expected },
          },
        );
      }
    }

    // Rule 14: design-pack format must match the framework the deployable
    // renders against.  TSX packs (mantine/shadcn/mui/chakra) need a
    // `react` framework; HEEx packs (ashPhoenix) need `phoenixLiveView`.
    // Without this rule, a mismatched pair (e.g. `platform: react,
    // design: ashPhoenix`) lowers cleanly and explodes at generation
    // time with a confusing "template not registered" error.  Custom
    // packs (any name not in BUILTIN_PACK_FORMATS) get a warning
    // instead — the validator can't read their `pack.json` to know the
    // format, but a typo should still surface loudly.
    this.checkDeployableDesignPack(d, hasUiBinding, framework, accept);

    // Existing rules — react/static both behave like frontends.
    if (d.platform === "react" || d.platform === "static") {
      const target = d.targets?.ref;
      if (!target) {
        accept(
          "error",
          `Frontend deployable '${d.name}' must declare 'targets: <backend-deployable>'.`,
          { node: d, property: "name" },
        );
        return;
      }
      if (target.platform === "react" || target.platform === "static") {
        accept(
          "error",
          `Frontend deployable '${d.name}' cannot target another frontend ('${target.name}'). Pick a 'dotnet' or 'hono' deployable.`,
          { node: d, property: "targets" },
        );
      }
      if ((d.moduleBindings ?? []).length > 0) {
        accept(
          "warning",
          `Frontend deployable '${d.name}' inherits modules from its target '${target.name}'; the explicit 'modules:' list is ignored.`,
          { node: d, property: "moduleBindings" },
        );
      }
      void siblings;
    } else {
      if (d.targets) {
        accept(
          "error",
          `'targets:' is only valid on a 'platform: react' or 'platform: static' deployable.`,
          { node: d, property: "targets" },
        );
      }
    }

    // Slice 11.26 — explicit api composition checks.
    this.checkDeployableServes(d, accept);
    this.checkDeployableUiCompose(d, accept);
    this.checkDeployableModuleStorages(d, accept);
  }

  /** Rule 14 — design-pack format must match the deployable's
   *  framework.  Three cases:
   *    1. `design:` set to a built-in name (mantine/shadcn/mui/chakra/
   *       ashPhoenix) whose format doesn't match the deployable's
   *       framework → error.  Suggests the valid built-ins for the
   *       framework's format so the fix is one rename away.
   *    2. `design:` set to a custom path (anything not in the
   *       built-in map) → warning.  The validator is sync + IO-free,
   *       so it can't read the custom pack's `pack.json` to check the
   *       format; the warning surfaces the unchecked surface so a
   *       typo still gets attention.
   *    3. `design:` set on a deployable with no UI mount and on a
   *       platform that doesn't render UI either → warning that the
   *       value is dropped at lowering and has no effect. */
  /** Backend-packages B1 — validate the `platform:` value now that
   *  the grammar admits an arbitrary STRING (for `family@version`
   *  pins).  Mirrors `checkDeployableDesignPack`'s version error:
   *
   *    - backend bareword (`hono`) / frontend keyword
   *      (`react`/`static`) → always fine.
   *    - backend pin (`"hono@v4"`) → the version must be a
   *      registered surface, else error listing the available pins.
   *    - anything else (`"frobnicator"`, a typo'd quoted platform)
   *      → unknown-platform error (the grammar enum used to reject
   *      these; the STRING alternative no longer does). */
  private checkDeployablePlatform(
    d: import("./generated/ast.js").Deployable,
    accept: ValidationAcceptor,
  ): void {
    const raw = d.platform;
    if (raw == null) return;
    const parsed = parseBuiltinPlatformRef(raw);
    if (parsed == null) {
      // Not a backend family — only the frontend keywords remain
      // valid.  (Bareword `react`/`static` and their quoted forms.)
      if (raw !== "react" && raw !== "static") {
        accept(
          "error",
          `Unknown platform '${raw}' on deployable '${d.name}'. Valid: 'dotnet', 'hono', 'react', 'static', 'phoenixLiveView' (backends also accept a pinned form, e.g. 'hono@v4').`,
          { node: d, property: "platform" },
        );
      }
      return;
    }
    // Backend.  A pin (`@version` in the source) must resolve to a
    // registered surface; a bareword always resolves (latest).
    const isPinned = raw.includes("@");
    if (isPinned && !isRegisteredBackendRef(parsed.qualified)) {
      const available = backendVersionsForFamily(parsed.family);
      accept(
        "error",
        `Platform '${raw}' on deployable '${d.name}' — no version '${parsed.version}' of backend '${parsed.family}'. Available: ${available.map((v) => `'${parsed.family}@${v}'`).join(", ")}.`,
        { node: d, property: "platform" },
      );
    }
  }

  private checkDeployableDesignPack(
    d: import("./generated/ast.js").Deployable,
    hasUiBinding: boolean,
    explicitFramework: string | undefined,
    accept: ValidationAcceptor,
  ): void {
    if (d.design == null) return;
    // Case 3 — design set on a non-UI deployable.  Lowering at
    // ir/lower.ts:481 silently drops `design` for non-react/static/
    // phoenixLiveView platforms, so a hono+design or dotnet+design
    // (no `ui:`) combination silently does nothing today.  Warn
    // before the silent drop costs the user a debugging session.
    if (!hasUiBinding && !platformMountsUi(d.platform)) {
      accept(
        "warning",
        `Design pack '${d.design}' set on deployable '${d.name}' (platform '${d.platform}' has no UI mount) — value is ignored at generation.`,
        { node: d, property: "design" },
      );
      return;
    }
    const framework = explicitFramework ?? expectedFrameworkFor(d.platform, hasUiBinding);
    const expectedFormat = expectedPackFormatFor(framework);
    // Phase 0 of pack-versioning: parse the slot value into
    // {family, version, qualified}.  Bareword (`mantine`) and pinned
    // (`mantine@v7`) forms both produce a parsed ref pointing at a
    // built-in family; custom paths (`./design/foo`) parse to null and
    // fall through to Case 2.  Distinguishing "known family, unknown
    // version" from "custom path" lets us emit a distinctive error
    // listing available versions instead of a generic warning.
    const parsedRef = parseBuiltinDesignRef(d.design);
    if (parsedRef == null) {
      // Case 2 — custom pack path.  Skip the strict check but warn
      // loudly so a misspelt built-in name (or a custom pack that
      // ships the wrong format) doesn't slip through silently.
      accept(
        "warning",
        `Custom design pack '${d.design}' on deployable '${d.name}' — format compatibility with framework '${framework ?? "(none)"}' is not checked at parse time; ensure its pack.json declares format '${expectedFormat ?? "tsx"}'.`,
        { node: d, property: "design" },
      );
      return;
    }
    const actualFormat = packFormatForBuiltin(d.design);
    if (actualFormat == null) {
      // Case 1b — built-in family known but the pinned version isn't
      // registered (e.g. user wrote `design: "mantine@v999"`).  List
      // the available versions so the fix is a one-character edit.
      const available = builtinVersionsForFamily(parsedRef.family);
      accept(
        "error",
        `Design pack '${d.design}' on deployable '${d.name}' — no version '${parsedRef.version}' of pack family '${parsedRef.family}'. Available: ${available.map((v) => `'${parsedRef.family}@${v}'`).join(", ")}.`,
        { node: d, property: "design" },
      );
      return;
    }
    // Case 1a — built-in pack version exists but its format doesn't
    // match the deployable's framework.
    if (expectedFormat && actualFormat !== expectedFormat) {
      accept(
        "error",
        `Design pack '${d.design}' is a ${actualFormat} pack but framework '${framework}' renders ${expectedFormat}. Use one of: ${builtinPackNamesForFormat(expectedFormat)}.`,
        { node: d, property: "design" },
      );
    }
  }

  /** Slice 11.27 — `modules: <M> { primary: <Storage>, ... }`
   *  per-module storage map validations.
   *    - Each storage ref must resolve.
   *    - No duplicate role within one module's brace block.
   *    - Brace blocks only valid on backend platforms (frontends
   *      don't persist anything; the storage map there is a smell).
   *    - Each module must have AT LEAST a `primary:` storage when
   *      its aggregates persist.  v0 relaxation: only enforce
   *      `primary:` when the brace block is non-empty (so existing
   *      bare `modules: Sales` deployables keep working).  Bare
   *      list still defaults to "no explicit storage; use generator
   *      defaults". */
  private checkDeployableModuleStorages(
    d: import("./generated/ast.js").Deployable,
    accept: ValidationAcceptor,
  ): void {
    const isBackend = platformOwnsBackend(d.platform);
    for (const mb of d.moduleBindings ?? []) {
      const block = mb.storages ?? [];
      if (block.length === 0) continue; // bare-list form
      if (!isBackend) {
        accept(
          "error",
          `'modules: <M> { ... }' storage block is only valid on a backend deployable (got platform '${d.platform}').`,
          { node: mb, property: "name" },
        );
        continue;
      }
      const seenRoles = new Set<string>();
      let hasPrimary = false;
      for (const sb of block) {
        const role = sb.role;
        if (seenRoles.has(role)) {
          accept(
            "error",
            `Module '${mb.name?.$refText}' on deployable '${d.name}' binds role '${role}' more than once.`,
            { node: sb, property: "role" },
          );
        } else {
          seenRoles.add(role);
        }
        if (role === "primary") hasPrimary = true;
        if (!sb.storage?.ref) {
          accept(
            "error",
            `Module '${mb.name?.$refText}' on deployable '${d.name}' references undeclared storage '${sb.storage?.$refText ?? "<missing>"}' for role '${role}'.`,
            { node: sb, property: "storage" },
          );
        }
      }
      if (!hasPrimary) {
        accept(
          "error",
          `Module '${mb.name?.$refText}' on deployable '${d.name}' must include a 'primary: <storage>' binding (transactional persistence).`,
          { node: mb, property: "name" },
        );
      }
    }
  }

  /** Slice 11.26 — `serves:` validations.
   *    - Only valid on platforms that own a backend (dotnet, hono,
   *      phoenixLiveView).  Frontend-only platforms (react, static)
   *      have no api surface to serve.
   *    - Each api ref must resolve.
   *    - No duplicate api names within one deployable's serves list. */
  private checkDeployableServes(
    d: import("./generated/ast.js").Deployable,
    accept: ValidationAcceptor,
  ): void {
    if (!d.serves || d.serves.length === 0) return;
    if (!platformOwnsBackend(d.platform)) {
      accept(
        "error",
        `'serves:' is only valid on a backend deployable (dotnet, hono, phoenixLiveView).  Got platform '${d.platform}'.`,
        { node: d, property: "serves" },
      );
      return;
    }
    const seen = new Set<string>();
    for (const ref of d.serves) {
      const name = ref?.$refText ?? "";
      if (!ref?.ref) {
        accept(
          "error",
          `Deployable '${d.name}' serves undeclared api '${name}'.  Declare 'api ${name} from <Module>' at system scope.`,
          { node: d, property: "serves" },
        );
        continue;
      }
      if (seen.has(name)) {
        accept(
          "error",
          `Deployable '${d.name}' lists api '${name}' more than once in its 'serves:' list.`,
          { node: d, property: "serves" },
        );
      } else {
        seen.add(name);
      }
    }
  }

  /** Slice 11.26 — `ui: WebApp { Sales: salesApi, ... }` compose-block
   *  validations.  Each binding maps a UI api parameter (declared as
   *  `api Sales: SalesApi` in the ui block) to a backend deployable
   *  that supplies its contract.  The rule applies to any deployable
   *  that mounts a UI (`platformMountsUi`) — split frontends (react /
   *  static) AND fullstack backends (phoenixLiveView, fullstack dotnet);
   *  in the fullstack case the deployable can be both source and
   *  target of its own bindings (it serves the api it consumes).
   *    - Each binding's `name` must match a UiApiParam in the ui.
   *    - Each binding's `source` must resolve AND `serves:` the
   *      param's declared api.
   *    - No duplicate param bindings.
   *    - Every UI api param must have a matching binding (no
   *      param left unbound). */
  private checkDeployableUiCompose(
    d: import("./generated/ast.js").Deployable,
    accept: ValidationAcceptor,
  ): void {
    const ui = d.uiSugar?.ref?.ref ?? d.uiCompose?.ref?.ref ?? d.uiBlock?.ref?.ref;
    if (!ui) return;

    // Collect declared UI api params (param name → required api name).
    const requiredParams = new Map<string, string>();
    for (const m of ui.members) {
      if (m.$type !== "UiApiParam") continue;
      const apiName = m.apiRef?.$refText ?? "";
      if (apiName) requiredParams.set(m.name, apiName);
    }

    if (requiredParams.size === 0) {
      // UI has no api params — extra ui-compose bindings are pointless.
      const bindings = d.uiCompose?.bindings ?? [];
      for (const b of bindings) {
        accept(
          "error",
          `Deployable '${d.name}' binds parameter '${b.name}' on ui '${ui.name}' but the ui declares no 'api ${b.name}: <Api>' parameter.`,
          { node: b, property: "name" },
        );
      }
      return;
    }

    // UI has api params → must use the compose-block form.
    if (!d.uiCompose) {
      const paramList = [...requiredParams.entries()]
        .map(([n, a]) => `${n}: <backend serving ${a}>`)
        .join(", ");
      accept(
        "error",
        `Deployable '${d.name}' deploys ui '${ui.name}' which declares api parameters; supply bindings via 'ui: ${ui.name} { ${paramList} }'.`,
        { node: d, property: "name" },
      );
      return;
    }

    const bindings = d.uiCompose.bindings ?? [];
    const seenNames = new Set<string>();
    const boundNames = new Set<string>();
    for (const b of bindings) {
      const paramName = b.name;
      const sourceName = b.source?.$refText ?? "";
      if (seenNames.has(paramName)) {
        accept(
          "error",
          `Deployable '${d.name}' binds ui parameter '${paramName}' more than once.`,
          { node: b, property: "name" },
        );
        continue;
      }
      seenNames.add(paramName);

      const requiredApi = requiredParams.get(paramName);
      if (!requiredApi) {
        accept(
          "error",
          `Deployable '${d.name}' binds parameter '${paramName}' on ui '${ui.name}' but the ui declares no 'api ${paramName}: <Api>' parameter.`,
          { node: b, property: "name" },
        );
        continue;
      }
      boundNames.add(paramName);

      if (!b.source?.ref) {
        accept(
          "error",
          `Deployable '${d.name}' references undeclared source deployable '${sourceName}' in 'ui: ${ui.name} { ${paramName}: ${sourceName} }'.`,
          { node: b, property: "source" },
        );
        continue;
      }
      const source = b.source.ref;
      const sourceServes = (source.serves ?? []).some((r) => r?.$refText === requiredApi);
      if (!sourceServes) {
        accept(
          "error",
          `Deployable '${sourceName}' does not 'serves: ${requiredApi}' — required to fill ui parameter '${paramName}: ${requiredApi}' on '${ui.name}'.`,
          { node: b, property: "source" },
        );
      }
    }

    // Every UI api param must be bound.
    for (const [name, apiName] of requiredParams) {
      if (!boundNames.has(name)) {
        accept(
          "error",
          `Deployable '${d.name}' is missing a binding for ui parameter '${name}: ${apiName}' on ui '${ui.name}'.`,
          { node: d, property: "name" },
        );
      }
    }
  }

  private checkContext(
    ctx: import("./generated/ast.js").BoundedContext,
    accept: ValidationAcceptor,
  ): void {
    for (const member of ctx.members) {
      if (isAggregate(member)) this.checkAggregate(member, accept);
      else if (isValueObject(member)) this.checkValueObject(member, accept);
    }
  }

  private checkAggregate(agg: Aggregate, accept: ValidationAcceptor) {
    // Ensure unique part names within the aggregate
    const partNames = new Set<string>();
    let displayField: Property | undefined;
    for (const m of agg.members) {
      if (isEntityPart(m)) {
        if (partNames.has(m.name)) {
          accept("error", `Duplicate entity part '${m.name}' in aggregate '${agg.name}'.`, {
            node: m,
            property: "name",
          });
        }
        partNames.add(m.name);
        this.checkEntityPart(m, agg, accept);
      }
      if (isContainment(m)) this.checkContainment(m, agg, accept);
      if (isInvariant(m)) this.checkInvariant(m, this.envForAggregate(agg), accept);
      if (isProperty(m) && m.check) this.checkPropertyCheck(m, this.envForAggregate(agg), accept);
      if (isDerivedProp(m)) this.checkDerived(m, this.envForAggregate(agg), accept);
      if (isFunctionDecl(m)) this.checkFunction(m, agg, undefined, accept);
      if (isOperation(m)) this.checkOperation(m, agg, accept);
      if (isProperty(m) && m.display) {
        // At most one display field per aggregate.  Type must be `string`
        // (the React generator uses it as a Mantine <Select> option label).
        if (displayField) {
          accept(
            "error",
            `Aggregate '${agg.name}' declares multiple 'display' fields ('${displayField.name}' and '${m.name}'); at most one is allowed.`,
            { node: m, property: "display" },
          );
        }
        displayField = m;
        const typeText = m.type?.base;
        const isString = typeText && isPrimitiveType(typeText) && typeText.name === "string";
        if (!isString) {
          accept(
            "error",
            `Display field '${m.name}' on aggregate '${agg.name}' must have type 'string'.`,
            { node: m, property: "display", code: "loom.display-not-string" },
          );
        }
      }
      const hasExtern = agg.members.some((x) => isOperation(x) && x.extern);
      if (isProperty(m) && m.provenanced && !hasExtern && !this.fieldIsWritten(agg, m.name)) {
        // A provenanced field that no operation ever assigns produces no
        // trace records.  Warn (not error), and only when the aggregate has
        // no `extern` operation — an extern handler has no visible body and
        // may legitimately be the writer.
        accept(
          "warning",
          `Provenanced field '${m.name}' on aggregate '${agg.name}' is never written; no trace records will be produced.`,
          { node: m, property: "provenanced", code: "loom.provenanced-never-written" },
        );
      }
    }
  }

  /** True iff some `:=`/`+=`/`-=` in this aggregate targets `field`
   *  directly (matches the v1 instrumentation scope — direct fields). */
  private fieldIsWritten(agg: Aggregate, field: string): boolean {
    for (const node of AstUtils.streamAllContents(agg)) {
      if (
        isAssignOrCallStmt(node) &&
        node.op &&
        node.target?.head === field &&
        (node.target.tail?.length ?? 0) === 0
      ) {
        return true;
      }
    }
    return false;
  }

  private checkEntityPart(part: EntityPart, agg: Aggregate, accept: ValidationAcceptor) {
    for (const m of part.members) {
      if (isContainment(m)) this.checkContainment(m, agg, accept);
      if (isInvariant(m)) this.checkInvariant(m, this.envForPart(agg, part), accept);
      if (isProperty(m) && m.check) this.checkPropertyCheck(m, this.envForPart(agg, part), accept);
      if (isDerivedProp(m)) this.checkDerived(m, this.envForPart(agg, part), accept);
      if (isFunctionDecl(m)) this.checkFunction(m, agg, part, accept);
    }
  }

  private checkValueObject(vo: ValueObject, accept: ValidationAcceptor) {
    for (const m of vo.members) {
      if (isContainment(m)) {
        accept("error", `Value objects cannot contain entities.`, { node: m, property: "name" });
      }
      if (isInvariant(m)) this.checkInvariant(m, this.envForValueObject(vo), accept);
      if (isProperty(m) && m.check) this.checkPropertyCheck(m, this.envForValueObject(vo), accept);
      if (isDerivedProp(m)) this.checkDerived(m, this.envForValueObject(vo), accept);
    }
  }

  private checkContainment(c: Containment, agg: Aggregate, accept: ValidationAcceptor) {
    const part = c.partType?.ref;
    if (!part) return;
    // Scope provider already restricts to local parts; this is a friendly
    // double-check in case of cross-aggregate ID-link errors.
    const owner = AstUtils.getContainerOfType(part, isAggregate);
    if (owner !== agg) {
      accept(
        "error",
        `Cannot 'contain' part '${part.name}' — it belongs to aggregate '${owner?.name ?? "?"}'. Use Id<${part.name}> for cross-aggregate links.`,
        { node: c, property: "partType" },
      );
    }
  }

  private checkMatchExpressions(
    model: import("./generated/ast.js").Model,
    accept: ValidationAcceptor,
  ): void {
    for (const node of AstUtils.streamAllContents(model)) {
      if (node.$type !== "MatchExpr") continue;
      const m = node as import("./generated/ast.js").MatchExpr;
      // Empty match (no arms, no else) is structurally meaningless —
      // grammar permits it, validator rejects.
      if (m.arms.length === 0 && !m.elseExpr) {
        accept("error", `Empty 'match { }' — must declare at least one arm or an 'else' branch.`, {
          node: m,
        });
        continue;
      }
      // Warn on non-exhaustive matches (no `else`).  An expression
      // without `else` returns undefined when no arm matches, which
      // is rarely intentional — for state-machine page bodies it
      // means "render nothing" which is usually a bug.  Promoted
      // from error to warning to keep the surface friendly while
      // the user iterates.
      if (!m.elseExpr) {
        accept(
          "warning",
          `'match' expression has no 'else' arm — when no arm matches, the expression is undefined.  Add 'else => …' for exhaustive coverage.`,
          { node: m },
        );
      }
    }
  }

  private checkMatchesCalls(
    model: import("./generated/ast.js").Model,
    accept: ValidationAcceptor,
  ): void {
    for (const node of AstUtils.streamAllContents(model)) {
      if (node.$type !== "MemberAccess") continue;
      const ma = node as import("./generated/ast.js").MemberAccess;
      if (ma.member !== "matches" || !ma.call) continue;
      // `matches` always takes exactly one string-literal argument.
      if (ma.args.length !== 1) {
        accept("error", `'matches' takes exactly one argument (a string-literal regex pattern).`, {
          node: ma,
          property: "args",
        });
        continue;
      }
      // Slice 1.5: call args are CallArg wrappers carrying an
      // optional `name:` prefix; reach for `.value` to inspect the
      // expression itself.  `string.matches(<regex>)` is a single-
      // positional-arg method-call, so `name` should be absent.
      const argWrap = ma.args[0]!;
      const arg = argWrap.value;
      if (argWrap.name) {
        accept(
          "error",
          `'matches' takes a single positional argument; named arguments are not supported.`,
          { node: argWrap, property: "name" },
        );
        continue;
      }
      if (arg.$type !== "StringLit") {
        accept(
          "error",
          `'matches' argument must be a string literal — patterns must be known at codegen time.`,
          { node: ma, property: "args" },
        );
        continue;
      }
      const raw = (arg as import("./generated/ast.js").StringLit).value as string;
      // The grammar's STRING terminal carries the surrounding quotes.
      const pattern = raw.startsWith('"') ? JSON.parse(raw) : raw;
      try {
        new RegExp(pattern);
      } catch (err) {
        accept(
          "error",
          `'matches' pattern is not a valid regular expression: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { node: ma, property: "args" },
        );
      }
    }
  }

  private checkPropertyCheck(p: Property, env: Env, accept: ValidationAcceptor) {
    if (!p.check) return;
    const t = typeOf(p.check, env);
    if (t.kind !== "primitive" || t.name !== "bool") {
      accept(
        "error",
        `Property check on '${p.name}' must be of type 'bool', got '${typeToString(t)}'.`,
        { node: p, property: "check" },
      );
    }
  }

  private checkInvariant(inv: Invariant, env: Env, accept: ValidationAcceptor) {
    const t = typeOf(inv.expr, env);
    if (t.kind !== "primitive" || t.name !== "bool") {
      accept("error", `Invariant must be of type 'bool', got '${typeToString(t)}'.`, {
        node: inv,
        property: "expr",
      });
    }
    if (inv.guard) {
      const g = typeOf(inv.guard, env);
      if (g.kind !== "primitive" || g.name !== "bool") {
        accept(
          "error",
          `Invariant guard ('when ...') must be of type 'bool', got '${typeToString(g)}'.`,
          { node: inv, property: "guard" },
        );
      }
    }
  }

  private checkDerived(d: DerivedProp, env: Env, accept: ValidationAcceptor) {
    const declared = resolveTypeRef(d.type);
    const actual = typeOf(d.expr, env);
    if (
      declared.kind !== "unknown" &&
      actual.kind !== "unknown" &&
      !isAssignable(actual, declared)
    ) {
      accept(
        "error",
        `Derived '${d.name}' has expression of type '${typeToString(actual)}' but declared type is '${typeToString(declared)}'.`,
        { node: d, property: "expr" },
      );
    }
  }

  private checkFunction(
    fn: FunctionDecl,
    agg: Aggregate,
    part: EntityPart | undefined,
    accept: ValidationAcceptor,
  ) {
    const env = part ? this.envForPart(agg, part, fn) : this.envForAggregate(agg, fn);
    const declared = resolveTypeRef(fn.returnType);
    const actual = typeOf(fn.body, env);
    if (
      declared.kind !== "unknown" &&
      actual.kind !== "unknown" &&
      !isAssignable(actual, declared)
    ) {
      accept(
        "error",
        `Function '${fn.name}' returns '${typeToString(actual)}' but is declared to return '${typeToString(declared)}'.`,
        { node: fn, property: "body" },
      );
    }
  }

  private checkOperation(op: Operation, agg: Aggregate, accept: ValidationAcceptor) {
    // Build env with parameters and walk body
    const bindings = new Map<string, { type: DddType; origin: AstNode }>();
    for (const p of op.params) bindings.set(p.name, { type: paramType(p), origin: p });
    let env: Env = makeEnv(this.envForAggregate(agg), bindings, { aggregate: agg });

    for (const stmt of op.body) {
      env = this.checkStatement(stmt, agg, op, env, accept);
    }
  }

  private checkStatement(
    stmt: Statement,
    agg: Aggregate,
    op: Operation,
    env: Env,
    accept: ValidationAcceptor,
  ): Env {
    if (isPreconditionStmt(stmt)) {
      const t = typeOf(stmt.expr, env);
      if (t.kind !== "primitive" || t.name !== "bool") {
        accept("error", `'precondition' must be of type 'bool', got '${typeToString(t)}'.`, {
          node: stmt,
          property: "expr",
        });
      }
      return env;
    }
    if (isRequiresStmt(stmt)) {
      const t = typeOf(stmt.expr, env);
      if (t.kind !== "primitive" || t.name !== "bool") {
        accept("error", `'requires' must be of type 'bool', got '${typeToString(t)}'.`, {
          node: stmt,
          property: "expr",
        });
      }
      return env;
    }
    if (isLetStmt(stmt)) {
      const t = typeOf(stmt.expr, env);
      const next = new Map<string, { type: DddType; origin: AstNode }>();
      next.set(stmt.name, { type: t, origin: stmt });
      return makeEnv(env, next);
    }
    if (isEmitStmt(stmt)) {
      this.checkEmit(stmt, env, accept);
      return env;
    }
    if (isAssignOrCallStmt(stmt)) {
      this.checkAssignOrCall(stmt, agg, op, env, accept);
      return env;
    }
    return env;
  }

  private checkAssignOrCall(
    stmt: AssignOrCallStmt,
    agg: Aggregate,
    op: Operation,
    env: Env,
    accept: ValidationAcceptor,
  ) {
    if (!stmt.op) {
      // Bare call statement
      this.checkCallStmt(stmt, agg, op, accept);
      return;
    }
    const targetType = this.lvalueType(stmt.target, agg, env, accept);
    // Reject assignment to a derived property — derived members are
    // computed from other state and writing to them would silently no-op.
    if (this.lvalueIsDerived(stmt.target, agg)) {
      accept("error", `Cannot assign to derived property '${pathString(stmt.target)}'.`, {
        node: stmt,
        property: "target",
      });
      return;
    }
    if (stmt.op === ":=") {
      const valueType = typeOf(stmt.value, env);
      if (
        targetType.kind !== "unknown" &&
        valueType.kind !== "unknown" &&
        !isAssignable(valueType, targetType)
      ) {
        accept(
          "error",
          `Cannot assign '${typeToString(valueType)}' to '${typeToString(targetType)}'.`,
          { node: stmt, property: "value" },
        );
      }
    } else {
      // '+=' or '-='
      if (targetType.kind !== "array") {
        accept(
          "error",
          `'${stmt.op}' requires a collection on the left-hand side, got '${typeToString(targetType)}'.`,
          { node: stmt, property: "target" },
        );
        return;
      }
      const valueType = typeOf(stmt.value, env);
      if (
        targetType.element.kind !== "unknown" &&
        valueType.kind !== "unknown" &&
        !isAssignable(valueType, targetType.element)
      ) {
        accept(
          "error",
          `Cannot ${stmt.op === "+=" ? "add" : "remove"} element of type '${typeToString(valueType)}' to/from collection of '${typeToString(targetType.element)}'.`,
          { node: stmt, property: "value" },
        );
      }
    }
  }

  private checkEmit(stmt: EmitStmt, env: Env, accept: ValidationAcceptor) {
    const ev = stmt.event?.ref;
    if (!ev) return;
    const declared = new Map(ev.fields.map((f) => [f.name, resolveTypeRef(f.type)] as const));
    const seen = new Set<string>();
    for (const f of stmt.fields) {
      seen.add(f.name);
      const expected = declared.get(f.name);
      if (!expected) {
        accept("error", `Event '${ev.name}' has no field '${f.name}'.`, {
          node: f,
          property: "name",
        });
        continue;
      }
      const actual = typeOf(f.value, env);
      if (!isAssignable(actual, expected)) {
        accept(
          "error",
          `Field '${f.name}' expects '${typeToString(expected)}' but got '${typeToString(actual)}'.`,
          { node: f, property: "value" },
        );
      }
    }
    for (const [name] of declared) {
      if (!seen.has(name)) {
        accept("warning", `Event field '${name}' not provided.`, {
          node: stmt,
          property: "event",
        });
      }
    }
  }

  private checkCallStmt(
    stmt: AssignOrCallStmt,
    agg: Aggregate,
    op: Operation,
    accept: ValidationAcceptor,
  ) {
    const lv = stmt.target;
    if (lv.tail.length === 0 && lv.call) {
      const name = lv.head;
      const fn = findFunction(agg, name);
      if (fn) return;
      const target = findOperation(agg, name);
      if (target) {
        if (target === op) {
          accept("warning", `Operation '${name}' calls itself.`, { node: stmt });
        }
        return;
      }
      accept("error", `Cannot resolve call to '${name}' from aggregate '${agg.name}'.`, {
        node: stmt,
      });
    } else if (!lv.call) {
      accept(
        "error",
        `Bare statement must be an assignment, collection mutation, or function/operation call.`,
        { node: stmt },
      );
    }
  }

  private lvalueType(
    lv: import("./generated/ast.js").LValue,
    agg: Aggregate,
    env: Env,
    accept: ValidationAcceptor,
  ): DddType {
    // Resolve the head: a parameter, let-binding, or an aggregate property.
    const headSym = env.resolve(lv.head);
    let cur: DddType;
    if (headSym) {
      cur = headSym.type;
    } else {
      // Check aggregate root members
      cur = lookupRootMember(agg, lv.head);
      if (cur.kind === "unknown") {
        accept("error", `Cannot resolve '${lv.head}'.`, { node: lv, property: "head" });
        return T.unknown;
      }
    }
    for (const seg of lv.tail) {
      cur = stepInto(cur, seg);
      if (cur.kind === "unknown") {
        accept("error", `Cannot resolve member '${seg}'.`, { node: lv });
        return T.unknown;
      }
    }
    return cur;
  }

  private envForAggregate(agg: Aggregate, fn?: FunctionDecl): Env {
    const bindings = new Map<string, { type: DddType; origin: AstNode }>();
    // Aggregate properties / derived / contains are in scope as bare
    // identifiers — same as if we accessed them via `this`.
    for (const m of agg.members) {
      if (isProperty(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
      else if (isDerivedProp(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
      else if (isContainment(m)) {
        const part = m.partType?.ref;
        if (part) {
          const t: DddType = { kind: "entity", ref: part };
          bindings.set(m.name, { type: m.collection ? T.array(t) : t, origin: m });
        }
      }
    }
    if (fn) for (const p of fn.params) bindings.set(p.name, { type: paramType(p), origin: p });
    return makeEnv(undefined, bindings, { aggregate: agg });
  }

  private envForPart(agg: Aggregate, part: EntityPart, fn?: FunctionDecl): Env {
    const bindings = new Map<string, { type: DddType; origin: AstNode }>();
    for (const m of part.members) {
      if (isProperty(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
      else if (isDerivedProp(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
      else if (isContainment(m)) {
        const partType = m.partType?.ref;
        if (partType) {
          const t: DddType = { kind: "entity", ref: partType };
          bindings.set(m.name, { type: m.collection ? T.array(t) : t, origin: m });
        }
      }
    }
    if (fn) for (const p of fn.params) bindings.set(p.name, { type: paramType(p), origin: p });
    return makeEnv(undefined, bindings, { aggregate: agg, part });
  }

  private envForValueObject(vo: ValueObject): Env {
    const bindings = new Map<string, { type: DddType; origin: AstNode }>();
    for (const m of vo.members) {
      if (isProperty(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
      else if (isDerivedProp(m)) bindings.set(m.name, { type: resolveTypeRef(m.type), origin: m });
    }
    return makeEnv(undefined, bindings, { valueObject: vo });
  }

  /**
   * True if the lvalue's *final* segment names a derived member of the
   * type reachable via the path so far.  Derived members are computed
   * from state and cannot be assigned to.
   */
  private lvalueIsDerived(lv: import("./generated/ast.js").LValue, agg: Aggregate): boolean {
    if (lv.tail.length === 0) {
      // Direct head reference — check root members
      for (const m of agg.members) {
        if (isDerivedProp(m) && m.name === lv.head) return true;
      }
      return false;
    }
    // Walk the path, last segment matters
    let cur: DddType = lookupRootMember(agg, lv.head);
    for (let i = 0; i < lv.tail.length - 1; i++) {
      cur = stepInto(cur, lv.tail[i]!);
    }
    const lastSegment = lv.tail[lv.tail.length - 1]!;
    if (cur.kind === "entity" || cur.kind === "aggregate") {
      for (const m of cur.ref.members) {
        if (isDerivedProp(m) && m.name === lastSegment) return true;
      }
    }
    if (cur.kind === "valueobject") {
      for (const m of cur.ref.members) {
        if (isDerivedProp(m) && m.name === lastSegment) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Page metamodel — Slice 3 validator obligations.
  //
  // Per the plan at /root/.claude/plans/yes-make-full-plan-tingly-sunbeam.md.
  // Walks each `ui` SystemMember and emits diagnostics for malformed
  // pages, scaffold directives, menus, and the references between
  // them.  Cross-cutting rules (uniqueness across uis, deployable.ui
  // → ui resolution) are handled in `check()` and `checkDeployable()`
  // respectively.
  //
  // These checks are intentionally syntactic / cross-reference; deeper
  // type analysis on body expressions and component-stdlib parameter
  // shape lives in Slice 5 (page emitter + closed-stdlib spec table).
  // ---------------------------------------------------------------------------

  private checkUi(
    ui: import("./generated/ast.js").Ui,
    sys: import("./generated/ast.js").System,
    accept: ValidationAcceptor,
  ): void {
    // Page name uniqueness within the ui (Rule 7).  Override-by-name
    // is the SAME mechanism — the explicit page must displace exactly
    // one scaffolded page; multiple explicit pages with the same name
    // are still an error.
    const pageNamesSeen = new Map<string, import("./generated/ast.js").Page>();
    for (const m of ui.members) {
      if (m.$type !== "Page") continue;
      const prior = pageNamesSeen.get(m.name);
      if (prior) {
        accept(
          "error",
          `Duplicate page '${m.name}' in ui '${ui.name}'.  Pages within a ui must have unique names; an explicit override-by-name displaces a single scaffolded page, not another explicit one.`,
          { node: m, property: "name" },
        );
      } else {
        pageNamesSeen.set(m.name, m);
      }
    }

    // At most one ui-level menu block (Rule 8 part).
    const menuBlocks = ui.members.filter((m) => m.$type === "MenuBlock");
    if (menuBlocks.length > 1) {
      for (const extra of menuBlocks.slice(1)) {
        accept(
          "error",
          `ui '${ui.name}' declares more than one 'menu { ... }' block; keep just the first.`,
          { node: extra },
        );
      }
    }

    // Slice 11.25 — UI api parameter checks.
    //   - Param names unique within the ui (`api Sales: …` declared twice).
    //   - apiRef cross-ref must resolve (handled by Langium linker; the
    //     refRoot returns undefined when the target isn't found, so the
    //     check below catches it explicitly with a clearer message).
    const apiParamSeen = new Map<string, import("./generated/ast.js").UiApiParam>();
    for (const m of ui.members) {
      if (m.$type !== "UiApiParam") continue;
      const prior = apiParamSeen.get(m.name);
      if (prior) {
        accept("error", `ui '${ui.name}' declares api parameter '${m.name}' more than once.`, {
          node: m,
          property: "name",
        });
      } else {
        apiParamSeen.set(m.name, m);
      }
      if (!m.apiRef?.ref) {
        accept(
          "error",
          `ui '${ui.name}' references undeclared api '${m.apiRef?.$refText ?? "<missing>"}'.  Declare it at system scope as 'api ${m.apiRef?.$refText ?? "<Name>"} from <Module>'.`,
          { node: m, property: "apiRef" },
        );
      }
    }

    // Per-member walks.
    for (const m of ui.members) {
      if (m.$type === "Scaffold") this.checkScaffold(m, sys, accept);
      else if (m.$type === "Page") this.checkPage(m, ui, accept);
      else if (m.$type === "MenuBlock") this.checkMenuBlock(m, ui, accept);
    }
  }

  private checkScaffold(
    s: import("./generated/ast.js").Scaffold,
    sys: import("./generated/ast.js").System,
    accept: ValidationAcceptor,
  ): void {
    // Rule 5 — selector targets must resolve to declarations of the
    // matching kind anywhere in the system.  The deployable-targets-
    // chain reachability check is left to Slice 4's expander where
    // we already need to walk reachability for page generation.

    // Build per-kind name sets from the system's domain IR.
    const moduleNames = new Set<string>();
    const contextNames = new Set<string>();
    const aggregateNames = new Set<string>();
    const workflowNames = new Set<string>();
    const viewNames = new Set<string>();
    for (const sm of sys.members) {
      if (sm.$type === "Module") {
        moduleNames.add(sm.name);
        for (const ctx of sm.contexts) {
          contextNames.add(ctx.name);
          for (const cm of ctx.members) {
            if (cm.$type === "Aggregate") aggregateNames.add(cm.name);
            else if (cm.$type === "Workflow") workflowNames.add(cm.name);
            else if (cm.$type === "View") viewNames.add(cm.name);
          }
        }
      } else if (sm.$type === "BoundedContext") {
        contextNames.add(sm.name);
        for (const cm of sm.members) {
          if (cm.$type === "Aggregate") aggregateNames.add(cm.name);
          else if (cm.$type === "Workflow") workflowNames.add(cm.name);
          else if (cm.$type === "View") viewNames.add(cm.name);
        }
      }
    }

    const expected =
      s.selector === "modules"
        ? moduleNames
        : s.selector === "contexts"
          ? contextNames
          : s.selector === "aggregates"
            ? aggregateNames
            : s.selector === "workflows"
              ? workflowNames
              : viewNames;

    const seenWithinDirective = new Set<string>();
    for (const t of s.targets) {
      if (!expected.has(t)) {
        accept(
          "error",
          `'scaffold ${s.selector}: ${t}' — no ${singular(s.selector)} '${t}' is declared in this system.`,
          { node: s, property: "targets" },
        );
      }
      // Rule 6 (light) — same name listed twice in one directive.
      // Cross-directive double-scaffolding (same module, different
      // granularity) is detected by Slice 4's expander when it
      // collapses scaffold output to a page-name map.
      if (seenWithinDirective.has(t)) {
        accept("error", `'scaffold ${s.selector}: ...' lists '${t}' more than once.`, {
          node: s,
          property: "targets",
        });
      }
      seenWithinDirective.add(t);
    }
  }

  private checkPage(
    p: import("./generated/ast.js").Page,
    ui: import("./generated/ast.js").Ui,
    accept: ValidationAcceptor,
  ): void {
    void ui;
    // Slice 11.25 — validate api body refs first so each chain ref
    // gets a precise diagnostic with source-location ranges.
    this.checkApiBodyRefs(p, ui, accept);
    // Property uniqueness (Rule 9 part) — at most one each of route,
    // title, requires, body, menu metadata.  Multiple `state {}`
    // blocks merge (per spec §6 — same posture as `permissions`).
    const seen = new Map<string, number>();
    for (const prop of p.props) {
      const key = prop.$type;
      if (key === "StateBlock") continue; // multiple allowed
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seen) {
      if (count > 1) {
        accept(
          "error",
          `Page '${p.name}' declares more than one '${pagePropDisplayName(key)}' property; keep just the first.`,
          { node: p, property: "name" },
        );
      }
    }

    // PageMenuMeta key names — only `section` / `label` / `order` /
    // `hidden` are recognised (parser accepts any LooseName via the
    // soft-keyword rule).
    const allowedMenuMetaKeys = new Set(["section", "label", "order", "hidden"]);
    for (const prop of p.props) {
      if (prop.$type !== "PageMenuMeta") continue;
      for (const entry of prop.entries) {
        if (!allowedMenuMetaKeys.has(entry.name)) {
          accept(
            "error",
            `Unknown menu metadata key '${entry.name}' on page '${p.name}'.  Recognised keys: ${[
              ...allowedMenuMetaKeys,
            ].join(", ")}.`,
            { node: entry, property: "name" },
          );
        }
      }
    }
  }

  private checkMenuBlock(
    block: import("./generated/ast.js").MenuBlock,
    ui: import("./generated/ast.js").Ui,
    accept: ValidationAcceptor,
  ): void {
    // Rule 8 — every page-link in a menu block must reference a page
    // in the SAME ui.  The grammar's `[Page:ID]` cross-reference
    // resolves globally; we additionally check the resolved page's
    // container.
    const pagesInThisUi = new Set(
      ui.members
        .filter((m) => m.$type === "Page")
        .map((m) => (m as import("./generated/ast.js").Page).name),
    );
    for (const section of block.sections) {
      for (const link of section.links) {
        // Slice 10: page links use a Langium cross-reference now
        // that scaffold expansion runs at the AST level.  The
        // linker reports unresolved refs natively
        // ("Could not resolve reference to Page named 'X'") — no
        // custom validator message needed.  `pagesInThisUi` is no
        // longer consulted here because cross-references are
        // already scoped to the surrounding ui by the default
        // scope provider.
        void pagesInThisUi;
        const targetName = link.page?.ref?.name ?? link.page?.$refText;
        void targetName;
        // MenuLinkProp key names — only `label` / `order` recognised.
        const allowedLinkKeys = new Set(["label", "order"]);
        for (const prop of link.props ?? []) {
          if (!allowedLinkKeys.has(prop.name)) {
            accept(
              "error",
              `Unknown menu link property '${prop.name}'.  Recognised: ${[...allowedLinkKeys].join(
                ", ",
              )}.`,
              { node: prop, property: "name" },
            );
          }
        }
      }
    }
  }

  /** Slice 11.25 — validate `<paramName>.<aggregate>.<op>` body
   *  ref chains in a page.  Each chain must:
   *    - root at a declared UiApiParam in the page's UI
   *    - reference a real aggregate in the api's source module
   *    - reference a real operation on that aggregate (CRUD or
   *      repository find)
   *  Diagnostics emit at the source-level node so the editor
   *  underlines the exact wrong segment. */
  private checkApiBodyRefs(
    p: import("./generated/ast.js").Page,
    ui: import("./generated/ast.js").Ui,
    accept: ValidationAcceptor,
  ): void {
    // Build the param-name → resolved Api map for this UI.
    const apiByParam = new Map<string, import("./generated/ast.js").Api>();
    for (const m of ui.members) {
      if (m.$type !== "UiApiParam") continue;
      const apiNode = m.apiRef?.ref;
      if (apiNode) apiByParam.set(m.name, apiNode);
    }
    if (apiByParam.size === 0) return; // no api params → nothing to validate

    // Walk every Expression in the page (body, title, requires,
    // state inits — anything that can mention a body-ref chain).
    for (const node of AstUtils.streamAllContents(p)) {
      if (node.$type !== "MemberAccess") continue;
      const ma = node as import("./generated/ast.js").MemberAccess;
      // We're looking for the OUTER `.<op>` of a 3-segment chain,
      // whose receiver is itself `<paramName>.<aggregate>`.
      // Skip non-three-segment chains (the deeper member or
      // outer .data accessors aren't the ones being validated).
      if (ma.receiver?.$type !== "MemberAccess") continue;
      const inner = ma.receiver as import("./generated/ast.js").MemberAccess;
      if (inner.receiver?.$type !== "NameRef") continue;
      const root = inner.receiver as import("./generated/ast.js").NameRef;
      const rootName = root.name as string;
      if (!apiByParam.has(rootName)) continue; // not an api binding ref

      const apiNode = apiByParam.get(rootName)!;
      const moduleName = apiNode.source?.$refText ?? "";
      const aggregateName = inner.member as string;
      const op = ma.member as string;

      // Find aggregate in the api's source module.
      const moduleNode = apiNode.source?.ref;
      const aggregate = moduleNode ? findAggregateInModule(moduleNode, aggregateName) : undefined;
      if (!aggregate) {
        accept(
          "error",
          `Aggregate '${aggregateName}' not found in api '${apiNode.name}' (module '${moduleName}').`,
          { node: inner, property: "member" },
        );
        continue;
      }

      // Validate the operation.
      if (!isValidApiOperation(aggregate, op)) {
        const allowed = listValidApiOperations(aggregate);
        accept(
          "error",
          `Operation '${op}' is not declared on aggregate '${aggregateName}'.  Available: ${allowed.join(", ")}.`,
          { node: ma, property: "member" },
        );
      }
    }
  }
}

/** Find an Aggregate by name across the contexts of a Module. */
function findAggregateInModule(
  mod: import("./generated/ast.js").Module,
  name: string,
): import("./generated/ast.js").Aggregate | undefined {
  for (const ctx of mod.contexts ?? []) {
    for (const am of ctx.members ?? []) {
      if (am.$type === "Aggregate" && am.name === name) return am;
    }
  }
  return undefined;
}

/** Standard CRUD operation names that the api auto-derives for
 *  every aggregate, plus the aggregate's repository finds.
 *  Repositories live at the BoundedContext level (peer to
 *  aggregates), declared as `repository <Name> for <Aggregate>`,
 *  so we walk the aggregate's container context to find ones
 *  pointing at this aggregate. */
function listValidApiOperations(agg: import("./generated/ast.js").Aggregate): string[] {
  const ops = new Set<string>(["all", "byId", "create", "update", "delete"]);
  const ctx = agg.$container;
  if (ctx?.$type === "BoundedContext") {
    for (const m of ctx.members ?? []) {
      if (m.$type !== "Repository") continue;
      if (m.aggregate?.ref !== agg) continue;
      for (const f of m.finds ?? []) ops.add(f.name);
    }
  }
  return [...ops].sort();
}

function isValidApiOperation(agg: import("./generated/ast.js").Aggregate, op: string): boolean {
  return listValidApiOperations(agg).includes(op);
}

// Map of PageProp $type names back to the source-side property name
// for diagnostics.  Used by `checkPage`'s duplicate-property message.
function pagePropDisplayName(typeName: string): string {
  switch (typeName) {
    case "RouteProp":
      return "route";
    case "TitleProp":
      return "title";
    case "RequiresProp":
      return "requires";
    case "BodyProp":
      return "body";
    case "PageMenuMeta":
      return "menu";
    default:
      return typeName;
  }
}

function singular(selector: string): string {
  switch (selector) {
    case "modules":
      return "module";
    case "contexts":
      return "context";
    case "aggregates":
      return "aggregate";
    case "workflows":
      return "workflow";
    case "views":
      return "view";
    default:
      return selector;
  }
}

function pathString(lv: import("./generated/ast.js").LValue): string {
  return [lv.head, ...lv.tail].join(".");
}

// ---------------------------------------------------------------------------
// Platform classification helpers.
//
// `platformMountsUi` consults the platform registry (`PlatformSurface
// .mountsUi`) so adding a new platform requires extending exactly that
// flag plus the `Platform` grammar enum + the `Framework` enum.
// `platformOwnsBackend` and `expectedFrameworkFor` still live here
// because the grammar enum is the source of truth for the validator
// (not the runtime registry) — a future refactor can move the backend
// flag to `PlatformSurface` too once the grammar/registry split is
// resolved.
// ---------------------------------------------------------------------------

function platformMountsUi(platform: string | undefined): boolean {
  if (platform == null) return false;
  // The registry's `mountsUi` is the single source of truth.  Cast is
  // safe because the grammar enum and the registry stay in lockstep
  // (registry barfs at boot if a platform is missing).
  try {
    return platformFor(platform as import("../ir/loom-ir.js").Platform).mountsUi;
  } catch {
    return false;
  }
}

/** The bareword family of a `platform:` value — strips a
 *  `@version` pin so the predicate helpers + framework checks work
 *  on `platform: "hono@v4"` exactly as on `platform: hono`.
 *  Frontend / unknown names pass through unchanged
 *  (`parseBuiltinPlatformRef` returns null for them). */
function platformFamily(platform: string | undefined): string | undefined {
  if (platform == null) return undefined;
  return parseBuiltinPlatformRef(platform)?.family ?? platform;
}

function platformOwnsBackend(platform: string | undefined): boolean {
  // The backend families are exactly the keys
  // `parseBuiltinPlatformRef` recognises (BUILTIN_PLATFORM_LATEST),
  // so a non-null parse — bareword or `family@version` pin — *is*
  // the backend predicate.
  return platform != null && parseBuiltinPlatformRef(platform) !== null;
}

/** Framework a deployable will render against, given its platform and
 *  whether it actually declares a `ui:` mount.  `hasUi` matters for
 *  platforms that are dual-mode: `dotnet` is backend-only without
 *  `ui:` and serves an embedded React SPA when `ui:` is set.  For
 *  always-frontend platforms (`react`/`static`) and always-fullstack
 *  platforms (`phoenixLiveView`) the answer is independent of `hasUi`. */
function expectedFrameworkFor(platform: string | undefined, hasUi: boolean): string | undefined {
  // Normalise a `family@version` pin to its family first so a
  // pinned backend (`"phoenixLiveView@v1"`, `"dotnet@v8"`) maps to
  // the same framework as its bareword.
  const fam = platformFamily(platform);
  if (fam === "react" || fam === "static") return "react";
  if (fam === "phoenixLiveView") return "phoenixLiveView";
  if (fam === "dotnet" && hasUi) return "react";
  return undefined;
}

/** Format a given framework's design pack must declare.  Mirrors
 *  `expectedFrameworkFor`; used by Rule 14 to cross-check the
 *  deployable's `design:` against its framework. */
function expectedPackFormatFor(framework: string | undefined): "tsx" | "heex" | undefined {
  if (framework === "react") return "tsx";
  if (framework === "phoenixLiveView") return "heex";
  return undefined;
}

/** Comma-joined list of built-in pack family names whose default
 *  version produces the given format — used to make Rule 14's
 *  diagnostic suggest valid replacements ("Use one of: mantine,
 *  shadcn, mui, chakra.").  Reads `BUILTIN_PACK_LATEST` so the
 *  suggestion follows the bareword resolution rule: each family
 *  shows up once, no `@version` noise. */
function builtinPackNamesForFormat(format: "tsx" | "heex"): string {
  return (Object.keys(BUILTIN_PACK_LATEST) as Array<keyof typeof BUILTIN_PACK_LATEST>)
    .filter((family) => {
      const f = packFormatForBuiltin(family);
      return f === format;
    })
    .join(", ");
}

export function registerValidationChecks(services: DddServices): void {
  const registry = services.validation.ValidationRegistry;
  const validator = services.validation.DddValidator;
  const checks: ValidationChecks<DddAstType> = {
    Model: validator.check.bind(validator),
  };
  registry.register(checks, validator);
}
