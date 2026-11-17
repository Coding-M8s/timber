import { safeDiagnostic, shellQuoteForDisplay as q } from "../display";
import { validateArenaName } from "../arena/participants";
import type { ArenaPickServices } from "../arena/services";
import type { ArenaArchive } from "../arena/archive";
import type { ArenaAttemptRecord, ArenaManifest, ArenaPickOptions, ArenaPickRecord } from "../arena/types";
import type { CommandContext } from "../services";
import type { ArenaAttemptSummary, DiffStat } from "../arena/summary";

const BETA = "Beta: arena pick is incomplete and under active testing; behavior may change.\n";

function inactive(attempt: ArenaAttemptRecord): void {
  if (attempt.stage === "setup-running" || attempt.stage === "launch-running" ||
      (attempt.stage === "failed" && attempt.failedStage === undefined))
    throw new Error(`${attempt.label} is still running or was interrupted (${attempt.stage}); let its agent finish first. Timber cannot detect every external process.`);
  if (attempt.stage !== "failed" && attempt.failedStage !== undefined)
    throw new Error(`${attempt.label} has an inconsistent lifecycle record; inspect it before cleanup.`);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const stat = (s: DiffStat) => `${plural(s.files, "file")} +${s.insertions} -${s.deletions}`;

export function describeWork(summary: ArenaAttemptSummary): string {
  if (summary.kind === "unavailable") return `cannot compare: ${safeDiagnostic(summary.reason)}`;
  const parts: string[] = [];
  if (summary.commits > 0) parts.push(`${plural(summary.commits, "commit")} (${stat(summary.committed)})`);
  if (summary.uncommitted.files > 0) parts.push(`uncommitted ${stat(summary.uncommitted)}`);
  if (summary.untracked > 0) parts.push(`${summary.untracked} untracked`);
  return parts.length ? parts.join(", ") : "no changes";
}

function state(attempt: ArenaAttemptRecord): string {
  if (attempt.stage === "failed") return `failed${attempt.failedStage ? ` in ${attempt.failedStage}` : ""}`;
  if (attempt.stage === "exited") return attempt.signal ? `stopped by ${attempt.signal}` : `exit ${attempt.exitCode ?? "?"}`;
  if (attempt.stage === "setup-running" || attempt.stage === "launch-running") return "running";
  return attempt.stage;
}

function agent(manifest: ArenaManifest, attempt: ArenaAttemptRecord): string {
  const recorded = manifest.version === 2 ? manifest.attempts.find(a => a.id === attempt.id) : undefined;
  const details = [recorded?.model, recorded?.effort == null ? undefined : `${recorded.effort} effort`].filter(Boolean);
  const preset = attempt.preset !== attempt.tool ? ` preset ${attempt.preset}` : "";
  return safeDiagnostic(`${attempt.tool}${preset}${details.length ? ` (${details.join(", ")})` : ""}`);
}

function retryCommand(name: string, winner: string, options: ArenaPickOptions): string {
  return ["timber", "arena", "pick", name, "--winner", winner,
    ...(options.keepBranch ? ["--keep-branch"] : []), ...(options.keepIgnored ? ["--keep-ignored"] : [])].map(q).join(" ");
}

/** Selection records intent only; live Git evidence remains cleanup's authority. */
export function createArenaPickHandler(services: ArenaPickServices) {
  return async (name: string, options: ArenaPickOptions, context: CommandContext): Promise<number> => {
    validateArenaName(name);
    if (options.inspect && options.winner !== undefined) throw new Error("--inspect cannot be combined with --winner.");
    const repository = await services.discoverRepository(context.cwd);
    const { manifest } = await services.readArena(repository, name);
    const previous = await services.readArenaPick(repository, name, manifest);
    const out = context.io.stdout, err = context.io.stderr;
    const [summaries, removal] = await Promise.all([
      Promise.all(manifest.attempts.map(a => services.summarizeArenaAttempt(repository, manifest, a))),
      Promise.all(manifest.attempts.map(a => services.inspectArenaRemoval(repository, a))),
    ]);
    const archiveOf = (id: string) => previous?.archives.find(a => a.attemptId === id);
    const gone = (i: number) => removal[i]!.worktree === "absent";
    const line = (a: ArenaAttemptRecord, i: number) => {
      const archived = archiveOf(a.id);
      const work = gone(i) ? `removed${archived ? `, archived as ${archived.ref}` : ""}` : describeWork(summaries[i]!);
      return `${a.label}  ${agent(manifest, a)}, ${state(a)}: ${work}`;
    };

    out(BETA);
    out(`Arena ${name}: ${plural(manifest.attempts.length, "attempt")} from ${manifest.base.commit.slice(0, 12)}${previous ? `, winner ${manifest.attempts.find(a => a.id === previous.winnerId)!.label}` : ""}\n`);
    manifest.attempts.forEach((a, i) => {
      out(`  ${line(a, i)}\n`);
      if (!gone(i)) out(`    ${safeDiagnostic(a.path)}\n`);
      if (options.inspect && !gone(i)) out(`    git -C ${q(a.path)} diff ${manifest.base.commit.slice(0, 12)}\n`);
    });
    if (options.inspect) {
      out("Each diff covers committed and uncommitted tracked changes. Untracked files: git -C <path> status\nReopen one: timber open --no-editor --no-agent -- <path>\n");
      return 0;
    }

    const choose = context.interactive ? context.choose : undefined;
    let winner: ArenaAttemptRecord | undefined;
    if (options.winner !== undefined) {
      winner = manifest.attempts.find(a => a.label === options.winner);
      if (!winner) throw new Error(`No attempt named ${JSON.stringify(options.winner)} in arena ${name}. Attempts: ${manifest.attempts.map(a => a.label).join(", ")}.`);
    } else if (choose) {
      const offered: ArenaAttemptRecord[] = [], labels: { value: string; label: string }[] = [];
      manifest.attempts.forEach((a, i) => { if (!gone(i)) { offered.push(a); labels.push({ value: a.id, label: line(a, i) }); } });
      const id = await choose("Which attempt do you want to keep?", labels);
      if (id === null) { out("Cancelled. Nothing changed.\n"); return 0; }
      winner = offered.find(a => a.id === id);
      if (!winner) throw new Error("Invalid selection; nothing was changed.");
    } else {
      throw new Error(`Choose a winner with --winner <label> (${manifest.attempts.map(a => a.label).join(", ")}), or run in an interactive terminal. Use --inspect to compare without changes.`);
    }
    const chosen = winner;
    inactive(chosen);
    await services.validateArenaAttempt(repository, manifest, chosen);

    const losers = manifest.attempts.filter((a, i) => a.id !== chosen.id && !gone(i));
    const changed = previous && previous.winnerId !== chosen.id
      ? `Changing the recorded winner from ${manifest.attempts.find(a => a.id === previous.winnerId)!.label}.\n` : "";
    out(`${changed}Keep ${chosen.label} at ${safeDiagnostic(chosen.path)}.\n`);
    if (losers.length) {
      out(`Remove ${losers.map(a => a.label).join(", ")}. Their commits and uncommitted files are archived under refs/timber/arena/${name}/ first. ` +
        `${options.keepIgnored ? "Attempts with ignored files are kept (--keep-ignored)." : "Ignored files such as .env and node_modules are deleted."} ` +
        `${options.keepBranch ? "Local branches are kept." : "Local branches are deleted."}\n`);
    }
    if (choose) {
      const decision = await choose(losers.length ? "Remove the other attempts?" : "Record this winner?", [
        { value: "cancel", label: "Cancel (default)", default: true },
        { value: "pick", label: losers.length ? `Keep ${chosen.label}, archive and remove ${plural(losers.length, "other attempt")}` : `Record ${chosen.label} as winner` },
      ]);
      if (decision !== "pick") { out("Cancelled. Nothing changed.\n"); return 0; }
    }

    const session = await services.openArenaForPick(repository, name, manifest, previous);
    let code = 0;
    const archived: ArenaArchive[] = [];
    try {
      const verifyWinner = async () => {
        await session.verify();
        inactive(chosen);
        await services.validateArenaAttempt(repository, manifest, chosen);
      };
      await verifyWinner();
      const record: ArenaPickRecord = { version: 1, arenaId: manifest.id, winnerId: chosen.id, archives: [...(previous?.archives ?? [])] };
      session.pick = record;
      await session.savePick();
      const config = await services.loadConfig(repository);
      for (const attempt of losers) {
        const boundary = async () => {
          await verifyWinner();
          if (attempt.path === chosen.path || attempt.branch === chosen.branch) throw new Error("cleanup target overlaps the winner");
          inactive(attempt);
          await services.validateArenaAttempt(repository, manifest, attempt);
        };
        let archive: ArenaArchive | undefined;
        try {
          await boundary();
          const tree = await services.validateArenaAttempt(repository, manifest, attempt);
          // Called with the fingerprint already captured, so removal fails if files change after archiving.
          const preserve = async () => {
            await boundary();
            archive = await services.archiveArenaAttempt(repository, tree, name, attempt.label);
            record.archives = [...record.archives.filter(a => a.attemptId !== attempt.id),
              { attemptId: attempt.id, ref: archive.ref, commit: archive.commit }];
            await session.savePick();
            return true;
          };
          await services.cleanupWorktree(repository, tree, config,
            { keepBranch: options.keepBranch === true, discardIgnored: options.keepIgnored !== true },
            context.io, preserve, undefined, { confirmEveryDiscard: true, beforeRemove: boundary, beforeDeleteBranch: verifyWinner });
          if (archive) archived.push(archive);
          out(`Removed ${attempt.label}${archive ? ` (archived as ${archive.ref})` : " (no unique work)"}.\n`);
        } catch (error) {
          code = 1;
          if (archive) archived.push(archive);
          const reason = safeDiagnostic(error instanceof Error ? error.message : "cleanup failed");
          const after = await services.inspectArenaRemoval(repository, attempt);
          err(`${after.worktree === "absent" ? "Partly removed" : "Kept"} ${attempt.label}: ${reason}\n`);
        }
      }
    } finally { await session.close(); }

    out(`Winner ${chosen.label}: ${safeDiagnostic(chosen.branch)} at ${safeDiagnostic(chosen.path)}. Nothing was merged or pushed.\n`);
    if (archived.length) out(`Restore an archived attempt: git worktree add -b <branch> <path> ${q(archived[0]!.ref)}\n`);
    if (code !== 0) out(`Fix the reasons above, then rerun: ${retryCommand(name, chosen.label, options)}\n`);
    return code;
  };
}
