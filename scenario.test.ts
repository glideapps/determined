import { describe, it } from "node:test";
import assert from "node:assert";
import { SimulationImpl, type SimulationTask } from "./simulation.ts";
import { SimpleEntropySource } from "./entropy.ts";
import { RecordingTraceSource, ReplayingTraceSource } from "./trace.ts";
import { CancellationError, isApplicationFailure, isCancellation } from "./errors.ts";
import { ArrayLogger } from "./test-helpers.ts";

// Acceptance test 14: a pi-orb-style scenario — a producer feeding a
// persistence worker that commits with simulated latency, failpoint-driven
// failures, and retry backoff, plus a shutdown that interrupts idle sleeps
// via cancellation while the worker keeps flushing until no complete
// records remain. The whole thing must run and replay deterministically
// under arbitrary entropy.

interface ScenarioState {
    readonly queue: string[];
    readonly committed: string[];
    readonly events: string[];
}

async function producer(task: SimulationTask, state: ScenarioState, shutdown: AbortSignal): Promise<void> {
    for (let i = 0; i < 5; i++) {
        try {
            await task.sleep(100, "produce interval", { signal: shutdown });
        } catch (e) {
            if (isCancellation(e)) {
                state.events.push(`producer stopped at t=${task.monotonicNow()}`);
                return;
            }
            throw e;
        }
        const record = `record-${i}`;
        state.queue.push(record);
        state.events.push(`produced ${record} at t=${task.monotonicNow()}`);
    }
    state.events.push(`producer done at t=${task.monotonicNow()}`);
}

async function worker(task: SimulationTask, state: ScenarioState, shutdown: AbortSignal): Promise<void> {
    for (;;) {
        const record = state.queue[0];
        if (record === undefined) {
            // Nothing to commit. On shutdown the flush is complete; until
            // then, poll — the idle sleep is cancellable so shutdown does
            // not have to wait out the poll interval.
            if (shutdown.aborted) break;
            try {
                await task.sleep(50, "poll interval", { signal: shutdown });
            } catch (e) {
                if (!isCancellation(e)) throw e;
            }
            continue;
        }
        // Commit with retry backoff. Deliberately NOT bounded by the
        // shutdown signal: controlled shutdown keeps committing until no
        // complete records remain. Retries retry simulated failures only —
        // a cancellation would have to propagate (none can occur here).
        for (let attempt = 0; ; attempt++) {
            try {
                await task.sleep(task.random("commit latency") * 20, "database commit latency");
                await task.failpoint("database commit");
                break;
            } catch (e) {
                if (isCancellation(e)) throw e;
                if (!isApplicationFailure(e)) throw e;
                await task.sleep(10 * (attempt + 1), "commit retry backoff");
            }
        }
        state.queue.shift();
        state.committed.push(record);
        state.events.push(`committed ${record} at t=${task.monotonicNow()}`);
    }
    state.events.push(`flushed at t=${task.monotonicNow()}`);
}

async function shutdowner(task: SimulationTask, state: ScenarioState, controller: AbortController): Promise<void> {
    await task.sleep(150 + task.random("shutdown delay") * 300, "shutdown delay");
    state.events.push(`shutdown requested at t=${task.monotonicNow()}`);
    controller.abort(new CancellationError(`shutdown requested at t=${task.monotonicNow()}`));
}

async function runScenario(entropy: ConstructorParameters<typeof SimulationImpl>[1]): Promise<ScenarioState> {
    const state: ScenarioState = { queue: [], committed: [], events: [] };
    const controller = new AbortController();
    const sim = new SimulationImpl(new ArrayLogger(), entropy, (...log) => (log[0] === "database commit" ? 0.2 : 0), {
        maxSchedulingSteps: 10_000,
        maxVirtualDurationMs: 60_000,
    });
    const result = await sim.runTasks([
        { name: "producer", f: (task) => producer(task, state, controller.signal) },
        { name: "worker", f: (task) => worker(task, state, controller.signal) },
        { name: "shutdown", f: (task) => shutdowner(task, state, controller) },
    ]);
    assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
    return state;
}

describe("pi-orb-style scenario", () => {
    it("retry/backoff with shutdown flush runs and replays deterministically", async () => {
        for (let iteration = 0; iteration < 20; iteration++) {
            const recording = new RecordingTraceSource(new SimpleEntropySource());
            const recorded = await runScenario(recording);

            // The flush completed: everything produced was committed, in
            // order, and the queue is empty.
            assert.deepStrictEqual(recorded.queue, []);
            const produced = recorded.events
                .filter((e) => e.startsWith("produced "))
                .map((e) => e.split(" ")[1]);
            assert.deepStrictEqual(recorded.committed, produced);

            // The exact event sequence — scheduling, timers, failures,
            // latencies, shutdown timing — replays identically.
            const replaying = new ReplayingTraceSource(recording.getTrace());
            const replayed = await runScenario(replaying);
            assert.deepStrictEqual(replayed.events, recorded.events);
            assert.deepStrictEqual(replayed.committed, recorded.committed);
            replaying.assertFullyConsumed();
        }
    });
});
