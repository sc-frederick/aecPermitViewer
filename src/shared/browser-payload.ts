/** True for the debug.log where headless Chromium on Windows writes GPU diagnostics at runtime; it isn't hashed. */
export function isBrowserDiagnosticFile(relative: string): boolean {
  return /^chromium_headless_shell-\d+\/chrome-headless-shell-win64\/debug\.log$/.test(relative);
}
