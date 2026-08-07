import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GENERATED_SKILL_COMMENT,
  diff,
  hasDrift,
  isAuthoredPath,
  normalizeLf,
  parseFrontmatter,
  plan,
  renderCodexAgent,
  renderSkillMirror,
  sync,
} from '../../scripts/sync-agent-skills.ts';

const agentSource = `---
name: docs-updater
description: Keeps the docs current.
tools: Read, Write, Edit
model: sonnet
---

You keep documentation current.

Use the Grep tool to check.
`;

const skillSource = `---
name: ship
description: Ship the branch.
---

# Ship

Do the thing.
`;

const fixtureRoots: string[] = [];
const authoredRoots = ['.agents/skills', '.claude/agents'] as const;
const missingRootCliCases = authoredRoots.flatMap((missingRoot) => [
  { mode: 'check', args: ['--check'], missingRoot },
  { mode: 'write', args: [], missingRoot },
]);

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-agent-skills-'));
  fixtureRoots.push(root);
  return root;
}

function write(root: string, rel: string, contents: string | Buffer): void {
  const target = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function seedAuthoredSources(root: string): void {
  write(root, '.agents/skills/demo/SKILL.md', skillSource);
  write(root, '.claude/agents/docs-updater.md', agentSource);
}

function runFixtureCli(root: string, ...args: string[]) {
  const script = 'scripts/sync-agent-skills.ts';
  write(root, script, fs.readFileSync(path.resolve(script)));
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', path.join(root, script), ...args],
    { cwd: root, encoding: 'utf8' },
  );
}

function snapshotTree(root: string): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  const visit = (dir: string, prefix = ''): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(target, rel);
      } else if (entry.isFile()) {
        snapshot.set(rel, fs.readFileSync(target));
      }
    }
  };
  visit(root);
  return snapshot;
}

function snapshotGeneratedTrees(root: string): Map<string, Buffer> {
  return new Map(
    [...snapshotTree(root)].filter(
      ([rel]) =>
        rel.startsWith('.claude/skills/') || rel.startsWith('.codex/agents/'),
    ),
  );
}

function planned(
  plans: ReturnType<typeof plan>,
  target: string,
): Buffer | undefined {
  const root = target.startsWith('.claude/skills/')
    ? '.claude/skills'
    : target.startsWith('.codex/agents/')
      ? '.codex/agents'
      : '';
  const rel = target.slice(root.length + 1);
  return plans.find((candidate) => candidate.root === root)?.files.get(rel);
}

function parseJsonStringAssignment(source: string, key: string): string {
  const prefix = `${key} = `;
  const assignment = source.split('\n').find((line) => line.startsWith(prefix));
  if (!assignment) throw new Error(`Missing ${key} assignment`);
  return JSON.parse(assignment.slice(prefix.length)) as string;
}

describe('parseFrontmatter', () => {
  it('reads flat key/value pairs and leaves the body untouched', () => {
    const { data, body } = parseFrontmatter(skillSource);
    expect(data).toEqual({ name: 'ship', description: 'Ship the branch.' });
    expect(body).toBe('# Ship\n\nDo the thing.');
  });
});

describe('renderSkillMirror', () => {
  const crlfSkillSource = `---\r\nname: ship\r\ndescription: Ship the branch.\r\n---\r\n\r\n# Ship\r\n`;

  it('puts the generated YAML comment on line 2 and normalizes LF', () => {
    const out = renderSkillMirror(
      crlfSkillSource,
      '.agents/skills/ship/SKILL.md',
    ).toString('utf8');
    expect(out.split('\n').slice(0, 4)).toEqual([
      '---',
      '# GENERATED — do not edit. Source: .agents/skills/ship/SKILL.md',
      'name: ship',
      'description: Ship the branch.',
    ]);
    expect(out).not.toContain('\r');
    expect(parseFrontmatter(out).data.name).toBe('ship');
  });

  it('normalizes a lone carriage return', () => {
    expect(normalizeLf('a\rb\r\nc')).toBe('a\nb\nc');
    expect(GENERATED_SKILL_COMMENT).toBe('# GENERATED — do not edit. Source:');
  });
});

describe('renderCodexAgent', () => {
  it('renders current Codex custom-agent TOML fields', () => {
    const out = renderCodexAgent(
      agentSource,
      '.claude/agents/docs-updater.md',
    ).toString('utf8');
    expect(out).toContain('name = "docs-updater"');
    expect(out).toContain('description = "Keeps the docs current."');
    expect(parseJsonStringAssignment(out, 'developer_instructions')).toBe(
      'You keep documentation current.\n\nUse the Grep tool to check.',
    );
    expect(out).not.toContain('tools =');
    expect(out).not.toContain('model =');
  });

  it('round-trips JSON-compatible TOML scalar strings', () => {
    const source = `---
name: docs-"updater"\\source
description: Keeps "quoted" C:\\docs current.
---

Use sqliteTable\\( and "quoted" text.
Then continue.
`;

    const out = renderCodexAgent(
      source,
      '.claude/agents/docs-updater.md',
    ).toString('utf8');

    expect(parseJsonStringAssignment(out, 'name')).toBe(
      'docs-"updater"\\source',
    );
    expect(parseJsonStringAssignment(out, 'description')).toBe(
      'Keeps "quoted" C:\\docs current.',
    );
    expect(out).toContain(
      'developer_instructions = "Use sqliteTable\\\\( and \\"quoted\\" text.\\nThen continue."',
    );
    expect(parseJsonStringAssignment(out, 'developer_instructions')).toBe(
      'Use sqliteTable\\( and "quoted" text.\nThen continue.',
    );
  });
});

describe('generated-tree planning and synchronization', () => {
  it('plans every file in an authored skill and both generated trees', () => {
    const root = fixtureRepo();
    write(root, '.agents/skills/demo/SKILL.md', skillSource);
    write(
      root,
      '.agents/skills/demo/scripts/run.sh',
      Buffer.from([0, 1, 2, 255]),
    );
    write(root, '.claude/agents/docs-updater.md', agentSource);

    const plans = plan(root);
    expect(planned(plans, '.claude/skills/demo/SKILL.md')).toBeDefined();
    expect(planned(plans, '.claude/skills/demo/scripts/run.sh')).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    expect(planned(plans, '.codex/agents/docs-updater.toml')).toBeDefined();
  });

  it('rejects a linked authored skills root without traversing it', () => {
    const root = fixtureRepo();
    const external = path.join(root, 'external-skills');
    write(root, 'external-skills/demo/SKILL.md', skillSource);
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
    fs.symlinkSync(
      external,
      path.join(root, '.agents', 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => plan(root)).toThrow(
      'Authored tree contains unsupported link:',
    );
  });

  it('rejects a linked authored agents root without traversing it', () => {
    const root = fixtureRepo();
    const external = path.join(root, 'external-agents');
    write(root, 'external-agents/docs-updater.md', agentSource);
    fs.mkdirSync(path.join(root, '.agents', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.symlinkSync(
      external,
      path.join(root, '.claude', 'agents'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => plan(root)).toThrow(
      'Authored tree contains unsupported link:',
    );
  });

  it.each(authoredRoots)(
    'rejects a missing authored %s root during planning',
    (missingRoot) => {
      const root = fixtureRepo();
      seedAuthoredSources(root);
      fs.rmSync(path.join(root, ...missingRoot.split('/')), {
        recursive: true,
        force: true,
      });

      expect(() => plan(root)).toThrow(
        `Authored tree must be a real directory: ${path.join(root, ...missingRoot.split('/'))}`,
      );
    },
  );

  it.each(authoredRoots)(
    'rejects a non-directory authored %s root during planning',
    (invalidRoot) => {
      const root = fixtureRepo();
      seedAuthoredSources(root);
      fs.rmSync(path.join(root, ...invalidRoot.split('/')), {
        recursive: true,
        force: true,
      });
      write(root, invalidRoot, 'not a directory');

      expect(() => plan(root)).toThrow(
        `Authored tree must be a real directory: ${path.join(root, ...invalidRoot.split('/'))}`,
      );
    },
  );

  it.each(missingRootCliCases)(
    '$mode mode does not prune generated outputs when $missingRoot is missing',
    ({ args, missingRoot }) => {
      const root = fixtureRepo();
      seedAuthoredSources(root);
      sync(root);
      fs.rmSync(path.join(root, ...missingRoot.split('/')), {
        recursive: true,
        force: true,
      });
      const before = snapshotGeneratedTrees(root);

      const result = runFixtureCli(root, ...args);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `Authored tree must be a real directory: ${path.join(root, ...missingRoot.split('/'))}`,
      );
      expect(snapshotGeneratedTrees(root)).toEqual(before);
    },
  );

  it('reports missing, stale, and extraneous generated files without writing', () => {
    const root = fixtureRepo();
    seedAuthoredSources(root);
    write(root, '.claude/skills/demo/SKILL.md', 'stale');
    write(root, '.claude/skills/orphan/SKILL.md', 'extra');

    expect(diff(root)).toEqual({
      missing: ['.codex/agents/docs-updater.toml'],
      stale: ['.claude/skills/demo/SKILL.md'],
      extraneous: ['.claude/skills/orphan/SKILL.md'],
    });
  });

  it('leaves generated files unchanged when check mode reports drift', () => {
    const root = fixtureRepo();
    seedAuthoredSources(root);
    const before = snapshotTree(root);

    expect(hasDrift(diff(root))).toBe(true);
    expect(snapshotTree(root)).toEqual(before);
  });

  it('reports a generated-tree root junction without traversing it', () => {
    const root = fixtureRepo();
    const external = path.join(root, 'external-generated-skills');
    seedAuthoredSources(root);
    write(
      root,
      'external-generated-skills/demo/SKILL.md',
      renderSkillMirror(skillSource, '.agents/skills/demo/SKILL.md'),
    );
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.symlinkSync(
      external,
      path.join(root, '.claude', 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(diff(root)).toEqual({
      missing: [
        '.claude/skills/demo/SKILL.md',
        '.codex/agents/docs-updater.toml',
      ],
      stale: [],
      extraneous: ['.claude/skills'],
    });
  });

  it('reports a nested generated junction as drift without reading or deleting its target', () => {
    const root = fixtureRepo();
    const external = fixtureRepo();
    seedAuthoredSources(root);
    write(
      external,
      'SKILL.md',
      renderSkillMirror(skillSource, '.agents/skills/demo/SKILL.md'),
    );
    write(external, 'keep.txt', 'external target remains untouched');
    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync(
      external,
      path.join(root, '.claude', 'skills', 'demo'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const nestedGeneratedPath = path.join(root, '.claude', 'skills', 'demo');
    const attemptedExternalReads: string[] = [];
    const readFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
      target: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (
        typeof target !== 'number' &&
        path.resolve(target.toString()).startsWith(nestedGeneratedPath)
      ) {
        attemptedExternalReads.push(target.toString());
      }
      return Reflect.apply(readFileSync, fs, [target, ...args]);
    }) as typeof fs.readFileSync);

    try {
      expect(diff(root)).toEqual({
        missing: [
          '.claude/skills/demo/SKILL.md',
          '.codex/agents/docs-updater.toml',
        ],
        stale: [],
        extraneous: ['.claude/skills/demo'],
      });
    } finally {
      readSpy.mockRestore();
    }
    expect(attemptedExternalReads).toEqual([]);
    expect(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8')).toBe(
      'external target remains untouched',
    );
    expect(fs.readFileSync(path.join(external, 'SKILL.md'))).toEqual(
      renderSkillMirror(skillSource, '.agents/skills/demo/SKILL.md'),
    );
  });

  it('reports descendants of an intermediate generated file as drift', () => {
    const root = fixtureRepo();
    seedAuthoredSources(root);
    write(root, '.claude/skills/demo', 'not a directory');

    expect(diff(root)).toEqual({
      missing: [
        '.claude/skills/demo/SKILL.md',
        '.codex/agents/docs-updater.toml',
      ],
      stale: [],
      extraneous: ['.claude/skills/demo'],
    });
    expect(
      fs.readFileSync(path.join(root, '.claude', 'skills', 'demo'), 'utf8'),
    ).toBe('not a directory');
  });

  it('unlinks a generated-tree junction without deleting its target', () => {
    const root = fixtureRepo();
    const external = path.join(root, 'junction-target');
    write(root, 'junction-target/keep.txt', 'keep');
    write(root, '.agents/skills/demo/SKILL.md', skillSource);
    fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync(
      external,
      path.join(root, '.claude', 'skills', 'demo'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    sync(root);

    expect(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8')).toBe(
      'keep',
    );
    expect(
      fs
        .lstatSync(path.join(root, '.claude', 'skills', 'demo'))
        .isSymbolicLink(),
    ).toBe(false);
  });

  it('becomes a no-op when synchronized twice', () => {
    const root = fixtureRepo();
    seedAuthoredSources(root);

    sync(root);
    expect(sync(root)).toEqual({ written: [], removed: [] });
  });
});

describe('isAuthoredPath', () => {
  it('classifies only authored inputs as hook sources', () => {
    expect(isAuthoredPath('.agents/skills/ship/SKILL.md')).toBe(true);
    expect(isAuthoredPath('.claude/agents/docs-updater.md')).toBe(true);
    expect(isAuthoredPath('.agents\\skills\\ship\\SKILL.md')).toBe(true);
    expect(isAuthoredPath('.claude/skills/ship/SKILL.md')).toBe(false);
    expect(isAuthoredPath('.codex/agents/docs-updater.toml')).toBe(false);
    expect(isAuthoredPath('.claude/agents/docs-updater.txt')).toBe(false);
    expect(isAuthoredPath('.claude/agents/nested/docs-updater.md')).toBe(false);
  });
});

describe('repository hook integration', () => {
  it('runs the agent synchronizer after Claude writes', () => {
    const settings = JSON.parse(
      fs.readFileSync(path.resolve('.claude/settings.json'), 'utf8'),
    ) as {
      hooks: {
        PostToolUse: Array<{ hooks: Array<{ command: string }> }>;
      };
    };

    expect(
      settings.hooks.PostToolUse.flatMap((group) =>
        group.hooks.map((hook) => hook.command),
      ),
    ).toEqual([
      'node --experimental-strip-types scripts/sync-agent-skills.ts --hook',
    ]);
  });
});

describe('check-mode CLI output', () => {
  it('names both generated roots when drift is present', () => {
    const root = fixtureRepo();
    seedAuthoredSources(root);

    const result = runFixtureCli(root, '--check');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Generated agent trees (.claude/skills, .codex/agents) are out of sync:',
    );
  });

  it('names both generated roots when they are in sync', () => {
    const root = fixtureRepo();
    seedAuthoredSources(root);
    sync(root);

    const result = runFixtureCli(root, '--check');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Generated agent trees (.claude/skills, .codex/agents) are in sync.',
    );
  });
});
