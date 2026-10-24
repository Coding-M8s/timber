import { bashCompletionScript } from "./bash";
import { fishCompletionScript } from "./fish";
import { zshCompletionScript } from "./zsh";

export const completionShells = ["bash", "zsh", "fish"] as const;

export function completionScript(shell: string): string | undefined {
  if (shell === "bash") return bashCompletionScript();
  if (shell === "zsh") return zshCompletionScript();
  if (shell === "fish") return fishCompletionScript();
  return undefined;
}
