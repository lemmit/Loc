// ---------------------------------------------------------------------------
// In-system typed api bindings (M-T4.8) — resolve, for one deployable, the
// `resource { kind: api, use: <Api> }` bindings it wires and which sibling
// deployable serves each.
//
// Pure IR: no port resolution here.  A service's container port comes from
// `PlatformSurface.composeService()`, which lives ABOVE this layer — the
// composer joins that on.  Keeping the join here would drag `platform/` into
// `ir/` against the pipeline direction.
// ---------------------------------------------------------------------------

import { descriptorFor } from "../../platform/metadata.js";
import type { BoundedContextIR, DataSourceIR, DeployableIR, SystemIR } from "../types/loom-ir.js";

export interface ApiResourceBinding {
  /** The `resource` declaration doing the binding. */
  readonly resource: DataSourceIR;
  /** The `api` it binds (`resource.apiName`). */
  readonly apiName: string;
  /** The backend deployable that `serves:` that api — the call's target. */
  readonly server: DeployableIR;
}

/** The api-bound resources `deployable` wires, each joined to the deployable
 *  that serves it.  A binding whose api no backend serves — or which more than
 *  one serves — is DROPPED here rather than guessed: `loom.resource-api-unserved`
 *  / `loom.resource-api-ambiguous-server` already fail the build, so by the time
 *  a generator runs, every surviving binding has exactly one server. */
export function apiResourceBindings(deployable: DeployableIR, sys: SystemIR): ApiResourceBinding[] {
  const out: ApiResourceBinding[] = [];
  for (const name of deployable.dataSourceNames) {
    const resource = sys.dataSources.find((r) => r.name === name);
    if (!resource?.apiName) continue;
    const servers = sys.deployables.filter(
      (d) => d.serves.includes(resource.apiName as string) && !descriptorFor(d.platform).isFrontend,
    );
    const server = servers.length === 1 ? servers[0] : undefined;
    if (!server) continue;
    // A deployable serving the api it also consumes is `loom.resource-api-self-call`
    // — likewise already an error; skip so a diagnostics-suppressed run can't
    // emit a service that depends_on itself (compose rejects the cycle).
    if (server.name === deployable.name) continue;
    out.push({ resource, apiName: resource.apiName, server });
  }
  return out;
}

/** The contexts a binding's client may expose operations for.
 *
 *  The api's subdomain is NOT the answer.  `api A from D` names a subdomain,
 *  but the deployable that `serves:` it mounts routes only for the contexts IT
 *  hosts — so taking every context of the subdomain emits client functions for
 *  operations the callee does not answer, which compile clean and 404 at
 *  runtime.  That is exactly the failure this feature exists to prevent (the
 *  untyped path's "a hand-written `/orders/{id}` compiles and 404s"), so
 *  getting it wrong here is worse than not having the feature.
 *
 *  Lives here, next to the binding it scopes, because all five backend client
 *  emitters need it and each had its own copy of the wrong version. */
export function servedContextsFor(
  binding: ApiResourceBinding,
  sys: SystemIR,
): readonly BoundedContextIR[] {
  const api = sys.apis.find((a) => a.name === binding.apiName);
  if (!api) return [];
  const inSubdomain = sys.subdomains.find((s) => s.name === api.sourceModule)?.contexts ?? [];
  const hosted = new Set(binding.server.contextNames);
  return inSubdomain.filter((c) => hosted.has(c.name));
}

/** True when any deployable in the system wires an api-bound resource — the
 *  gate that keeps systems without one byte-identical. */
export function systemHasApiResourceBindings(sys: SystemIR): boolean {
  return sys.dataSources.some((r) => r.apiName);
}
