import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * What kind of failure a cause was, judged from structured fields only:
 * - `sqlite`: the SQLite driver reported it.
 * - `system`: an operating system call failed, such as a file or process operation.
 * - `tagged`: one of the app's own tagged errors.
 * - `defect`: a JavaScript error that points at a bug, such as a TypeError.
 * - `unclassified`: none of the above.
 */
export type FailureClass = "sqlite" | "system" | "tagged" | "defect" | "unclassified";

/**
 * A failure reduced to fields that are safe to keep. The message, stack, and any value the operation handled are left
 * out, because they can hold paths, portal text, or other user data.
 */
export interface ClassifiedCause {
  class: FailureClass;
  /** The error's constructor name, or `non-error` when something other than an Error was thrown. */
  name: string;
  /** The `_tag` of one of the app's own errors. */
  tag: string | null;
  /** A Node or driver code such as `ENOENT` or `ERR_SQLITE_ERROR`. */
  code: string | null;
  /** SQLite's extended result code, such as 2067 for a unique constraint. */
  errcode: number | null;
  /** The system call that failed, such as `rename`. */
  syscall: string | null;
}

/** An identifier-like value: codes, tags, and names never carry free text into the log. */
const identifier = z
  .string()
  .max(64)
  .regex(/^[\w.-]+$/);

/** Structured fields read from a thrown value. Each falls back on its own, so one odd field doesn't hide the rest. */
const causeFieldsSchema = z.object({
  name: identifier.catch("Error"),
  _tag: identifier.optional().catch(undefined),
  code: identifier.optional().catch(undefined),
  errcode: z.number().int().optional().catch(undefined),
  syscall: identifier.optional().catch(undefined),
});

const DEFECT_NAMES = new Set(["TypeError", "RangeError", "ReferenceError", "SyntaxError"]);

/** Classifies a caught value without reading its message. Anything that isn't an Error is `unclassified`. */
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

/** One recorded failure: when, which operation, the check run when there is one, and the classified cause. */
export interface Diagnostic {
  at: string;
  operation: string;
  runId: string | null;
  cause: ClassifiedCause;
}

/** Past this size the log is moved aside to `<file>.1`, replacing any older one, so it never grows without bound. */
const MAX_LOG_BYTES = 256 * 1024;

/**
 * A local JSON-lines log of failures the user sees only as a generic message, so they can be told apart later. It
 * lives in the app's data folder and is deleted with it.
 */
export class DiagnosticLog {
  /** True between `stop()` and `restart()`. */
  private stopped = false;

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Appends one diagnostic unless stopped. Never throws: a failed log write has nowhere to be reported, and must not
   * change what the user is told.
   */
  record(operation: string, runId: string | null, cause: unknown): void {
    if (this.stopped) return;
    const entry: Diagnostic = { at: this.now().toISOString(), operation, runId, cause: classifyCause(cause) };

    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const size = statSync(this.filePath, { throwIfNoEntry: false })?.size ?? 0;

      if (size > MAX_LOG_BYTES) renameSync(this.filePath, `${this.filePath}.1`);
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // Ignored on purpose; see `record`.
    }
  }

  /**
   * Drops records until `restart()`. Called before the data folder is deleted, so a late failure (such as a snapshot
   * still in flight) doesn't recreate the folder.
   */
  stop(): void {
    this.stopped = true;
  }

  /** Records again after a deletion that didn't go ahead. */
  restart(): void {
    this.stopped = false;
  }
}
