/**
 * Native arena tools: how each installed agent CLI is started, how it takes the
 * task prompt and model, and which literal arguments a preset may add. One plain
 * table shared by validation, launch, recovery, selection, setup and docs.
 */
export const nativeArenaTools = ["codex", "claude", "cursor", "gemini", "grok", "opencode", "copilot"] as const;
export type NativeArenaTool = (typeof nativeArenaTools)[number];

export interface NativeArenaToolSpec {
  /** Selection and setup label. */
  label: string;
  /** Program on PATH that Timber starts. */
  executable: string;
  /** Flags whose value is the model ID. */
  modelFlags: readonly string[];
  /** Flags that take exactly one value (model flags included). */
  valueFlags: readonly string[];
  /** Flags that take no value. */
  switches: readonly string[];
  /** Timber can request a reasoning effort (Codex config, Claude flag, Cursor model variant). */
  effort: boolean;
  /** Native arguments that start an interactive session seeded with the task prompt. */
  promptArgs(prompt: string): string[];
}

/*
 * Allow-lists take documented interactive options with one clear value or none.
 * Permission modes are allowed as values, as for Codex and Claude; blanket
 * auto-approve switches, other prompts, headless modes, resume, other folders,
 * worktrees and subcommands are refused.
 */
export const nativeArenaToolSpecs: Readonly<Record<NativeArenaTool, NativeArenaToolSpec>> = {
  codex: {
    label: "Codex CLI",
    executable: "codex",
    modelFlags: ["--model", "-m"],
    valueFlags: ["--model", "-m", "--profile", "-p", "--config", "-c", "--sandbox", "-s", "--ask-for-approval", "-a"],
    switches: ["--no-alt-screen", "--no-daemon", "--search"],
    effort: true,
    promptArgs: prompt => ["--", prompt],
  },
  claude: {
    label: "Claude Code",
    executable: "claude",
    modelFlags: ["--model"],
    valueFlags: ["--model", "--effort", "--permission-mode", "--agent"],
    switches: ["--no-chrome"],
    effort: true,
    promptArgs: prompt => ["--", prompt],
  },
  cursor: {
    label: "Cursor CLI",
    // Not `cursor` (the editor) or the ambiguous `agent`.
    executable: "cursor-agent",
    modelFlags: ["--model"],
    valueFlags: ["--model"],
    switches: [],
    effort: true,
    promptArgs: prompt => ["--", prompt],
  },
  gemini: {
    label: "Gemini CLI",
    executable: "gemini",
    modelFlags: ["--model", "-m"],
    valueFlags: ["--model", "-m", "--approval-mode"],
    switches: ["--sandbox", "-s"],
    effort: false,
    // -i/--prompt-interactive runs the prompt and stays interactive; -p would exit.
    promptArgs: prompt => [`--prompt-interactive=${prompt}`],
  },
  grok: {
    label: "Grok Build",
    executable: "grok",
    modelFlags: ["--model", "-m"],
    valueFlags: ["--model", "-m", "--permission-mode", "--agent"],
    switches: ["--no-alt-screen", "--no-memory", "--disable-web-search", "--no-subagents"],
    effort: false,
    // Positional prompt; `--` keeps it from being read as a subcommand.
    promptArgs: prompt => ["--", prompt],
  },
  opencode: {
    label: "OpenCode",
    executable: "opencode",
    modelFlags: ["--model", "-m"],
    valueFlags: ["--model", "-m", "--agent"],
    switches: [],
    effort: false,
    // The positional argument is a project directory, never the prompt.
    promptArgs: prompt => [`--prompt=${prompt}`],
  },
  copilot: {
    label: "GitHub Copilot CLI",
    executable: "copilot",
    modelFlags: ["--model"],
    valueFlags: ["--model", "--agent", "--mode"],
    switches: ["--no-banner", "--sandbox", "--no-sandbox", "--screen-reader"],
    effort: false,
    // -i/--interactive runs the prompt and stays interactive; -p would exit.
    promptArgs: prompt => [`--interactive=${prompt}`],
  },
};

export function isNativeArenaTool(value: string): value is NativeArenaTool {
  return (nativeArenaTools as readonly string[]).includes(value);
}
