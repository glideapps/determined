import { describe, it } from "node:test";
import assert from "node:assert";
import { Mutex } from "./mutex.ts";
import { NoSimulationTask } from "./simulation.ts";

const noTask = new NoSimulationTask("test", false);

// Helper to assert a promise is still pending
const assertIsPending = async (promise: Promise<any>) => {
    let isPending = true;
    promise.finally(() => {
        isPending = false;
    });
    // Give the promise a chance to resolve if it's not pending
    await Promise.resolve();
    assert.strictEqual(isPending, true, "Promise was expected to be pending, but it resolved");
};

// Helper to assert a promise has resolved
const assertIsResolved = async (promise: Promise<any>) => {
    let isResolved = false;
    promise.finally(() => {
        isResolved = true;
    });
    // Give the promise a chance to resolve
    await Promise.resolve();
    assert.strictEqual(isResolved, true, "Promise was expected to be resolved, but it's still pending");
};

describe("Mutex", () => {
    it("should immediately acquire lock when unlocked", async () => {
        const mutex = new Mutex("test");
        const lock = mutex.lock(noTask, "test");

        // Should resolve immediately
        await assertIsResolved(lock);

        mutex.unlock(noTask, "test");
    });

    it("should make a waiter wait until the lock is released", async () => {
        const mutex = new Mutex("test");

        // Acquire the lock
        await mutex.lock(noTask, "test");

        // Start a second task that tries to acquire the lock
        const waiter = mutex.lock(noTask, "test");

        // Assert that the second task is, in fact, waiting
        await assertIsPending(waiter);

        // Release the lock
        mutex.unlock(noTask, "test");

        // Now the waiter should resolve and acquire the lock
        await waiter;

        // Cleanup
        mutex.unlock(noTask, "test");
    });

    it("should serve multiple waiters in FIFO order", async () => {
        const mutex = new Mutex("test");
        const order: number[] = [];

        // Acquire the lock
        await mutex.lock(noTask, "test");

        // Queue up multiple waiters
        const waiter1 = mutex.lock(noTask, "test").then(() => {
            order.push(1);
        });

        const waiter2 = mutex.lock(noTask, "test").then(() => {
            order.push(2);
        });

        const waiter3 = mutex.lock(noTask, "test").then(() => {
            order.push(3);
        });

        // Verify all are waiting
        await assertIsPending(waiter1);
        await assertIsPending(waiter2);
        await assertIsPending(waiter3);

        // Release the lock - this should give it to waiter1
        mutex.unlock(noTask, "test");
        await waiter1;

        // Waiter1 got the lock, release it for waiter2
        mutex.unlock(noTask, "test");
        await waiter2;

        // Waiter2 got the lock, release it for waiter3
        mutex.unlock(noTask, "test");
        await waiter3;

        // All done, release the final lock
        mutex.unlock(noTask, "test");

        // Verify FIFO order
        assert.deepStrictEqual(order, [1, 2, 3], "Waiters should be served in FIFO order");
    });

    it("should throw when unlocking an unlocked mutex", () => {
        const mutex = new Mutex("test");

        assert.throws(
            () => mutex.unlock(noTask, "test"),
            /Can't unlock a mutex that's not locked/,
            "Should throw when unlocking an unlocked mutex",
        );
    });

    it("should handle concurrent operations correctly", async () => {
        const mutex = new Mutex("test");
        const results: number[] = [];

        const task = async (id: number) => {
            await mutex.lock(noTask, "test");

            // Simulate some async work
            const currentLength = results.length;
            await new Promise((resolve) => setImmediate(resolve));
            results.push(id);

            // Verify no other task interfered
            assert.strictEqual(
                results.length,
                currentLength + 1,
                `Task ${id}: No other task should have modified results while locked`,
            );

            mutex.unlock(noTask, "test");
        };

        // Run 10 tasks concurrently
        await Promise.all([task(1), task(2), task(3), task(4), task(5), task(6), task(7), task(8), task(9), task(10)]);

        // All tasks should have completed
        assert.strictEqual(results.length, 10, "All tasks should have completed");
    });

    it("should prevent race conditions on shared resources", async () => {
        const mutex = new Mutex("test");
        let sharedResource = 0;

        const incrementer = async () => {
            await mutex.lock(noTask, "test");
            const current = sharedResource;

            // Simulate async delay where race condition would occur
            await new Promise((resolve) => setTimeout(resolve, 10));

            sharedResource = current + 1;
            mutex.unlock(noTask, "test");
        };

        // Run 20 concurrent incrementers
        await Promise.all(Array.from({ length: 20 }, () => incrementer()));

        // If mutex works correctly, we should have exactly 20 increments
        assert.strictEqual(sharedResource, 20, "Mutex should prevent race conditions on shared resource");
    });
});
