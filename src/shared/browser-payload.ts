/** Chromium's Windows GPU diagnostics are runtime data, separate from the hashed browser code. */
export function isBrowserDiagnosticFile(relative: string): boolean {
  return /^chromium_headless_shell-\d+\/chrome-headless-shell-win64\/debug\.log$/.test(relative);
}
