import { z } from "zod";
import { credentialFile } from "../platform/credential-file";
import type { SingleCredentialStore } from "../platform/credential-file";

const keySchema = z.string().min(1).refine(value => !/[\s\u0000-\u0020\u007f-\u009f]/u.test(value));
const storeSchema = z.object({ version: z.literal(1), token: keySchema }).strict();

export function validLinearKey(key: string): boolean { return keySchema.safeParse(key).success; }

export type LinearCredentialStore = SingleCredentialStore<string>;

const file = credentialFile<string>({
  name: "linear", label: "Linear",
  parse: value => storeSchema.parse(value).token,
  record: token => ({ token }),
  check: key => {
    if (!validLinearKey(key)) throw new Error("Enter a nonblank Linear personal API key without whitespace or control characters.");
  },
});

export function readLinearCredentialStore(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<LinearCredentialStore> {
  return file.read(env, signal);
}

export async function loadSavedLinearKey(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<string | null> {
  return (await readLinearCredentialStore(env, signal)).get();
}

/** Credentials publish first; config's successful publication is the shared commit point. */
export const withLinearCredentialSave = file.save;
