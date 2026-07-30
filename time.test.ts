import { describe, it } from "node:test";
import assert from "node:assert";
import { defined } from "@glideapps/ts-necessities";
import { NoSimulationTask, noSimulation, SimulationImpl, type SimulationTask } from "./simulation.ts";
import { RecordingEntropySource, ReplayingEntropySource, SimpleEntropySource } from "./entropy.ts";
import { RecordingTraceSource, ReplayingTraceSource } from "./trace.ts";
import { isApplicationFailure, isCancellation } from "./errors.ts";
import { Mutex } from "./mutex.ts";
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

    // Acceptance test 7 (abort path): aborting a sleep cancels its timer —
    // the timer cannot wake the task later, and virtual time does not
    // advance to the abandoned deadline.
    it("aborting a sleep rejects it with the abort reason and cancels its timer", async () => {
        const order: string[] = [];
        const stop = new Error("stop requested");
        const controller = new AbortController();
        let caught: unknown;
        // Entropy:
        //   0. START pick from [sleeper, aborter]: 0 -> sleeper; it sleeps
        //      (10,000ms) and parks; aborter is forced.
        //   aborter aborts the signal — the sleeper becomes schedulable, but
        //   the aborter continues until it finishes (non-preemptive).
        //   Then everything is forced: the sleeper's rejection, its second
        //   sleep's timer (the only pending timer if — and only if — the
        //   aborted 10,000ms timer was really cancelled; a leaked timer
        //   would consume an extra entropy draw and exhaust the source).
        const sim = makeSim([0]);
        const result = await sim.runTasks([
            {
                name: "sleeper",
                f: async (task: SimulationTask) => {
                    try {
                        await task.sleep(10_000, "long nap", { signal: controller.signal });
                    } catch (e) {
                        caught = e;
                        order.push("sleeper-aborted");
                    }
                    assert.strictEqual(task.monotonicNow(), 0, "abort must not advance virtual time");
                    await task.sleep(5, "short nap");
                    return task.monotonicNow();
                },
            },
            {
                name: "aborter",
                f: async () => {
                    order.push("aborter-before");
                    controller.abort(stop);
                    order.push("aborter-after");
                    return -1;
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        // The aborter ran to completion before the sleeper was woken.
        assert.deepStrictEqual(order, ["aborter-before", "aborter-after", "sleeper-aborted"]);
        // The sleep rejected with exactly the signal's abort reason.
        assert.strictEqual(caught, stop);
        // The second sleep advanced time to 5, not to the abandoned 10,000ms
        // deadline.
        assert.strictEqual(result.value[0], 5);
    });

    it("a sleep aborted with the default reason rejects with a cancellation", async () => {
        const controller = new AbortController();
        let caught: unknown;
        const sim = makeSim([0]);
        const result = await sim.runTasks([
            {
                name: "sleeper",
                f: async (task: SimulationTask) => {
                    try {
                        await task.sleep(1_000, "nap", { signal: controller.signal });
                    } catch (e) {
                        caught = e;
                    }
                },
            },
            {
                name: "aborter",
                f: async () => {
                    controller.abort();
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.ok(isCancellation(caught), `expected a cancellation, got ${String(caught)}`);
    });

    // Acceptance test 17: a sleep given an already-aborted signal rejects
    // immediately with the abort reason — no timer is registered and no
    // entropy is consumed.
    it("a pre-aborted signal rejects the sleep immediately, without a timer or entropy", async () => {
        const reason = new Error("already shut down");
        const controller = new AbortController();
        controller.abort(reason);
        let caught: unknown;
        // Single task: every choice is forced, and FixedEntropySource([])
        // throws on any draw.
        const sim = makeSim([]);
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    try {
                        await task.sleep(10_000, "nap", { signal: controller.signal });
                    } catch (e) {
                        caught = e;
                    }
                    assert.strictEqual(task.monotonicNow(), 0);
                    // The only pending timer must be this one — a leaked
                    // timer from the rejected sleep would make the pick
                    // non-forced and consume entropy.
                    await task.sleep(5, "short");
                    return task.monotonicNow();
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.strictEqual(caught, reason);
        assert.strictEqual(result.value[0], 5);
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

describe("deadlines and timeouts", () => {
    // Acceptance tests 7 and 8: completing work cancels its pending timeout,
    // and a cancelled timer cannot wake anything later.
    it("work completing before its timeout cancels the deadline timer", async () => {
        // Entropy:
        //   Single task. withTimedSignal creates the deadline timer (10,000ms),
        //   the operation sleeps (100ms) -> two pending timers:
        //   0. timer pick from [deadline, sleep]: 0.999 -> the sleep fires at
        //      t=100; the operation completes and cancels the deadline.
        //   The final sleep (50ms) is then the ONLY pending timer — forced,
        //   no entropy. A leaked deadline timer would consume an extra draw
        //   and exhaust the entropy source.
        const sim = makeSim([0.999]);
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    const value = await task.withTimedSignal(
                        async (signal) => {
                            await task.sleep(100, "operation latency", { signal });
                            return "done";
                        },
                        10_000,
                        "operation deadline",
                    );
                    assert.strictEqual(task.monotonicNow(), 100);
                    await task.sleep(50, "after");
                    return [value, task.monotonicNow()] as const;
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.deepStrictEqual(result.value[0], ["done", 150]);
    });

    // Acceptance test 9: an operation completing close to its timeout can be
    // driven by entropy to either order, and each order replays exactly.
    it("completion-versus-timeout ordering is an entropy decision that replays exactly", async () => {
        async function run(entropy: ConstructorParameters<typeof SimulationImpl>[1]): Promise<string> {
            const sim = new SimulationImpl(new ArrayLogger(), entropy, () => 0);
            const result = await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        try {
                            return await task.withTimedSignal(
                                async (signal) => {
                                    await task.sleep(1_000, "operation", { signal });
                                    return "completed";
                                },
                                1_000,
                                "tight deadline",
                            );
                        } catch (e) {
                            if (isCancellation(e)) return "aborted";
                            throw e;
                        }
                    },
                },
            ]);
            assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
            return defined(result.value[0]);
        }

        // Timer creation order is [deadline, operation sleep]; both are due
        // at t=1000. Entropy picks which fires first.
        assert.strictEqual(await run(new FixedEntropySource([0])), "aborted");
        assert.strictEqual(await run(new FixedEntropySource([0.999])), "completed");

        // Each order replays exactly from a recording.
        for (const pick of [0, 0.999]) {
            const recording = new RecordingEntropySource(new FixedEntropySource([pick]));
            const recorded = await run(recording);
            const replayed = await run(new ReplayingEntropySource(recording.getRecords()));
            assert.strictEqual(replayed, recorded);
        }
    });

    it("the deadline signal aborts with a cancellation carrying the reason and virtual abort time", async () => {
        let caught: unknown;
        // Entropy: 0 picks the deadline timer from [deadline, sleep].
        const sim = makeSim([0]);
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    try {
                        await task.withTimedSignal(
                            (signal) => task.sleep(60_000, "slow operation", { signal }),
                            5_000,
                            "runtime request deadline",
                        );
                    } catch (e) {
                        caught = e;
                    }
                    return task.monotonicNow();
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.ok(isCancellation(caught), `expected a cancellation, got ${String(caught)}`);
        const cancellation = caught as { message: string; deadlineReason?: string; abortedAtMs?: number };
        assert.strictEqual(cancellation.deadlineReason, "runtime request deadline");
        assert.strictEqual(cancellation.abortedAtMs, 5_000);
        assert.match(cancellation.message, /runtime request deadline/);
        assert.match(cancellation.message, /5000/);
        // The aborted sleeper woke at the deadline, not at its own deadline.
        assert.strictEqual(result.value[0], 5_000);
    });

    // Acceptance test 16: a callback that ignores its signal is not
    // interrupted — it completes late, and the ignored-signal diagnostic
    // reports the late completion.
    it("a callback ignoring its signal completes late and is reported", async () => {
        const logger = new ArrayLogger();
        // Entropy: 0 picks the deadline timer from [deadline, ignorer sleep];
        // afterwards the ignorer's sleep is forced.
        const sim = new SimulationImpl(logger, new FixedEntropySource([0]), () => 0);
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    // The sleep does NOT take the signal: it ignores it.
                    const value = await task.withTimedSignal(
                        async () => {
                            await task.sleep(60_000, "ignoring the signal");
                            return "late";
                        },
                        10_000,
                        "status deadline",
                    );
                    return [value, task.monotonicNow()] as const;
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.deepStrictEqual(result.value[0], ["late", 60_000]);
        const warning = logger.errors.find((e) => e.includes("status deadline"));
        assert.ok(warning !== undefined, `expected an ignored-signal warning, got: ${logger.errors.join("; ")}`);
        assert.match(warning, /50000ms after its signal aborted/);
    });

    it("the ignored-signal diagnostic can be escalated to a failure", async () => {
        const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0]), () => 0, {
            failOnLateCompletion: true,
        });
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    return await task.withTimedSignal(
                        async () => {
                            await task.sleep(60_000, "ignoring the signal");
                            return "late";
                        },
                        10_000,
                        "status deadline",
                    );
                },
            },
        ]);
        assert.ok(result.isErr());
        assert.match(result.error.message, /status deadline/);
        assert.match(result.error.message, /after its signal aborted/);
    });

    // A cooperative cancellation that is honored settles at the abort
    // instant and must NOT be reported as ignoring its signal.
    it("an honored cancellation is not reported as a late completion", async () => {
        const logger = new ArrayLogger();
        const sim = new SimulationImpl(logger, new FixedEntropySource([0]), () => 0, {
            failOnLateCompletion: true,
        });
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    try {
                        await task.withTimedSignal(
                            (signal) => task.sleep(60_000, "slow", { signal }),
                            5_000,
                            "honored deadline",
                        );
                        return "completed";
                    } catch (e) {
                        if (isCancellation(e)) return "aborted";
                        throw e;
                    }
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.deepStrictEqual(result.value, ["aborted"]);
        assert.deepStrictEqual(logger.errors, []);
    });

    // Acceptance test 15: a deadlock report identifies a blocked task
    // holding an already-aborted signal — the signature of a deadline that
    // could not interrupt a non-cancellable wait.
    it("a deadlock report calls out an aborted signal held by a blocked task", async () => {
        const mutex = new Mutex("shared resource");
        // Entropy:
        //   0. START pick from [holder, waiter]: 0 -> holder locks the mutex
        //      and blocks forever; waiter is forced: creates a deadline, then
        //      blocks on the mutex. No runnable task, one pending timer: the
        //      deadline fires (forced) and aborts its signal — but a mutex
        //      wait is not cancellable, so nothing wakes: deadlock.
        const sim = makeSim([0]);
        const result = await sim.runTasks([
            {
                name: "holder",
                f: async (task: SimulationTask) => {
                    await mutex.lock(task, "hold forever");
                    task.blockpoint("holding the mutex forever");
                    await new Promise<void>(() => {});
                },
            },
            {
                name: "waiter",
                f: async (task: SimulationTask) => {
                    const deadline = task.createDeadline(100, "acquire deadline");
                    try {
                        await mutex.lock(task, "acquire under deadline");
                    } finally {
                        deadline.cancel();
                    }
                },
            },
        ]);
        assert.ok(result.isErr());
        assert.match(result.error.message, /[Dd]eadlock/);
        assert.match(result.error.message, /acquire deadline/);
        assert.match(result.error.message, /aborted at t=100ms/);
        assert.match(result.error.message, /waiter/);
    });

    // Acceptance test 19: a task API called from a user 'abort' listener
    // fails with a clear error, while the internal sleep wakeup on the same
    // signal works normally.
    it("user abort listeners run, but the internal sleep wakeup is privileged", async () => {
        let listenerRan = false;
        let caught: unknown;
        // Entropy: 0 picks the deadline timer from [deadline, sleep].
        const sim = makeSim([0]);
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    const deadline = task.createDeadline(100, "watchdog");
                    deadline.signal.addEventListener("abort", () => {
                        // A plain synchronous state change: allowed.
                        listenerRan = true;
                    });
                    try {
                        await task.sleep(10_000, "nap", { signal: deadline.signal });
                    } catch (e) {
                        caught = e;
                    } finally {
                        deadline.cancel();
                    }
                    return task.monotonicNow();
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.strictEqual(listenerRan, true);
        assert.ok(isCancellation(caught), `expected a cancellation, got ${String(caught)}`);
        assert.strictEqual(result.value[0], 100);
    });

    it("a task API call from a user abort listener aborts with a clear error", async () => {
        const sim = makeSim([0]);
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    const deadline = task.createDeadline(100, "watchdog");
                    deadline.signal.addEventListener("abort", () => {
                        void task.checkpoint("from inside a listener");
                    });
                    try {
                        await task.sleep(10_000, "nap", { signal: deadline.signal });
                    } finally {
                        deadline.cancel();
                    }
                },
            },
        ]);
        assert.ok(result.isErr());
        assert.match(result.error.message, /abort.*listener/i);
        assert.match(result.error.message, /checkpoint/);
    });

    it("a user abort listener that throws aborts the simulation with that error", async () => {
        const sim = makeSim([0]);
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    const deadline = task.createDeadline(100, "watchdog");
                    deadline.signal.addEventListener("abort", () => {
                        throw new Error("listener bug");
                    });
                    try {
                        await task.sleep(10_000, "nap", { signal: deadline.signal });
                    } finally {
                        deadline.cancel();
                    }
                },
            },
        ]);
        assert.ok(result.isErr());
        assert.strictEqual(result.error.message, "listener bug");
    });

    // Acceptance test 18: a retry loop retries simulated failpoint failures
    // but immediately propagates a cancellation.
    it("retry loops retry failures but propagate cancellations", async () => {
        async function run(): Promise<[string, number]> {
            let attempts = 0;
            // Failpoint probability 1: every failpoint fails (and draws one
            // entropy value for the decision).
            // Entropy:
            //   0. failpoint attempt 0 fails: 0.5
            //   1. backoff sleep parks; timer pick [deadline(250), backoff(100)]:
            //      0.999 -> backoff fires, t=100
            //   2. failpoint attempt 1 fails: 0.5
            //   3. timer pick [deadline(250), backoff(200)]: 0.999 -> t=200
            //   4. failpoint attempt 2 fails: 0.5
            //   5. timer pick [deadline(250), backoff(300)]: 0 -> the DEADLINE
            //      fires at t=250; the backoff sleep rejects with the
            //      cancellation, which must propagate out of the retry loop.
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0.5, 0.999, 0.5, 0.999, 0.5, 0]), () => 1);
            const result = await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        try {
                            return await task.withTimedSignal(
                                async (signal) => {
                                    for (;;) {
                                        try {
                                            attempts++;
                                            await task.failpoint("op attempt");
                                            return "ok";
                                        } catch (e) {
                                            if (isCancellation(e)) throw e;
                                            if (!isApplicationFailure(e)) throw e;
                                            await task.sleep(100, "retry backoff", { signal });
                                        }
                                    }
                                },
                                250,
                                "operation deadline",
                            );
                        } catch (e) {
                            if (isCancellation(e)) return "cancelled";
                            throw e;
                        }
                    },
                },
            ]);
            assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
            return [defined(result.value[0]), attempts];
        }

        // Three failing attempts were retried; the cancellation was not.
        assert.deepStrictEqual(await run(), ["cancelled", 3]);
        // And the identical entropy replays to the identical outcome.
        assert.deepStrictEqual(await run(), ["cancelled", 3]);
    });
});

describe("noSimulation real time", () => {
    // Acceptance test 12: the same clock-facing code runs in production
    // using real time. A shared operation, written once against
    // SimulationTask, exercised through noSimulation here (and through
    // SimulationImpl everywhere above).
    async function backoffOperation(task: SimulationTask): Promise<number> {
        const start = task.monotonicNow();
        await task.sleep(10, "first backoff");
        await task.sleep(15, "second backoff");
        return task.monotonicNow() - start;
    }

    it("runs the same sleep-based code with real timers", async () => {
        const result = await noSimulation.runTasks([{ name: "op", f: backoffOperation }]);
        assert.ok(result.isOk());
        // Real timers may fire a hair early or late; the elapsed time must
        // just be roughly the requested 25ms.
        assert.ok(defined(result.value[0]) >= 20, `expected >=20ms elapsed, got ${result.value[0]}`);
    });

    it("wallNow tracks Date.now and monotonicNow advances", async () => {
        const task = new NoSimulationTask("test", false);
        assert.ok(Math.abs(task.wallNow() - Date.now()) < 1_000);
        const before = task.monotonicNow();
        await task.sleep(10, "tick");
        assert.ok(task.monotonicNow() > before);
    });

    // Acceptance test 20 (production half): the same validation as in
    // simulation — setTimeout would silently clamp a negative delay.
    it("rejects negative sleep durations", () => {
        const task = new NoSimulationTask("test", false);
        assert.throws(() => task.sleep(-5, "bad"), TypeError);
    });

    it("aborting a real sleep rejects with the abort reason", async () => {
        const task = new NoSimulationTask("test", false);
        const reason = new Error("stop");
        const controller = new AbortController();
        setTimeout(() => controller.abort(reason), 10);
        await assert.rejects(
            task.sleep(60_000, "long", { signal: controller.signal }),
            (e: unknown) => e === reason,
        );
    });

    it("a pre-aborted signal rejects a real sleep immediately", async () => {
        const task = new NoSimulationTask("test", false);
        const reason = new Error("already stopped");
        const controller = new AbortController();
        controller.abort(reason);
        const before = Date.now();
        await assert.rejects(
            task.sleep(60_000, "long", { signal: controller.signal }),
            (e: unknown) => e === reason,
        );
        assert.ok(Date.now() - before < 1_000);
    });

    it("an expired real deadline aborts with a cancellation carrying the reason", async () => {
        const task = new NoSimulationTask("test", false);
        const deadline = task.createDeadline(10, "real deadline");
        try {
            await assert.rejects(
                task.sleep(60_000, "guarded", { signal: deadline.signal }),
                (e: unknown) => {
                    assert.ok(isCancellation(e), `expected a cancellation, got ${String(e)}`);
                    assert.strictEqual((e as { deadlineReason?: string }).deadlineReason, "real deadline");
                    return true;
                },
            );
        } finally {
            deadline.cancel();
        }
    });

    it("cancelling a real deadline prevents the abort", async () => {
        const task = new NoSimulationTask("test", false);
        const deadline = task.createDeadline(10, "cancelled deadline");
        deadline.cancel();
        await task.sleep(30, "wait past the deadline");
        assert.strictEqual(deadline.signal.aborted, false);
    });

    it("withTimedSignal cancels its deadline when the operation completes", async () => {
        const task = new NoSimulationTask("test", false);
        let signalSeen: AbortSignal | undefined;
        const value = await task.withTimedSignal(
            async (signal) => {
                signalSeen = signal;
                await task.sleep(5, "quick op", { signal });
                return "done";
            },
            10_000,
            "generous deadline",
        );
        assert.strictEqual(value, "done");
        await task.sleep(20, "give a leaked timer a chance to fire");
        assert.strictEqual(defined(signalSeen).aborted, false);
    });

    it("withTimedSignal aborts a too-slow operation's signal", async () => {
        const task = new NoSimulationTask("test", false);
        await assert.rejects(
            task.withTimedSignal(
                (signal) => task.sleep(60_000, "too slow", { signal }),
                10,
                "tight deadline",
            ),
            (e: unknown) => isCancellation(e),
        );
    });
});

describe("safety guards", () => {
    // Acceptance test 13: maximum-step and maximum-virtual-time guards
    // terminate pathological tests; a step budget exhausted at a fixed
    // virtual time is reported as a livelock.
    it("a checkpoint livelock exhausts the step budget and is reported as a livelock", async () => {
        const sim = makeSim([], { maxSchedulingSteps: 100 });
        const result = await sim.runTasks([
            {
                name: "spinner",
                f: async (task: SimulationTask) => {
                    for (;;) {
                        await task.checkpoint("spin");
                    }
                },
            },
        ]);
        assert.ok(result.isErr());
        assert.match(result.error.message, /Maximum scheduling steps \(100\) exceeded/);
        assert.match(result.error.message, /livelock/);
        assert.match(result.error.message, /t=0ms/);
    });

    it("an endlessly rescheduled zero-duration timer is reported as a livelock", async () => {
        const sim = makeSim([], { maxSchedulingSteps: 100 });
        const result = await sim.runTasks([
            {
                name: "spinner",
                f: async (task: SimulationTask) => {
                    for (;;) {
                        await task.sleep(0, "spin");
                    }
                },
            },
        ]);
        assert.ok(result.isErr());
        assert.match(result.error.message, /livelock/);
        assert.match(result.error.message, /t=0ms/);
    });

    it("a step budget exhausted while virtual time advances is not reported as a livelock", async () => {
        const sim = makeSim([], { maxSchedulingSteps: 100 });
        const result = await sim.runTasks([
            {
                name: "ticker",
                f: async (task: SimulationTask) => {
                    for (;;) {
                        await task.sleep(10, "tick");
                    }
                },
            },
        ]);
        assert.ok(result.isErr());
        assert.match(result.error.message, /Maximum scheduling steps \(100\) exceeded/);
        assert.doesNotMatch(result.error.message, /livelock/);
        assert.match(result.error.message, /still advancing/);
    });

    it("the maximum virtual duration terminates a runaway clock", async () => {
        const sim = makeSim([], { maxVirtualDurationMs: 60_000 });
        const result = await sim.runTasks([
            {
                name: "far-future",
                f: async (task: SimulationTask) => {
                    await task.sleep(10_000, "fine");
                    await task.sleep(1_000_000, "too far");
                },
            },
        ]);
        assert.ok(result.isErr());
        assert.match(result.error.message, /Maximum virtual duration \(60000ms\) exceeded/);
        assert.match(result.error.message, /too far/);
    });
});

describe("timer pick policy", () => {
    it("a custom policy chooses which pending timer fires", async () => {
        // An earliest-deadline-first policy: fully deterministic, consumes
        // no entropy. Unbiased picking could make time gallop; the policy
        // shapes exploration only.
        const sim = new SimulationImpl(
            new ArrayLogger(),
            new FixedEntropySource([0]),
            () => 0,
            {
                pickTimerIndex: (timers) => {
                    let best = 0;
                    for (let i = 1; i < timers.length; i++) {
                        if (defined(timers[i]).deadline < defined(timers[best]).deadline) best = i;
                    }
                    return best;
                },
            },
        );
        const wakes: Array<[string, number]> = [];
        // Entropy: only the START pick (0 -> A). Both timer picks go through
        // the policy, which draws nothing.
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    await task.sleep(2_000, "late");
                    wakes.push(["A", task.monotonicNow()]);
                },
            },
            {
                name: "B",
                f: async (task: SimulationTask) => {
                    await task.sleep(1_000, "early");
                    wakes.push(["B", task.monotonicNow()]);
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        // Earliest-first: B wakes at 1000 before A at 2000 — unlike the
        // default uniform pick, this is guaranteed regardless of entropy.
        assert.deepStrictEqual(wakes, [
            ["B", 1_000],
            ["A", 2_000],
        ]);
    });

    it("a policy can consume entropy to bias the choice", async () => {
        async function run(draw: number): Promise<Array<[string, number]>> {
            const wakes: Array<[string, number]> = [];
            const sim = new SimulationImpl(
                new ArrayLogger(),
                new FixedEntropySource([0, draw]),
                () => 0,
                {
                    // Fire the earliest deadline with 90% probability, any
                    // other uniformly otherwise — a biased exploration
                    // policy in the spirit of the spec's suggestion.
                    pickTimerIndex: (timers, _now, random) => {
                        const r = random("timer pick bias");
                        let earliest = 0;
                        for (let i = 1; i < timers.length; i++) {
                            if (defined(timers[i]).deadline < defined(timers[earliest]).deadline) earliest = i;
                        }
                        if (r < 0.9) return earliest;
                        return earliest === 0 ? 1 : 0;
                    },
                },
            );
            const result = await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        await task.sleep(2_000, "late");
                        wakes.push(["A", task.monotonicNow()]);
                    },
                },
                {
                    name: "B",
                    f: async (task: SimulationTask) => {
                        await task.sleep(1_000, "early");
                        wakes.push(["B", task.monotonicNow()]);
                    },
                },
            ]);
            assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
            return wakes;
        }

        assert.deepStrictEqual(await run(0.5), [
            ["B", 1_000],
            ["A", 2_000],
        ]);
        assert.deepStrictEqual(await run(0.95), [
            ["A", 2_000],
            ["B", 2_000],
        ]);
    });

    it("a single pending timer is a forced choice that bypasses the policy", async () => {
        const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([]), () => 0, {
            pickTimerIndex: () => {
                throw new Error("policy must not be called for a forced choice");
            },
        });
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    await task.sleep(1_000, "solo");
                    return task.monotonicNow();
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.deepStrictEqual(result.value, [1_000]);
    });
});

describe("cross-task promise sharing", () => {
    // These tests cover DETERMINED-BUG.md: a task awaiting a promise that
    // will be settled by another task (the singleflight/coalescing shape)
    // must complete — the scheduler must advance time to pending timers
    // even while a task is suspended on a promise it doesn't manage, and
    // must fail loudly (never hang silently) when nothing can progress.
    //
    // A hang can't fail a test by itself, so every runTasks is raced
    // against a real-time timeout that turns a hang into an assertion
    // failure instead of a stuck test runner.
    const HANG = Symbol("hang");
    async function withHangGuard<T>(run: Promise<T>): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<typeof HANG>((resolve) => {
            timer = setTimeout(() => resolve(HANG), 2_000);
        });
        const raced = await Promise.race([run, timeout]);
        clearTimeout(timer);
        if (raced === HANG) assert.fail("simulation hung: runTasks never settled");
        return raced;
    }

    function makeCrossTaskSim(entropy: ConstructorParameters<typeof SimulationImpl>[1]): SimulationImpl {
        return new SimulationImpl(new ArrayLogger(), entropy, () => 0, {
            maxSchedulingSteps: 10_000,
            maxVirtualDurationMs: 60_000,
        });
    }

    // The direct repro from DETERMINED-BUG.md. Always-zero entropy forces
    // the deadlocking schedule: the owner runs first, publishes its
    // promise, and sleeps; the waiter then awaits the foreign promise
    // directly. (Under random entropy the scheduler can happen to fire the
    // owner's timer before the waiter awaits, masking the bug.)
    it("a task awaiting a promise settled by another task's timer completes", async () => {
        const sim = makeCrossTaskSim({ random: () => 0 });
        let shared: Promise<string> | undefined;
        let settled = false;
        let waiterSawSettled: boolean | undefined;
        const result = await withHangGuard(
            sim.runTasks([
                {
                    name: "owner",
                    f: async (task: SimulationTask) => {
                        shared = task.sleep(10, "work").then(() => {
                            settled = true;
                            return "done";
                        });
                        return await shared;
                    },
                },
                {
                    name: "waiter",
                    f: async (task: SimulationTask) => {
                        // Wait until the owner has published its promise, then await it.
                        while (shared === undefined) await task.sleep(1, "poll");
                        waiterSawSettled = settled;
                        return await shared;
                    },
                },
            ]),
        );
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.deepStrictEqual(result.value, ["done", "done"]);
        // Guard the repro itself: the waiter must have suspended on the
        // promise while it was still pending — otherwise this test isn't
        // exercising the cross-task wait at all.
        assert.strictEqual(waiterSawSettled, false);
    });

    // The motivating use case: singleflight. Several waiters coalesce on
    // one in-flight operation and all receive its result. Waiters resumed
    // by the shared promise settling run in promise-reaction order, not
    // entropy order — so also assert the whole run is deterministic by
    // running it twice and comparing the recorded resume orders.
    it("multiple waiters coalescing on one in-flight promise all complete deterministically", async () => {
        async function runScenario(): Promise<{ values: readonly string[]; order: string[] }> {
            const sim = makeCrossTaskSim({ random: () => 0 });
            const order: string[] = [];
            let inFlight: Promise<string> | undefined;
            const fetchOnce = (task: SimulationTask): Promise<string> => {
                inFlight ??= task.sleep(50, "fetch").then(() => "payload");
                return inFlight;
            };
            const makeWaiter = (name: string) => ({
                name,
                f: async (task: SimulationTask) => {
                    while (inFlight === undefined) await task.sleep(1, "poll");
                    const value = await inFlight;
                    order.push(name);
                    return value;
                },
            });
            const result = await withHangGuard(
                sim.runTasks([
                    {
                        name: "fetcher",
                        f: async (task: SimulationTask) => {
                            const value = await fetchOnce(task);
                            order.push("fetcher");
                            return value;
                        },
                    },
                    makeWaiter("waiterA"),
                    makeWaiter("waiterB"),
                    makeWaiter("waiterC"),
                ]),
            );
            assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
            return { values: result.value, order };
        }

        const first = await runScenario();
        assert.deepStrictEqual(first.values, ["payload", "payload", "payload", "payload"]);
        assert.strictEqual(first.order.length, 4);
        const second = await runScenario();
        assert.deepStrictEqual(second.order, first.order);
    });

    // A task suspended on a foreign promise must not stall the rest of the
    // simulation: a checkpoint-parked task keeps running, at the current
    // virtual time, before any timer fires.
    it("a checkpointing task keeps running while another task awaits a foreign promise", async () => {
        const sim = makeCrossTaskSim({ random: () => 0 });
        let shared: Promise<string> | undefined;
        const workerTimes: number[] = [];
        const result = await withHangGuard(
            sim.runTasks([
                {
                    name: "owner",
                    f: async (task: SimulationTask) => {
                        shared = task.sleep(10, "work").then(() => "done");
                        return await shared;
                    },
                },
                {
                    name: "waiter",
                    f: async (task: SimulationTask) => {
                        while (shared === undefined) await task.sleep(1, "poll");
                        return await shared;
                    },
                },
                {
                    name: "worker",
                    f: async (task: SimulationTask) => {
                        workerTimes.push(task.monotonicNow());
                        await task.checkpoint("mid");
                        workerTimes.push(task.monotonicNow());
                        return "worked";
                    },
                },
            ]),
        );
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.deepStrictEqual(result.value, ["done", "done", "worked"]);
        // The worker never sleeps, so it must have run to completion at
        // t=0 — before the scheduler advanced time to the owner's timer.
        assert.deepStrictEqual(workerTimes, [0, 0]);
    });

    // A foreign promise settled directly by another running task — no
    // timer involved. The waiter is listed first so always-zero entropy
    // schedules it first and it suspends on the still-unsettled promise;
    // the scheduler must keep running the resolver and must not misreport
    // a deadlock while the settling cascade is still in the microtask
    // queue.
    it("a foreign promise settled by another task without a timer completes", async () => {
        const sim = makeCrossTaskSim({ random: () => 0 });
        let resolveShared!: (value: string) => void;
        const shared = new Promise<string>((resolve) => {
            resolveShared = resolve;
        });
        const result = await withHangGuard(
            sim.runTasks([
                {
                    name: "waiter",
                    f: async () => {
                        return await shared;
                    },
                },
                {
                    name: "resolver",
                    f: async (task: SimulationTask) => {
                        await task.checkpoint("before resolve");
                        resolveShared("payload");
                        return "resolved";
                    },
                },
            ]),
        );
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.deepStrictEqual(result.value, ["payload", "resolved"]);
    });

    // Promise.all spanning tasks: the waiter joins on two promises settled
    // by two different tasks' timers.
    it("Promise.all over promises from different tasks completes", async () => {
        const sim = makeCrossTaskSim({ random: () => 0 });
        let sharedA: Promise<string> | undefined;
        let sharedB: Promise<string> | undefined;
        const result = await withHangGuard(
            sim.runTasks([
                {
                    name: "ownerA",
                    f: async (task: SimulationTask) => {
                        sharedA = task.sleep(10, "work A").then(() => "A");
                        return await sharedA;
                    },
                },
                {
                    name: "ownerB",
                    f: async (task: SimulationTask) => {
                        sharedB = task.sleep(20, "work B").then(() => "B");
                        return await sharedB;
                    },
                },
                {
                    name: "waiter",
                    f: async (task: SimulationTask) => {
                        while (sharedA === undefined || sharedB === undefined) await task.sleep(1, "poll");
                        return await Promise.all([sharedA, sharedB]);
                    },
                },
            ]),
        );
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.deepStrictEqual(result.value, ["A", "B", ["A", "B"]]);
    });

    // A timer whose only effect is settling a foreign promise: a deadline
    // whose abort listener resolves a deferred (listeners are documented
    // as allowed to "settle a low-level promise"). Firing it produces no
    // schedulable task synchronously — the wake-up sits in the microtask
    // queue — so the scheduler must wait for the cascade instead of
    // misreporting a deadlock.
    it("a timer that settles only a foreign promise does not deadlock", async () => {
        const sim = makeCrossTaskSim({ random: () => 0 });
        let resolveShared!: (value: string) => void;
        const shared = new Promise<string>((resolve) => {
            resolveShared = resolve;
        });
        const result = await withHangGuard(
            sim.runTasks([
                {
                    name: "creator",
                    f: async (task: SimulationTask) => {
                        const deadline = task.createDeadline(5, "settle shared");
                        deadline.signal.addEventListener("abort", () => resolveShared("settled"), { once: true });
                        return "created";
                    },
                },
                {
                    name: "waiter",
                    f: async (task: SimulationTask) => {
                        // A deeper reaction chain than a bare await: the
                        // whole cascade must drain before the scheduler
                        // decides anything.
                        const value = await shared.then((v) => v).then((v) => v);
                        return `${value} at t=${task.monotonicNow()}ms`;
                    },
                },
            ]),
        );
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.deepStrictEqual(result.value, ["created", "settled at t=5ms"]);
    });

    // Same shape plus a later timer: after the settling timer fires, the
    // scheduler must let the wake-up cascade drain rather than firing the
    // later timer too — the waiter must observe t=5, not t=1000.
    it("a later timer does not fire before a settling cascade has drained", async () => {
        const sim = makeCrossTaskSim({ random: () => 0 });
        let resolveShared!: (value: string) => void;
        const shared = new Promise<string>((resolve) => {
            resolveShared = resolve;
        });
        const result = await withHangGuard(
            sim.runTasks([
                {
                    // Runs first (always-zero entropy), so its timer is
                    // created first and the always-zero timer pick fires it
                    // first.
                    name: "creator",
                    f: async (task: SimulationTask) => {
                        const deadline = task.createDeadline(5, "settle shared");
                        deadline.signal.addEventListener("abort", () => resolveShared("settled"), { once: true });
                        return "created";
                    },
                },
                {
                    name: "sleeper",
                    f: async (task: SimulationTask) => {
                        await task.sleep(1_000, "long nap");
                        return `woke at t=${task.monotonicNow()}ms`;
                    },
                },
                {
                    name: "waiter",
                    f: async (task: SimulationTask) => {
                        const value = await shared;
                        return `${value} at t=${task.monotonicNow()}ms`;
                    },
                },
            ]),
        );
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.deepStrictEqual(result.value, ["created", "woke at t=1000ms", "settled at t=5ms"]);
    });

    // Promises settled by the runtime itself — already resolved, or via
    // queueMicrotask — resume their awaiters during the microtask drain,
    // before the scheduler's quiescence check. None of these may be
    // misreported as a deadlock.
    it("promises settled outside the scheduler do not false-deadlock", async () => {
        const sim = makeCrossTaskSim({ random: () => 0 });
        const result = await withHangGuard(
            sim.runTasks([
                {
                    name: "resolved",
                    f: async (task: SimulationTask) => {
                        await Promise.resolve();
                        await task.checkpoint("mid");
                        return await Promise.resolve("a");
                    },
                },
                {
                    name: "microtask",
                    f: async () => {
                        await new Promise<void>((resolve) => queueMicrotask(resolve));
                        return "b";
                    },
                },
                {
                    name: "nested",
                    f: async () => {
                        return await Promise.resolve("c")
                            .then((v) => v)
                            .then((v) => Promise.resolve(v))
                            .then((v) => v);
                    },
                },
            ]),
        );
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.deepStrictEqual(result.value, ["a", "b", "c"]);
    });

    // A completed run may leave a quiescence probe pending. It must be
    // inert: no entropy draws, no log output, no state mutation, and no
    // poisoning of the instance.
    it("pending probes from a completed run are inert", async () => {
        const logger = new ArrayLogger();
        // FixedEntropySource throws on any draw, so an extra draw from a
        // post-completion probe would surface as a failure below.
        const sim = new SimulationImpl(logger, new FixedEntropySource([]), () => 0);
        const solo = {
            name: "solo",
            f: async (task: SimulationTask) => {
                await task.sleep(1, "nap");
                return "one";
            },
        };
        const first = await withHangGuard(sim.runTasks([solo]));
        assert.ok(first.isOk(), `expected ok, got err: ${first.isErr() ? first.error.message : ""}`);
        const logCount = logger.logs.length;
        // Let any pending probes fire.
        await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
        assert.strictEqual(logger.logs.length, logCount, "a post-completion probe did something");
        // Not poisoned: the instance is still usable.
        const again = await withHangGuard(sim.runTasks([solo]));
        assert.ok(again.isOk(), `expected ok, got err: ${again.isErr() ? again.error.message : ""}`);
    });

    // Back-to-back runs on one instance, where the second run starts while
    // the first run's probe is still pending: the stale probe must not
    // touch the new run's state, and the new run's own probes must work.
    it("a stale probe from an earlier run does not affect a cross-task run started immediately", async () => {
        const sim = makeCrossTaskSim({ random: () => 0 });
        const first = await withHangGuard(
            sim.runTasks([
                {
                    name: "solo",
                    f: async (task: SimulationTask) => {
                        await task.sleep(1, "nap");
                        return "one";
                    },
                },
            ]),
        );
        assert.ok(first.isOk(), `expected ok, got err: ${first.isErr() ? first.error.message : ""}`);

        // No event-loop turn in between: run 2 starts with run 1's probe
        // still in flight.
        let shared: Promise<string> | undefined;
        const second = await withHangGuard(
            sim.runTasks([
                {
                    name: "owner",
                    f: async (task: SimulationTask) => {
                        shared = task.sleep(10, "work").then(() => "done");
                        return await shared;
                    },
                },
                {
                    name: "waiter",
                    f: async (task: SimulationTask) => {
                        while (shared === undefined) await task.sleep(1, "poll");
                        return await shared;
                    },
                },
            ]),
        );
        assert.ok(second.isOk(), `expected ok, got err: ${second.isErr() ? second.error.message : ""}`);
        assert.deepStrictEqual(second.value, ["done", "done"]);
    });

    // Fail-loudly half of the contract: a task suspended on a promise
    // nobody will ever settle, with no pending timers, is a genuine
    // deadlock. It must abort with a diagnostic naming the stuck task —
    // never hang silently.
    it("a task awaiting a promise nobody settles fails loudly instead of hanging", async () => {
        const sim = makeCrossTaskSim({ random: () => 0 });
        let resolveLate!: (value: string) => void;
        const late = new Promise<string>((resolve) => {
            resolveLate = resolve;
        });
        let zombieRan = false;
        const result = await withHangGuard(
            sim.runTasks([
                {
                    name: "finisher",
                    f: async (task: SimulationTask) => {
                        await task.checkpoint("step");
                        return "finished";
                    },
                },
                {
                    name: "stuck",
                    f: async () => {
                        await late;
                        zombieRan = true;
                        return "unreachable";
                    },
                },
            ]),
        );
        assert.ok(result.isErr(), "expected the simulation to report the deadlock");
        assert.match(result.error.message, /[Dd]eadlock/);
        assert.match(result.error.message, /stuck/);

        // Like any failed run, a probe-detected deadlock poisons the
        // instance.
        const reused = await withHangGuard(sim.runTasks([{ name: "again", f: async () => "again" }]));
        assert.ok(reused.isErr(), "expected the poisoned instance to fail");

        // Settling the promise after the run failed resumes the abandoned
        // task's code — that cannot be prevented, but it must not crash the
        // process or produce an unhandled rejection.
        resolveLate("too late");
        await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
        assert.strictEqual(zombieRan, true, "the abandoned task's continuation should have run");
    });

    // A budget error raised while the scheduler advances time on behalf of
    // a foreign-suspended task has no task stack to propagate through; it
    // must still fail the run instead of hanging.
    it("exceeding maxVirtualDurationMs while a task awaits a foreign promise fails the run", async () => {
        const sim = new SimulationImpl(new ArrayLogger(), { random: () => 0 }, () => 0, {
            maxVirtualDurationMs: 5,
        });
        let shared: Promise<string> | undefined;
        const result = await withHangGuard(
            sim.runTasks([
                {
                    name: "owner",
                    f: async (task: SimulationTask) => {
                        shared = task.sleep(10, "too long").then(() => "done");
                        return await shared;
                    },
                },
                {
                    name: "waiter",
                    f: async (task: SimulationTask) => {
                        while (shared === undefined) await task.sleep(1, "poll");
                        return await shared;
                    },
                },
            ]),
        );
        assert.ok(result.isErr(), "expected the simulation to report the budget violation");
        assert.match(result.error.message, /Maximum virtual duration/);
    });

    // The cross-task shape must stay deterministic: a recorded run replays
    // identically, including the timer firings that resume foreign-blocked
    // tasks.
    it("cross-task awaits record and replay deterministically", async () => {
        async function runScenario(
            entropy: ConstructorParameters<typeof SimulationImpl>[1],
        ): Promise<string[]> {
            const events: string[] = [];
            let shared: Promise<string> | undefined;
            const sim = makeCrossTaskSim(entropy);
            const result = await withHangGuard(
                sim.runTasks([
                    {
                        name: "owner",
                        f: async (task: SimulationTask) => {
                            shared = task.sleep(10, "work").then(() => "done");
                            const value = await shared;
                            events.push(`owner got ${value} at t=${task.monotonicNow()}ms`);
                        },
                    },
                    {
                        name: "waiterA",
                        f: async (task: SimulationTask) => {
                            while (shared === undefined) await task.sleep(1, "poll");
                            const value = await shared;
                            events.push(`waiterA got ${value} at t=${task.monotonicNow()}ms`);
                        },
                    },
                    {
                        name: "waiterB",
                        f: async (task: SimulationTask) => {
                            await task.sleep(3, "delay");
                            const value = await defined(shared);
                            events.push(`waiterB got ${value} at t=${task.monotonicNow()}ms`);
                        },
                    },
                ]),
            );
            assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
            return events;
        }

        for (let iteration = 0; iteration < 10; iteration++) {
            const recording = new RecordingTraceSource(new SimpleEntropySource());
            const recorded = await runScenario(recording);
            const replaying = new ReplayingTraceSource(recording.getTrace());
            const replayed = await runScenario(replaying);
            assert.deepStrictEqual(replayed, recorded);
            replaying.assertFullyConsumed();
        }
    });
});
