import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCOUNT_REFERENCE,
  DEFAULT_TEMPLATE,
  DEFAULT_TOKEN_REFERENCE,
  parseArgs,
  parseTemplate,
} from '../../scripts/put-secret';

describe('parseArgs', () => {
  it('takes exactly one upper-case secret name', () => {
    expect(parseArgs(['ANTHROPIC_API_KEY'])).toEqual({
      name: 'ANTHROPIC_API_KEY',
      template: DEFAULT_TEMPLATE,
      tokenReference: DEFAULT_TOKEN_REFERENCE,
      accountReference: DEFAULT_ACCOUNT_REFERENCE,
    });
    expect(() => parseArgs([])).toThrow('secret name');
    expect(() => parseArgs(['lower'])).toThrow('secret name');
    expect(() => parseArgs(['A', 'B'])).toThrow('Exactly one');
  });

  it('accepts reference and template overrides', () => {
    const options = parseArgs([
      '--template',
      't.tpl',
      'X',
      '--token-reference',
      'op://v/i/t',
      '--account-reference',
      'op://v/i/a',
    ]);
    expect(options.template).toBe('t.tpl');
    expect(options.tokenReference).toBe('op://v/i/t');
    expect(options.accountReference).toBe('op://v/i/a');
    expect(() => parseArgs(['X', '--nope', 'y'])).toThrow('Unknown argument');
    expect(() => parseArgs(['X', '--template'])).toThrow('requires a value');
  });
});

describe('parseTemplate', () => {
  it('maps declared names to their op references and ignores everything else', () => {
    const references = parseTemplate(
      [
        'A={{ op://Ashebrook/Item One/A }}',
        'B = {{op://Ashebrook/Item Two/B}}',
        '# comment',
        'PLAIN=value',
        'BAD={{ not-a-reference }}',
        '',
      ].join('\r\n'),
    );
    expect([...references]).toEqual([
      ['A', 'op://Ashebrook/Item One/A'],
      ['B', 'op://Ashebrook/Item Two/B'],
    ]);
  });
});
