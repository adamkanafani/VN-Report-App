/**
 * Converts an absolute Windows path to its "extended-length" form (the `\\?\` prefix, or
 * `\\?\UNC\` for a network share) so Win32 file APIs use the ~32,767-character limit instead of
 * the classic 260-character MAX_PATH.
 *
 * Real job folders nest several levels deep under long, descriptive names (customer, job number,
 * part description, exhibit type, the source file's own verbose real-world filename) and routinely
 * land north of 260 characters once combined -- confirmed against a real failure on Job 18664's
 * OneDrive copy (271 characters), where Node's fs.readFile surfaced it as an opaque
 * `UNKNOWN: unknown error, read` with no hint that path length was the actual cause. Every
 * filesystem call that touches a path built from a scanned job folder should go through this --
 * a short internal path (the app's own bundled assets, its %LOCALAPPDATA% state file) will never
 * hit the limit, but there's no harm in it being idempotent on those too.
 *
 * A no-op on non-Windows platforms, where MAX_PATH doesn't apply. Only meant for the literal
 * filesystem call itself -- keep using the plain path everywhere else (display, comparisons,
 * JSON sent to the client), since the prefixed form isn't meant to be read by a person.
 */
export function toLongPath(absolutePath: string): string {
  if (process.platform !== "win32") return absolutePath;
  if (absolutePath.startsWith("\\\\?\\")) return absolutePath; // already prefixed
  if (absolutePath.startsWith("\\\\")) {
    // UNC path (\\server\share\...) needs its own prefix form -- \\?\ alone would just double up
    // the leading slashes rather than extend the length limit.
    return "\\\\?\\UNC\\" + absolutePath.slice(2);
  }
  return "\\\\?\\" + absolutePath;
}
