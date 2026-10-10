import type { CommandHandlers, CommandServices } from "../services";

type NewServices = Pick<CommandServices,
  "discoverRepository" | "loadConfig" | "resolveBase" | "createWorktree" | "runSetup" | "launchEditor">;

/** Create a new workspace, then optionally start its configured editor. */
export function createNewHandler(services: NewServices): CommandHandlers["new"] {
  return async (branch, options, context) => {
    const repository = await services.discoverRepository(context.cwd);
    const config = await services.loadConfig(repository);
    const base = await services.resolveBase(repository, config, options.base);
    const worktree = await services.createWorktree(repository, { kind: "new", branch, base }, config);
    context.io.stdout(`Created ${branch} at ${worktree.path}\n`);

    if (config.hooks?.postCreate.length) {
      await services.runSetup(repository, worktree, config, context.io);
    }

    const editor = await services.launchEditor(worktree, config, options.editor === false);
    if (editor.kind === "failed") throw new Error(editor.message);
  };
}
