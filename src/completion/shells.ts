import { bashCompletionScript } from "./bash";
import { zshCompletionScript } from "./zsh";

export const completionShells = ["bash", "zsh"] as const;

export function completionScript(shell: string): string | undefined {
  if (shell === "bash") return bashCompletionScript();
  if (shell === "zsh") return zshCompletionScript();
  return undefined;
}
