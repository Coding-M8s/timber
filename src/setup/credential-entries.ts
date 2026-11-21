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
  | { kind: "forget"; label: string }
  | { kind: "default"; label: string };

/** Everything a saved-credential menu shows; labels and emails are never secret. */
export interface EntryMenu {
  title: string;
  /** Singular noun such as "personal API key" or "login". */
  noun: string;
  /** Saved labels, default first. */
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
    const fallback = labels[0]!;
    const name = (label: string) => `${menu.describe(label)}${label === fallback ? " (default)" : ""}`;
    const keep = menu.repository === null ? `Keep saved ${menu.noun}s (hidden; default ${menu.describe(fallback)})`
      : menu.association === null ? `Keep: this repository uses the default ${menu.describe(fallback)}`
        : `Keep: this repository uses ${menu.describe(menu.association)}`;
    choices = [{ value: "keep", label: keep }];
    if (menu.repository !== null) {
      // Selecting the default explicitly keeps this repository on it if the default later changes.
      for (const label of labels) {
        if (label === menu.association) continue;
        choices.push({ value: `use:${label}`, label: `Use ${name(label)} for this repository` });
      }
    }
    choices.push({ value: "add", label: `Add another ${menu.noun}` });
    for (const label of labels.slice(1)) choices.push({ value: `default:${label}`, label: `Make ${menu.describe(label)} the default for repositories without a selection` });
    for (const label of labels) choices.push({ value: `replace:${label}`, label: `Replace ${name(label)}` });
    for (const label of labels) {
      const count = others(menu, label);
      choices.push({ value: `remove:${label}`, label: `Remove ${name(label)}${count ? ` (selected by ${plural(count, "other repositor")})` : ""}` });
    }
    if (menu.association !== null) choices.push({ value: "forget", label: `Stop selecting ${menu.describe(menu.association)} for this repository (use the default; keeps it saved)` });
  }
  const choice = await prompt.select(menu.title, choices, "keep");
  if (choice === null) throw new SetupCancelled();
  if (!choices.some(option => option.value === choice)) throw new Error("Invalid credentials choice; no settings saved.");
  if (choice === "keep" || choice === "add") return { kind: choice };
  if (choice === "forget") return { kind: "forget", label: menu.association! };
  if (choice === "replace" || choice === "remove") {
    return labels.length === 0 ? { kind: "add" } : { kind: choice, label: labels[0]! };
  }
  const [kind, label] = choice.split(":") as ["use" | "replace" | "remove" | "default", string];
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

/** Adding an entry never changes what other repositories use. */
export function addedEntryNotice(noun: string, fallback: string): string {
  return `Repositories without their own selection keep using the default ${noun} ${fallback}. Use "Make ... the default" in this menu to change that.\n`;
}

/** Removing the default promotes the next saved entry. */
export function newDefaultNotice(noun: string, fallback: string): string {
  return `${fallback} is now the default ${noun} for repositories without their own selection.\n`;
}
