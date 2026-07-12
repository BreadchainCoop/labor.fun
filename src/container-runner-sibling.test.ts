import { describe, it, expect } from 'vitest';

import {
  parseSelfMounts,
  siblingMountSource,
  translateSiblingHostPath,
} from './container-runner.js';

// A realistic orchestrator mount table (docker inspect .Mounts) for the TEE
// compose: labor-profiles at /app/profiles, with labor-store/labor-data mounted
// OVER subpaths, plus the docker + dstack sockets.
const INSPECT_JSON = JSON.stringify([
  {
    Type: 'volume',
    Name: 'tee_labor-profiles',
    Source: '/var/lib/docker/volumes/tee_labor-profiles/_data',
    Destination: '/app/profiles',
  },
  {
    Type: 'volume',
    Name: 'tee_labor-store',
    Source: '/var/lib/docker/volumes/tee_labor-store/_data',
    Destination: '/app/profiles/decentral-park/store',
  },
  {
    Type: 'volume',
    Name: 'tee_labor-data',
    Source: '/var/lib/docker/volumes/tee_labor-data/_data',
    Destination: '/app/profiles/decentral-park/data',
  },
  {
    Type: 'bind',
    Source: '/var/run/docker.sock',
    Destination: '/var/run/docker.sock',
  },
]);

describe('parseSelfMounts', () => {
  it('maps destination→source and sorts longest-destination-first', () => {
    const m = parseSelfMounts(INSPECT_JSON);
    expect(m.map((x) => x.dest)).toEqual([
      // the two deeper (nested-volume) destinations must come before /app/profiles
      '/app/profiles/decentral-park/store',
      '/app/profiles/decentral-park/data',
      '/var/run/docker.sock',
      '/app/profiles',
    ]);
    expect(m[0].src).toBe('/var/lib/docker/volumes/tee_labor-store/_data');
  });

  it('returns [] for malformed / non-array json', () => {
    expect(parseSelfMounts('not json')).toEqual([]);
    expect(parseSelfMounts('{}')).toEqual([]);
  });

  it('drops entries missing Destination or Source', () => {
    const m = parseSelfMounts(
      JSON.stringify([
        { Destination: '/x' },
        { Source: '/y' },
        { Destination: '/z', Source: '/host/z' },
      ]),
    );
    expect(m).toEqual([{ dest: '/z', src: '/host/z' }]);
  });
});

describe('translateSiblingHostPath', () => {
  const self = parseSelfMounts(INSPECT_JSON);

  it('translates a group folder (on labor-profiles) to the host volume path', () => {
    expect(
      translateSiblingHostPath(
        '/app/profiles/decentral-park/groups/signal_ron',
        self,
      ),
    ).toBe(
      '/var/lib/docker/volumes/tee_labor-profiles/_data/decentral-park/groups/signal_ron',
    );
  });

  it('prefers the deeper nested volume (store) over /app/profiles', () => {
    expect(
      translateSiblingHostPath('/app/profiles/decentral-park/store', self),
    ).toBe('/var/lib/docker/volumes/tee_labor-store/_data');
    // and a file under the store subtree
    expect(
      translateSiblingHostPath(
        '/app/profiles/decentral-park/data/sessions/x',
        self,
      ),
    ).toBe('/var/lib/docker/volumes/tee_labor-data/_data/sessions/x');
  });

  it('translates an exact destination to its source with no trailing slash', () => {
    expect(translateSiblingHostPath('/app/profiles', self)).toBe(
      '/var/lib/docker/volumes/tee_labor-profiles/_data',
    );
  });

  it('passes /dev/null and unmapped paths through unchanged', () => {
    expect(translateSiblingHostPath('/dev/null', self)).toBe('/dev/null');
    expect(translateSiblingHostPath('/app', self)).toBe('/app'); // image dir, not a mount
    expect(translateSiblingHostPath('/etc/hosts', self)).toBe('/etc/hosts');
  });

  it('does not translate a path that merely shares a prefix string', () => {
    // /app/profiles-backup must NOT match /app/profiles
    expect(translateSiblingHostPath('/app/profiles-backup/x', self)).toBe(
      '/app/profiles-backup/x',
    );
  });

  it('empty self-mount table => everything passes through (safe degradation)', () => {
    expect(
      translateSiblingHostPath('/app/profiles/decentral-park/groups/g', []),
    ).toBe('/app/profiles/decentral-park/groups/g');
  });
});

describe('siblingMountSource (skip image-dir mounts)', () => {
  const self = parseSelfMounts(INSPECT_JSON);
  const IMAGE_ROOT = '/app';

  it('translates a volume-backed source', () => {
    expect(
      siblingMountSource(
        '/app/profiles/decentral-park/groups/signal_ron',
        self,
        IMAGE_ROOT,
      ),
    ).toBe(
      '/var/lib/docker/volumes/tee_labor-profiles/_data/decentral-park/groups/signal_ron',
    );
  });

  it('SKIPS the project-root image dir (returns null)', () => {
    expect(siblingMountSource('/app', self, IMAGE_ROOT)).toBeNull();
  });

  it('SKIPS an untranslated path under the image dir (e.g. baked rules)', () => {
    expect(siblingMountSource('/app/rules', self, IMAGE_ROOT)).toBeNull();
  });

  it('keeps /dev/null and genuine external host paths', () => {
    expect(siblingMountSource('/dev/null', self, IMAGE_ROOT)).toBe('/dev/null');
    expect(siblingMountSource('/etc/gws-creds.json', self, IMAGE_ROOT)).toBe(
      '/etc/gws-creds.json',
    );
  });

  it('does not skip a sibling dir that only shares a prefix string', () => {
    expect(siblingMountSource('/app-data/x', self, IMAGE_ROOT)).toBe(
      '/app-data/x',
    );
  });
});
