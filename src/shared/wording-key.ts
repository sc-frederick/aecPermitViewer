export function wordingKey(wording: string): string {
  return wording.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
