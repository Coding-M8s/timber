import type { CommandHandlers, CommandServices } from "../services";
import type { Branch, OpenTarget, RepositoryContext, Worktree } from "../types";

const terminalControl = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const terminalControls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
const extendedControls = /[\u007f-\u009f\u2028\u2029]/gu;

function codePointEscape(character: string): string {
  return `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
}

/** JSON rendering is readable for paths while explicitly escaping DEL, C1 and line separators. */
function jsonDisplay(value: string): string {
  return JSON.stringify(value).replace(extendedControls, codePointEscape);
}

function safeDisplay(value: string): string {
  return terminalControl.test(value) ? jsonDisplay(value) : value;
}

function diagnosticEscape(character: string): string {
  if (character === "\b") return "\\b";
  if (character === "\t") return "\\t";
  if (character === "\n") return "\\n";
  if (character === "\f") return "\\f";
  if (character === "\r") return "\\r";
  return codePointEscape(character);
}

function bashByteEscapes(character: string): string {
  return [...new TextEncoder().encode(character)]
    .map(byte => `\\${byte.toString(8).padStart(3, "0")}`)
    .join("");
}

/** Keep service errors on one safe display line without changing ordinary punctuation. */
function safeDiagnostic(value: string): string {
  return value.replace(terminalControls, diagnosticEscape);
}

function bashAnsiCQuote(value: string): string {
  const contents = [...value].map(character => {
    if (character === "\\") return "\\\\";
    if (character === "'") return "\\'";
    if (character === "\b") return "\\b";
    if (character === "\t") return "\\t";
    if (character === "\n") return "\\n";
    if (character === "\f") return "\\f";
    if (character === "\r") return "\\r";
    if (character === "\v") return "\\v";
    if (character === "!" || terminalControl.test(character)) return bashByteEscapes(character);
    return character;
  }).join("");
  return `$'${contents}'`;
}

function retryForDisplay(path: string, ordinaryRetry: string): string {
  return terminalControl.test(path)
    ? `Bash retry command: timber open -- ${bashAnsiCQuote(path)}`
    : ordinaryRetry;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Command failed unexpectedly";
}

async function safely<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(safeDiagnostic(errorMessage(error)));
  }
}

function exactSelector(target: OpenTarget): string {
  if (target.kind === "worktree") return target.worktree.path;
  return target.branch.kind === "local"
    ? target.branch.name
    : `${target.branch.remote}/${target.branch.name}`;
}

function targetIdentity(target: OpenTarget): string {
  return target.kind === "worktree"
    ? `worktree:${target.worktree.path}`
    : `branch:${target.branch.ref}`;
}

function remotePrefix(repository: RepositoryContext, branchName: string): string | null {
  return [...repository.remotes]
    .sort((left, right) => right.name.length - left.name.length)
    .find(remote => branchName.startsWith(`${remote.name}/`))?.name ?? null;
}

function targetLabel(target: OpenTarget): string {
  if (target.kind === "worktree") return `Worktree ${safeDisplay(target.worktree.path)}`;
  if (target.branch.kind === "local") {
    return `Local branch ${safeDisplay(target.branch.name)} (Git ref: ${safeDisplay(target.branch.ref)})`;
  }
  return `Remote branch ${safeDisplay(`${target.branch.remote}/${target.branch.name}`)} (Git ref: ${safeDisplay(target.branch.ref)})`;
}

function ambiguousMessage(
  input: string, candidates: readonly OpenTarget[], repository: RepositoryContext,
): string {
  const identities = new Map<string, OpenTarget>();
  for (const candidate of candidates) identities.set(targetIdentity(candidate), candidate);
  const unique = [...identities.values()];
  const decorated = unique.map(target => ({
    target,
    selector: exactSelector(target),
    shadowedBy: target.kind === "branch" && target.branch.kind === "local"
      ? remotePrefix(repository, target.branch.name)
      : null,
  }));
  const selectorCounts = new Map<string, number>();
  for (const item of decorated) selectorCounts.set(item.selector, (selectorCounts.get(item.selector) ?? 0) + 1);
  decorated.sort((left, right) => left.selector < right.selector ? -1
    : left.selector > right.selector ? 1
      : targetIdentity(left.target) < targetIdentity(right.target) ? -1
        : targetIdentity(left.target) > targetIdentity(right.target) ? 1 : 0);

  const hasShadowedLocal = decorated.some(item => item.shadowedBy !== null);
  const header = hasShadowedLocal
    ? `Input ${jsonDisplay(input)} matches multiple targets. Exact selectors are shown where supported; shadowed local branches require a Git worktree and absolute path:\n`
    : `Input ${jsonDisplay(input)} matches multiple targets. Choose an exact branch or worktree path:\n`;
  const lines = decorated.flatMap(({ target, selector, shadowedBy }) => {
    if (shadowedBy !== null && target.kind === "branch" && target.branch.kind === "local") {
      return [
        `  ${targetLabel(target)} — shadowed by known remote prefix ${safeDisplay(shadowedBy)}; this name is parsed as a remote selector.`,
        "    To open this local branch, create a Git worktree for it, then run timber open -- '<absolute-worktree-path>'.",
      ];
    }
    if ((selectorCounts.get(selector) ?? 0) > 1) {
      return [
        `  ${targetLabel(target)}`,
        `    Exact selector: ${safeDisplay(selector)}`,
      ];
    }
    return [`  ${safeDisplay(selector)}`];
  });
  return header + lines.join("\n");
}

function branchRequest(branch: Branch) {
  return branch.kind === "local"
    ? { kind: "local" as const, branch }
    : { kind: "remote" as const, branch };
}

/** Resolve an existing target, create only a selected branch, then optionally start its editor. */
export function createOpenHandler(
  services: Pick<CommandServices,
    "discoverRepository" | "loadConfig" | "resolveOpenTarget" | "createWorktree" | "launchEditor">,
): CommandHandlers["open"] {
  return async (input, options, context) => {
    if (!input.trim()) throw new Error("Provide an existing branch or worktree path to open.");

    const repository = await safely(() => services.discoverRepository(context.cwd));
    const config = await safely(() => services.loadConfig(repository));
    const resolution = await safely(() => services.resolveOpenTarget(repository, input, config));

    if (resolution.kind === "not-found") {
      throw new Error(`No existing branch or worktree matches ${jsonDisplay(input)}. Check the exact branch or absolute worktree path.`);
    }
    if (resolution.kind === "ambiguous") {
      throw new Error(ambiguousMessage(input, resolution.candidates, repository));
    }

    const selected = resolution.value;
    const created = selected.kind === "branch";
    const worktree: Worktree = created
      ? await safely(() => services.createWorktree(repository, branchRequest(selected.branch), config))
      : selected.worktree;

    const editor = await safely(() => services.launchEditor(worktree, config, options.editor === false));
    if (editor.kind === "failed") {
      const retryCommand = retryForDisplay(worktree.path, editor.retryCommand);
      const includedRetry = editor.message.includes(editor.retryCommand);
      const originalMessage = includedRetry
        ? editor.message.replace(editor.retryCommand, () => retryCommand)
        : editor.message;
      const message = safeDiagnostic(originalMessage);
      const retry = includedRetry ? "" : ` Retry with: ${retryCommand}`;
      context.io.stderr(`error: ${message}${retry}\n`);
    }

    context.io.stdout(`${created ? "Created" : "Opened existing"} worktree at ${safeDisplay(worktree.path)}\n`);
  };
}
