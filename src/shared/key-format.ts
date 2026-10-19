export function keyProblem(key: string): string | null {
  if (key.length === 0) return "Enter your API key.";

  if (key.length < 8 || key.length > 512) return "That key looks incomplete.";

  if (/\s|\p{Cc}/u.test(key)) return "Remove spaces and line breaks.";

  return null;
}
