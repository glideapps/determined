import { describe, it } from "node:test";
import assert from "node:assert";
import { SimulationImpl, type SimulationTask } from "./simulation.ts";
import { RecordingEntropySource, ReplayingEntropySource, SimpleEntropySource } from "./entropy.ts";
import { ConditionVariable } from "./condition-variable.ts";
import { ArrayLogger, FixedEntropySource } from "./test-helpers.ts";

function makeSim(entropy: number[], options?: ConstructorParameters<typeof SimulationImpl>[3]): SimulationImpl {
    return new SimulationImpl(new ArrayLogger(), new FixedEntropySource(entropy), () => 0, options);
}

describe("virtual clock", () => {
    it("monotonicNow starts at 0 and wallNow defaults to the same epoch 0", async () => {
        const sim = makeSim([]);
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    assert.strictEqual(task.monotonicNow(), 0);
                    assert.strictEqual(task.wallNow(), 0);
                    return "done";
                },
            },
        ]);
        assert.ok(result.isOk());
    });

    it("wallNow is the configured epoch plus monotonic time", async () => {
        const epoch = 1_700_000_000_000;
        const sim = makeSim([], { wallClockEpoch: epoch });
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    assert.strictEqual(task.wallNow(), epoch);
                    await task.sleep(500, "advance");
                    assert.strictEqual(task.monotonicNow(), 500);
                    assert.strictEqual(task.wallNow(), epoch + 500);
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
    });
});

describe("deterministic sleep", () => {
    // Acceptance test 1: a one-hour sleep completes without one hour of real
    // waiting. Single task, single timer: both choices are forced, so no
    // entropy may be consumed (FixedEntropySource would throw).
    it("a one-hour sleep completes instantly in real time and consumes no entropy", async () => {
        const sim = makeSim([]);
        const before = Date.now();
        const result = await sim.runTasks([
            {
                name: "sleeper",
                f: async (task: SimulationTask) => {
                    await task.sleep(3_600_000, "one hour");
                    return task.monotonicNow();
                },
            },
        ]);
        assert.ok(result.isOk());
        assert.deepStrictEqual(result.value, [3_600_000]);
        assert.ok(Date.now() - before < 5_000, "must not wait in real time");
    });

    it("sequential sleeps accumulate virtual time", async () => {
        const sim = makeSim([]);
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    await task.sleep(100, "first");
                    await task.sleep(200, "second");
                    return task.monotonicNow();
                },
            },
        ]);
        assert.ok(result.isOk());
        assert.deepStrictEqual(result.value, [300]);
    });

    // Acceptance test 2: while one task sleeps, another runnable task
    // continues; the sleeper only wakes when no runnable task remains.
    it("a runnable task continues while another sleeps", async () => {
        const order: string[] = [];
        // Entropy:
        //   0. START pick from [sleeper, worker]: 0 -> sleeper; it sleeps
        //   then worker is the only candidate (forced), runs both steps;
        //   after worker finishes, the sleep timer is forced, then sleeper
        //   is the only candidate.
        const sim = makeSim([0]);
        const result = await sim.runTasks([
            {
                name: "sleeper",
                f: async (task: SimulationTask) => {
                    await task.sleep(1_000, "nap");
                    order.push("sleeper-woke");
                },
            },
            {
                name: "worker",
                f: async (task: SimulationTask) => {
                    order.push("worker-1");
                    await task.checkpoint("mid");
                    order.push("worker-2");
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.deepStrictEqual(order, ["worker-1", "worker-2", "sleeper-woke"]);
    });

    // Acceptance tests 3 and 4: with all tasks sleeping, an entropy-chosen
    // timer fires and virtual time advances to at least its deadline. A
    // later-deadline timer may fire before an earlier one; time is monotonic.
    it("entropy picks which pending timer fires; a later deadline can fire first", async () => {
        async function run(timerPick: number): Promise<Array<[string, number]>> {
            const wakes: Array<[string, number]> = [];
            // Entropy:
            //   0. START pick from [A, B]: 0 -> A; A sleeps (1000ms)
            //   then B is forced, sleeps (2000ms)
            //   1. all blocked, pick timer from [A-nap, B-nap]: timerPick
            //   then everything is forced.
            const sim = makeSim([0, timerPick]);
            const result = await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        await task.sleep(1_000, "nap");
                        wakes.push(["A", task.monotonicNow()]);
                    },
                },
                {
                    name: "B",
                    f: async (task: SimulationTask) => {
                        await task.sleep(2_000, "nap");
                        wakes.push(["B", task.monotonicNow()]);
                    },
                },
            ]);
            assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
            return wakes;
        }

        // Timer pick 0 -> A's earlier timer fires first: A wakes at 1000,
        // then B at 2000.
        assert.deepStrictEqual(await run(0), [
            ["A", 1_000],
            ["B", 2_000],
        ]);
        // Timer pick 0.999 -> B's later timer fires first: B wakes at 2000;
        // A's timer then fires at max(2000, 1000) = 2000 — virtual time
        // never moves backward.
        assert.deepStrictEqual(await run(0.999), [
            ["B", 2_000],
            ["A", 2_000],
        ]);
    });

    it("deadline ties are broken by entropy and replay identically", async () => {
        async function run(entropy: ConstructorParameters<typeof SimulationImpl>[1]): Promise<string[]> {
            const order: string[] = [];
            const sim = new SimulationImpl(new ArrayLogger(), entropy, () => 0);
            const result = await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        await task.sleep(1_000, "tie");
                        order.push("A");
                    },
                },
                {
                    name: "B",
                    f: async (task: SimulationTask) => {
                        await task.sleep(1_000, "tie");
                        order.push("B");
                    },
                },
            ]);
            assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
            return order;
        }

        // Both tie orders are reachable, driven purely by the timer pick.
        assert.deepStrictEqual(await run(new FixedEntropySource([0, 0])), ["A", "B"]);
        assert.deepStrictEqual(await run(new FixedEntropySource([0, 0.999])), ["B", "A"]);

        // And a recorded run replays to the identical order.
        const recording = new RecordingEntropySource(new SimpleEntropySource());
        const recordedOrder = await run(recording);
        const replayedOrder = await run(new ReplayingEntropySource(recording.getRecords()));
        assert.deepStrictEqual(replayedOrder, recordedOrder);
    });

    // Acceptance test 5: a pending timer prevents false deadlock detection.
    it("a sleeping task with a pending timer is not a deadlock", async () => {
        const cv = new ConditionVariable("data");
        // Entropy:
        //   0. START pick from [waiter, sleeper]: 0 -> waiter; it blocks on cv
        //   then sleeper is forced: sleeps; all tasks blocked, but the sleep
        //   timer is pending -> no deadlock; timer forced, sleeper notifies.
        const sim = makeSim([0]);
        const result = await sim.runTasks([
            {
                name: "waiter",
                f: async (task: SimulationTask) => {
                    await cv.wait(task, "data");
                    return "woken";
                },
            },
            {
                name: "sleeper",
                f: async (task: SimulationTask) => {
                    await task.sleep(30_000, "delay before notify");
                    cv.notifyAll(task, "data ready");
                    return "notified";
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.deepStrictEqual(result.value, ["woken", "notified"]);
    });

    // Acceptance test 6: no timers plus only blocked tasks is a deadlock,
    // and the report names the blocked tasks and their reasons.
    it("blocked tasks with no pending timers deadlock with a descriptive report", async () => {
        const sim = makeSim([0]);
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    task.blockpoint("waiting for godot");
                    await new Promise<void>(() => {});
                },
            },
            {
                name: "B",
                f: async (task: SimulationTask) => {
                    task.blockpoint("waiting for A");
                    await new Promise<void>(() => {});
                },
            },
        ]);
        assert.ok(result.isErr());
        assert.match(result.error.message, /[Dd]eadlock/);
        assert.match(result.error.message, /t=0ms/);
        assert.match(result.error.message, /A.*waiting for godot/);
        assert.match(result.error.message, /B.*waiting for A/);
    });

    // Acceptance test 20 (simulation half): negative durations are rejected;
    // zero-duration sleeps yield through the scheduler without a time advance.
    it("a negative sleep duration is rejected with a TypeError", async () => {
        let caught: unknown;
        const sim = makeSim([]);
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    try {
                        await task.sleep(-5, "bad");
                    } catch (e) {
                        caught = e;
                    }
                },
            },
        ]);
        assert.ok(result.isOk());
        assert.ok(caught instanceof TypeError, `expected TypeError, got ${String(caught)}`);
    });

    it("a zero-duration sleep yields through the scheduler without advancing time", async () => {
        const order: string[] = [];
        // Entropy:
        //   0. START pick from [A, B]: 0 -> A; A sleeps(0) -> blocked with an
        //   immediately-due timer; B is forced and runs to completion; the
        //   timer is forced; A is forced.
        const sim = makeSim([0]);
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    await task.sleep(0, "yield");
                    order.push("A-woke");
                    return task.monotonicNow();
                },
            },
            {
                name: "B",
                f: async () => {
                    order.push("B-ran");
                    return -1;
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        // B ran while A's zero-duration timer was pending: the sleep yielded.
        assert.deepStrictEqual(order, ["B-ran", "A-woke"]);
        // No time advance was required.
        assert.strictEqual(result.value[0], 0);
    });
});
