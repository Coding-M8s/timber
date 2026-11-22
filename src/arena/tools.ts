/**
 * Native arena tools: how each installed agent CLI is started, how it takes the
 * task prompt and model, and which literal arguments a preset may add. One plain
 * table shared by validation, launch, recovery, selection, setup and docs.
 */
export const nativeArenaTools = ["codex", "claude", "cursor", "gemini", "grok", "opencode", "copilot", "qwen", "amp", "pi"] as const;
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
  /** Native arguments that start a session seeded with the task prompt. */
  promptArgs(prompt: string): string[];
  /** The session stays interactive after the task prompt; false only for Amp's execute mode. */
  interactive: boolean;
  /** The parser matches flags exactly, so `--flag=value` is not understood (Pi). */
  separateValuesOnly?: true;
  /** Model IDs the tool rejects before starting; checked before any worktree is made. */
  modelShape?: { pattern: RegExp; message: string };
  /** Flags the tool refuses unless a model is also given. */
  needModel?: readonly string[];
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
    interactive: true,
  },
  claude: {
    label: "Claude Code",
    executable: "claude",
    modelFlags: ["--model"],
    valueFlags: ["--model", "--effort", "--permission-mode", "--agent"],
    switches: ["--no-chrome"],
    effort: true,
    promptArgs: prompt => ["--", prompt],
    interactive: true,
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
    interactive: true,
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
    interactive: true,
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
    interactive: true,
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
    interactive: true,
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
    interactive: true,
  },
  qwen: {
    label: "Qwen Code",
    executable: "qwen",
    modelFlags: ["--model", "-m"],
    // --sandbox is omitted: Qwen types it as a string, so it can take the next argument.
    valueFlags: ["--model", "-m", "--approval-mode", "--auth-type"],
    switches: ["--screen-reader"],
    effort: false,
    // -i/--prompt-interactive runs the prompt and stays interactive; a positional prompt would exit.
    promptArgs: prompt => [`--prompt-interactive=${prompt}`],
    interactive: true,
  },
  amp: {
    label: "Amp",
    executable: "amp",
    // --mode is refused: Amp rejects it beside --model, and it also takes a model ID.
    modelFlags: ["--model"],
    valueFlags: ["--model"],
    switches: ["--no-ide", "--no-notifications", "--no-archive-after-execute"],
    // Amp's own check: "Expected provider/name, such as openai/gpt-6-astra."
    modelShape: { pattern: /^[^/\s]+\/\S+$/u, message: "Amp models are written provider/name, such as openai/gpt-6-astra." },
    effort: false,
    // Amp takes a first message on the command line only in execute mode, which ends after one turn.
    promptArgs: prompt => ["--execute", prompt],
    interactive: false,
  },
  pi: {
    label: "Pi",
    executable: "pi",
    modelFlags: ["--model"],
    valueFlags: ["--model", "--provider", "--tui-mode"],
    switches: ["--offline", "--verbose"],
    // Pi compares each argument to "--model" and friends exactly and rejects "--model=x".
    separateValuesOnly: true,
    needModel: ["--provider"],
    effort: false,
    // Positional messages open the terminal UI with that first prompt; --print would exit.
    promptArgs: prompt => ["--", prompt],
    interactive: true,
  },
};

export function isNativeArenaTool(value: string): value is NativeArenaTool {
  return (nativeArenaTools as readonly string[]).includes(value);
}
