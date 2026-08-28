import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  repositoryRootFromModuleUrl,
  resolvePrivatePath,
  resolvePrivateRoot,
} from '../../scripts/private-root';

const repositoryRoot = path.join(
  path.parse(process.cwd()).root,
  'workspace',
  'public',
);

describe('resolvePrivateRoot', () => {
  it('derives the default repository root from the resolver module', () => {
    const moduleUrl = pathToFileURL(
      path.join(repositoryRoot, 'scripts', 'private-root.ts'),
    ).href;
    expect(repositoryRootFromModuleUrl(moduleUrl)).toBe(repositoryRoot);
  });

  it('uses an explicit fallback for transformed non-file module URLs', () => {
    expect(
      repositoryRootFromModuleUrl(
        'http://vitest/private-root.ts',
        repositoryRoot,
      ),
    ).toBe(repositoryRoot);
  });

  it('defaults to the private directory inside the public repository', () => {
    expect(resolvePrivateRoot({ repositoryRoot })).toBe(
      path.resolve(repositoryRoot, 'private'),
    );
  });

  it('treats a blank override as the default', () => {
    expect(resolvePrivateRoot({ repositoryRoot, configuredRoot: '   ' })).toBe(
      path.resolve(repositoryRoot, 'private'),
    );
  });

  it('resolves a relative override from the public repository root', () => {
    expect(
      resolvePrivateRoot({ repositoryRoot, configuredRoot: '../records' }),
    ).toBe(path.resolve(repositoryRoot, '../records'));
  });

  it('preserves an absolute external root', () => {
    const externalRoot = path.resolve(
      repositoryRoot,
      '..',
      'encrypted-records',
    );
    expect(
      resolvePrivateRoot({ repositoryRoot, configuredRoot: externalRoot }),
    ).toBe(externalRoot);
  });
});

describe('resolvePrivatePath', () => {
  it('resolves child paths below the selected private root', () => {
    expect(
      resolvePrivatePath(['rag_corpus', 'import-manifest.json'], {
        repositoryRoot,
        configuredRoot: '../records',
      }),
    ).toBe(
      path.resolve(
        repositoryRoot,
        '../records/rag_corpus/import-manifest.json',
      ),
    );
  });
});

describe('private root language parity', () => {
  it('keeps the Python resolver aligned with the TypeScript contract', () => {
    const externalRoot = path.resolve(
      repositoryRoot,
      '..',
      'encrypted-records',
    );
    const configuredRoots = ['', '   ', '../records', externalRoot];
    const pythonProgram = [
      'import json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'from private_root import resolve_private_root',
      'values = json.loads(sys.argv[3])',
      'print(json.dumps([str(resolve_private_root(sys.argv[2], value)) for value in values]))',
    ].join('\n');
    const result = spawnSync(
      process.platform === 'win32' ? 'python' : 'python3',
      [
        '-c',
        pythonProgram,
        path.resolve(process.cwd(), 'scripts'),
        repositoryRoot,
        JSON.stringify(configuredRoots),
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      configuredRoots.map((configuredRoot) =>
        resolvePrivateRoot({ repositoryRoot, configuredRoot }),
      ),
    );
  });
});
