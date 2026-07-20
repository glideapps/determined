import { describe, it } from "node:test";
import assert from "node:assert";
import { SimulationImpl, type SimulationTask } from "./simulation.ts";
import { SimpleEntropySource } from "./entropy.ts";
import { RecordingTraceSource, ReplayingTraceSource } from "./trace.ts";
import { ArrayLogger } from "./test-helpers.ts";

describe("trace with explicit timer records", () => {
    // Acceptance test 10: recorded scheduling and timer behavior replay
    // exactly.
    it("a recorded timer-heavy run replays exactly and consumes the whole trace", async () => {
        async function run(entropy: ConstructorParameters<typeof SimulationImpl>[1]): Promise<string[]> {
            const order: string[] = [];
            const sim = new SimulationImpl(new ArrayLogger(), entropy, () => 0, { wallClockEpoch: 12_345 });
            const result = await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        await task.sleep(100, "a-first");
                        order.push(`A1@${task.monotonicNow()}`);
                        await task.sleep(200, "a-second");
                        order.push(`A2@${task.monotonicNow()}`);
                    },
                },
                {
                    name: "B",
                    f: async (task: SimulationTask) => {
                        await task.sleep(150, "b-first");
                        order.push(`B1@${task.monotonicNow()}`);
                    },
                },
            ]);
            assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
            return order;
        }

        const recording = new RecordingTraceSource(new SimpleEntropySource());
        const recordedOrder = await run(recording);

        const trace = recording.getTrace();
        // The trace contains explicit timer records, not just entropy.
        assert.strictEqual(trace.filter((r) => r.type === "timer-create").length, 3);
        assert.strictEqual(trace.filter((r) => r.type === "timer-fire").length, 3);
        assert.strictEqual(trace[0]?.type, "run-start");

        const replaying = new ReplayingTraceSource(trace);
        const replayedOrder = await run(replaying);
        assert.deepStrictEqual(replayedOrder, recordedOrder);
        replaying.assertFullyConsumed();
    });

    // Acceptance test 11: changing a timer reason or deadline produces a
    // clear replay-divergence error — even for forced choices that consume
    // no entropy, which is exactly why timer records are explicit.
    it("a changed timer reason diverges even when no entropy is consumed", async () => {
        async function run(entropy: ConstructorParameters<typeof SimulationImpl>[1], reason: string) {
            const sim = new SimulationImpl(new ArrayLogger(), entropy, () => 0);
            // Single task, single timer: every choice is forced, so the
            // entropy stream alone could never notice the change.
            return await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        await task.sleep(1_000, reason);
                    },
                },
            ]);
        }

        const recording = new RecordingTraceSource(new SimpleEntropySource());
        assert.ok((await run(recording, "original reason")).isOk());

        const result = await run(new ReplayingTraceSource(recording.getTrace()), "changed reason");
        assert.ok(result.isErr());
        assert.match(result.error.message, /divergence|mismatch/i);
        assert.match(result.error.message, /original reason/);
        assert.match(result.error.message, /changed reason/);
    });

    it("a changed deadline diverges even when no entropy is consumed", async () => {
        async function run(entropy: ConstructorParameters<typeof SimulationImpl>[1], durationMs: number) {
            const sim = new SimulationImpl(new ArrayLogger(), entropy, () => 0);
            return await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        await task.sleep(durationMs, "nap");
                    },
                },
            ]);
        }

        const recording = new RecordingTraceSource(new SimpleEntropySource());
        assert.ok((await run(recording, 1_000)).isOk());

        const result = await run(new ReplayingTraceSource(recording.getTrace()), 2_000);
        assert.ok(result.isErr());
        assert.match(result.error.message, /divergence|mismatch/i);
        assert.match(result.error.message, /1000/);
        assert.match(result.error.message, /2000/);
    });

    it("a missing timer cancellation diverges", async () => {
        async function run(entropy: ConstructorParameters<typeof SimulationImpl>[1], cancel: boolean) {
            const sim = new SimulationImpl(new ArrayLogger(), entropy, () => 0);
            return await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        const deadline = task.createDeadline(10_000, "guard");
                        if (cancel) deadline.cancel();
                        await task.sleep(100, "nap");
                    },
                },
            ]);
        }

        const recording = new RecordingTraceSource(new SimpleEntropySource());
        assert.ok((await run(recording, true)).isOk());

        const result = await run(new ReplayingTraceSource(recording.getTrace()), false);
        assert.ok(result.isErr());
        assert.match(result.error.message, /divergence|mismatch/i);
    });

    it("a changed wall-clock epoch diverges at run start", async () => {
        async function run(entropy: ConstructorParameters<typeof SimulationImpl>[1], epoch: number) {
            const sim = new SimulationImpl(new ArrayLogger(), entropy, () => 0, { wallClockEpoch: epoch });
            return await sim.runTasks([{ name: "A", f: async () => 42 }]);
        }

        const recording = new RecordingTraceSource(new SimpleEntropySource());
        assert.ok((await run(recording, 1_000)).isOk());

        const result = await run(new ReplayingTraceSource(recording.getTrace()), 2_000);
        assert.ok(result.isErr());
        assert.match(result.error.message, /divergence|mismatch/i);
        assert.match(result.error.message, /epoch/i);
    });

    it("unused recorded events are reported by assertFullyConsumed", async () => {
        async function run(entropy: ConstructorParameters<typeof SimulationImpl>[1], sleeps: number) {
            const sim = new SimulationImpl(new ArrayLogger(), entropy, () => 0);
            return await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        for (let i = 0; i < sleeps; i++) {
                            await task.sleep(100, `nap ${i}`);
                        }
                    },
                },
            ]);
        }

        const recording = new RecordingTraceSource(new SimpleEntropySource());
        assert.ok((await run(recording, 2)).isOk());

        const replaying = new ReplayingTraceSource(recording.getTrace());
        assert.ok((await run(replaying, 1)).isOk());
        assert.throws(() => replaying.assertFullyConsumed(), /unused/i);
    });

    it("an exhausted trace is reported descriptively", async () => {
        async function run(entropy: ConstructorParameters<typeof SimulationImpl>[1], sleeps: number) {
            const sim = new SimulationImpl(new ArrayLogger(), entropy, () => 0);
            return await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        for (let i = 0; i < sleeps; i++) {
                            await task.sleep(100, `nap ${i}`);
                        }
                    },
                },
            ]);
        }

        const recording = new RecordingTraceSource(new SimpleEntropySource());
        assert.ok((await run(recording, 1)).isOk());

        const result = await run(new ReplayingTraceSource(recording.getTrace()), 2);
        assert.ok(result.isErr());
        assert.match(result.error.message, /exhausted/i);
    });
});
