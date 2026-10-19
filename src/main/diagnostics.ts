import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export type FailureClass = "sqlite" | "system" | "tagged" | "defect" | "unclassified";

export interface ClassifiedCause {
  class: FailureClass;
  name: string;
  tag: string | null;
  code: string | null;
  errcode: number | null;
  syscall: string | null;
}

const identifier = z
  .string()
  .max(64)
  .regex(/^[\w.-]+$/);

const causeFieldsSchema = z.object({
  name: identifier.catch("Error"),
  _tag: identifier.optional().catch(undefined),
  code: identifier.optional().catch(undefined),
  errcode: z.number().int().optional().catch(undefined),
  syscall: identifier.optional().catch(undefined),
});

const DEFECT_NAMES = new Set(["TypeError", "RangeError", "ReferenceError", "SyntaxError"]);

export function classifyCause(cause: unknown): ClassifiedCause {
  const parsed = cause instanceof Error ? causeFieldsSchema.safeParse(cause) : null;

  if (!parsed?.success)
    return { class: "unclassified", name: "non-error", tag: null, code: null, errcode: null, syscall: null };
  const { name, _tag: tag = null, code = null, errcode = null, syscall = null } = parsed.data;

  return { class: failureClass(name, tag, code, errcode, syscall), name, tag, code, errcode, syscall };
}

function failureClass(
  name: string,
  tag: string | null,
  code: string | null,
  errcode: number | null,
  syscall: string | null,
): FailureClass {
  if (tag !== null) return "tagged";

  if (code === "ERR_SQLITE_ERROR" || errcode !== null) return "sqlite";

  if (syscall !== null || (code !== null && /^E[A-Z0-9]+$/.test(code))) return "system";

  return DEFECT_NAMES.has(name) ? "defect" : "unclassified";
}

export interface Diagnostic {
  at: string;
  operation: string;
  runId: string | null;
  cause: ClassifiedCause;
}

const MAX_LOG_BYTES = 256 * 1024;

export class DiagnosticLog {
  private stopped = false;

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(operation: string, runId: string | null, cause: unknown): void {
    if (this.stopped) return;
    const entry: Diagnostic = { at: this.now().toISOString(), operation, runId, cause: classifyCause(cause) };

    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const size = statSync(this.filePath, { throwIfNoEntry: false })?.size ?? 0;

      if (size > MAX_LOG_BYTES) renameSync(this.filePath, `${this.filePath}.1`);
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {}
  }

  stop(): void {
    this.stopped = true;
  }

  restart(): void {
    this.stopped = false;
  }
}
