import { describe, it } from "node:test";
import assert from "node:assert";
import {
    ApplicationFailure,
    CancellationError,
    isApplicationFailure,
    isCancellation,
    makeErrorType,
} from "./errors.ts";

describe("ApplicationFailure", () => {
    it("constructs with defaults: type is undefined, nonRetryable is false", () => {
        const err = new ApplicationFailure("test message");
        assert.strictEqual(err.message, "test message");
        assert.strictEqual(err.type, undefined);
        assert.strictEqual(err.nonRetryable, false);

        // Explicit undefined also produces the same defaults
        const err2 = new ApplicationFailure("test", undefined, undefined);
        assert.strictEqual(err2.nonRetryable, false);
    });

    it("constructs with all parameters", () => {
        const type = makeErrorType("MyError");
        const err = new ApplicationFailure("test", type, true);
        assert.strictEqual(err.message, "test");
        assert.strictEqual(err.type, type);
        assert.strictEqual(err.nonRetryable, true);
    });

    it("extends Error", () => {
        const err = new ApplicationFailure("test");
        assert.ok(err instanceof Error);
        assert.ok(err instanceof ApplicationFailure);
    });
});

describe("CancellationError", () => {
    it("constructs with message and optional metadata", () => {
        const err = new CancellationError("Deadline 'health timeout' aborted at t=10000ms");
        assert.strictEqual(err.message, "Deadline 'health timeout' aborted at t=10000ms");
        assert.strictEqual(err.name, "CancellationError");
        assert.strictEqual(err.deadlineReason, undefined);
        assert.strictEqual(err.abortedAtMs, undefined);

        const err2 = new CancellationError("timed out", "health timeout", 10_000);
        assert.strictEqual(err2.deadlineReason, "health timeout");
        assert.strictEqual(err2.abortedAtMs, 10_000);
    });

    it("extends Error but is not an ApplicationFailure", () => {
        const err = new CancellationError("cancelled");
        assert.ok(err instanceof Error);
        assert.strictEqual(isApplicationFailure(err), false);
    });
});

describe("isCancellation", () => {
    it("returns true for CancellationError", () => {
        assert.strictEqual(isCancellation(new CancellationError("cancelled")), true);
    });

    it("returns true for native abort reasons", () => {
        // AbortController.abort() with no argument uses a DOMException named
        // "AbortError"; AbortSignal.timeout uses one named "TimeoutError".
        const controller = new AbortController();
        controller.abort();
        assert.strictEqual(isCancellation(controller.signal.reason), true);
        assert.strictEqual(isCancellation(new DOMException("timed out", "TimeoutError")), true);
    });

    it("returns false for other DOMExceptions", () => {
        assert.strictEqual(isCancellation(new DOMException("bad data", "DataError")), false);
    });

    it("returns false for ApplicationFailure and plain errors", () => {
        assert.strictEqual(isCancellation(new ApplicationFailure("simulated")), false);
        assert.strictEqual(isCancellation(new Error("boom")), false);
        assert.strictEqual(isCancellation("string"), false);
        assert.strictEqual(isCancellation(undefined), false);
    });
});

describe("isApplicationFailure", () => {
    it("returns true for ApplicationFailure", () => {
        assert.strictEqual(isApplicationFailure(new ApplicationFailure("test")), true);
    });

    it("returns false for plain Error", () => {
        assert.strictEqual(isApplicationFailure(new Error("test")), false);
    });

    it("returns false for non-Error values", () => {
        assert.strictEqual(isApplicationFailure("string"), false);
        assert.strictEqual(isApplicationFailure(null), false);
        assert.strictEqual(isApplicationFailure(undefined), false);
        assert.strictEqual(isApplicationFailure(42), false);
    });
});
