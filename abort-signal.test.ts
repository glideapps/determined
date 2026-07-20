import { describe, it } from "node:test";
import assert from "node:assert";
import { OwnedAbortSignal } from "./abort-signal.ts";
import { SimulationImpl, type SimulationTask } from "./simulation.ts";
import { isCancellation } from "./errors.ts";
import { ArrayLogger, FixedEntropySource } from "./test-helpers.ts";

// A dispatcher that runs listeners directly, like the simulation's does —
// minus the task-API guard, which simulation tests cover.
function makeSignal(): OwnedAbortSignal {
    return new OwnedAbortSignal({ dispatchUserAbortListener: (listener) => listener() });
}

describe("OwnedAbortSignal", () => {
    it("starts unaborted with no reason or abort time", () => {
        const signal = makeSignal();
        assert.strictEqual(signal.aborted, false);
        assert.strictEqual(signal.reason, undefined);
        assert.strictEqual(signal.abortedAtMs, undefined);
    });

    it("throwIfAborted is a no-op before abort and throws the reason after", () => {
        const signal = makeSignal();
        signal.throwIfAborted();
        const reason = new Error("stop");
        signal.abort(reason, 1_000);
        assert.throws(() => signal.throwIfAborted(), (e: unknown) => e === reason);
    });

    it("abort sets aborted, reason, and abort time", () => {
        const signal = makeSignal();
        const reason = new Error("stop");
        signal.abort(reason, 1_000);
        assert.strictEqual(signal.aborted, true);
        assert.strictEqual(signal.reason, reason);
        assert.strictEqual(signal.abortedAtMs, 1_000);
    });

    it("abort is one-shot: a second abort changes nothing and re-fires nothing", () => {
        const signal = makeSignal();
        let calls = 0;
        signal.addEventListener("abort", () => calls++);
        const first = new Error("first");
        signal.abort(first, 1_000);
        signal.abort(new Error("second"), 2_000);
        assert.strictEqual(calls, 1);
        assert.strictEqual(signal.reason, first);
        assert.strictEqual(signal.abortedAtMs, 1_000);
    });

    it("listeners fire in registration order with an abort event", () => {
        const signal = makeSignal();
        const order: string[] = [];
        signal.addEventListener("abort", (ev) => {
            order.push(`first:${ev.type}`);
        });
        signal.addEventListener("abort", () => {
            order.push("second");
        });
        signal.abort(new Error("stop"), 0);
        assert.deepStrictEqual(order, ["first:abort", "second"]);
    });

    it("listeners added after abort never fire (the event is one-shot)", () => {
        const signal = makeSignal();
        signal.abort(new Error("stop"), 0);
        let called = false;
        signal.addEventListener("abort", () => {
            called = true;
        });
        assert.strictEqual(called, false);
    });

    it("removeEventListener prevents a listener from firing", () => {
        const signal = makeSignal();
        let called = false;
        const listener = (): void => {
            called = true;
        };
        signal.addEventListener("abort", listener);
        signal.removeEventListener("abort", listener);
        signal.abort(new Error("stop"), 0);
        assert.strictEqual(called, false);
    });

    it("removeEventListener ignores unknown listeners and non-abort types", () => {
        const signal = makeSignal();
        let calls = 0;
        const listener = (): void => {
            calls++;
        };
        signal.addEventListener("abort", listener);
        signal.removeEventListener("abort", () => {});
        signal.removeEventListener("other", listener);
        signal.abort(new Error("stop"), 0);
        assert.strictEqual(calls, 1);
    });

    it("addEventListener ignores non-abort event types", () => {
        const signal = makeSignal();
        let called = false;
        signal.addEventListener("other", () => {
            called = true;
        });
        signal.abort(new Error("stop"), 0);
        assert.strictEqual(called, false);
    });

    it("addEventListener accepts boolean and object options", () => {
        const signal = makeSignal();
        const order: string[] = [];
        // A boolean third argument is the useCapture flag, irrelevant here
        // but part of the standard signature.
        signal.addEventListener("abort", () => order.push("boolean"), true);
        signal.addEventListener("abort", () => order.push("once"), { once: true });
        signal.abort(new Error("stop"), 0);
        assert.deepStrictEqual(order, ["boolean", "once"]);
    });

    it("an onabort handler fires after listeners", () => {
        const signal = makeSignal();
        const order: string[] = [];
        signal.addEventListener("abort", () => order.push("listener"));
        signal.onabort = (ev) => order.push(`onabort:${ev.type}`);
        signal.abort(new Error("stop"), 0);
        assert.deepStrictEqual(order, ["listener", "onabort:abort"]);
    });

    it("dispatchEvent is not supported", () => {
        const signal = makeSignal();
        assert.throws(() => signal.dispatchEvent(), /dispatchEvent is not supported/);
    });

    it("internal callbacks run before user listeners and can be detached", () => {
        const signal = makeSignal();
        const order: string[] = [];
        signal.addEventListener("abort", () => order.push("user"));
        signal.addInternalCallback(() => order.push("internal"));
        const detach = signal.addInternalCallback(() => order.push("detached"));
        detach();
        signal.abort(new Error("stop"), 0);
        assert.deepStrictEqual(order, ["internal", "user"]);
    });
});

describe("OwnedAbortSignal in simulation", () => {
    // The documented pattern for reacting to aborts without a cancellable
    // sleep: poll throwIfAborted() at wakeup points.
    it("throwIfAborted works on a deadline signal from task code", async () => {
        let caught: unknown;
        // Entropy: 0 picks the deadline timer from [deadline, sleep].
        const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0]), () => 0);
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    const deadline = task.createDeadline(100, "poll deadline");
                    try {
                        deadline.signal.throwIfAborted();
                        // Sleep WITHOUT the signal, then poll at the wakeup
                        // point.
                        await task.sleep(10_000, "uninterruptible work");
                        deadline.signal.throwIfAborted();
                        return "completed";
                    } catch (e) {
                        caught = e;
                        return "aborted";
                    } finally {
                        deadline.cancel();
                    }
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.deepStrictEqual(result.value, ["aborted"]);
        assert.ok(isCancellation(caught), `expected a cancellation, got ${String(caught)}`);
    });

    it("removing a user listener from a deadline signal prevents it from firing", async () => {
        let called = false;
        const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0]), () => 0);
        const result = await sim.runTasks([
            {
                name: "A",
                f: async (task: SimulationTask) => {
                    const deadline = task.createDeadline(100, "watchdog");
                    const listener = (): void => {
                        called = true;
                    };
                    deadline.signal.addEventListener("abort", listener);
                    deadline.signal.removeEventListener("abort", listener);
                    try {
                        await task.sleep(10_000, "nap", { signal: deadline.signal });
                    } catch (e) {
                        if (!isCancellation(e)) throw e;
                    } finally {
                        deadline.cancel();
                    }
                },
            },
        ]);
        assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
        assert.strictEqual(called, false);
    });
});
