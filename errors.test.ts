import { describe, it } from "node:test";
import assert from "node:assert";
import { ApplicationFailure, isApplicationFailure, makeErrorType } from "./errors.ts";

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
