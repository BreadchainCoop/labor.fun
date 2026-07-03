import { describe, it, expect, vi, beforeEach } from 'vitest';

// Exercises container-runtime.ts's CONTAINER_RUNTIME=kubernetes branch —
// stopContainer/ensureContainerRuntimeRunning/cleanupOrphans dispatching to
// kubectl instead of docker. A separate file from container-runtime.test.ts
// because that file relies on the real (docker-default) config module;
// mocking config here to 'kubernetes' would change behavior for every test
// in this suite if combined into one file.
vi.mock('./config.js', () => ({
  CONTAINER_RUNTIME: 'kubernetes',
  K8S_NAMESPACE: 'tenant-acme',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('container-runtime kubernetes dispatch', () => {
  it('stopContainer runs kubectl delete pod, not docker stop', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(
      'kubectl delete pod nanoclaw-test-123 --grace-period=1 --now --namespace tenant-acme',
      { stdio: 'pipe' },
    );
  });

  it('stopContainer still rejects unsafe names before touching kubectl', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow(
      'Invalid container name',
    );
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('ensureContainerRuntimeRunning checks kubectl cluster-info', () => {
    mockExecSync.mockReturnValueOnce('');
    ensureContainerRuntimeRunning();
    expect(mockExecSync).toHaveBeenCalledWith('kubectl cluster-info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith('Kubernetes cluster reachable');
  });

  it('ensureContainerRuntimeRunning throws when the cluster is unreachable', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('connection refused');
    });
    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
  });

  it('cleanupOrphans lists pods by label selector and deletes each', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1 nanoclaw-b-2');
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenNthCalledWith(
      1,
      'kubectl get pods -l app=nanoclaw-agent -o jsonpath={.items[*].metadata.name} --namespace tenant-acme',
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      'kubectl delete pod nanoclaw-a-1 --grace-period=1 --now --namespace tenant-acme',
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      'kubectl delete pod nanoclaw-b-2 --grace-period=1 --now --namespace tenant-acme',
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });

  it('cleanupOrphans does nothing when no pods match the label', () => {
    mockExecSync.mockReturnValueOnce('');
    cleanupOrphans();
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
