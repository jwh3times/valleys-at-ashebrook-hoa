import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  REPO_ROOT,
  parseFrontmatter,
  yamlScalar,
  banner,
  renderSkillMirror,
  renderAgentMirror,
  isSourcePath,
  plan,
  diff,
  hasDrift,
  GENERATED_MARKER,
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

describe('parseFrontmatter', () => {
  it('reads flat key/value pairs and leaves the body untouched', () => {
    const { data, body } = parseFrontmatter(skillSource);
    expect(data).toEqual({ name: 'ship', description: 'Ship the branch.' });
    expect(body).toBe('# Ship\n\nDo the thing.');
  });

  it('folds a wrapped value back into its key', () => {
    const { data } = parseFrontmatter(
      '---\ndescription: one\n  two\nname: x\n---\n\nbody\n',
    );
    expect(data.description).toBe('one two');
    expect(data.name).toBe('x');
  });

  it('treats a file without frontmatter as all body', () => {
    expect(parseFrontmatter('just text\n')).toEqual({
      data: {},
      body: 'just text',
    });
  });
});

describe('yamlScalar', () => {
  it('leaves ordinary prose bare', () => {
    expect(yamlScalar('Ship the branch — open a PR.')).toBe(
      'Ship the branch — open a PR.',
    );
  });

  it('quotes a value that would otherwise parse as a mapping', () => {
    expect(yamlScalar('Use when: the branch is ready')).toBe(
      '"Use when: the branch is ready"',
    );
  });
});

describe('renderSkillMirror', () => {
  const out = renderSkillMirror(skillSource, '.claude/skills/ship/SKILL.md');

  it('keeps the frontmatter Codex reads', () => {
    expect(
      out.startsWith('---\nname: ship\ndescription: Ship the branch.\n---'),
    ).toBe(true);
  });

  it('stamps provenance under the frontmatter so pruning can identify it', () => {
    expect(out).toContain(GENERATED_MARKER);
    expect(out.indexOf(banner('.claude/skills/ship/SKILL.md'))).toBeGreaterThan(
      out.indexOf('---\nname'),
    );
  });

  it('preserves the body verbatim and ends with a single newline', () => {
    expect(out).toContain('# Ship\n\nDo the thing.');
    expect(out.endsWith('Do the thing.\n')).toBe(true);
  });
});

describe('renderAgentMirror', () => {
  const out = renderAgentMirror(agentSource, '.claude/agents/docs-updater.md');

  it('carries the name and description into the skill frontmatter', () => {
    expect(out).toContain('name: docs-updater');
    expect(out).toContain('description: Keeps the docs current.');
  });

  it('drops Claude-only frontmatter that Codex cannot honor', () => {
    expect(out).not.toContain('tools:');
    expect(out).not.toContain('model: sonnet');
  });

  it('explains that this is a delegated role with foreign tool names', () => {
    expect(out).toContain('**Delegated role.**');
    expect(out).toContain('.claude/agents/docs-updater.md');
    expect(out).toContain('use your equivalents');
  });

  it('preserves the instruction body', () => {
    expect(out).toContain('You keep documentation current.');
  });
});

describe('isSourcePath', () => {
  it('matches the sources and the mirror it generates', () => {
    expect(isSourcePath('.claude/agents/code-reviewer.md')).toBe(true);
    expect(isSourcePath('.claude/skills/ship/SKILL.md')).toBe(true);
    expect(isSourcePath('.agents/skills/ship/SKILL.md')).toBe(true);
  });

  // A hook payload carries whatever separator the machine Claude Code runs on
  // uses, so both spellings must resolve the same way wherever the tests run.
  it('resolves windows and posix absolute paths identically', () => {
    expect(isSourcePath('C:\\repo\\.claude\\agents\\x.md', 'C:\\repo')).toBe(
      true,
    );
    expect(isSourcePath('/repo/.claude/skills/ship/SKILL.md', '/repo')).toBe(
      true,
    );
    expect(isSourcePath('.claude\\agents\\x.md')).toBe(true);
  });

  it('accepts an absolute path inside this repo', () => {
    expect(
      isSourcePath(path.join(REPO_ROOT, '.claude', 'agents', 'x.md')),
    ).toBe(true);
  });

  it('ignores everything else', () => {
    expect(isSourcePath('src/pages/index.astro')).toBe(false);
    expect(isSourcePath('.claude/settings.json')).toBe(false);
    expect(isSourcePath('/somewhere/else/.claude/agents/x.md')).toBe(false);
  });
});

describe('the checked-in mirror', () => {
  it('covers every agent and skill exactly once', () => {
    const names = plan().map((p) => p.name);
    expect(names).toContain('ship');
    expect(names).toContain('code-reviewer');
    expect(names).toContain('docs-updater');
    expect(new Set(names).size).toBe(names.length);
  });

  it('is in sync with .claude/ — run `npm run agents:sync` if this fails', () => {
    expect(diff()).toEqual({
      missing: [],
      stale: [],
      extra: [],
      orphaned: [],
    });
    expect(hasDrift(diff())).toBe(false);
  });
});
