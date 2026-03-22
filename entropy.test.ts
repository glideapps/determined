import { describe, it } from "node:test";
import assert from "node:assert";
import {
    SimpleEntropySource,
    RecordingEntropySource,
    ReplayingEntropySource,
    sample,
} from "./entropy.ts";
import { FixedEntropySource, SpyEntropySource } from "./test-helpers.ts";

describe("RecordingEntropySource", () => {
    it("delegates to underlying source and returns same value", () => {
        const underlying = new FixedEntropySource([0.1, 0.2, 0.3]);
        const recording = new RecordingEntropySource(underlying);
        assert.strictEqual(recording.random("a"), 0.1);
        assert.strictEqual(recording.random("b"), 0.2);
        assert.strictEqual(recording.random("c"), 0.3);
    });

    it("records name and value for each call", () => {
        const underlying = new FixedEntropySource([0.5, 0.7]);
        const recording = new RecordingEntropySource(underlying);
        recording.random("first");
        recording.random("second");

        const records = recording.getRecords();
        assert.strictEqual(records.length, 2);
        assert.deepStrictEqual(records[0], { name: "first", value: 0.5 });
        assert.deepStrictEqual(records[1], { name: "second", value: 0.7 });
    });

    it("accumulates records across multiple calls", () => {
        const underlying = new FixedEntropySource([0.1, 0.2, 0.3]);
        const recording = new RecordingEntropySource(underlying);
        recording.random("a");
        assert.strictEqual(recording.getRecords().length, 1);
        recording.random("b");
        recording.random("c");
        assert.strictEqual(recording.getRecords().length, 3);
    });

    it("forwards name to underlying source", () => {
        const spy = new SpyEntropySource([0.1, 0.2]);
        const recording = new RecordingEntropySource(spy);
        recording.random("first-call");
        recording.random("second-call");
        assert.deepStrictEqual(spy.calledNames, ["first-call", "second-call"]);
    });

    it("getRecords() returns a live reference to the internal array", () => {
        const underlying = new FixedEntropySource([0.1, 0.2]);
        const recording = new RecordingEntropySource(underlying);
        recording.random("a");
        const recordsBefore = recording.getRecords();
        assert.strictEqual(recordsBefore.length, 1);

        recording.random("b");
        // readonly type annotation doesn't prevent runtime observation of mutations
        assert.strictEqual(recordsBefore.length, 2);
        assert.deepStrictEqual(recordsBefore[1], { name: "b", value: 0.2 });
    });
});

describe("ReplayingEntropySource", () => {
    it("replays recorded values in sequence", () => {
        const replayer = new ReplayingEntropySource([
            { name: "a", value: 0.1 },
            { name: "b", value: 0.2 },
        ]);
        assert.strictEqual(replayer.random("a"), 0.1);
        assert.strictEqual(replayer.random("b"), 0.2);
    });

    it("throws when records exhausted", () => {
        const replayer = new ReplayingEntropySource([{ name: "a", value: 0.1 }]);
        replayer.random("a");
        assert.throws(
            () => replayer.random("b"),
            /No more entropy records available when requesting "b"/,
        );
    });

    it("throws on name mismatch with descriptive message", () => {
        const replayer = new ReplayingEntropySource([{ name: "expected", value: 0.5 }]);
        assert.throws(
            () => replayer.random("actual"),
            /Entropy record name mismatch at position 0: expected "expected", got "actual"/,
        );
    });

    it("shallow-copies: immune to array mutation but not object mutation", () => {
        const records = [
            { name: "a", value: 0.1 },
            { name: "b", value: 0.2 },
        ];
        const replayer = new ReplayingEntropySource(records);

        // Array-level mutation (truncate) does not affect replay
        records.length = 0;
        assert.strictEqual(replayer.random("a"), 0.1);
        assert.strictEqual(replayer.random("b"), 0.2);
    });

    it("shallow-copies: object mutation in source records affects replay", () => {
        const record = { name: "a", value: 0.1 };
        const replayer = new ReplayingEntropySource([record]);

        // Mutate the record object after construction
        record.name = "mutated";
        // Replay sees the mutation because slice() doesn't deep-copy
        assert.throws(
            () => replayer.random("a"),
            /Entropy record name mismatch.*expected "mutated", got "a"/,
        );
    });

    it("round-trips with RecordingEntropySource", () => {
        const underlying = new SimpleEntropySource();
        const recording = new RecordingEntropySource(underlying);

        const values: number[] = [];
        for (let i = 0; i < 10; i++) {
            values.push(recording.random(`call-${i}`));
        }

        const replayer = new ReplayingEntropySource(recording.getRecords());
        for (let i = 0; i < 10; i++) {
            assert.strictEqual(replayer.random(`call-${i}`), values[i]);
        }
    });
});

describe("sample", () => {
    it("returns undefined for empty array", () => {
        const source = new FixedEntropySource([]);
        assert.strictEqual(sample(source, "test", []), undefined);
    });

    it("returns the single item without consuming entropy", () => {
        // FixedEntropySource with no values would throw if entropy were consumed
        const source = new FixedEntropySource([]);
        assert.strictEqual(sample(source, "test", [42]), 42);
    });

    it("picks first item when entropy returns 0", () => {
        const source = new FixedEntropySource([0]);
        assert.strictEqual(sample(source, "test", ["a", "b", "c", "d"]), "a");
    });

    it("picks last item when entropy returns 0.999", () => {
        const source = new FixedEntropySource([0.999]);
        assert.strictEqual(sample(source, "test", ["a", "b", "c", "d"]), "d");
    });

    it("picks correct index for intermediate values", () => {
        // 4 items, entropy = 0.5: floor(0.5 * 4) = floor(2) = 2 -> "c"
        const source = new FixedEntropySource([0.5]);
        assert.strictEqual(sample(source, "test", ["a", "b", "c", "d"]), "c");
    });

    it("forwards name to entropy source", () => {
        const spy = new SpyEntropySource([0]);
        sample(spy, "pick-task", ["a", "b"]);
        assert.deepStrictEqual(spy.calledNames, ["pick-task"]);
    });
});
