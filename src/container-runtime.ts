/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 *
 * This file is the Docker implementation (the default, self-hosted path).
 * The Kubernetes backend (CONTAINER_RUNTIME=kubernetes) lives in
 * container-runtime-k8s.ts — see docs/KUBERNETES.md for why it's a separate
 * module rather than branches sprinkled through this one.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { CONTAINER_RUNTIME, K8S_NAMESPACE } from './config.js';
import {
  buildClusterCheckArgs,
  buildDeletePodArgs,
  buildListOrphanPodsArgs,
} from './container-runtime-k8s.js';
import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 * Kubernetes: 0.0.0.0 — pods reach each other by pod IP, not host.docker.internal;
 *   binding 0.0.0.0 is safe here because it's scoped to the pod's own network
 *   namespace, not the node's. See docs/KUBERNETES.md "Credential proxy reachability".
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (CONTAINER_RUNTIME === 'kubernetes') return '0.0.0.0';
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/**
 * Env-gated `docker run` resource-limit flags: --memory (+ matching
 * --memory-swap so swap isn't unbounded), --cpus, --pids-limit. Each flag is
 * only added when its env var is set, so the default behavior (no limits) is
 * unchanged for existing installs. Values are passed through verbatim to
 * docker, which validates its own flag syntax (e.g. "512m", "1.5").
 */
export function resourceLimitArgs(): string[] {
  const args: string[] = [];
  const memory = process.env.AGENT_CONTAINER_MEMORY;
  if (memory) {
    args.push('--memory', memory, '--memory-swap', memory);
  }
  const cpus = process.env.AGENT_CONTAINER_CPUS;
  if (cpus) {
    args.push('--cpus', cpus);
  }
  const pidsLimit = process.env.AGENT_CONTAINER_PIDS_LIMIT;
  if (pidsLimit) {
    args.push('--pids-limit', pidsLimit);
  }
  return args;
}

/**
 * Stop a container/pod by name. Docker path unchanged (execSync + docker
 * stop). Under CONTAINER_RUNTIME=kubernetes this deletes the pod instead —
 * see container-runtime-k8s.ts's buildDeletePodArgs and
 * docs/KUBERNETES.md "Timeout/kill parity".
 */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  if (CONTAINER_RUNTIME === 'kubernetes') {
    const args = buildDeletePodArgs(name, K8S_NAMESPACE);
    execSync(`kubectl ${args.join(' ')}`, { stdio: 'pipe' });
    return;
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  if (CONTAINER_RUNTIME === 'kubernetes') {
    try {
      // Scope the reachability/permission check to the tenant namespace — see
      // buildClusterCheckArgs (auth can-i create pods) for why this replaced
      // cluster-info, which a namespaced tenant Role cannot run.
      execSync(`kubectl ${buildClusterCheckArgs(K8S_NAMESPACE).join(' ')}`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      logger.debug('Kubernetes cluster reachable and pod-create allowed');
      return;
    } catch (err) {
      logger.error(
        { err },
        'Failed to reach Kubernetes cluster or lacking pod-create permission',
      );
      throw new Error('Container runtime is required but failed to start', {
        cause: err,
      });
    }
  }
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill orphaned NanoClaw containers/pods from previous runs. */
export function cleanupOrphans(): void {
  try {
    let orphans: string[];
    if (CONTAINER_RUNTIME === 'kubernetes') {
      // jsonpath output is space-separated pod names, not newline-separated.
      const output = execSync(
        `kubectl ${buildListOrphanPodsArgs(K8S_NAMESPACE).join(' ')}`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
      );
      orphans = output.trim().split(/\s+/).filter(Boolean);
    } else {
      const output = execSync(
        `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
      );
      orphans = output.trim().split('\n').filter(Boolean);
    }
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
