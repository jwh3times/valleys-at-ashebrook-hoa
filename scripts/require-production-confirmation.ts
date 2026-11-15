import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type HookInput = {
  tool_name?: unknown;
  tool_input?: {
    command?: unknown;
    [field: string]: unknown;
  };
};

/** The shell whose syntax a command is read in. */
export type Shell = 'bash' | 'powershell';

function hasFlags(command: string, ...flags: string[]): boolean {
  return flags.every((flag) => command.includes(flag));
}

function shellWords(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((word) =>
    word.replace(/^(['"])(.*)\1$/, '$2'),
  );
}

function executableIndex(words: string[], executable: string): number {
  return words.findIndex((word) => {
    const basename = word.replaceAll('\\', '/').split('/').at(-1);
    return basename === executable || basename === `${executable}.cmd`;
  });
}

// Every word npm 12 resolves to `run` (its `deref` in `lib/utils/cmd-list.js`): the aliases
// `run-script`, `rum` and `urn`, and the unique abbreviations `ur` and `run-` through
// `run-scrip`. npm first turns camelCase into kebab-case, so `runScript` counts too.
const RUN_COMMAND =
  /^(?:run(?:-(?:s(?:c(?:r(?:i(?:p(?:t)?)?)?)?)?)?)?|rum|urn|ur)$/;

function isRunCommand(word: string): boolean {
  return RUN_COMMAND.test(
    word.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
  );
}

type NpmPositional = {
  word: string;
  /** It directly follows a flag written without `=`, so it may be that flag's value. */
  mayBeFlagValue: boolean;
};

/**
 * npm's arguments as its option parser reads them, without knowing which flags take a value:
 * the flags before the first bare `--`, and the positional words — every other word before it,
 * and every word after it, since `--` only ends npm's options. Commands are found among the
 * positional words by presence rather than position, because a value-taking flag such as
 * `--prefix <dir>` can stand between `npm` and its command (#588).
 */
function parseNpmArguments(argumentsAfterNpm: string[]): {
  flags: string[];
  positional: NpmPositional[];
} {
  const flags: string[] = [];
  const positional: NpmPositional[] = [];
  let endOfOptions = false;
  let afterFlag = false;
  for (const word of argumentsAfterNpm) {
    if (!endOfOptions && word === '--') {
      endOfOptions = true;
      afterFlag = false;
    } else if (!endOfOptions && word.startsWith('-')) {
      flags.push(word);
      afterFlag = !word.includes('=');
    } else {
      positional.push({ word, mayBeFlagValue: afterFlag });
      afterFlag = false;
    }
  }
  return { flags, positional };
}

/**
 * The words that could name the script an `npm run` command runs: the positional words after
 * `run` up to the first that cannot be a flag's value, which is the script name; the words after
 * it are the script's own arguments. Empty when the command runs no script. Callers match a gated
 * script name exactly among them, so a value-taking flag on either side of `run`
 * (`-w <workspace>`) cannot hide it; a folder or workspace named like a gated script only adds a
 * prompt (#588).
 */
function npmRunScriptCandidates(words: string[]): string[] {
  const npmIndex = executableIndex(words, 'npm');
  if (npmIndex < 0) return [];

  const { positional } = parseNpmArguments(words.slice(npmIndex + 1));
  const runIndex = positional.findIndex(({ word }) => isRunCommand(word));
  if (runIndex < 0) return [];

  const candidates: string[] = [];
  for (const { word, mayBeFlagValue } of positional.slice(runIndex + 1)) {
    candidates.push(word);
    // After npm's `--`, npm 12 takes even a flag-shaped word (`npm -- run --silent deploy`) as the
    // script name, so `deploy` never runs; looking past it anyway costs a prompt, never a miss.
    if (!mayBeFlagValue && !word.startsWith('-')) break;
  }
  return candidates;
}

const INSTALL_SCRIPTS_REASON =
  'let dependency install scripts run while production credentials are available';

// npm 12's settings that let dependency install scripts run despite the `allowScripts` policy:
// `allow-scripts` adds packages to it, `dangerously-allow-all-scripts` ignores it. Each can be a
// flag, an `npm config set` key, or an `npm_config_*` variable. `--allow-scripts-pending` and
// `--allow-scripts-pin` only list or pin, and `--no-…` turns a setting off, so none of them match.
const SCRIPT_SWITCH_FLAG =
  /^--(?:dangerously-allow-all-scripts|allow-scripts)(?:=|$)/i;
const SCRIPT_SWITCH_CONFIG_KEY =
  /^(?:dangerously-allow-all-scripts|allow-scripts)(?:=|$)/i;
const SCRIPT_SWITCH_VARIABLE =
  /^npm_config_(?:dangerously_allow_all_scripts|allow_scripts)=/i;

/**
 * Whether a command segment lets dependency install scripts run. Plain installs are not gated:
 * npm 12 blocks every dependency's install scripts until they are approved, so changing the
 * dependency tree runs no dependency code. Approving those scripts, or switching the policy off,
 * is what lets them run (#586). A `package.json` or `.npmrc` edited outside a command is left to
 * review of the diff.
 */
function enablesInstallScripts(words: string[]): boolean {
  // An exported or inline variable applies to whatever npm runs next in the same shell.
  if (words.some((word) => SCRIPT_SWITCH_VARIABLE.test(word))) return true;

  const npmIndex = executableIndex(words, 'npm');
  const npxIndex = executableIndex(words, 'npx');
  const commandIndex = npmIndex >= 0 ? npmIndex : npxIndex;
  if (commandIndex < 0) return false;

  // Flags after `--` belong to a script or binary, not to npm.
  const { flags, positional: positionalWords } = parseNpmArguments(
    words.slice(commandIndex + 1),
  );
  if (flags.some((word) => SCRIPT_SWITCH_FLAG.test(word))) return true;
  if (npmIndex < 0) return false;

  const positional = positionalWords.map(({ word }) => word);
  const after = (command: string): string[] => {
    const index = positional.indexOf(command);
    return index < 0 ? [] : positional.slice(index + 1);
  };

  if (positional.includes('approve-scripts')) {
    return !flags.includes('--allow-scripts-pending');
  }
  if (after('install-scripts')[0] === 'approve') return true;

  const config = after('config');
  if (config[0] === 'set') {
    return config.slice(1).some((word) => SCRIPT_SWITCH_CONFIG_KEY.test(word));
  }
  const pkg = after('pkg');
  if (pkg[0] === 'set') {
    return pkg.slice(1).some((word) => /^allowScripts(?:[.[=]|$)/.test(word));
  }
  return false;
}

function wranglerArguments(words: string[]): string[] | null {
  const wranglerIndex = executableIndex(words, 'wrangler');
  return wranglerIndex < 0 ? null : words.slice(wranglerIndex + 1);
}

function isReadOnlyWrangler(argumentsAfterWrangler: string[]): boolean {
  const command = argumentsAfterWrangler.join(' ');

  if (/^(?:--help|-h|--version|-v)(?:\s|$)/.test(command)) return true;
  if (/(?:^|\s)(?:--help|-h|--version)(?:\s|$)/.test(command)) return true;
  if (/(?:^|\s)--dry-run(?:\s|$)/.test(command)) return true;
  if (/^(?:whoami|tail|types|docs|check)(?:\s|$)/.test(command)) return true;
  if (
    /^dev(?:\s|$)/.test(command) &&
    !/(?:^|\s)--remote(?:\s|$)/.test(command)
  ) {
    return true;
  }
  if (/^d1\s+(?:list|info|export)(?:\s|$)/.test(command)) return true;
  if (/^d1\s+migrations\s+(?:list|create)(?:\s|$)/.test(command)) {
    return true;
  }
  if (
    /^d1\s+(?:execute|migrations\s+apply)(?:\s|$)/.test(command) &&
    /(?:^|\s)--local(?:\s|$)/.test(command) &&
    !/(?:^|\s)--remote(?:\s|$)/.test(command)
  ) {
    return true;
  }
  if (/^secret\s+list(?:\s|$)/.test(command)) return true;
  if (/^kv\s+(?:namespace\s+list|key\s+(?:get|list))(?:\s|$)/.test(command)) {
    return true;
  }
  if (/^r2\s+(?:bucket\s+(?:list|info)|object\s+get)(?:\s|$)/.test(command)) {
    return true;
  }
  if (/^vectorize\s+(?:list|get|query)(?:\s|$)/.test(command)) return true;
  if (/^hyperdrive\s+(?:list|get)(?:\s|$)/.test(command)) return true;
  if (/^queues\s+(?:list|info)(?:\s|$)/.test(command)) return true;
  if (/^containers\s+(?:list|info)(?:\s|$)/.test(command)) return true;
  if (/^containers\s+(?:images|registries)\s+list(?:\s|$)/.test(command)) {
    return true;
  }
  if (/^workflows\s+(?:list|describe)(?:\s|$)/.test(command)) return true;
  if (/^workflows\s+instances\s+(?:list|describe)(?:\s|$)/.test(command)) {
    return true;
  }
  if (/^pipelines\s+(?:list|show)(?:\s|$)/.test(command)) return true;
  if (
    /^secrets-store\s+(?:store\s+list|secret\s+(?:list|get))(?:\s|$)/.test(
      command,
    )
  ) {
    return true;
  }
  if (/^pages\s+(?:project|deployment)\s+list(?:\s|$)/.test(command)) {
    return true;
  }

  return false;
}

/**
 * Classify shell commands that may change production or expose its credentials to new code.
 * The hook asks the user rather than denying them: agents are authorized production operators,
 * but the decision to perform each high-impact mutation stays with the user.
 */
export function productionConfirmationReason(
  command: string,
  shell: Shell = 'bash',
): string | null {
  if (shell === 'powershell') return powerShellConfirmationReason(command);
  const segments = command.split(/\s*(?:&&|\|\||[;|])\s*/);
  for (const segment of segments) {
    const reason = productionConfirmationReasonForSegment(segment);
    if (reason) return reason;
  }
  return null;
}

function productionConfirmationReasonForSegment(
  command: string,
): string | null {
  const normalized = command.replace(/\s+/g, ' ').trim();
  return productionConfirmationReasonForWords(
    shellWords(normalized),
    normalized,
  );
}

/**
 * The gates, applied to one command: its words as the shell hands them to the program, and its
 * text, which the flag gates (`--commit`, `--remote --write`) and the direct-script gate read.
 */
function productionConfirmationReasonForWords(
  words: string[],
  normalized: string,
): string | null {
  if (enablesInstallScripts(words)) return INSTALL_SCRIPTS_REASON;

  const scriptCandidates = npmRunScriptCandidates(words);
  const runs = (script: string): boolean => scriptCandidates.includes(script);

  if (runs('deploy')) {
    return 'deploy the application to production';
  }
  if (runs('db:migrate:remote')) {
    return 'apply migrations to production D1';
  }
  if (runs('secrets:put')) {
    return 'replace a production Worker secret';
  }

  const productionImport = new Set([
    'corpus:import',
    'docs:import',
    'docs:dedupe',
    'ocr:scanned',
  ]);
  if (
    scriptCandidates.some((script) => productionImport.has(script)) &&
    /--(?:commit|wipe)\b/.test(normalized)
  ) {
    return 'write or clean-replace production document data';
  }

  if (runs('roster:backfill') && hasFlags(normalized, '--remote', '--write')) {
    return 'write production roster or access-audit data';
  }

  const directScript =
    /\bscripts[\\/](?:put-secret|import-corpus|import-documents|dedupe-documents|ocr-scanned|migrate-roster)\.ts\b/;
  if (
    directScript.test(normalized) &&
    (/put-secret\.ts\b/.test(normalized) ||
      /--(?:commit|wipe)\b/.test(normalized) ||
      hasFlags(normalized, '--remote', '--write'))
  ) {
    return 'invoke a production-mutating operator script directly';
  }

  const wrangler = wranglerArguments(words);
  if (wrangler) {
    const wranglerCommand = wrangler.join(' ');
    if (
      /^(?:deploy|delete|rollback)(?:\s|$)/.test(wranglerCommand) &&
      !/(?:^|\s)--dry-run(?:\s|$)/.test(wranglerCommand)
    ) {
      return 'change or remove a production Worker deployment';
    }
    if (/^versions\s+deploy(?:\s|$)/.test(wranglerCommand)) {
      return 'change the production Worker version';
    }
    if (
      /^d1\s+(?:execute|migrations\s+apply)(?:\s|$)/.test(wranglerCommand) &&
      /(?:^|\s)--remote(?:\s|$)/.test(wranglerCommand)
    ) {
      return 'write or migrate production D1';
    }
    if (/^secret\s+(?:put|bulk|delete)(?:\s|$)/.test(wranglerCommand)) {
      return 'change production Worker secrets';
    }
    if (!isReadOnlyWrangler(wrangler)) {
      return 'perform a Cloudflare management operation that is not classified as read-only';
    }
  }

  return null;
}

class PowerShellParseError extends Error {}

// PowerShell takes typographic quotes as string delimiters, and en and em dashes and the horizontal
// bar as a parameter's dash.
const POWERSHELL_SINGLE_QUOTES = "'‘’‚‛";
const POWERSHELL_DOUBLE_QUOTES = '"“”„';

// The escape sequences PowerShell expands in double-quoted strings; any other escaped character
// stands for itself.
const POWERSHELL_ESCAPES: Readonly<Record<string, string>> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

/** Whether `char` is one of `set`. Past the end, `peek()` gives `''`, which `includes` accepts. */
function isOneOf(set: string, char: string): boolean {
  return char !== '' && set.includes(char);
}

/**
 * Reads a PowerShell command line into the commands it runs, each as the words PowerShell hands
 * the program: quotes removed, backtick escapes applied, words joined across quotes. It reads only
 * as much of the language as finding commands needs, and throws `PowerShellParseError` on text it
 * cannot follow, so the caller can fall back to a reading that never loses a prompt.
 */
class PowerShellReader {
  private readonly text: string;
  private index = 0;
  /** Each command PowerShell runs, as its words. */
  readonly commands: string[][] = [];
  /** Every string literal's value, for code that runs a string the reader cannot follow. */
  readonly strings: string[] = [];

  constructor(text: string) {
    this.text = text;
  }

  private peek(offset = 0): string {
    return this.text[this.index + offset] ?? '';
  }

  private startsWith(text: string): boolean {
    return this.text.startsWith(text, this.index);
  }

  /** Reads commands up to `closer`, which it consumes, or to the end of the text. */
  readSequence(closer: ')' | '}' | null): void {
    let words: string[] = [];
    let word: string | null = null;
    const endWord = (): void => {
      if (word !== null) words.push(word);
      word = null;
    };
    const endCommand = (): void => {
      endWord();
      if (words.length > 0) this.commands.push(words);
      words = [];
    };
    const append = (text: string): void => {
      word = (word ?? '') + text;
    };

    while (this.index < this.text.length) {
      const char = this.peek();
      if (char === closer) {
        this.index++;
        endCommand();
        return;
      }
      if (char === ')' || char === '}') {
        throw new PowerShellParseError(`unmatched ${char}`);
      }
      if (/[^\S\r\n]/.test(char)) {
        // PowerShell splits words on any whitespace, a no-break space and a form feed included.
        endWord();
        this.index++;
      } else if (word === null && char === '#') {
        // A comment runs to the end of the line.
        while (this.index < this.text.length && !isOneOf('\r\n', this.peek())) {
          this.index++;
        }
      } else if (word === null && this.startsWith('<#')) {
        const end = this.text.indexOf('#>', this.index + 2);
        if (end < 0) throw new PowerShellParseError('unterminated comment');
        this.index = end + 2;
      } else if (this.startsWith('${')) {
        // `${name}` is a variable whose name may hold any character but `}`.
        const end = this.text.indexOf('}', this.index + 2);
        if (end < 0) throw new PowerShellParseError('unterminated variable');
        append(this.text.slice(this.index, end + 1));
        this.index = end + 1;
      } else if (this.atHereStringStart()) {
        append(this.readHereString());
      } else if (
        this.startsWith('$(') ||
        this.startsWith('@(') ||
        this.startsWith('@{') ||
        char === '(' ||
        char === '{'
      ) {
        // Subexpressions, groups and script blocks hold commands PowerShell runs. A script block
        // is read even when nothing visibly invokes it: over-prompting is safe, a miss is not.
        // The group's own text stays in the word, so `& (Get-Command npm)` or an argument array
        // can still be read from it.
        const start = this.index;
        const bracket = char === '(' || char === '{' ? char : this.peek(1);
        this.index += bracket === char ? 1 : 2;
        this.readSequence(bracket === '(' ? ')' : '}');
        append(this.text.slice(start, this.index));
      } else if (isOneOf('\r\n;|', char)) {
        endCommand();
        this.index++;
      } else if (char === '>') {
        // A redirection (`>`, `>>`, `2>&1`, `*>&1`) ends the word before it, and `&1` names a
        // stream rather than starting a job. PowerShell allows one in the middle of a command.
        endWord();
        this.index++;
        if (this.peek() === '>') this.index++;
        if (this.peek() === '&') this.index += 2;
      } else if (char === '&') {
        this.index++;
        if (this.peek() === '&') {
          this.index++;
          endCommand();
        } else {
          // `&` before a command is the call operator; after one it runs that command as a job.
          endWord();
          if (words.length > 0) endCommand();
        }
      } else if (char === '`') {
        this.index++;
        const escaped = this.peek();
        if (escaped === '') {
          throw new PowerShellParseError('trailing backtick');
        }
        if (escaped === '\r' || escaped === '\n') {
          // A backtick at the end of a line continues the command on the next.
          this.index += escaped === '\r' && this.peek(1) === '\n' ? 2 : 1;
          endWord();
        } else {
          append(escaped);
          this.index++;
        }
      } else if (isOneOf(POWERSHELL_SINGLE_QUOTES, char)) {
        append(this.readSingleQuoted());
      } else if (isOneOf(POWERSHELL_DOUBLE_QUOTES, char)) {
        append(this.readDoubleQuoted());
      } else {
        append(char);
        this.index++;
      }
    }
    if (closer) throw new PowerShellParseError(`missing ${closer}`);
    endCommand();
  }

  /** A literal string: a doubled quote stands for one quote. */
  private readSingleQuoted(): string {
    this.index++;
    let value = '';
    while (this.index < this.text.length) {
      const char = this.peek();
      this.index++;
      if (!isOneOf(POWERSHELL_SINGLE_QUOTES, char)) {
        value += char;
      } else if (isOneOf(POWERSHELL_SINGLE_QUOTES, this.peek())) {
        value += char;
        this.index++;
      } else {
        this.strings.push(value);
        return value;
      }
    }
    throw new PowerShellParseError('unterminated single-quoted string');
  }

  /** `@'` or `@"` at the end of its line opens a here-string. */
  private atHereStringStart(): boolean {
    return (
      this.peek() === '@' &&
      isOneOf(
        POWERSHELL_SINGLE_QUOTES + POWERSHELL_DOUBLE_QUOTES,
        this.peek(1),
      ) &&
      /^[ \t]*\r?\n/.test(this.text.slice(this.index + 2, this.index + 66))
    );
  }

  /**
   * A here-string's text, which ends at a line that starts with its closing quote and `@`. A
   * single-quoted one is literal; a double-quoted one expands escapes and runs its `$()`
   * subexpressions.
   */
  private readHereString(): string {
    const expandable = isOneOf(POWERSHELL_DOUBLE_QUOTES, this.peek(1));
    const quotes = expandable
      ? POWERSHELL_DOUBLE_QUOTES
      : POWERSHELL_SINGLE_QUOTES;
    this.index = this.text.indexOf('\n', this.index) + 1;
    let value = '';
    let lineStart = true;
    while (this.index < this.text.length) {
      const char = this.peek();
      if (lineStart && isOneOf(quotes, char) && this.peek(1) === '@') {
        this.index += 2;
        this.strings.push(value);
        return value;
      }
      lineStart = false;
      if (expandable && this.startsWith('$(')) {
        this.index += 2;
        this.readSequence(')');
      } else if (expandable && char === '`') {
        value += this.expandEscape(this.peek(1));
        this.index += 2;
      } else {
        value += char;
        this.index++;
        lineStart = char === '\n';
      }
    }
    throw new PowerShellParseError('unterminated here-string');
  }

  /** An expandable string: escapes expand, `$()` runs, and a doubled quote stands for one. */
  private readDoubleQuoted(): string {
    this.index++;
    let value = '';
    while (this.index < this.text.length) {
      const char = this.peek();
      if (this.startsWith('$(')) {
        this.index += 2;
        this.readSequence(')');
        continue;
      }
      this.index++;
      if (char === '`') {
        value += this.expandEscape(this.peek());
        this.index++;
      } else if (!isOneOf(POWERSHELL_DOUBLE_QUOTES, char)) {
        value += char;
      } else if (isOneOf(POWERSHELL_DOUBLE_QUOTES, this.peek())) {
        value += char;
        this.index++;
      } else {
        this.strings.push(value);
        return value;
      }
    }
    throw new PowerShellParseError('unterminated double-quoted string');
  }

  private expandEscape(char: string): string {
    return POWERSHELL_ESCAPES[char] ?? char;
  }
}

const GATED_PROGRAMS = new Set(['npm', 'npx', 'wrangler']);

/** A program's name as PowerShell resolves it: no folder, no extension, any case. */
function powerShellProgramName(word: string): string {
  return (word.replaceAll('\\', '/').split('/').at(-1) ?? word)
    .toLowerCase()
    .replace(/\.(?:cmd|ps1|bat|exe)$/, '');
}

/**
 * The word the gates see for `word`. PowerShell finds a program case-insensitively and with or
 * without its extension, so `NPM`, `npm.ps1` and `.\node_modules\.bin\wrangler.cmd` name the
 * programs the gates look for, and so does a group that names one (`& (Get-Command npm)`).
 */
function powerShellProgramWord(word: string): string {
  const name = powerShellProgramName(word);
  if (GATED_PROGRAMS.has(name)) return name;
  if (/^[$@]?\(/.test(word)) {
    const named = (word.match(/[^\s()'"$@,;]+/g) ?? [])
      .map(powerShellProgramName)
      .find((part) => GATED_PROGRAMS.has(part));
    if (named) return named;
  }
  return word;
}

type PowerShellParameter = { name: string; value?: string };

/**
 * `word` as a PowerShell parameter: `-Name`, `-Name:value`, with an en or em dash, a horizontal
 * bar or a doubled dash in place of `-`, and with `/` where the program accepts it.
 */
function powerShellParameter(
  word: string,
  { slash = false } = {},
): PowerShellParameter | undefined {
  const match = (
    slash
      ? /^(?:[-–—―]{1,2}|\/)([a-z][a-z0-9-]*)(?::([\s\S]*))?$/i
      : /^[-–—―]{1,2}([a-z][a-z0-9-]*)(?::([\s\S]*))?$/i
  ).exec(word);
  if (!match) return undefined;
  return { name: (match[1] ?? '').toLowerCase(), value: match[2] };
}

/** `-EncodedCommand` as `pwsh` and `powershell.exe` accept it: any prefix of it, or `-ec`. */
function isEncodedCommandFlag(word: string): boolean {
  const name = powerShellParameter(word, { slash: true })?.name;
  return (
    name !== undefined && (name === 'ec' || 'encodedcommand'.startsWith(name))
  );
}

/**
 * A word's value as a wrapper receives it: a parameter given its value with a colon
 * (`-Command:'…'`) passes the value, any other parameter passes nothing.
 */
function wrapperArgument(
  word: string,
  options: { slash?: boolean } = {},
): string | undefined {
  const parameter = powerShellParameter(word, options);
  return parameter ? parameter.value : word;
}

function wrapperArguments(
  words: string[],
  options: { slash?: boolean } = {},
): string[] {
  return words.flatMap((word) => wrapperArgument(word, options) ?? []);
}

/** The Bash reading of the text after the flag a Bash-like wrapper runs its string from. */
function bashWrapperReason(
  words: string[],
  isRunFlag: (word: string) => boolean,
  toBash: (text: string) => string = (text) => text,
): string | null {
  const runFlagIndex = words.findIndex(isRunFlag);
  if (runFlagIndex < 0) return null;
  const runFlag = words[runFlagIndex] ?? '';
  // `cmd /cnpm run deploy` attaches the command to `/c`.
  const attached = runFlag.replace(/^(?:\/[ck]|-[a-z]*c[a-z]*)/i, '');
  const text = [attached, ...words.slice(runFlagIndex + 1)].join(' ');
  return productionConfirmationReason(toBash(text), 'bash');
}

/**
 * The reason the string a wrapper program is handed needs confirmation: `words` start at the
 * wrapper's name.
 */
function wrapperReason(words: string[]): string | null {
  const [program = '', ...rest] = words;
  switch (powerShellProgramName(program)) {
    case 'invoke-expression':
    case 'iex':
      return powerShellConfirmationReason(wrapperArguments(rest).join(' '));
    case 'pwsh':
    case 'powershell':
      // Every word that is not a parameter may be the command (`powershell "…"` runs it).
      return powerShellConfirmationReason(
        wrapperArguments(rest, { slash: true }).join(' '),
      );
    case 'cmd':
      // cmd's `^` escapes the next character and its `&` separates commands; read as Bash, the
      // result over-prompts but never misses.
      return bashWrapperReason(
        rest,
        (word) => /^\/[ck]/i.test(word),
        (text) => text.replaceAll('^', '').replaceAll('&', ';'),
      );
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'dash':
      return bashWrapperReason(rest, (word) => /^-[a-z]*c[a-z]*$/i.test(word));
    case 'start-process':
    case 'saps':
    case 'start': {
      // The program and its argument list, given as one string, a list or an array.
      const command = wrapperArguments(rest)
        .flatMap((word) => word.split(/[\s,'"()@]+/))
        .filter((word) => word !== '')
        .map(powerShellProgramWord);
      return productionConfirmationReasonForWords(command, command.join(' '));
    }
    default:
      return null;
  }
}

/** A wrapper anywhere in the command: after an assignment (`$x = iex …`), `.`, or `wsl`. */
function powerShellWrapperReason(words: string[]): string | null {
  for (let index = 0; index < words.length; index++) {
    const reason = wrapperReason(words.slice(index));
    if (reason) return reason;
  }
  return null;
}

// In PowerShell an environment variable is set by name in many ways (`$env:…`, `Set-Item env:…`,
// `[Environment]::SetEnvironmentVariable`), so naming an install-script switch is enough to ask.
const POWERSHELL_SCRIPT_SWITCH_VARIABLE =
  /npm_config_(?:dangerously_allow_all_scripts|allow_scripts)(?![a-z0-9_])/i;

// Code that runs a string whose value the reader may not see: a variable, a pipeline, a method.
const POWERSHELL_RUNS_STRINGS =
  /\b(?:iex|invoke-expression|invokescript|newscriptblock)\b|\[scriptblock\]::create/i;

const ENCODED_COMMAND_REASON =
  'run an encoded PowerShell command the hook cannot read';
const DYNAMIC_SCRIPT_REASON =
  'run an npm script whose name the hook cannot read';

/**
 * Whether the text starts PowerShell with an encoded command, however it is passed: directly, in
 * a `Start-Process` argument list, or through `cmd /c`.
 */
function startsEncodedPowerShell(command: string): boolean {
  return (
    /pwsh|powershell/i.test(command) &&
    command
      .split(/[\s,'"()=;|&{}‘-„]+/)
      .some((word) => isEncodedCommandFlag(word))
  );
}

/** The gates applied to a command read in PowerShell syntax (#592). */
function powerShellConfirmationReason(command: string): string | null {
  if (POWERSHELL_SCRIPT_SWITCH_VARIABLE.test(command)) {
    return INSTALL_SCRIPTS_REASON;
  }
  if (startsEncodedPowerShell(command)) return ENCODED_COMMAND_REASON;

  const reader = new PowerShellReader(command);
  try {
    reader.readSequence(null);
  } catch (error) {
    // Text this reader cannot follow is read as Bash, as the hook read every command before.
    if (error instanceof PowerShellParseError) {
      return productionConfirmationReason(command, 'bash');
    }
    throw error;
  }

  for (const words of reader.commands) {
    const programWords = words.map(powerShellProgramWord);
    const reason =
      powerShellWrapperReason(words) ??
      productionConfirmationReasonForWords(
        programWords,
        programWords.join(' '),
      );
    if (reason) return reason;
    // `npm run $name` or `npm run $(…)`: the script cannot be known, so ask.
    if (
      npmRunScriptCandidates(programWords).some((word) => /^[$@(]/.test(word))
    ) {
      return DYNAMIC_SCRIPT_REASON;
    }
  }

  // A string run by `iex`, a script block or `InvokeScript` may reach it through a variable or a
  // pipeline, so every string literal is read as a command too.
  if (POWERSHELL_RUNS_STRINGS.test(command)) {
    for (const text of reader.strings) {
      const reason = powerShellConfirmationReason(text);
      if (reason) return reason;
    }
  }
  return null;
}

/**
 * The reason a Claude Code tool call needs confirmation, or `null`. The hook is registered for
 * every tool (#592), so it checks any call whose input carries a string `command`: PowerShell's
 * in PowerShell syntax, every other tool's (Bash, Monitor, a tool added later) in Bash syntax,
 * since over-prompting is safe and a miss is not.
 */
export function hookConfirmationReason(input: HookInput): string | null {
  const command = input.tool_input?.command;
  if (typeof command !== 'string') {
    if (input.tool_name === 'Bash') {
      throw new Error('Bash hook input did not contain a command string.');
    }
    return null;
  }
  return productionConfirmationReason(
    command,
    input.tool_name === 'PowerShell' ? 'powershell' : 'bash',
  );
}

async function runHook(): Promise<void> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  const reason = hookConfirmationReason(JSON.parse(raw) as HookInput);
  if (!reason) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `Explicit confirmation required: this command may ${reason}.`,
      },
    }),
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (entryPoint === import.meta.url) {
  runHook().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
