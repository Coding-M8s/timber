import type { Command } from "commander";
import { listBranches } from "../git/branches";
import { discoverRepository } from "../git/repository";
import { listWorktreeInventory } from "../git/worktrees";
import type { GitReadOptions } from "../types";
import { completionShells } from "./shells";

export interface CompletionRequest {
  cwd: string;
  /** Completed arguments, excluding the executable and the word at the cursor. */
  words: readonly string[];
  prefix: string;
}

function filtered(values: readonly string[], prefix: string): string[] {
  return [...new Set(values)].filter(value => value.startsWith(prefix)).sort();
}

/** Raw selectors, independent of any shell's quoting or transport protocol. */
async function repositoryCandidates(cwd: string, mode: "open" | "done" | "rebase" | "base" | "rebase-base"): Promise<string[]> {
  try {
    // One deadline for the whole lookup keeps a stalled Git from hanging the Tab press.
    const options: GitReadOptions = { signal: AbortSignal.timeout(1000) };
    const repository = await discoverRepository(cwd, options);
    const trees = (mode === "base" || mode === "rebase-base") ? [] : await listWorktreeInventory(repository, options);
    const isRemoteSelector = (name: string) => repository.remotes.some(remote => name.startsWith(remote.name + "/"));
    const registrations = new Map<string, number>();
    for (const tree of trees) {
      if (tree.branch !== null) registrations.set(tree.branch, (registrations.get(tree.branch) ?? 0) + 1);
    }
    // A branch registered in several worktrees is ambiguous; only its paths identify one.
    const values = trees.filter(tree => mode !== "done" || !tree.isPrimary)
      .flatMap(tree => tree.branch === null || isRemoteSelector(tree.branch)
        || registrations.get(tree.branch) !== 1 ? [tree.path] : [tree.path, tree.branch]);
    if (mode === "open" || mode === "base" || mode === "rebase-base") {
      values.push(...(await listBranches(repository, options)).flatMap(branch => {
        if (branch.kind === "remote") return [branch.remote + "/" + branch.name];
        if (mode === "rebase-base") return [branch.ref];
        if ((registrations.get(branch.name) ?? 0) > 1) return [];
        // Normal resolution reserves remote/name for explicit remote selectors.
        // Base resolution also accepts full refs; open uses absolute tree paths.
        if (isRemoteSelector(branch.name) || (mode === "base" && branch.name.startsWith("refs/"))) {
          return mode === "base" ? [branch.ref] : [];
        }
        return [branch.name];
      }));
    }
    return values;
  } catch {
    // Outside Git, stale/inaccessible metadata, and missing Git are normal for Tab.
    return [];
  }
}

export async function completionCandidates(program: Command, request: CompletionRequest): Promise<readonly string[]> {
  const { words, prefix, cwd } = request;
  const help = program.createHelp();
  const commands = help.visibleCommands(program);
  if (words.length === 0) {
    return filtered(prefix.startsWith("-")
      ? help.visibleOptions(program).flatMap(option => [option.short, option.long].filter((flag): flag is string => !!flag))
      : commands.flatMap(command => [command.name(), ...command.aliases()]), prefix);
  }
  const selectedCommand = commands.find(command => command.name() === words[0] || command.aliases().includes(words[0]!));
  if (!selectedCommand) return [];
  let command: Command = selectedCommand;
  let commandWords = words.slice(1);
  while (command.commands.length && commandWords.length) {
    const child: Command | undefined = help.visibleCommands(command).find(candidate => candidate.name() === commandWords[0]
      || candidate.aliases().includes(commandWords[0]!));
    if (!child) break;
    command = child;
    commandWords = commandWords.slice(1);
  }
  if (command.commands.length && commandWords.length === 0 && !prefix.startsWith("-")) {
    return filtered(help.visibleCommands(command).flatMap(child => [child.name(), ...child.aliases()]), prefix);
  }
  const options = help.visibleOptions(command);
  let operands = 0;
  let endOptions = false;
  let expectingValue = false;
  for (const word of commandWords) {
    if (expectingValue) { expectingValue = false; continue; }
    if (!endOptions && word === "--") { endOptions = true; continue; }
    if (!endOptions && word.startsWith("-")) {
      const flag = word.split("=")[0];
      // An unknown flag is a parse error at execution, not a reason to stop suggesting.
      const option = options.find(option => option.long === flag || option.short === flag);
      expectingValue = option !== undefined && (option.required || option.optional) && !word.includes("=");
    } else {
      operands++;
    }
  }
  if (expectingValue) {
    const previous = words.at(-1);
    if (previous === "--tool" && command.parent?.name() === "arena") return filtered(["codex", "claude", "cursor", "manual"], prefix);
    return previous === "--base" ? filtered(await repositoryCandidates(cwd, command.name() === "rebase" ? "rebase-base" : "base"), prefix) : [];
  }
  if (!endOptions && prefix.startsWith("--tool=") && command.parent?.name() === "arena") {
    return filtered(["codex", "claude", "cursor", "manual"].map(value => "--tool=" + value), prefix);
  }
  if (!endOptions && prefix.startsWith("--base=") && options.some(option => option.long === "--base")) {
    return filtered((await repositoryCandidates(cwd, command.name() === "rebase" ? "rebase-base" : "base")).map(value => "--base=" + value), prefix);
  }
  if (!endOptions && prefix.startsWith("-")) {
    return filtered(options.flatMap(option => [option.short, option.long].filter((flag): flag is string => !!flag)), prefix);
  }
  if (operands > 0) return [];
  if (command.name() === "completion") return filtered(completionShells, prefix);
  if (command.name() === "help") return filtered(commands.map(command => command.name()), prefix);
  if (command.name() === "create" && command.parent?.name() === "backup") return filtered(await repositoryCandidates(cwd, "rebase"), prefix);
  if (command.parent?.name() === "backup") return [];
  if (command.name() === "publish") return filtered(await repositoryCandidates(cwd, "rebase"), prefix);
  if (command.name() === "open" || command.name() === "done" || command.name() === "rebase") {
    return filtered(await repositoryCandidates(cwd, command.name() as "open" | "done" | "rebase"), prefix);
  }
  return [];
}
