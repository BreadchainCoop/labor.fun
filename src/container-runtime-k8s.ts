/**
 * Kubernetes container-runtime backend for NanoClaw.
 *
 * Selected via CONTAINER_RUNTIME=kubernetes (src/config.ts). Mirrors the
 * Docker backend (container-runtime.ts / container-runner.ts) one pod per
 * agent run, `--rm` semantics, stdin-in/stdout-out — but the actual pod spec,
 * path translation, and resource-limit mapping are Kubernetes-specific and
 * live here so container-runner.ts only needs a small branch at its existing
 * spawn-command seam. See docs/KUBERNETES.md for the full design rationale.
 *
 * The pure functions below (buildK8sPodOverrides, translateMountForK8s,
 * toK8sMemoryQuantity, toK8sCpuQuantity) take plain data in and return plain
 * data out — no fs/child_process access — so they're unit-testable without a
 * cluster. The argv builders at the bottom (buildKubectlRunArgs,
 * buildDeletePodArgs, buildListOrphanPodsArgs, buildClusterCheckArgs) are
 * also pure — they return argv arrays, not run anything — and are invoked
 * (with execSync/spawn) from container-runtime.ts and container-runner.ts.
 */
import { logger } from './logger.js';

export type K8sVolumeModeKind = 'hostPath' | 'pvc';

export interface K8sMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface K8sEnvVar {
  name: string;
  value?: string;
  /** When true, the value is NOT embedded — see buildK8sPodOverrides doc. */
  valueFromProcessEnv?: boolean;
}

export interface K8sResourceLimits {
  /** e.g. "2g", "512m" — same syntax the docker --memory flag accepts. */
  memory?: string;
  /** e.g. "2", "1.5", "500m" — same syntax the docker --cpus flag accepts. */
  cpus?: string;
  /** No Kubernetes equivalent; see warnPidsLimitUnsupported(). */
  pidsLimit?: string;
}

export interface BuildPodOverridesOptions {
  podName: string;
  image: string;
  mounts: K8sMount[];
  env: K8sEnvVar[];
  volumeMode: K8sVolumeModeKind;
  /** Required when volumeMode === 'hostPath'. */
  nodeName?: string;
  /** Required when volumeMode === 'pvc'. */
  pvcName?: string;
  /** Required when volumeMode === 'pvc' and any mount is non-'/dev/null'. */
  pvcRoots?: PvcRootMapping[];
  resources?: K8sResourceLimits;
  /** Run the container as this uid:gid, matching docker's --user flag. */
  runAsUser?: number;
  runAsGroup?: number;
  /**
   * Pod-level supplemental group applied to mounted volumes
   * (`spec.securityContext.fsGroup`). Kubernetes recursively chowns the volume
   * root to this gid on mount, so a non-root agent (the image's uid/gid 1000
   * `node` user) can write to a PVC whose backing block-storage volume mounts
   * root-owned — the same EACCES-on-write failure the orchestrator pod hit and
   * fixed with a pod-level fsGroup. Only meaningful for writable PVC-backed
   * volumes (hostPath volumes already resolve on the shared node); leave unset
   * when the pod runs as true root (uid 0), which needs no fsGroup remap.
   */
  fsGroup?: number;
  labels?: Record<string, string>;
}

/**
 * One volume + volumeMount pair translated from a docker-style bind mount.
 * Exported so path-translation tests can assert on the intermediate shape
 * without re-deriving it from a full pod spec.
 */
export interface TranslatedVolume {
  volume: Record<string, unknown>;
  volumeMount: Record<string, unknown>;
}

/** Known PVC-mode root prefixes and the subPath segment they map to. Order
 * matters: longer/more-specific roots must be checked before shorter ones
 * that could also match (none currently overlap, but keep this ordering
 * invariant if roots are added). */
export interface PvcRootMapping {
  hostRoot: string;
  subPathPrefix: string;
}

/**
 * Translates one docker-style bind mount into a Kubernetes volume +
 * volumeMount pair, per the strategy documented in docs/KUBERNETES.md
 * ("Volumes"):
 *
 * - hostPath mode: pass the absolute host path straight through as
 *   `hostPath.path` (no translation — the agent pod is pinned to the same
 *   node as the orchestrator via nodeName, so the path resolves the same way
 *   it does for a Docker bind mount).
 * - pvc mode: the hostPath must fall under one of `pvcRoots` (typically
 *   PROFILE_DIR, DATA_DIR, and process.cwd() for the read-only project-root
 *   mount); it's rewritten to a subPath relative to that root, all sharing
 *   ONE PersistentVolumeClaim volume (so multiple mounts don't need multiple
 *   PVCs). A host path outside every known root throws — silently mounting
 *   the wrong thing (or nothing) would be worse than a loud config error.
 * - The `/dev/null`-shadowed .env mount (hostPath === '/dev/null') has no PVC
 *   subPath meaning in either mode; it's special-cased to an emptyDir volume
 *   so the "shadow this file with nothing" intent survives the translation.
 */
export function translateMountForK8s(
  mount: K8sMount,
  volumeMode: K8sVolumeModeKind,
  volumeIndex: number,
  pvcRoots: PvcRootMapping[],
  pvcName?: string,
): TranslatedVolume {
  const volumeName = `v${volumeIndex}`;

  if (mount.hostPath === '/dev/null') {
    return {
      volume: { name: volumeName, emptyDir: {} },
      volumeMount: {
        name: volumeName,
        mountPath: mount.containerPath,
        readOnly: mount.readonly,
      },
    };
  }

  if (volumeMode === 'hostPath') {
    return {
      volume: {
        name: volumeName,
        hostPath: { path: mount.hostPath, type: 'DirectoryOrCreate' },
      },
      volumeMount: {
        name: volumeName,
        mountPath: mount.containerPath,
        readOnly: mount.readonly,
      },
    };
  }

  // pvc mode
  if (!pvcName) {
    throw new Error(
      'translateMountForK8s: pvcName is required when volumeMode is "pvc"',
    );
  }
  const root = pvcRoots.find(
    (r) =>
      mount.hostPath === r.hostRoot ||
      mount.hostPath.startsWith(r.hostRoot + '/'),
  );
  if (!root) {
    throw new Error(
      `translateMountForK8s: host path "${mount.hostPath}" does not fall under any known PVC root ` +
        `(${pvcRoots.map((r) => r.hostRoot).join(', ')}) — cannot translate to a subPath. ` +
        `Add its root to pvcRoots or use K8S_VOLUME_MODE=hostPath instead.`,
    );
  }
  const relative = mount.hostPath
    .slice(root.hostRoot.length)
    .replace(/^\/+/, '');
  const subPath = relative
    ? `${root.subPathPrefix}/${relative}`
    : root.subPathPrefix;

  return {
    volume: { name: volumeName, persistentVolumeClaim: { claimName: pvcName } },
    volumeMount: {
      name: volumeName,
      mountPath: mount.containerPath,
      readOnly: mount.readonly,
      subPath,
    },
  };
}

/**
 * Converts a docker --memory-style value ("2g", "512m", "1024") to a
 * Kubernetes memory quantity. Docker's suffixes (g/m/k, case-insensitive) are
 * treated here as binary (Gi/Mi/Ki) since that's how Docker itself interprets
 * them — this is a direct suffix remap, not a unit-conversion (1g docker ==
 * 1Gi k8s), so a value round-trips exactly.
 */
export function toK8sMemoryQuantity(value: string): string {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmMgG]?)(i?)b?$/);
  if (!m) return value; // pass through unrecognized formats rather than fail
  const [, num, unit] = m;
  const suffix: Record<string, string> = {
    '': '', // bare number = bytes, same in both
    k: 'Ki',
    K: 'Ki',
    m: 'Mi',
    M: 'Mi',
    g: 'Gi',
    G: 'Gi',
  };
  return `${num}${suffix[unit] ?? ''}`;
}

/**
 * Converts a docker --cpus-style value ("2", "1.5", "500m") to a Kubernetes
 * CPU quantity. Kubernetes accepts the exact same syntax (bare core count or
 * millicpu with an "m" suffix), so this is a passthrough — kept as a named
 * function for symmetry with toK8sMemoryQuantity and so call sites read the
 * same way; it also gives one place to add validation later.
 */
export function toK8sCpuQuantity(value: string): string {
  return value.trim();
}

/** Logged once at process start when AGENT_CONTAINER_PIDS_LIMIT is set under
 * CONTAINER_RUNTIME=kubernetes — see docs/KUBERNETES.md "pids-limit has no
 * Kubernetes equivalent". Exported so container-runner.ts (or index.ts) can
 * call it exactly once at startup instead of on every pod spec build. */
export function warnPidsLimitUnsupported(pidsLimit: string): void {
  logger.warn(
    { pidsLimit },
    'AGENT_CONTAINER_PIDS_LIMIT has no Kubernetes equivalent (no per-pod pids-limit API) — ' +
      'ignored under CONTAINER_RUNTIME=kubernetes. Set the kubelet --pod-max-pids flag ' +
      'cluster-wide instead. See docs/KUBERNETES.md.',
  );
}

/**
 * Builds the full Pod spec JSON passed to `kubectl run --overrides=<json>`.
 * Pure function: no fs/network access, fully deterministic given its inputs,
 * which is what makes it unit-testable without a live cluster.
 *
 * Notes on shape:
 * - apiVersion/kind wrap a partial Pod so --overrides can patch metadata.labels
 *   and spec.* independent of whatever kubectl run's own flags would generate.
 * - restartPolicy is always "Never" (mirrors docker's --rm — a run pod is not
 *   meant to restart in place; the caller re-invokes for retries).
 * - env entries with valueFromProcessEnv=true are NOT resolved here — see
 *   buildKubectlRunArgs for why (matches container-runner.ts's existing
 *   "-e NAME" no-value passthrough pattern for secrets, keeping them out of
 *   any JSON that might get logged).
 */
export function buildK8sPodOverrides(
  opts: BuildPodOverridesOptions,
): Record<string, unknown> {
  const pvcRoots: PvcRootMapping[] = opts.pvcRoots ?? [];
  const volumes: Record<string, unknown>[] = [];
  const volumeMounts: Record<string, unknown>[] = [];

  opts.mounts.forEach((mount, i) => {
    const translated = translateMountForK8s(
      mount,
      opts.volumeMode,
      i,
      pvcRoots,
      opts.pvcName,
    );
    volumes.push(translated.volume);
    volumeMounts.push(translated.volumeMount);
  });

  const envList = opts.env
    .filter((e) => !e.valueFromProcessEnv)
    .map((e) => ({ name: e.name, value: e.value ?? '' }));

  const resources: Record<string, unknown> = {};
  if (opts.resources?.memory || opts.resources?.cpus) {
    const limits: Record<string, string> = {};
    if (opts.resources.memory) {
      limits.memory = toK8sMemoryQuantity(opts.resources.memory);
    }
    if (opts.resources.cpus) {
      limits.cpu = toK8sCpuQuantity(opts.resources.cpus);
    }
    resources.limits = limits;
    // Guaranteed QoS by default: requests == limits. See docs/KUBERNETES.md
    // "Resource limits".
    resources.requests = { ...limits };
  }

  const securityContext: Record<string, unknown> = {};
  if (opts.runAsUser != null) securityContext.runAsUser = opts.runAsUser;
  if (opts.runAsGroup != null) securityContext.runAsGroup = opts.runAsGroup;

  const container: Record<string, unknown> = {
    name: opts.podName,
    image: opts.image,
    stdin: true,
    stdinOnce: true,
    tty: false,
    env: envList,
    volumeMounts,
  };
  if (Object.keys(resources).length > 0) container.resources = resources;
  if (Object.keys(securityContext).length > 0) {
    container.securityContext = securityContext;
  }

  const spec: Record<string, unknown> = {
    restartPolicy: 'Never',
    containers: [container],
    volumes,
  };
  // Pod-level fsGroup: chowns mounted (PVC) volumes to this gid so the non-root
  // agent can write to a root-owned backing volume. Container-level runAsUser/
  // runAsGroup control the process identity; fsGroup is intentionally
  // pod-level because it applies to volumes, not the process. See the option's
  // doc comment for the EACCES rationale.
  if (opts.fsGroup != null) {
    spec.securityContext = { fsGroup: opts.fsGroup };
  }
  if (opts.volumeMode === 'hostPath') {
    if (!opts.nodeName) {
      throw new Error(
        'buildK8sPodOverrides: nodeName is required when volumeMode is "hostPath"',
      );
    }
    spec.nodeName = opts.nodeName;
  }

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: opts.podName,
      labels: { app: 'nanoclaw-agent', ...opts.labels },
    },
    spec,
  };
}

/**
 * Builds the `kubectl run ...` argv, mirroring buildContainerArgs' docker
 * `run -i --rm ...` in container-runner.ts. Env vars flagged
 * valueFromProcessEnv are passed as bare `--env NAME` equivalents via the
 * overrides env list being left empty for them; kubectl run has no
 * name-only passthrough like `docker run -e NAME`, so instead those values
 * are expected to already be resolved into the pod overrides' env list by
 * the caller for secrets that must reach the pod — see container-runner.ts's
 * buildSpawnCommand for how this is composed. This function itself only
 * assembles the CLI invocation, not the secret-handling policy.
 */
export function buildKubectlRunArgs(opts: {
  podName: string;
  image: string;
  namespace: string;
  overrides: Record<string, unknown>;
}): string[] {
  const args = [
    'run',
    opts.podName,
    '--image',
    opts.image,
    '--rm',
    '-i',
    '--restart=Never',
  ];
  if (opts.namespace) {
    args.push('--namespace', opts.namespace);
  }
  args.push('--overrides', JSON.stringify(opts.overrides));
  return args;
}

/** Args for `kubectl delete pod <name> --grace-period=1 --now`, the k8s
 * equivalent of `docker stop -t 1 <name>`. */
export function buildDeletePodArgs(
  podName: string,
  namespace: string,
): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(podName)) {
    throw new Error(`Invalid pod name: ${podName}`);
  }
  const args = ['delete', 'pod', podName, '--grace-period=1', '--now'];
  if (namespace) args.push('--namespace', namespace);
  return args;
}

/** Args for listing orphaned agent pods by label, the k8s equivalent of
 * `docker ps --filter name=nanoclaw-`. */
export function buildListOrphanPodsArgs(namespace: string): string[] {
  const args = [
    'get',
    'pods',
    '-l',
    'app=nanoclaw-agent',
    '-o',
    'jsonpath={.items[*].metadata.name}',
  ];
  if (namespace) args.push('--namespace', namespace);
  return args;
}

/**
 * Args for the startup cluster-reachability check — the k8s equivalent of
 * `docker info`.
 *
 * Uses `kubectl auth can-i create pods [--namespace <ns>]` rather than
 * `kubectl cluster-info`. `cluster-info` lists Services in `kube-system`, which
 * a per-tenant orchestrator's namespaced Role does NOT permit — it crash-loops
 * at boot with "services is forbidden ... in the namespace kube-system". A
 * tenant ServiceAccount must never have cluster-wide/kube-system read, so the
 * check itself must live within the namespaced Role. `auth can-i` is answered
 * by a SelfSubjectAccessReview (always creatable by any authenticated user) and
 * checks the EXACT permission the backend needs to spawn agent pods — so it
 * doubles as an RBAC-misconfiguration check. It prints "yes"/"no" and exits
 * non-zero (with --quiet) when the answer is "no" or the API is unreachable.
 */
export function buildClusterCheckArgs(namespace = ''): string[] {
  const args = ['auth', 'can-i', 'create', 'pods', '--quiet'];
  if (namespace) args.push('--namespace', namespace);
  return args;
}
