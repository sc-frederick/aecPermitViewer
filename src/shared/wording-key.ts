/**
 * Portal wording, such as a status or a workflow task name, compared without regard to case or runs of spaces, which
 * vary between records and hand entry.
 */
export function wordingKey(wording: string): string {
  return wording.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
