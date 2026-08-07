import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GENERATED_SKILL_COMMENT,
  diff,
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
    expect(out).toContain('developer_instructions = """');
    expect(out).toContain('You keep documentation current.');
    expect(out).not.toContain('tools =');
    expect(out).not.toContain('model =');
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

  it('unlinks a generated-tree junction without deleting its target', () => {
    const root = fixtureRepo();
    const external = path.join(root, 'junction-target');
    write(root, 'junction-target/keep.txt', 'keep');
    write(root, '.agents/skills/demo/SKILL.md', skillSource);
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
  it('matches only authored inputs in either path spelling', () => {
    expect(isAuthoredPath('.agents/skills/ship/SKILL.md')).toBe(true);
    expect(isAuthoredPath('.claude/agents/docs-updater.md')).toBe(true);
    expect(isAuthoredPath('.agents\\skills\\ship\\SKILL.md')).toBe(true);
    expect(isAuthoredPath('.claude/skills/ship/SKILL.md')).toBe(false);
    expect(isAuthoredPath('.codex/agents/docs-updater.toml')).toBe(false);
  });
});
