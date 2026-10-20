import { safeDiagnostic } from "../display";
import type { ArenaPlan, ArenaReview, PlannedAttempt } from "./types";

import { terminalStyle as arenaStyle } from "../terminal-style";

type ArenaStyle = ReturnType<typeof arenaStyle>;

export function arenaRunBlock(attempt: PlannedAttempt, number: number, total: number, style: ArenaStyle): string {
  const native = ["codex", "claude", "cursor"].includes(attempt.tool);
  const model = attempt.model ?? (native ? "tool default" : "not specified");
  const effort = attempt.effort == null
    ? native ? `tool/model default${attempt.effortEnvironment ? `; CLAUDE_CODE_EFFORT_LEVEL=${attempt.effortEnvironment} (inherited)` : ""}; effective unknown` : "not specified"
    : `${attempt.effort} (requested); effective unknown`;
  return [
    style.heading(`Run ${number}/${total} · ${attempt.label}`),
    `  ${style.label("Tool")}    ${safeDiagnostic(attempt.tool)}`,
    `  ${style.label("Model")}   ${safeDiagnostic(model)}`,
    `  ${style.label("Effort")}  ${safeDiagnostic(effort)}`,
    ...(attempt.configSource === "preset" || attempt.configSource === "ordinary" ? [`  ${style.label("Preset")}  ${safeDiagnostic(attempt.preset)}`] : []),
    `  ${style.label("Branch")}  ${safeDiagnostic(attempt.branch)}`,
    `  ${style.label("Path")}    ${safeDiagnostic(attempt.path)}`,
  ].join("\n");
}

function arenaOverview(plan: ArenaReview, style: ArenaStyle): string {
  const commit = "base" in plan ? plan.base.commit
    : plan.source.kind === "local" ? plan.source.base.commit : plan.source.advertisedCommit;
  const source = "base" in plan ? plan.source?.selector ?? plan.base.ref : plan.source.selector;
  return [
    style.heading(`Arena ${plan.name}`),
    `  ${style.label("Source")}  ${safeDiagnostic(source)}`,
    `  ${style.label("Commit")}  ${safeDiagnostic(commit)}`,
    `  ${style.label("Runs")}    ${plan.attempts.length} · sequential in this terminal`,
    ...(plan.ticket ? [`  ${style.label("Ticket")}  ${safeDiagnostic(plan.ticket)}`] : []),
  ].join("\n");
}

export function arenaReviewText(plan: ArenaReview): string {
  const plain = arenaStyle(false, {});
  return [
    arenaOverview(plan, plain),
    ...plan.attempts.map((attempt, index) => "\n" + arenaRunBlock(attempt, index + 1, plan.attempts.length, plain)),
    ...(plan.source?.ticketBranchMissing ? ["\nNo matching ticket branch found; using configured/default starting point."] : []),
    ...(!("base" in plan) && plan.source.kind === "remote" ? ["\nAfter confirmation, fetch the selected remote branch; cached refs may change."] : []),
    "\nTask text and executable arguments are omitted.",
    "Exit each agent normally to start the next run. All workspaces are retained.",
    "\nCreate these workspaces?",
  ].join("\n");
}

export function arenaStartText(plan: ArenaPlan, taskPath: string, style: ArenaStyle): string {
  return `\n${arenaOverview(plan, style)}\n  ${style.label("Task")}    ${safeDiagnostic(taskPath)} (private snapshot)\n\n`;
}
