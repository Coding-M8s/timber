/**
 * True for a compiled release executable, false for a Bun source or `bun link` run.
 * Bun serves a compiled executable's embedded entry from `/$bunfs/` on Linux and macOS
 * and from `B:/~BUN/` on Windows.
 */
export function isStandaloneMain(main: string = Bun.main): boolean {
  return main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/u.test(main);
}
