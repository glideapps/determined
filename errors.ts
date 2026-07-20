import { type BrandedString, makeBrandString } from "@glideapps/ts-necessities";

export type ErrorType = BrandedString<"ErrorType">;
export const makeErrorType = makeBrandString<ErrorType>();

export class ApplicationFailure extends Error {
    public readonly type: ErrorType | undefined;
    public readonly nonRetryable: boolean;

    constructor(message: string, type?: ErrorType, nonRetryable?: boolean) {
        super(message);
        this.type = type;
        this.nonRetryable = nonRetryable ?? false;
    }
}

export function isApplicationFailure(error: unknown): error is ApplicationFailure {
    return error instanceof ApplicationFailure;
}

/**
 * The rejection used when a sleep or operation is cancelled via an
 * `AbortSignal` or a deadline expires. Deliberately not an
 * `ApplicationFailure`: retry logic retries application failures but must
 * always propagate cancellations.
 */
export class CancellationError extends Error {
    /** The reason string of the deadline that aborted, if any. */
    public readonly deadlineReason: string | undefined;
    /** The (virtual) monotonic time at which the signal aborted, if known. */
    public readonly abortedAtMs: number | undefined;

    constructor(message: string, deadlineReason?: string, abortedAtMs?: number) {
        super(message);
        this.name = "CancellationError";
        this.deadlineReason = deadlineReason;
        this.abortedAtMs = abortedAtMs;
    }
}

/**
 * Whether `error` is a cancellation, i.e. the result of an aborted signal or
 * an expired deadline — from `determined`'s own deadlines
 * (`CancellationError`) or from the platform (`DOMException`s named
 * `AbortError`/`TimeoutError`, as produced by `AbortController.abort()` and
 * `AbortSignal.timeout`).
 */
export function isCancellation(error: unknown): boolean {
    if (error instanceof CancellationError) return true;
    return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}
