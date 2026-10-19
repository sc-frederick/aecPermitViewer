import { z } from "zod";
import type { ReviewEntry } from "./reviews.js";

const plainText = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^\P{Cc}+$/u);

/** One dated workflow entry, including pending rounds whose status and decision date are not yet set. */
export const reviewEntrySchema = z.object({
  process: plainText,
  status: plainText.nullable(),
  date: z.iso.date().nullable(),
  dueDate: z.iso.date().nullable(),
}) satisfies z.ZodType<ReviewEntry>;

/** Null means no workflow was read (including observations saved by older app versions). */
export const reviewsSchema = z.array(reviewEntrySchema).max(3000).nullable();

/** Accela's US calendar date, or null for its pending TBD placeholder or an invalid date. */
export function reviewDate(value: string): string | null {
  const parts = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());

  if (!parts) return null;
  const parsed = z.iso.date().safeParse(`${parts[3]}-${parts[1]?.padStart(2, "0")}-${parts[2]?.padStart(2, "0")}`);

  return parsed.success ? parsed.data : null;
}
