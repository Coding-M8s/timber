import { credentialLabelHint, defaultCredentialLabel, validCredentialLabel } from "../credential-selection";
import type { CommandIO } from "../services";
import type { ChoiceOption } from "../selection";
import { SetupCancelled } from "./types";
import type { SetupPrompt } from "./types";

export type EntryAction =
  | { kind: "keep" }
  | { kind: "add" }
  | { kind: "use"; label: string }
  | { kind: "replace"; label: string }
  | { kind: "remove"; label: string }
  | { kind: "forget"; label: string };

/** Everything a saved-credential menu shows; labels and emails are never secret. */
export interface EntryMenu {
  title: string;
  /** Singular noun such as "personal API key" or "login". */
  noun: string;
  labels: readonly string[];
  describe(label: string): string;
  /** Null outside repository setup, where no association can be chosen. */
  repository: string | null;
  association: string | null;
  users(label: string): readonly string[];
  /** Wording for the familiar zero/one-entry menu. */
  single: { keep: string; enter: string; replace: string; remove: string };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "y" : "ies"}`;

function others(menu: EntryMenu, label: string): number {
  return menu.users(label).filter(repository => repository !== menu.repository).length;
}

export async function chooseEntryAction(prompt: SetupPrompt, menu: EntryMenu): Promise<EntryAction> {
  const { labels, single } = menu;
  let choices: ChoiceOption[];
  if (labels.length === 0) {
    choices = [{ value: "keep", label: "None" }, { value: "replace", label: single.enter }];
  } else if (labels.length === 1) {
    choices = [
      { value: "keep", label: single.keep },
      { value: "replace", label: single.replace },
      { value: "add", label: `Add another ${menu.noun} (for a different workspace or account)` },
      { value: "remove", label: single.remove },
    ];
  } else {
    const keep = menu.repository === null ? `Keep saved ${menu.noun}s (hidden)`
      : menu.association === null ? `Keep (no ${menu.noun} selected for this repository)`
        : `Keep: this repository uses ${menu.describe(menu.association)}`;
    choices = [{ value: "keep", label: keep }];
    if (menu.repository !== null) {
      for (const label of labels) if (label !== menu.association) choices.push({ value: `use:${label}`, label: `Use ${menu.describe(label)} for this repository` });
    }
    choices.push({ value: "add", label: `Add another ${menu.noun}` });
    for (const label of labels) choices.push({ value: `replace:${label}`, label: `Replace ${menu.describe(label)}` });
    for (const label of labels) {
      const count = others(menu, label);
      choices.push({ value: `remove:${label}`, label: `Remove ${menu.describe(label)}${count ? ` (selected by ${plural(count, "other repositor")})` : ""}` });
    }
    if (menu.association !== null) choices.push({ value: "forget", label: `Stop selecting ${menu.describe(menu.association)} for this repository (keeps it saved)` });
  }
  const choice = await prompt.select(menu.title, choices, "keep");
  if (choice === null) throw new SetupCancelled();
  if (!choices.some(option => option.value === choice)) throw new Error("Invalid credentials choice; no settings saved.");
  if (choice === "keep" || choice === "add") return { kind: choice };
  if (choice === "forget") return { kind: "forget", label: menu.association! };
  if (choice === "replace" || choice === "remove") {
    return labels.length === 0 ? { kind: "add" } : { kind: choice, label: labels[0]! };
  }
  const [kind, label] = choice.split(":") as ["use" | "replace" | "remove", string];
  return { kind, label };
}

/** The first saved entry needs no name; later entries need a distinct label. */
export async function chooseNewLabel(prompt: SetupPrompt, io: CommandIO, labels: readonly string[]): Promise<string> {
  if (labels.length === 0) return defaultCredentialLabel;
  io.stdout(`Name this entry so you can tell it apart, such as a workspace or account name. Labels are not secret. ${credentialLabelHint}\n`);
  while (true) {
    const label = await prompt.text("Label for the new entry", "");
    if (label === null) throw new SetupCancelled();
    if (!validCredentialLabel(label)) { io.stderr(`Invalid label. ${credentialLabelHint}\n`); continue; }
    if (labels.includes(label)) { io.stderr("That label is already saved; choose another or replace the existing entry.\n"); continue; }
    return label;
  }
}

/** Removing an entry other repositories selected needs explicit confirmation. */
export async function confirmRemoval(prompt: SetupPrompt, menu: EntryMenu, label: string): Promise<boolean> {
  const count = others(menu, label);
  if (!count) return true;
  const answer = await prompt.confirm(`Remove ${menu.describe(label)}? ${plural(count, "other repositor")} selected it and will need a new selection.`, false);
  if (answer === null) throw new SetupCancelled();
  return answer;
}

export function severalEntriesNotice(provider: string, noun: string): string {
  return `With several saved ${provider} ${noun}s, each repository must select one. Repositories without a selection report it until you run timber setup there.\n`;
}
