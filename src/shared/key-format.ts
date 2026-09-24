/** Returns an error message for an unusable key, or null when it looks like a key. */
export function keyProblem(key: string): string | null {
  if (key.length === 0) return "Enter your API key.";
  if (key.length < 8 || key.length > 512) return "That key looks incomplete.";
  if (/\s|[\u0000-\u001f\u007f]/.test(key)) return "Remove spaces and line breaks.";
  return null;
}
