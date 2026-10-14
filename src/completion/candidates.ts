import { Command, Option } from "commander";

export interface CompletionCommand {
  /** Space-separated Commander path; nested paths let the catalog represent shells/subcommands. */
  name: string;
  flags: readonly { name: string; takesValue: boolean }[];
  positional: "none" | "target" | "freeform" | "shell";
}

export interface CompletionCatalog {
  rootFlags: CompletionCommand["flags"];
  commands: readonly CompletionCommand[];
}

export interface CompletionRequest {
  cwd: string;
  words: readonly string[];
  current: string;
}

export interface CompletionServices {
  listTargets(command: "open" | "done", cwd: string): Promise<readonly string[]>;
}

interface CommanderCommandInternals {
  _hidden?: boolean;
  _helpOption?: Option | null;
}

function isHidden(command: Command): boolean {
  return (command as Command & CommanderCommandInternals)._hidden === true;
}

function flagsFor(command: Command): CompletionCommand["flags"] {
  const internals = command as Command & CommanderCommandInternals;
  const configuredHelp = internals._helpOption;
  const options = command.options.filter(option => !option.hidden);

  // Commander keeps its default help option separate from `options` until parsing.
  if (configuredHelp !== null) options.push(configuredHelp ?? new Option("-h, --help", "display help for command"));

  const flags = new Map<string, boolean>();
  for (const option of options) {
    for (const name of [option.short, option.long]) {
      if (name) flags.set(name, option.required || option.optional);
    }
  }
  return [...flags].map(([name, takesValue]) => ({ name, takesValue }));
}

function positionalKind(path: string): CompletionCommand["positional"] {
  if (path === "open" || path === "done") return "target";
  if (path === "new" || path === "help") return "freeform";
  if (path === "completion") return "shell";
  return "none";
}

function visibleCommandCatalog(program: Command): CompletionCommand[] {
  const commands: CompletionCommand[] = [];

  function visit(parent: Command, parentPath: readonly string[]): void {
    for (const child of parent.commands) {
      if (isHidden(child)) continue;
      const pathParts = [...parentPath, child.name()];
      const name = pathParts.join(" ");
      commands.push({ name, flags: flagsFor(child), positional: positionalKind(name) });
      visit(child, pathParts);
    }
  }

  visit(program, []);

  // Commander adds this implicit built-in when a command tree exists; its help route has no flags.
  if (program.commands.length > 0 && !commands.some(command => command.name === "help")) {
    commands.push({ name: "help", flags: [], positional: "freeform" });
  }
  return commands;
}

export function completionCatalog(program: Command): CompletionCatalog {
  return { rootFlags: flagsFor(program), commands: visibleCommandCatalog(program) };
}

function startsWith(value: string, prefix: string): boolean {
  return value.startsWith(prefix);
}

function rootCommands(catalog: CompletionCatalog): string[] {
  return [...new Set(catalog.commands.map(command => command.name.split(" ")[0]!))];
}

function childrenFor(catalog: CompletionCatalog, path: readonly string[]): string[] {
  const children = new Set<string>();
  for (const command of catalog.commands) {
    const parts = command.name.split(" ");
    if (parts.length <= path.length || !path.every((part, index) => parts[index] === part)) continue;
    children.add(parts[path.length]!);
  }
  return [...children];
}

function findCommand(catalog: CompletionCatalog, path: readonly string[]): CompletionCommand | undefined {
  return catalog.commands.find(command => command.name === path.join(" "));
}

interface ParsedOptions {
  positional: readonly string[];
  terminated: boolean;
  expectsValue: boolean;
}

function parseOptions(words: readonly string[], flags: CompletionCommand["flags"]): ParsedOptions {
  const positional: string[] = [];
  let terminated = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (!terminated && word === "--") {
      terminated = true;
      continue;
    }
    if (!terminated && word.startsWith("-") && word !== "-") {
      const equals = word.indexOf("=");
      const name = equals < 0 ? word : word.slice(0, equals);
      const option = flags.find(flag => flag.name === name);
      if (option?.takesValue && equals < 0) {
        if (index === words.length - 1) return { positional, terminated, expectsValue: true };
        index += 1;
      }
      continue;
    }
    positional.push(word);
  }
  return { positional, terminated, expectsValue: false };
}

function currentIsOptionValue(current: string, flags: CompletionCommand["flags"]): boolean {
  const equals = current.indexOf("=");
  if (equals < 0) return false;
  const name = current.slice(0, equals);
  return flags.some(flag => flag.name === name && flag.takesValue);
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, character => character.codePointAt(0)!);
  const rightPoints = Array.from(right, character => character.codePointAt(0)!);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function sortedUnique(values: readonly string[], prefix: string): string[] {
  return [...new Set(values.filter(value => startsWith(value, prefix)))].sort(compareCodePoints);
}

export async function complete(
  request: CompletionRequest,
  catalog: CompletionCatalog,
  services: CompletionServices,
): Promise<readonly string[]> {
  const [firstWord, ...remainingWords] = request.words;
  if (firstWord === undefined) {
    if (request.current.startsWith("-")) return sortedUnique(catalog.rootFlags.map(flag => flag.name), request.current);
    return sortedUnique([...rootCommands(catalog), ...catalog.rootFlags.map(flag => flag.name)], request.current);
  }

  if (firstWord === "help") {
    let path: string[] = [];
    for (const part of remainingWords) {
      const available = path.length === 0 ? rootCommands(catalog) : childrenFor(catalog, path);
      if (!available.includes(part)) return [];
      path = [...path, part];
    }
    const available = path.length === 0 ? rootCommands(catalog) : childrenFor(catalog, path);
    return sortedUnique(available, request.current);
  }

  let path = [firstWord];
  let pathLength = 1;
  while (pathLength < request.words.length) {
    const children = childrenFor(catalog, path);
    const next = request.words[pathLength]!;
    if (!children.includes(next)) break;
    path = [...path, next];
    pathLength += 1;
  }

  const selected = findCommand(catalog, path);
  if (!selected) return [];
  const args = request.words.slice(pathLength);
  const parsed = parseOptions(args, selected.flags);
  if (parsed.expectsValue || currentIsOptionValue(request.current, selected.flags)) return [];

  if (!parsed.terminated && request.current.startsWith("-")) {
    return sortedUnique(selected.flags.map(flag => flag.name), request.current);
  }

  let candidates: string[] = [];
  const children = childrenFor(catalog, path);
  if (selected.positional === "shell" && parsed.positional.length === 0) {
    candidates.push(...children);
    if (request.current === "" && !parsed.terminated) candidates.push(...selected.flags.map(flag => flag.name));
  } else if (selected.positional === "target" && parsed.positional.length === 0) {
    if (selected.name === "open" || selected.name === "done") {
      candidates.push(...await services.listTargets(selected.name, request.cwd));
    }
  } else if (request.current === "" && !parsed.terminated) {
    candidates.push(...selected.flags.map(flag => flag.name));
  }
  return sortedUnique(candidates, request.current);
}
