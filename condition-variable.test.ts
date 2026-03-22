import { describe, it } from "node:test";
import assert from "node:assert";
import { ConditionVariable } from "./condition-variable.ts";
import { SimulationImpl, type SimulationTask } from "./simulation.ts";
import { ArrayLogger, FixedEntropySource } from "./test-helpers.ts";

describe("ConditionVariable", () => {
    it("wait + notifyAll basic flow", async () => {
        // Entropy: pick waiter first from [waiter, notifier]
        const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0]), 0);
        const cv = new ConditionVariable("test");
        const order: string[] = [];

        const result = await sim.runTasks([
            {
                name: "waiter",
                f: async (task: SimulationTask) => {
                    await cv.wait(task, "signal");
                    order.push("waiter-resumed");
                    return "waited";
                },
            },
            {
                name: "notifier",
                f: async (task: SimulationTask) => {
                    cv.notifyAll(task, "signal");
                    order.push("notifier-done");
                    return "notified";
                },
            },
        ]);

        assert.ok(result.isOk());
        assert.deepStrictEqual(result.value, ["waited", "notified"]);
        // Notifier completes before waiter resumes
        assert.deepStrictEqual(order, ["notifier-done", "waiter-resumed"]);
    });

    it("multiple waiters all wake", async () => {
        // Entropy:
        //   1. Pick from [w1, w2, notifier] (3 items): 0 -> w1
        //   2. Pick from [w2, notifier] (2 items): 0 -> w2
        //   3. After notify, pick from [w1, w2] (2 items): 0 -> w1
        const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0, 0, 0]), 0);
        const cv = new ConditionVariable("test");
        const order: string[] = [];

        const result = await sim.runTasks([
            {
                name: "w1",
                f: async (task: SimulationTask) => {
                    await cv.wait(task, "signal");
                    order.push("w1");
                    return "w1";
                },
            },
            {
                name: "w2",
                f: async (task: SimulationTask) => {
                    await cv.wait(task, "signal");
                    order.push("w2");
                    return "w2";
                },
            },
            {
                name: "notifier",
                f: async (task: SimulationTask) => {
                    cv.notifyAll(task, "signal");
                    order.push("notifier");
                    return "notifier";
                },
            },
        ]);

        assert.ok(result.isOk());
        assert.deepStrictEqual(result.value, ["w1", "w2", "notifier"]);
        assert.deepStrictEqual(order, ["notifier", "w1", "w2"]);
    });

    it("notifyAll with no waiters does not throw", async () => {
        const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([]), 0);
        const cv = new ConditionVariable("test");

        const result = await sim.runTasks([
            {
                name: "notifier",
                f: async (task: SimulationTask) => {
                    cv.notifyAll(task, "signal");
                    return "done";
                },
            },
        ]);

        assert.ok(result.isOk());
    });

    it("wait blocks until notified", async () => {
        // Pick waiter first
        const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0]), 0);
        const cv = new ConditionVariable("test");
        const order: string[] = [];

        const result = await sim.runTasks([
            {
                name: "waiter",
                f: async (task: SimulationTask) => {
                    order.push("waiter-before");
                    await cv.wait(task, "signal");
                    order.push("waiter-after");
                    return "waited";
                },
            },
            {
                name: "notifier",
                f: async (task: SimulationTask) => {
                    order.push("notifier-before");
                    cv.notifyAll(task, "signal");
                    order.push("notifier-after");
                    return "notified";
                },
            },
        ]);

        assert.ok(result.isOk());
        // Waiter starts first (picked by entropy), blocks on wait,
        // notifier runs and notifies, notifier finishes, then waiter resumes
        assert.ok(order.indexOf("waiter-before") < order.indexOf("notifier-before"));
        assert.ok(order.indexOf("notifier-after") < order.indexOf("waiter-after"));
    });

    it("reuse: wait/notifyAll works across multiple cycles on the same CV", async () => {
        // Entropy:
        //   1. Pick from [waiter, notifier]: 0 -> waiter
        //   2. After first notify + checkpoint, pick from [waiter, notifier]: 0 -> waiter
        const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0, 0]), 0);
        const cv = new ConditionVariable("test");
        const order: string[] = [];

        const result = await sim.runTasks([
            {
                name: "waiter",
                f: async (task: SimulationTask) => {
                    await cv.wait(task, "cycle-1");
                    order.push("wake-1");
                    await cv.wait(task, "cycle-2");
                    order.push("wake-2");
                    return "waited";
                },
            },
            {
                name: "notifier",
                f: async (task: SimulationTask) => {
                    cv.notifyAll(task, "cycle-1");
                    await task.checkpoint("between");
                    cv.notifyAll(task, "cycle-2");
                    return "notified";
                },
            },
        ]);

        assert.ok(result.isOk());
        assert.deepStrictEqual(result.value, ["waited", "notified"]);
        assert.deepStrictEqual(order, ["wake-1", "wake-2"]);
    });

    it("notify-before-wait causes deadlock (notifications are not sticky)", async () => {
        // Entropy: pick notifier first (0.999 -> index 1 of [waiter, notifier])
        const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0.999]), 0);
        const cv = new ConditionVariable("test");
        const order: string[] = [];

        const result = await sim.runTasks([
            {
                name: "waiter",
                f: async (task: SimulationTask) => {
                    order.push("waiter-start");
                    await cv.wait(task, "signal");
                    order.push("waiter-resumed");
                    return "waited";
                },
            },
            {
                name: "notifier",
                f: async (task: SimulationTask) => {
                    order.push("notifier-start");
                    cv.notifyAll(task, "signal");
                    order.push("notifier-done");
                    return "notified";
                },
            },
        ]);

        assert.ok(result.isErr());
        // Notifier completed, but waiter never resumed (lost wakeup)
        assert.ok(order.includes("notifier-done"), "notifier should have completed");
        assert.ok(!order.includes("waiter-resumed"), "waiter should never have resumed");
    });
});
