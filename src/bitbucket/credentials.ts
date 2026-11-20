import { z } from "zod";
import { credentialFile } from "../platform/credential-file";
import type { SingleCredentialStore } from "../platform/credential-file";

/** An Atlassian account email and a Bitbucket API token, sent as HTTP Basic credentials. */
export interface BitbucketLogin { email: string; token: string }

const loginSchema = z.object({
  email: z.string().regex(/^[^\s:@\u0000-\u001f\u007f-\u009f]+@[^\s:@\u0000-\u001f\u007f-\u009f]+$/u),
  token: z.string().min(1).refine(value => !/[\s\u0000-\u0020\u007f-\u009f]/u.test(value)),
});
const storeSchema = loginSchema.extend({ version: z.literal(1) }).strict();

export function validBitbucketLogin(login: BitbucketLogin): boolean { return loginSchema.safeParse(login).success; }

export type BitbucketCredentialStore = SingleCredentialStore<BitbucketLogin>;

const file = credentialFile<BitbucketLogin>({
  name: "bitbucket", label: "Bitbucket",
  parse: value => { const { email, token } = storeSchema.parse(value); return { email, token }; },
  record: login => ({ email: login?.email ?? null, token: login?.token ?? null }),
  check: login => {
    if (!validBitbucketLogin(login)) throw new Error("Enter a valid Atlassian account email and a nonblank Bitbucket API token without whitespace or control characters.");
  },
});

export function readBitbucketCredentialStore(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<BitbucketCredentialStore> {
  return file.read(env, signal);
}

export async function loadSavedBitbucketLogin(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<BitbucketLogin | null> {
  return (await readBitbucketCredentialStore(env, signal)).get();
}

/** Credentials publish first; config's successful publication is the shared commit point. */
export const withBitbucketCredentialSave = file.save;
