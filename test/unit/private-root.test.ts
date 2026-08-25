import path from 'node:path';
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
