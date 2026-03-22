import { describe, it } from "node:test";
import assert from "node:assert";
import {
    NoSimulationTask,
    SimulationImpl,
    noSimulation,
    type SimulationTask,
} from "./simulation.ts";
import { isApplicationFailure } from "./errors.ts";
import { ArrayLogger, FixedEntropySource, SpyEntropySource } from "./test-helpers.ts";

describe("NoSimulationTask", () => {
    it("checkpoint resolves immediately", async () => {
        const task = new NoSimulationTask("test", false);
        await task.checkpoint("hello");
    });

    it("failpoint resolves immediately", async () => {
        const task = new NoSimulationTask("test", false);
        await task.failpoint("hello");
    });

    it("abortSimulation throws the provided error", () => {
        const task = new NoSimulationTask("test", false);
        const error = new Error("boom");
        assert.throws(() => task.abortSimulation(error), (e: unknown) => e === error);
    });
});

describe("noSimulation", () => {
    it("runs tasks and returns ok with results", async () => {
        const result = await noSimulation.runTasks([
            { name: "task1", f: async () => 42 },
            { name: "task2", f: async () => "hello" },
        ]);
        assert.ok(result.isOk());
        assert.deepStrictEqual(result.value, [42, "hello"]);
    });

    it("returns err if a task throws", async () => {
        const result = await noSimulation.runTasks([
            { name: "fail", f: async () => { throw new Error("boom"); } },
        ]);
        assert.ok(result.isErr());
        assert.strictEqual(result.error.message, "boom");
    });
});

describe("SimulationImpl", () => {
    describe("basic task execution", () => {
        it("single task runs and returns its result", async () => {
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([]), 0);
            const result = await sim.runTasks([
                { name: "task1", f: async () => 42 },
            ]);
            assert.ok(result.isOk());
            assert.deepStrictEqual(result.value, [42]);
        });

        it("multiple tasks all run and return results in spec order", async () => {
            // Entropy picks:
            //   1. START: [A, B] -> 0 -> A
            //   2. A at "step": [A, B] -> 0 -> A again, A finishes
            //   Then only B remains -> no entropy needed
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0, 0]), 0);
            const result = await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        await task.checkpoint("step");
                        return "a";
                    },
                },
                {
                    name: "B",
                    f: async (task: SimulationTask) => {
                        await task.checkpoint("step");
                        return "b";
                    },
                },
            ]);
            assert.ok(result.isOk());
            assert.deepStrictEqual(result.value, ["a", "b"]);
        });

        it("empty task list returns ok with empty array", async () => {
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([]), 0);
            const result = await sim.runTasks([]);
            assert.ok(result.isOk());
            assert.deepStrictEqual(result.value, []);
        });
    });

    describe("deterministic scheduling", () => {
        // Uses event traces (not logs) to assert actual execution order
        async function runWithEntropy(values: number[]): Promise<string[]> {
            const order: string[] = [];
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource(values), 0);
            const result = await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        await task.checkpoint("A-1");
                        order.push("A-1");
                        await task.checkpoint("A-2");
                        order.push("A-2");
                    },
                },
                {
                    name: "B",
                    f: async (task: SimulationTask) => {
                        await task.checkpoint("B-1");
                        order.push("B-1");
                        await task.checkpoint("B-2");
                        order.push("B-2");
                    },
                },
            ]);
            assert.ok(result.isOk(), `expected ok, got err: ${result.isErr() ? result.error.message : ""}`);
            return order;
        }

        it("same entropy produces identical execution order", async () => {
            const order1 = await runWithEntropy([0, 0, 0]);
            const order2 = await runWithEntropy([0, 0, 0]);
            assert.deepStrictEqual(order1, order2);
        });

        it("entropy [0,0,0] runs A to completion before B", async () => {
            // Always picks first task (index 0) when both available
            const order = await runWithEntropy([0, 0, 0]);
            assert.deepStrictEqual(order, ["A-1", "A-2", "B-1", "B-2"]);
        });

        it("entropy [0.999,...] runs B to completion before A", async () => {
            // Always picks last task (index 1) when both available
            const order = await runWithEntropy([0.999, 0.999, 0.999]);
            assert.deepStrictEqual(order, ["B-1", "B-2", "A-1", "A-2"]);
        });

        it("mixed entropy produces interleaved execution", async () => {
            // 1. START: [A,B] -> 0 -> A unblocked
            // 2. A at "A-1": [A,B] -> 0.999 -> B unblocked
            // 3. B at "B-1": [A,B] -> 0 -> A unblocked, A pushes "A-1"
            // 4. A at "A-2": [A,B] -> 0.999 -> B unblocked, B pushes "B-1"
            // 5. B at "B-2": [A,B] -> 0 -> A unblocked, A pushes "A-2", A finishes
            // B unblocked (1 task, no entropy), B pushes "B-2"
            const order = await runWithEntropy([0, 0.999, 0, 0.999, 0]);
            assert.deepStrictEqual(order, ["A-1", "B-1", "A-2", "B-2"]);
        });
    });

    describe("failpoints", () => {
        it("with failureProbability 0, failpoints never fail and no entropy consumed for fail decision", async () => {
            // No entropy values provided - would throw if any were consumed
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([]), 0);
            const result = await sim.runTasks([
                {
                    name: "task1",
                    f: async (task: SimulationTask) => {
                        await task.failpoint("fp1");
                        return 42;
                    },
                },
            ]);
            assert.ok(result.isOk());
            assert.deepStrictEqual(result.value, [42]);
        });

        it("with failureProbability 1, failpoints always fail with ApplicationFailure", async () => {
            // 1 entropy value for the fail decision
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0.5]), 1);
            const result = await sim.runTasks([
                {
                    name: "task1",
                    f: async (task: SimulationTask) => {
                        await task.failpoint("fp1");
                        return 42;
                    },
                },
            ]);
            assert.ok(result.isErr());
            assert.ok(isApplicationFailure(result.error));
            assert.ok(result.error.message.includes("Simulated failure at failpoint"));
        });

        it("intermediate probability: entropy < prob fails, entropy >= prob passes", async () => {
            // Prob = 0.5, entropy = 0.7 -> 0.7 >= 0.5 -> pass
            const sim1 = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0.7]), 0.5);
            const result1 = await sim1.runTasks([
                {
                    name: "task1",
                    f: async (task: SimulationTask) => {
                        await task.failpoint("fp1");
                        return "passed";
                    },
                },
            ]);
            assert.ok(result1.isOk());
            assert.deepStrictEqual(result1.value, ["passed"]);

            // Prob = 0.5, entropy = 0.3 -> 0.3 < 0.5 -> fail
            const sim2 = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0.3]), 0.5);
            const result2 = await sim2.runTasks([
                {
                    name: "task1",
                    f: async (task: SimulationTask) => {
                        await task.failpoint("fp1");
                        return "passed";
                    },
                },
            ]);
            assert.ok(result2.isErr());
        });

        it("failpoint failure aborts run while other tasks are parked", async () => {
            // A parks at checkpoint, B hits a failing failpoint.
            // Entropy:
            //   1. START pick from [A, B] (2): 0 -> A
            //   2. A checkpoints, pick from [A, B]: 0.999 -> B
            //   3. B failpoint fail decision: 0.3 < 0.5 -> fail
            const order: string[] = [];
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0, 0.999, 0.3]), 0.5);
            const result = await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        await task.checkpoint("parked");
                        order.push("A-continued");
                        return "a";
                    },
                },
                {
                    name: "B",
                    f: async (task: SimulationTask) => {
                        await task.failpoint("critical-op");
                        order.push("B-continued");
                        return "b";
                    },
                },
            ]);

            assert.ok(result.isErr());
            assert.ok(isApplicationFailure(result.error));
            // A should not have continued past its checkpoint
            assert.deepStrictEqual(order, []);
        });

        it("failpoint forwards decorated name to entropy source", async () => {
            // Entropy: 1 for fail decision
            const spy = new SpyEntropySource([0.9]);
            const sim = new SimulationImpl(new ArrayLogger(), spy, 0.5);
            const result = await sim.runTasks([
                {
                    name: "myTask",
                    f: async (task: SimulationTask) => {
                        await task.failpoint("my-failpoint");
                        return "ok";
                    },
                },
            ]);
            assert.ok(result.isOk());
            const fpCall = spy.calledNames.find((n) => n.includes("my-failpoint"));
            assert.ok(fpCall, "should forward failpoint name to entropy source");
            assert.ok(fpCall.includes("myTask"), "should include task name in entropy reason");
        });

        it("successful failpoint acts as a scheduling point", async () => {
            // Entropy:
            //   1. START pick from [A, B]: 0 -> A
            //   2. A's failpoint fail decision: 0.9 >= 0.5 -> pass
            //   3. Failpoint scheduling pick from [A, B]: 0.999 -> B
            // B runs before A continues, proving failpoint yields control
            const order: string[] = [];
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0, 0.9, 0.999]), 0.5);
            const result = await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        await task.failpoint("fp");
                        order.push("A-after-fp");
                        return "a";
                    },
                },
                {
                    name: "B",
                    f: async () => {
                        order.push("B-ran");
                        return "b";
                    },
                },
            ]);

            assert.ok(result.isOk());
            // B ran before A continued after the failpoint
            assert.deepStrictEqual(order, ["B-ran", "A-after-fp"]);
        });
    });

    describe("error handling", () => {
        it("task throwing a regular error returns err", async () => {
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([]), 0);
            const result = await sim.runTasks([
                {
                    name: "task1",
                    f: async () => { throw new Error("boom"); },
                },
            ]);
            assert.ok(result.isErr());
            assert.strictEqual(result.error.message, "boom");
        });

        it("abortSimulation returns err", async () => {
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([]), 0);
            const result = await sim.runTasks([
                {
                    name: "task1",
                    f: async (task: SimulationTask) => {
                        task.abortSimulation(new Error("aborted"));
                    },
                },
            ]);
            assert.ok(result.isErr());
            assert.strictEqual(result.error.message, "aborted");
        });

        it("abort with tasks parked at checkpoint and blockpoint", async () => {
            // 3 tasks: A parks at checkpoint, B parks at blockpoint, C throws.
            // Entropy:
            //   1. START pick from [A, B, C] (3 items): 0 -> A
            //   2. A checkpoints, pick from [A, B, C]: 0.5 -> floor(0.5*3)=1 -> B
            //   3. B blockpoints, pick from [A, C] (2 items): 0.999 -> C
            const order: string[] = [];
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0, 0.5, 0.999]), 0);
            const result = await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        await task.checkpoint("parked");
                        order.push("A-continued");
                        return "a";
                    },
                },
                {
                    name: "B",
                    f: async (task: SimulationTask) => {
                        task.blockpoint("parked");
                        await new Promise<void>(() => {});
                        order.push("B-continued");
                    },
                },
                {
                    name: "C",
                    f: async () => {
                        order.push("C-ran");
                        throw new Error("abort-test");
                    },
                },
            ]);

            assert.ok(result.isErr());
            assert.strictEqual(result.error.message, "abort-test");
            // Neither A (at checkpoint) nor B (at blockpoint) should have continued
            assert.deepStrictEqual(order, ["C-ran"]);
        });
    });

    describe("deadlock detection", () => {
        it("all tasks blocked produces an error", async () => {
            // Entropy: pick first task from [A, B] at START
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0]), 0);
            const result = await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        task.blockpoint("blocked");
                        await new Promise<void>(() => {});
                    },
                },
                {
                    name: "B",
                    f: async (task: SimulationTask) => {
                        task.blockpoint("blocked");
                        await new Promise<void>(() => {});
                    },
                },
            ]);
            // The only possible error source in this setup is deadlock
            assert.ok(result.isErr());
        });
    });

    describe("instance reuse", () => {
        it("SimulationImpl can be reused after a successful run", async () => {
            // Single-task runs need no entropy (sample short-circuits for 1 item)
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([]), 0);

            const r1 = await sim.runTasks([
                { name: "first", f: async () => 1 },
            ]);
            assert.ok(r1.isOk());
            assert.deepStrictEqual(r1.value, [1]);

            const r2 = await sim.runTasks([
                { name: "second", f: async () => 2 },
            ]);
            assert.ok(r2.isOk(), "reused SimulationImpl after success should work");
            assert.deepStrictEqual(r2.value, [2]);
        });

        // Documents current behavior: abortedWithError is never reset, so the
        // instance is permanently poisoned. This may be a bug rather than a
        // contract — the test exists to prevent silent behavior changes.
        it("SimulationImpl is poisoned after a failed run", async () => {
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([]), 0);

            const r1 = await sim.runTasks([
                { name: "fail", f: async () => { throw new Error("boom"); } },
            ]);
            assert.ok(r1.isErr());

            // Second run on same instance: trivial success task still gets the old error
            const r2 = await sim.runTasks([
                { name: "ok", f: async () => 42 },
            ]);
            assert.ok(r2.isErr(), "reused SimulationImpl should still be poisoned");
        });

        // Same as above: documents current poisoning behavior after deadlock.
        it("SimulationImpl is poisoned after deadlock", async () => {
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0]), 0);

            const r1 = await sim.runTasks([
                {
                    name: "A",
                    f: async (task: SimulationTask) => {
                        task.blockpoint("blocked");
                        await new Promise<void>(() => {});
                    },
                },
                {
                    name: "B",
                    f: async (task: SimulationTask) => {
                        task.blockpoint("blocked");
                        await new Promise<void>(() => {});
                    },
                },
            ]);
            assert.ok(r1.isErr());

            // Reuse after deadlock: also poisoned
            const r2 = await sim.runTasks([
                { name: "ok", f: async () => 42 },
            ]);
            assert.ok(r2.isErr(), "reused SimulationImpl after deadlock should still be poisoned");
        });
    });

    describe("task lifecycle", () => {
        it("completed task is excluded from subsequent scheduling", async () => {
            // 3 tasks: A finishes immediately, then B and C each have a checkpoint.
            // After A finishes, only B and C remain in the pool.
            //
            // Key: entropy 0.5 disambiguates pool size.
            //   floor(0.5 * 3) = 1 (picks B from [A,B,C])
            //   floor(0.5 * 2) = 1 (picks C from [B,C])
            // If A were still in the pool, B would be picked. Since A is removed, C is picked.
            //
            // Entropy trace:
            //   1. START pick from [A, B, C] (3): 0 -> A. A finishes immediately.
            //   2. After A removed, pick from [B, C] (2): 0.5 -> index 1 -> C
            //   3. C resolves START, runs, hits C-cp. Pick from [B, C] (2): 0.999 -> C
            //   4. C resolves C-cp, pushes "C", finishes. Only B left (auto-resolved).
            //   5. B resolves START, runs, hits B-cp. 1 item, auto-resolved.
            //   6. B resolves B-cp, pushes "B", finishes.
            const order: string[] = [];
            const sim = new SimulationImpl(new ArrayLogger(), new FixedEntropySource([0, 0.5, 0.999]), 0);
            const result = await sim.runTasks([
                { name: "A", f: async () => { order.push("A"); return "a"; } },
                {
                    name: "B",
                    f: async (task: SimulationTask) => {
                        await task.checkpoint("B-cp");
                        order.push("B");
                        return "b";
                    },
                },
                {
                    name: "C",
                    f: async (task: SimulationTask) => {
                        await task.checkpoint("C-cp");
                        order.push("C");
                        return "c";
                    },
                },
            ]);

            assert.ok(result.isOk());
            assert.deepStrictEqual(result.value, ["a", "b", "c"]);
            // C picked before B proves A was removed (see entropy trace above)
            assert.deepStrictEqual(order, ["A", "C", "B"]);
        });

        it("task.random() delegates to simulation entropy with decorated name", async () => {
            // Entropy: 1 for scheduling (START pick), 1 for task.random()
            const spy = new SpyEntropySource([0, 0.42]);
            const sim = new SimulationImpl(new ArrayLogger(), spy, 0);
            let randomValue = 0;
            const result = await sim.runTasks([
                {
                    name: "task1",
                    f: async (task: SimulationTask) => {
                        randomValue = task.random("my-reason");
                        return "done";
                    },
                },
                // Second task so we consume entropy for scheduling
                { name: "task2", f: async () => "ok" },
            ]);
            assert.ok(result.isOk());
            assert.strictEqual(randomValue, 0.42);
            // Verify the name was forwarded with task-name decoration
            const randomCall = spy.calledNames.find((n) => n.includes("my-reason"));
            assert.ok(randomCall, "should forward reason to entropy source");
            assert.ok(randomCall.includes("task1"), "should include task name in entropy reason");
        });
    });
});
