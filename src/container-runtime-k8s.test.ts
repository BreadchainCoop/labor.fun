import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  buildK8sPodOverrides,
  buildKubectlRunArgs,
  buildDeletePodArgs,
  buildListOrphanPodsArgs,
  buildClusterCheckArgs,
  translateMountForK8s,
  toK8sMemoryQuantity,
  toK8sCpuQuantity,
  warnPidsLimitUnsupported,
  type PvcRootMapping,
} from './container-runtime-k8s.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- toK8sMemoryQuantity ---

describe('toK8sMemoryQuantity', () => {
  it('converts g suffix to Gi', () => {
    expect(toK8sMemoryQuantity('2g')).toBe('2Gi');
    expect(toK8sMemoryQuantity('2G')).toBe('2Gi');
  });

  it('converts m suffix to Mi', () => {
    expect(toK8sMemoryQuantity('512m')).toBe('512Mi');
    expect(toK8sMemoryQuantity('512M')).toBe('512Mi');
  });

  it('converts k suffix to Ki', () => {
    expect(toK8sMemoryQuantity('1024k')).toBe('1024Ki');
  });

  it('passes bare numbers through unchanged (bytes)', () => {
    expect(toK8sMemoryQuantity('1048576')).toBe('1048576');
  });

  it('accepts decimal values', () => {
    expect(toK8sMemoryQuantity('1.5g')).toBe('1.5Gi');
  });

  it('passes through unrecognized formats rather than throwing', () => {
    expect(toK8sMemoryQuantity('not-a-value')).toBe('not-a-value');
  });
});

// --- toK8sCpuQuantity ---

describe('toK8sCpuQuantity', () => {
  it('passes bare core counts through unchanged', () => {
    expect(toK8sCpuQuantity('2')).toBe('2');
  });

  it('passes millicpu values through unchanged', () => {
    expect(toK8sCpuQuantity('500m')).toBe('500m');
  });

  it('trims whitespace', () => {
    expect(toK8sCpuQuantity(' 1.5 ')).toBe('1.5');
  });
});

// --- warnPidsLimitUnsupported ---

describe('warnPidsLimitUnsupported', () => {
  it('logs a warning with the ignored value', () => {
    warnPidsLimitUnsupported('256');
    expect(logger.warn).toHaveBeenCalledWith(
      { pidsLimit: '256' },
      expect.stringContaining('no Kubernetes equivalent'),
    );
  });
});

// --- translateMountForK8s ---

describe('translateMountForK8s', () => {
  it('hostPath mode: passes the absolute host path straight through', () => {
    const result = translateMountForK8s(
      {
        hostPath: '/data/groups/acme',
        containerPath: '/workspace/group',
        readonly: false,
      },
      'hostPath',
      0,
      [],
    );
    expect(result.volume).toEqual({
      name: 'v0',
      hostPath: { path: '/data/groups/acme', type: 'DirectoryOrCreate' },
    });
    expect(result.volumeMount).toEqual({
      name: 'v0',
      mountPath: '/workspace/group',
      readOnly: false,
    });
  });

  it('hostPath mode: marks readonly mounts', () => {
    const result = translateMountForK8s(
      {
        hostPath: '/data/shared-kb',
        containerPath: '/workspace/shared-kb',
        readonly: true,
      },
      'hostPath',
      1,
      [],
    );
    expect(result.volumeMount).toMatchObject({ readOnly: true });
  });

  it('/dev/null mount becomes an emptyDir volume regardless of mode', () => {
    const result = translateMountForK8s(
      {
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      },
      'hostPath',
      2,
      [],
    );
    expect(result.volume).toEqual({ name: 'v2', emptyDir: {} });
    expect(result.volumeMount).toEqual({
      name: 'v2',
      mountPath: '/workspace/project/.env',
      readOnly: true,
    });
  });

  it('pvc mode: rewrites a host path under a known root to a subPath', () => {
    const roots: PvcRootMapping[] = [
      { hostRoot: '/profiles/acme', subPathPrefix: 'profile' },
    ];
    const result = translateMountForK8s(
      {
        hostPath: '/profiles/acme/groups/main/context',
        containerPath: '/workspace/shared-kb',
        readonly: true,
      },
      'pvc',
      0,
      roots,
      'nanoclaw-data',
    );
    expect(result.volume).toEqual({
      name: 'v0',
      persistentVolumeClaim: { claimName: 'nanoclaw-data' },
    });
    expect(result.volumeMount).toEqual({
      name: 'v0',
      mountPath: '/workspace/shared-kb',
      readOnly: true,
      subPath: 'profile/groups/main/context',
    });
  });

  it('pvc mode: exact root match uses the prefix with no trailing segment', () => {
    const roots: PvcRootMapping[] = [
      { hostRoot: '/profiles/acme', subPathPrefix: 'profile' },
    ];
    const result = translateMountForK8s(
      {
        hostPath: '/profiles/acme',
        containerPath: '/workspace/root',
        readonly: true,
      },
      'pvc',
      0,
      roots,
      'nanoclaw-data',
    );
    expect(result.volumeMount.subPath).toBe('profile');
  });

  it('pvc mode: throws when pvcName is missing', () => {
    expect(() =>
      translateMountForK8s(
        {
          hostPath: '/profiles/acme/x',
          containerPath: '/workspace/x',
          readonly: false,
        },
        'pvc',
        0,
        [{ hostRoot: '/profiles/acme', subPathPrefix: 'profile' }],
      ),
    ).toThrow(/pvcName is required/);
  });

  it('pvc mode: throws when the host path is outside every known root', () => {
    const roots: PvcRootMapping[] = [
      { hostRoot: '/profiles/acme', subPathPrefix: 'profile' },
    ];
    expect(() =>
      translateMountForK8s(
        {
          hostPath: '/etc/somewhere-else',
          containerPath: '/workspace/x',
          readonly: false,
        },
        'pvc',
        0,
        roots,
        'nanoclaw-data',
      ),
    ).toThrow(/does not fall under any known PVC root/);
  });

  it('pvc mode: does not false-positive match a root that is a string prefix but not a path prefix', () => {
    // /profiles/acme-extra should NOT match root /profiles/acme
    const roots: PvcRootMapping[] = [
      { hostRoot: '/profiles/acme', subPathPrefix: 'profile' },
    ];
    expect(() =>
      translateMountForK8s(
        {
          hostPath: '/profiles/acme-extra/x',
          containerPath: '/workspace/x',
          readonly: false,
        },
        'pvc',
        0,
        roots,
        'nanoclaw-data',
      ),
    ).toThrow(/does not fall under any known PVC root/);
  });
});

// --- buildK8sPodOverrides ---

describe('buildK8sPodOverrides', () => {
  it('builds a hostPath-mode pod spec with nodeName and translated volumes', () => {
    const overrides = buildK8sPodOverrides({
      podName: 'nanoclaw-acme-123',
      image: 'nanoclaw-agent:latest',
      mounts: [
        {
          hostPath: '/data/groups/acme',
          containerPath: '/workspace/group',
          readonly: false,
        },
        {
          hostPath: '/data/shared-kb',
          containerPath: '/workspace/shared-kb',
          readonly: true,
        },
      ],
      env: [{ name: 'TZ', value: 'UTC' }],
      volumeMode: 'hostPath',
      nodeName: 'node-1',
    });

    expect(overrides).toMatchObject({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'nanoclaw-acme-123',
        labels: { app: 'nanoclaw-agent' },
      },
    });
    const spec = (overrides as any).spec;
    expect(spec.restartPolicy).toBe('Never');
    expect(spec.nodeName).toBe('node-1');
    expect(spec.volumes).toHaveLength(2);
    expect(spec.volumes[0]).toEqual({
      name: 'v0',
      hostPath: { path: '/data/groups/acme', type: 'DirectoryOrCreate' },
    });
    expect(spec.containers[0].volumeMounts).toHaveLength(2);
    expect(spec.containers[0].env).toEqual([{ name: 'TZ', value: 'UTC' }]);
    expect(spec.containers[0].stdin).toBe(true);
    expect(spec.containers[0].stdinOnce).toBe(true);
  });

  it('throws when hostPath mode is missing nodeName', () => {
    expect(() =>
      buildK8sPodOverrides({
        podName: 'p',
        image: 'img',
        mounts: [],
        env: [],
        volumeMode: 'hostPath',
      }),
    ).toThrow(/nodeName is required/);
  });

  it('builds resources.limits and matching requests when memory/cpus are set', () => {
    const overrides: any = buildK8sPodOverrides({
      podName: 'p',
      image: 'img',
      mounts: [],
      env: [],
      volumeMode: 'hostPath',
      nodeName: 'node-1',
      resources: { memory: '2g', cpus: '1.5' },
    });
    const container = overrides.spec.containers[0];
    expect(container.resources.limits).toEqual({ memory: '2Gi', cpu: '1.5' });
    expect(container.resources.requests).toEqual({ memory: '2Gi', cpu: '1.5' });
  });

  it('omits resources entirely when no limits are set', () => {
    const overrides: any = buildK8sPodOverrides({
      podName: 'p',
      image: 'img',
      mounts: [],
      env: [],
      volumeMode: 'hostPath',
      nodeName: 'node-1',
    });
    expect(overrides.spec.containers[0].resources).toBeUndefined();
  });

  it('sets securityContext.runAsUser/runAsGroup when provided', () => {
    const overrides: any = buildK8sPodOverrides({
      podName: 'p',
      image: 'img',
      mounts: [],
      env: [],
      volumeMode: 'hostPath',
      nodeName: 'node-1',
      runAsUser: 1001,
      runAsGroup: 1001,
    });
    expect(overrides.spec.containers[0].securityContext).toEqual({
      runAsUser: 1001,
      runAsGroup: 1001,
    });
  });

  it('omits securityContext when runAsUser/runAsGroup are not provided', () => {
    const overrides: any = buildK8sPodOverrides({
      podName: 'p',
      image: 'img',
      mounts: [],
      env: [],
      volumeMode: 'hostPath',
      nodeName: 'node-1',
    });
    expect(overrides.spec.containers[0].securityContext).toBeUndefined();
  });

  it('filters out env entries flagged valueFromProcessEnv', () => {
    const overrides: any = buildK8sPodOverrides({
      podName: 'p',
      image: 'img',
      mounts: [],
      env: [
        { name: 'TZ', value: 'UTC' },
        { name: 'SECRET_NAME_ONLY', valueFromProcessEnv: true },
      ],
      volumeMode: 'hostPath',
      nodeName: 'node-1',
    });
    expect(overrides.spec.containers[0].env).toEqual([
      { name: 'TZ', value: 'UTC' },
    ]);
  });

  it('builds a pvc-mode pod spec without nodeName', () => {
    const overrides: any = buildK8sPodOverrides({
      podName: 'p',
      image: 'img',
      mounts: [
        {
          hostPath: '/profiles/acme/groups/main',
          containerPath: '/workspace/group',
          readonly: false,
        },
      ],
      env: [],
      volumeMode: 'pvc',
      pvcName: 'nanoclaw-data',
      pvcRoots: [{ hostRoot: '/profiles/acme', subPathPrefix: 'profile' }],
    });
    expect(overrides.spec.nodeName).toBeUndefined();
    expect(overrides.spec.volumes[0]).toMatchObject({
      persistentVolumeClaim: { claimName: 'nanoclaw-data' },
    });
    expect(overrides.spec.containers[0].volumeMounts[0]).toMatchObject({
      subPath: 'profile/groups/main',
    });
  });

  it('throws in pvc mode when pvcRoots is omitted and a mount needs translation', () => {
    expect(() =>
      buildK8sPodOverrides({
        podName: 'p',
        image: 'img',
        mounts: [
          {
            hostPath: '/profiles/acme/groups/main',
            containerPath: '/workspace/group',
            readonly: false,
          },
        ],
        env: [],
        volumeMode: 'pvc',
        pvcName: 'nanoclaw-data',
      }),
    ).toThrow(/does not fall under any known PVC root/);
  });
});

// --- buildKubectlRunArgs ---

describe('buildKubectlRunArgs', () => {
  it('builds run --rm -i --restart=Never with image, namespace, and overrides JSON', () => {
    const overrides = { apiVersion: 'v1', kind: 'Pod' };
    const args = buildKubectlRunArgs({
      podName: 'nanoclaw-acme-123',
      image: 'nanoclaw-agent:latest',
      namespace: 'tenant-acme',
      overrides,
    });
    expect(args).toEqual([
      'run',
      'nanoclaw-acme-123',
      '--image',
      'nanoclaw-agent:latest',
      '--rm',
      '-i',
      '--restart=Never',
      '--namespace',
      'tenant-acme',
      '--overrides',
      JSON.stringify(overrides),
    ]);
  });

  it('omits --namespace when namespace is empty (use kubeconfig default)', () => {
    const args = buildKubectlRunArgs({
      podName: 'p',
      image: 'img',
      namespace: '',
      overrides: {},
    });
    expect(args).not.toContain('--namespace');
  });
});

// --- buildDeletePodArgs ---

describe('buildDeletePodArgs', () => {
  it('builds delete pod args with grace-period=1 --now', () => {
    const args = buildDeletePodArgs('nanoclaw-acme-123', 'tenant-acme');
    expect(args).toEqual([
      'delete',
      'pod',
      'nanoclaw-acme-123',
      '--grace-period=1',
      '--now',
      '--namespace',
      'tenant-acme',
    ]);
  });

  it('omits --namespace when empty', () => {
    const args = buildDeletePodArgs('nanoclaw-acme-123', '');
    expect(args).not.toContain('--namespace');
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => buildDeletePodArgs('foo; rm -rf /', '')).toThrow(
      'Invalid pod name',
    );
    expect(() => buildDeletePodArgs('foo$(whoami)', '')).toThrow(
      'Invalid pod name',
    );
  });
});

// --- buildListOrphanPodsArgs ---

describe('buildListOrphanPodsArgs', () => {
  it('builds a label-selector list query', () => {
    const args = buildListOrphanPodsArgs('tenant-acme');
    expect(args).toEqual([
      'get',
      'pods',
      '-l',
      'app=nanoclaw-agent',
      '-o',
      'jsonpath={.items[*].metadata.name}',
      '--namespace',
      'tenant-acme',
    ]);
  });

  it('omits --namespace when empty', () => {
    const args = buildListOrphanPodsArgs('');
    expect(args).not.toContain('--namespace');
  });
});

// --- buildClusterCheckArgs ---

describe('buildClusterCheckArgs', () => {
  it('returns a namespaced auth can-i pod-create check with no namespace', () => {
    // No namespace: check reachability + pod-create permission in the current
    // context's default namespace (cluster-info would need kube-system read a
    // tenant Role lacks — see the function doc).
    expect(buildClusterCheckArgs()).toEqual([
      'auth',
      'can-i',
      'create',
      'pods',
      '--quiet',
    ]);
  });

  it('scopes the check to the given namespace', () => {
    expect(buildClusterCheckArgs('tenant-acme')).toEqual([
      'auth',
      'can-i',
      'create',
      'pods',
      '--quiet',
      '--namespace',
      'tenant-acme',
    ]);
  });
});
