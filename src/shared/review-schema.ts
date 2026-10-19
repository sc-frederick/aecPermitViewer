import { z } from "zod";
import type { ReviewEntry } from "./reviews.js";

const plainText = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^\P{Cc}+$/u);

export const reviewEntrySchema = z.object({
  process: plainText,
  status: plainText.nullable(),
  date: z.iso.date().nullable(),
  dueDate: z.iso.date().nullable(),
}) satisfies z.ZodType<ReviewEntry>;

export const reviewsSchema = z.array(reviewEntrySchema).max(3000).nullable();

export function reviewDate(value: string): string | null {
  const parts = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());

  if (!parts) return null;
  const parsed = z.iso.date().safeParse(`${parts[3]}-${parts[1]?.padStart(2, "0")}-${parts[2]?.padStart(2, "0")}`);

  return parsed.success ? parsed.data : null;
}
