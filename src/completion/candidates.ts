import type { Command } from "commander";
import { listBranches } from "../git/branches";
import { discoverRepository } from "../git/repository";
import { listWorktreeInventory } from "../git/worktrees";

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
async function repositoryCandidates(cwd: string, mode: "open" | "done" | "base"): Promise<string[]> {
  try {
    const repository = await discoverRepository(cwd);
    const trees = mode === "base" ? [] : await listWorktreeInventory(repository);
    const isRemoteSelector = (name: string) => repository.remotes.some(remote => name.startsWith(remote.name + "/"));
    const primaryBranches = new Set(trees.filter(tree => tree.isPrimary).map(tree => tree.branch));
    const values = trees.filter(tree => mode !== "done" || !tree.isPrimary)
      .flatMap(tree => tree.branch === null || isRemoteSelector(tree.branch)
        || (mode === "done" && primaryBranches.has(tree.branch)) ? [tree.path] : [tree.path, tree.branch]);
    if (mode !== "done") {
      values.push(...(await listBranches(repository)).flatMap(branch => {
        if (branch.kind === "remote") return [branch.remote + "/" + branch.name];
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
  const command = commands.find(command => command.name() === words[0] || command.aliases().includes(words[0]!));
  if (!command) return [];
  const options = help.visibleOptions(command);
  let operands = 0;
  let endOptions = false;
  let expectingValue = false;
  for (const word of words.slice(1)) {
    if (expectingValue) { expectingValue = false; continue; }
    if (!endOptions && word === "--") { endOptions = true; continue; }
    if (!endOptions && word.startsWith("-")) {
      const flag = word.split("=")[0];
      const option = options.find(option => option.long === flag || option.short === flag);
      if (!option) return [];
      expectingValue = (option.required || option.optional) && !word.includes("=");
    } else {
      operands++;
    }
  }
  if (expectingValue) {
    const previous = words.at(-1);
    return previous === "--base" ? filtered(await repositoryCandidates(cwd, "base"), prefix) : [];
  }
  if (!endOptions && prefix.startsWith("--base=") && command.name() === "new") {
    return filtered((await repositoryCandidates(cwd, "base")).map(value => "--base=" + value), prefix);
  }
  if (!endOptions && prefix.startsWith("-")) {
    return filtered(options.flatMap(option => [option.short, option.long].filter((flag): flag is string => !!flag)), prefix);
  }
  if (operands > 0) return [];
  if (command.name() === "completion") return filtered(["bash"], prefix);
  if (command.name() === "help") return filtered(commands.map(command => command.name()), prefix);
  if (command.name() === "open" || command.name() === "done") {
    return filtered(await repositoryCandidates(cwd, command.name() as "open" | "done"), prefix);
  }
  return [];
}
