import { resolve } from "node:path";
import { appIntegrations, checkAppIntegration } from "../app-config/check";
import type { AppIntegration } from "../app-config/check";
import { appConfigScopes, knownSecrets, readAppConfigInput, safeAppDiagnostic } from "../app-config/input";
import type { AppConfigScope } from "../app-config/input";
import { applyAppConfig, createAppConfigReport, readAppConfig } from "../app-config/settings";
import { safeDisplay } from "../display";
import { runMachineCommand } from "../machine";
import type { CommandContext } from "../services";

interface AppConfigOptions { scope?: string; inputFile?: string; resultFile?: string; editTracked?: boolean }

function scopeOf(value: string | undefined, required: boolean): AppConfigScope | undefined {
  if (value === undefined && !required) return undefined;
  if (!appConfigScopes.some(scope => scope === value)) throw new Error("Choose --scope repository or --scope global.");
  return value as AppConfigScope;
}

/** Experimental settings transport for app consumers. No prompt, terminal, or tool launch. */
export async function runAppConfig(
  action: string, integration: string | undefined, options: AppConfigOptions, context: CommandContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (action === "read") {
    if (integration !== undefined || options.inputFile || options.resultFile || options.editTracked) {
      throw new Error("Read accepts only --scope.");
    }
    context.io.stdout(JSON.stringify(await readAppConfig(scopeOf(options.scope, true)!, context.cwd, env)) + "\n");
    return 0;
  }
  if (action === "apply") {
    if (integration !== undefined || !options.inputFile || !options.resultFile) {
      throw new Error("Apply requires --scope, --input-file and --result-file.");
    }
    const scope = scopeOf(options.scope, true)!;
    const inputFile = resolve(context.cwd, options.inputFile);
    return runMachineCommand("config", context, async ({ machine }) => {
      const report = createAppConfigReport(scope);
      machine?.config(report);
      let secrets = knownSecrets(env);
      try {
        const input = await readAppConfigInput(inputFile);
        secrets = knownSecrets(env, input);
        await applyAppConfig(scope, context.cwd, input, { editTracked: options.editTracked === true }, report, env, machine);
      } catch (error) {
        throw new Error(safeAppDiagnostic(error, secrets, "Could not save settings."));
      }
      context.io.stdout(`Saved ${scope === "global" ? "machine defaults" : "repository settings"} at ${safeDisplay(report.path ?? "")}\n`);
    }, options.resultFile);
  }
  if (action === "check") {
    if (!appIntegrations.some(name => name === integration)) throw new Error("Check one of: github, linear, jira.");
    if (options.resultFile || options.editTracked) throw new Error("Check accepts only --scope and --input-file.");
    const scope = scopeOf(options.scope, false);
    let result;
    try {
      const input = options.inputFile === undefined ? undefined : await readAppConfigInput(resolve(context.cwd, options.inputFile));
      result = await checkAppIntegration(integration as AppIntegration, context.cwd, scope, input, { env, fetch: (url, init) => fetch(url, init), timeoutMs: 10_000 });
    } catch (error) {
      // An unusable draft is still a check result, so stdout always carries one object.
      result = { schemaVersion: 1 as const, integration: integration as AppIntegration, ok: false, source: null, account: null,
        diagnostic: safeAppDiagnostic(error, knownSecrets(env), "Connection check failed.") };
    }
    context.io.stdout(JSON.stringify(result) + "\n");
    return result.ok ? 0 : 1;
  }
  throw new Error("Unknown __app-config action. Use read, apply, or check.");
}
