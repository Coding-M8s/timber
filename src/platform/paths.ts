import { resolve, win32 } from "node:path";

/** Case folding is for filesystem collision/identity checks, never Git ref names. */
export function pathKey(path: string, platform = process.platform): string {
  return platform === "win32" ? win32.resolve(path).toLowerCase() : resolve(path);
}

export function samePath(left: string, right: string, platform = process.platform): boolean {
  return pathKey(left, platform) === pathKey(right, platform);
}

export function validateWindowsComponent(name: string): void {
  if (/[<>:"/\\|?*\u0000-\u001f]/u.test(name) || /[. ]$/u.test(name)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)) {
    throw new Error("Worktree path contains a reserved or ambiguous Windows filename. Choose another branch or directory.");
  }
}
