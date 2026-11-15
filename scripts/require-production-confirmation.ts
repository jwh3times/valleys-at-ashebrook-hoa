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
  return bashConfirmationReason(command);
}

/**
 * How the hook read every Bash command before #591: segments split on `&&`, `||`, `;` and `|`,
 * words split on whitespace.
 */
function splitterConfirmationReason(command: string): string | null {
  const segments = command.split(/\s*(?:&&|\|\||[;|])\s*/);
  for (const segment of segments) {
    const normalized = segment.replace(/\s+/g, ' ').trim();
    const reason = productionConfirmationReasonForWords(
      shellWords(normalized),
      normalized,
    );
    if (reason) return reason;
  }
  return null;
}

/**
 * The reading for text the Bash reader cannot parse: the splitter's, and the splitter's again
 * with quotes and backslashes removed and every other shell operator, a newline included, read as
 * a separator. A shell runs each complete line before the one it cannot parse, so neither may
 * lose a prompt; over-reading here costs only a prompt.
 */
function unparsedConfirmationReason(command: string): string | null {
  return (
    splitterConfirmationReason(command) ??
    splitterConfirmationReason(
      command.replace(/["'\\]/g, '').replace(/\$\(|[()`{}<>&|;\n]/g, ';'),
    )
  );
}

class BashParseError extends Error {}

/** One simple command as a POSIX shell runs it. */
type BashCommand = {
  /** Its words after quote removal, without redirections. */
  words: string[];
  /** What it reads on standard input: heredoc bodies, here-strings and `<` redirection targets. */
  input: string[];
  /** It reads the output of an earlier command through a pipe. */
  piped: boolean;
};

type PendingHeredoc = {
  delimiter: string;
  /** A quoted delimiter (`<<'EOF'`) stops the shell expanding the body. */
  quoted: boolean;
  stripTabs: boolean;
  command: BashCommand;
};

type Redirect = 'target' | 'input' | 'here-string' | 'heredoc';

const BASH_BLANK = /[ \t\r\f\v]/;

// Deeper nesting than this is read by `unparsedConfirmationReason`, before the stack runs out:
// a throw from the hook blocks the tool call.
const MAX_NESTING = 200;

/**
 * Reads Bash text the way a POSIX shell does, far enough to find every command it will run (#591):
 * commands split on newlines and every control operator, attached or spaced; words joined from
 * their quoted parts; redirection targets dropped; heredoc bodies and quoted text kept as data;
 * and the commands inside `$(…)`, backticks and `<(…)` collected wherever the shell expands them.
 * A parse error leaves `commands` holding what was read before it.
 */
class BashReader {
  private readonly text: string;
  private index = 0;
  private nesting: number;
  readonly commands: BashCommand[];
  private pendingHeredocs: PendingHeredoc[] = [];

  constructor(text: string, commands: BashCommand[] = [], nesting = 0) {
    this.text = text;
    this.commands = commands;
    this.nesting = nesting;
  }

  /** Read the whole text, throwing `BashParseError` where a shell would wait for more. */
  readAll(): BashCommand[] {
    this.readSequence(null);
    if (this.pendingHeredocs.length > 0) {
      throw new BashParseError('heredoc without a closing delimiter');
    }
    return this.commands;
  }

  private peek(offset = 0): string {
    return this.text[this.index + offset] ?? '';
  }

  private nested<T>(read: () => T): T {
    if (++this.nesting > MAX_NESTING) {
      throw new BashParseError('nested too deeply');
    }
    try {
      return read();
    } finally {
      this.nesting--;
    }
  }

  private reader(text: string): BashReader {
    return new BashReader(text, this.commands, this.nesting + 1);
  }

  private newCommand(piped: boolean): BashCommand {
    const command: BashCommand = { words: [], input: [], piped };
    this.commands.push(command);
    return command;
  }

  /**
   * Commands up to `closer` (consumed), or to the end of the text when it is `null`. The first
   * command reads a pipe when `piped` is set (`… | (bash)`).
   */
  private readSequence(closer: ')' | null, piped = false): void {
    this.nested(() => this.readCommands(closer, piped));
  }

  private readCommands(closer: ')' | null, piped: boolean): void {
    let command = this.newCommand(piped);
    let word: string | null = null;
    let quoted = false;
    let redirect: Redirect | null = null;
    let stripTabs = false;

    const endWord = (): void => {
      if (word === null) return;
      if (redirect === 'heredoc') {
        this.pendingHeredocs.push({
          delimiter: word,
          quoted,
          stripTabs,
          command,
        });
      } else if (redirect === 'here-string' || redirect === 'input') {
        command.input.push(word);
      } else if (redirect === null) {
        command.words.push(word);
      }
      redirect = null;
      word = null;
      quoted = false;
    };
    /** End the last word, which must not leave a redirection waiting for its target. */
    const endWords = (): void => {
      endWord();
      if (redirect !== null) {
        throw new BashParseError('redirection without a target');
      }
    };
    const isEmpty = (): boolean =>
      word === null &&
      redirect === null &&
      command.words.length === 0 &&
      command.input.length === 0;
    const endCommand = (nextPiped = false): void => {
      endWords();
      command = this.newCommand(nextPiped);
    };
    const append = (text: string, isQuoted = false): void => {
      word = (word ?? '') + text;
      if (isQuoted) quoted = true;
    };
    const startRedirect = (kind: Redirect, length: number): void => {
      // A file descriptor written against the operator (`2>`) is part of it, not a word.
      if (word !== null && !quoted && /^\d+$/.test(word)) word = null;
      endWord();
      redirect = kind;
      this.index += length;
    };

    while (true) {
      const char = this.peek();
      if (char === '') {
        if (closer !== null) throw new BashParseError(`missing ${closer}`);
        endWords();
        return;
      }
      if (char === ')' && closer === ')') {
        this.index++;
        endWords();
        return;
      }
      if (char === '\n') {
        this.index++;
        // A line ending in `|`, `&&` or `||` continues on the next one.
        if (!isEmpty()) endCommand();
        this.readHeredocBodies();
        continue;
      }
      if (BASH_BLANK.test(char)) {
        this.index++;
        endWord();
        continue;
      }
      if (char === '#' && word === null) {
        while (this.peek() !== '' && this.peek() !== '\n') this.index++;
        continue;
      }
      if (char === '\\') {
        const next = this.peek(1);
        this.index += 2;
        // A backslash before a newline joins the lines.
        if (next !== '\n') append(next, true);
        continue;
      }
      if (char === "'") {
        append(this.readSingleQuoted(), true);
        continue;
      }
      if (char === '"') {
        this.index++;
        append(this.readDoubleQuoted(), true);
        continue;
      }
      if (char === '$') {
        const next = this.peek(1);
        append(this.readDollar(true), next === "'" || next === '"');
        continue;
      }
      if (char === '`') {
        append(this.readBackquoted());
        continue;
      }
      if (char === ';' || char === ')') {
        this.index++;
        endCommand();
        continue;
      }
      if (char === '(') {
        if (this.peek(1) === '(' && word === null) {
          // `((…))` is arithmetic, which runs only its substitutions.
          this.index += 2;
          this.readArithmetic();
          continue;
        }
        const subshellPiped = command.piped && isEmpty();
        this.index++;
        endCommand();
        this.readSequence(')', subshellPiped);
        endCommand();
        continue;
      }
      if (char === '&') {
        if (this.peek(1) === '>') {
          startRedirect('target', this.peek(2) === '>' ? 3 : 2);
        } else {
          this.index += this.peek(1) === '&' ? 2 : 1;
          endCommand();
        }
        continue;
      }
      if (char === '|') {
        if (this.peek(1) === '|') {
          this.index += 2;
          endCommand();
        } else {
          this.index += this.peek(1) === '&' ? 2 : 1;
          endCommand(true);
        }
        continue;
      }
      if (char === '<' || char === '>') {
        const next = this.peek(1);
        if (next === '(') {
          // Process substitution runs its commands; the word it becomes is a file name.
          const start = this.index;
          this.index += 2;
          this.readSequence(')');
          append(this.text.slice(start, this.index));
        } else if (char === '<' && next === '<' && this.peek(2) === '<') {
          startRedirect('here-string', 3);
        } else if (char === '<' && next === '<') {
          stripTabs = this.peek(2) === '-';
          startRedirect('heredoc', stripTabs ? 3 : 2);
        } else if (char === '<') {
          startRedirect(
            next === '&' ? 'target' : 'input',
            next === '&' || next === '>' ? 2 : 1,
          );
        } else {
          startRedirect(
            'target',
            next === '>' || next === '|' || next === '&' ? 2 : 1,
          );
        }
        continue;
      }
      this.index++;
      append(char);
    }
  }

  /** `'…'`, from its opening quote: every character is literal. */
  private readSingleQuoted(): string {
    const end = this.text.indexOf("'", this.index + 1);
    if (end < 0) throw new BashParseError("missing '");
    const value = this.text.slice(this.index + 1, end);
    this.index = end + 1;
    return value;
  }

  /** `"…"`, after its opening quote: substitutions run, and `\` escapes only `$`, `` ` ``, `"`, `\`. */
  private readDoubleQuoted(): string {
    let value = '';
    while (true) {
      const char = this.peek();
      if (char === '') throw new BashParseError('missing "');
      if (char === '"') {
        this.index++;
        return value;
      }
      if (char === '\\') {
        const next = this.peek(1);
        this.index += 2;
        if (next === '\n') continue;
        value += next !== '' && '$`"\\'.includes(next) ? next : `\\${next}`;
        continue;
      }
      if (char === '$') {
        value += this.readDollar(false);
        continue;
      }
      if (char === '`') {
        value += this.readBackquoted();
        continue;
      }
      value += char;
      this.index++;
    }
  }

  /**
   * Text starting with `$`, returned as the word text it stands for: `$(…)` runs its commands,
   * `$((…))` is arithmetic, and `${…}` may hold substitutions. Outside double quotes, `$'…'` is
   * ANSI-C quoted and `$"…"` double-quoted; inside them, and in a heredoc body, both are text.
   */
  private readDollar(unquoted: boolean): string {
    const next = this.peek(1);
    const start = this.index;
    if (next === '(' && this.peek(2) === '(') {
      this.index += 3;
      this.readArithmetic();
      return this.text.slice(start, this.index);
    }
    if (next === '(') {
      this.index += 2;
      this.readSequence(')');
      return this.text.slice(start, this.index);
    }
    if (next === '{') {
      this.index += 2;
      this.nested(() => this.readParameter());
      return this.text.slice(start, this.index);
    }
    if (unquoted && next === "'") {
      this.index++;
      return this.readAnsiCQuoted();
    }
    if (unquoted && next === '"') {
      this.index += 2;
      return this.readDoubleQuoted();
    }
    this.index++;
    return '$';
  }

  /** `${…}`, after its opening brace: nested braces, quotes and substitutions included. */
  private readParameter(): void {
    while (true) {
      const char = this.peek();
      if (char === '') throw new BashParseError('missing }');
      if (char === '}') {
        this.index++;
        return;
      }
      if (char === '\\') this.index += 2;
      else if (char === "'") this.readSingleQuoted();
      else if (char === '"') {
        this.index++;
        this.readDoubleQuoted();
      } else if (char === '$') this.readDollar(false);
      else if (char === '`') this.readBackquoted();
      else this.index++;
    }
  }

  /** Arithmetic after its `((`, through the closing `))`: only its substitutions run. */
  private readArithmetic(): void {
    this.nested(() => {
      let depth = 0;
      while (true) {
        const char = this.peek();
        if (char === '') throw new BashParseError('missing ))');
        if (char === ')' && depth === 0) {
          if (this.peek(1) !== ')') throw new BashParseError('missing ))');
          this.index += 2;
          return;
        }
        if (char === '(') depth++;
        if (char === ')') depth--;
        if (char === '\\') this.index += 2;
        else if (char === '$') this.readDollar(false);
        else if (char === '`') this.readBackquoted();
        else this.index++;
      }
    });
  }

  /** `'…'` after `$`, from its opening quote, with its backslash escapes expanded. */
  private readAnsiCQuoted(): string {
    const escapes: Readonly<Record<string, string>> = {
      n: '\n',
      t: '\t',
      r: '\r',
      a: '\x07',
      b: '\b',
      e: '\x1b',
      E: '\x1b',
      f: '\f',
      v: '\v',
    };
    let value = '';
    this.index++;
    while (true) {
      const char = this.peek();
      if (char === '') throw new BashParseError("missing '");
      if (char === "'") {
        this.index++;
        return value;
      }
      if (char === '\\') {
        const next = this.peek(1);
        this.index += 2;
        value += escapes[next] ?? next;
        continue;
      }
      value += char;
      this.index++;
    }
  }

  /** `` `…` ``, from its opening backquote: its commands are read with the backslashes it removes. */
  private readBackquoted(): string {
    const start = this.index;
    let inner = '';
    this.index++;
    while (true) {
      const char = this.peek();
      if (char === '') throw new BashParseError('missing `');
      if (char === '`') break;
      const next = this.peek(1);
      if (char === '\\' && next !== '' && '$`\\"'.includes(next)) {
        inner += next;
        this.index += 2;
        continue;
      }
      inner += char;
      this.index++;
    }
    this.index++;
    this.nested(() => this.reader(inner).readAll());
    return this.text.slice(start, this.index);
  }

  /**
   * The bodies of the heredocs started on the line just read, which follow it line by line. An
   * unquoted delimiter lets the shell expand the body, so its substitutions run.
   */
  private readHeredocBodies(): void {
    const pending = this.pendingHeredocs;
    this.pendingHeredocs = [];
    for (const heredoc of pending) {
      const lines: string[] = [];
      while (true) {
        if (this.index >= this.text.length) {
          throw new BashParseError(`heredoc without ${heredoc.delimiter}`);
        }
        const newline = this.text.indexOf('\n', this.index);
        const end = newline < 0 ? this.text.length : newline;
        const line = this.text.slice(this.index, end).replace(/\r$/, '');
        this.index = end + 1;
        const compared = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
        if (compared === heredoc.delimiter) break;
        lines.push(compared);
      }
      const body = lines.join('\n');
      heredoc.command.input.push(body);
      if (!heredoc.quoted) {
        this.nested(() => this.reader(body).readExpansions());
      }
    }
  }

  /** Text the shell expands without splitting into commands: only its substitutions run. */
  private readExpansions(): void {
    while (this.index < this.text.length) {
      const char = this.peek();
      if (char === '\\') this.index += 2;
      else if (char === '$') this.readDollar(false);
      else if (char === '`') this.readBackquoted();
      else this.index++;
    }
  }
}

const BASH_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);

// Words that may stand before the program a simple command runs.
const COMMAND_PREFIXES = new Set([
  '!',
  '{',
  'if',
  'then',
  'elif',
  'else',
  'do',
  'while',
  'until',
  'time',
  'exec',
  'command',
  'builtin',
  'nohup',
  'sudo',
  'env',
  'nice',
]);

/** The index of the program a command runs: past assignments, keywords and prefix commands. */
function programIndex(words: string[]): number {
  let index = 0;
  let afterPrefix = false;
  while (index < words.length) {
    const word = words[index] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) afterPrefix = false;
    else if (COMMAND_PREFIXES.has(word)) afterPrefix = true;
    else if (!(afterPrefix && word.startsWith('-'))) return index;
    index++;
  }
  return -1;
}

const isDashC = (word: string): boolean => /^-[a-z]*c[a-z]*$/i.test(word);
const isSlashC = (word: string): boolean => /^\/\/?[ck]/i.test(word);

type ReadText = (text: string) => string | null;

const STANDARD_INPUT_FILE = /^\/(?:dev\/stdin|dev\/fd\/0|proc\/self\/fd\/0)$/;

/**
 * How a shell whose name is `words[0]` reads the text on its standard input, when it runs that
 * text as commands: given neither a command string nor a script file (`bash`, `sh -s`, `pwsh -`).
 */
function shellInputReader(words: string[]): ReadText | null {
  const name = programBaseName(words[0] ?? '');
  const rest = words.slice(1);

  if (BASH_SHELLS.has(name)) {
    let readsInput = false;
    for (let position = 0; position < rest.length; position++) {
      const word = rest[position] ?? '';
      if (word === '--' || word === '-') {
        return readsInput || position === rest.length - 1
          ? bashConfirmationReason
          : null;
      }
      if (/^[-+][a-zA-Z]+$/.test(word)) {
        if (word.slice(1).includes('c')) return null;
        if (word.slice(1).includes('s')) readsInput = true;
        if (/^[-+][oO]$/.test(word)) position++;
      } else if (/^--(?:rcfile|init-file)$/.test(word)) {
        position++;
      } else if (!word.startsWith('--')) {
        // A script file: its text is out of the hook's reach, and its input is data, unless the
        // file is standard input itself.
        return readsInput || STANDARD_INPUT_FILE.test(word)
          ? bashConfirmationReason
          : null;
      }
    }
    return bashConfirmationReason;
  }
  if (name === 'source' || name === '.') {
    return STANDARD_INPUT_FILE.test(rest[0] ?? '')
      ? bashConfirmationReason
      : null;
  }
  if (name === 'pwsh' || name === 'powershell') {
    const commandWords = wrapperArguments(rest, { slash: true });
    return commandWords.length === 0 ||
      (commandWords.length === 1 && commandWords[0] === '-')
      ? powerShellConfirmationReason
      : null;
  }
  if (name === 'cmd') {
    return rest.some(isSlashC)
      ? null
      : (text) => bashConfirmationReason(cmdTextAsBash(text));
  }
  return null;
}

const INPUT_SHELLS = new Set([
  ...BASH_SHELLS,
  'pwsh',
  'powershell',
  'cmd',
  'source',
  '.',
]);

/**
 * The readers of every shell in a command that runs its standard input, wherever it stands
 * (`timeout 60 bash`, `nice -n 5 sh -s`): a shell name that is only an argument over-prompts.
 */
function standardInputReaders(words: string[]): ReadText[] {
  const readers: ReadText[] = [];
  for (let index = 0; index < words.length; index++) {
    if (!INPUT_SHELLS.has(programBaseName(words[index] ?? ''))) continue;
    const reader = shellInputReader(words.slice(index));
    if (reader) readers.push(reader);
  }
  return readers;
}

/** cmd's `^` escapes the next character and its `&` separates commands. */
function cmdTextAsBash(text: string): string {
  return text.replaceAll('^', '').replaceAll('&', ';');
}

// Programs that run their arguments as code. Every one but a shell without `-c` (or `cmd` without
// `/c`) runs all the words after it, so the scan for wrappers stops there.
const WRAPPERS = new Set([
  ...BASH_SHELLS,
  'eval',
  'cmd',
  'pwsh',
  'powershell',
  'invoke-expression',
  'iex',
  'start-process',
  'saps',
  'start',
]);

/**
 * The reason the string a wrapper program runs needs confirmation, the wrapper standing anywhere
 * in the command (`sudo bash -c …`, `FOO=1 eval …`).
 */
function bashWrapperCommandReason(words: string[]): string | null {
  for (let index = 0; index < words.length; index++) {
    const name = programBaseName(words[index] ?? '');
    if (!WRAPPERS.has(name)) continue;
    const rest = words.slice(index + 1);
    if (name === 'eval') return bashConfirmationReason(rest.join(' '));
    if (
      (name === 'pwsh' || name === 'powershell') &&
      rest.some((word) => isEncodedCommandFlag(word))
    ) {
      return ENCODED_COMMAND_REASON;
    }
    const reason = wrapperReason(words.slice(index));
    const runsRest = BASH_SHELLS.has(name)
      ? rest.some(isDashC)
      : name !== 'cmd' || rest.some(isSlashC);
    if (reason || runsRest) return reason;
  }
  return null;
}

/**
 * What `commands` may write, as far as the hook can tell without running them: each heredoc and
 * here-string they read (`cat` copies it), each word, and each command's arguments as `echo` joins
 * them, with `printf`'s `\n` read as a newline; and what a process substitution redirected into
 * one writes. Over-reading costs a prompt, never a miss.
 */
function writtenTexts(commands: BashCommand[]): string[] {
  return commands
    .flatMap((writer) => [
      ...writer.input.flatMap((text) =>
        SUBSTITUTION.test(text) ? [text, ...substitutionOutputs(text)] : [text],
      ),
      ...writer.words,
      writer.words.slice(1).join(' '),
    ])
    .flatMap((text) =>
      text.includes('\\n') ? [text, text.replaceAll('\\n', '\n')] : [text],
    );
}

/** The text a command reads on standard input: its own, and a pipe's from the commands before it. */
function standardInputTexts(
  command: BashCommand,
  earlier: BashCommand[],
): string[] {
  return [
    ...writtenTexts([{ ...command, words: [] }]),
    ...(command.piped ? writtenTexts(earlier) : []),
  ];
}

const SUBSTITUTION = /\$\(|`|<\(/;

/**
 * What the substitutions in a word may write, which the shell puts in the word's place. A word has
 * no separator outside its substitutions, so the reader's first command is the word itself and
 * every later one runs inside a substitution; reading only those keeps each output shorter than
 * the word, so the recursion ends.
 */
function substitutionOutputs(word: string): string[] {
  const known = reading?.outputs.get(word);
  if (known) return known;
  const reader = new BashReader(word);
  try {
    reader.readAll();
  } catch (error) {
    if (!(error instanceof BashParseError)) throw error;
  }
  const outputs = writtenTexts(reader.commands.slice(1));
  reading?.outputs.set(word, outputs);
  return outputs;
}

const CODE_RUNNERS = new Set([...BASH_SHELLS, 'eval', 'source', '.']);

/**
 * The reason a command whose code comes from a substitution needs confirmation: a substitution as
 * the program's name (`$(which npm) run …`), or in the code a shell runs (`eval "$(…)"`,
 * `bash -c "$(cat <<'EOF' …)"`, `source <(…)`).
 */
function substitutedCodeReason(words: string[]): string | null {
  const index = programIndex(words);
  const program = words[index] ?? '';
  if (index >= 0 && SUBSTITUTION.test(program)) {
    const rest = words.slice(index + 1);
    for (const output of substitutionOutputs(program)) {
      const reason = bashConfirmationReason([output, ...rest].join(' '));
      if (reason) return reason;
    }
  }
  const runner = words.findIndex((word) =>
    CODE_RUNNERS.has(programBaseName(word)),
  );
  if (runner < 0) return null;
  for (const word of words.slice(runner + 1)) {
    if (!SUBSTITUTION.test(word)) continue;
    for (const output of substitutionOutputs(word)) {
      const reason = bashConfirmationReason(output);
      if (reason) return reason;
    }
  }
  return null;
}

// Past this many alternatives a word is left unexpanded: `{a,b}` repeated multiplies them.
const MAX_BRACE_EXPANSIONS = 64;

/** A word's brace expansion (`{deploy,check}`), which the shell makes before running the command. */
function expandBraces(word: string): string[] {
  const match = /^([\s\S]*?)\{([^{}]*,[^{}]*)\}([\s\S]*)$/.exec(word);
  if (!match) return [word];
  const [, before = '', alternatives = '', after = ''] = match;
  const expanded = alternatives
    .split(',')
    .flatMap((alternative) => expandBraces(`${before}${alternative}${after}`));
  return expanded.length > MAX_BRACE_EXPANSIONS ? [word] : expanded;
}

/** The gates applied to each command a shell runs, in order. */
function bashCommandsReason(commands: BashCommand[]): string | null {
  for (const [index, simple] of commands.entries()) {
    const words = simple.words.flatMap(expandBraces);
    const reason =
      productionConfirmationReasonForWords(words, words.join(' ')) ??
      bashWrapperCommandReason(words) ??
      substitutedCodeReason(words);
    if (reason) return reason;
    // `npm run "$SCRIPT"` or `npm run $(…)`: the script cannot be known, so ask.
    if (npmRunScriptCandidates(words).some((word) => /[$`]/.test(word))) {
      return DYNAMIC_SCRIPT_REASON;
    }

    const readers = standardInputReaders(words);
    if (readers.length === 0) continue;
    for (const text of standardInputTexts(simple, commands.slice(0, index))) {
      for (const readInput of readers) {
        const inputReason = readInput(text);
        if (inputReason) return inputReason;
      }
    }
  }
  return null;
}

/**
 * One top-level reading's state. Wrappers and substitutions nest (`eval eval …`, `$($(…))`) and
 * reach the same texts again and again, so each text's answer and each word's substitution
 * outputs are kept; past `MAX_DEPTH` levels or `MAX_READINGS` texts, a text is read as unparsed,
 * which over-prompts but answers well within the hook's timeout.
 */
type Reading = {
  reasons: Map<string, string | null>;
  outputs: Map<string, string[]>;
  depth: number;
  readings: number;
};
const MAX_DEPTH = 32;
const MAX_READINGS = 2_000;
let reading: Reading | null = null;

/** The gates applied to a command read in Bash syntax (#591). */
function bashConfirmationReason(command: string): string | null {
  const outermost = reading === null;
  const state: Reading = reading ?? {
    reasons: new Map(),
    outputs: new Map(),
    depth: 0,
    readings: 0,
  };
  reading = state;
  try {
    if (state.reasons.has(command)) return state.reasons.get(command) ?? null;
    let reason: string | null;
    if (state.depth >= MAX_DEPTH || ++state.readings > MAX_READINGS) {
      reason = unparsedConfirmationReason(command);
    } else {
      state.depth++;
      try {
        reason = readBashCommands(command);
      } finally {
        state.depth--;
      }
    }
    state.reasons.set(command, reason);
    return reason;
  } finally {
    if (outermost) reading = null;
  }
}

function readBashCommands(command: string): string | null {
  const reader = new BashReader(command);
  try {
    return bashCommandsReason(reader.readAll());
  } catch (error) {
    if (!(error instanceof BashParseError)) throw error;
    return (
      bashCommandsReason(reader.commands) ?? unparsedConfirmationReason(command)
    );
  }
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

/** A program's name with no folder or extension, in any case, as PowerShell and Git Bash find it. */
function programBaseName(word: string): string {
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
  const name = programBaseName(word);
  if (GATED_PROGRAMS.has(name)) return name;
  if (/^[$@]?\(/.test(word)) {
    const named = (word.match(/[^\s()'"$@,;]+/g) ?? [])
      .map(programBaseName)
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
  // `cmd /cnpm run deploy` attaches the command to `/c`; Git Bash users write `//c`.
  const attached = runFlag.replace(/^(?:\/\/?[ck]|-[a-z]*c[a-z]*)/i, '');
  const text = [attached, ...words.slice(runFlagIndex + 1)].join(' ');
  return productionConfirmationReason(toBash(text), 'bash');
}

/**
 * The reason the string a wrapper program is handed needs confirmation: `words` start at the
 * wrapper's name.
 */
function wrapperReason(words: string[]): string | null {
  const [program = '', ...rest] = words;
  const name = programBaseName(program);
  if (BASH_SHELLS.has(name)) return bashWrapperReason(rest, isDashC);
  switch (name) {
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
      // Read as Bash, cmd's text over-prompts but never misses.
      return bashWrapperReason(rest, isSlashC, cmdTextAsBash);
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
