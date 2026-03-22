import { assert, defined } from "@glideapps/ts-necessities";
import type { SimulationTask } from "./simulation.ts";

export class Mutex {
    /** This is `undefined` iff the mutex is unlocked.  Otherwise it's an array of resolve functions, one for each waiter. */
    private waiters: (() => void)[] | undefined;
    private readonly name: string;

    constructor(name: string) {
        this.name = name;
    }

    public get isLocked(): boolean {
        return this.waiters !== undefined;
    }

    public lock(task: SimulationTask, reason: string): Promise<void> {
        if (this.waiters === undefined) {
            task.log(`mutex "${this.name}" locked unopposed for "${reason}"`);
            this.waiters = [];
            return Promise.resolve();
        } else {
            task.blockpoint(`mutex "${this.name}" enqueue for "${reason}", ${this.waiters.length} other waiters`);
            const p = new Promise<void>((resolve) => {
                defined(this.waiters, "Promise init function did not run inline").push(async () => {
                    await task.checkpoint(
                        `mutex "${this.name}" acquired by waiter for "${reason}", ${defined(this.waiters).length} other waiters`,
                    );
                    resolve();
                });
            });
            return p;
        }
    }

    public unlock(task: SimulationTask, reason: string): void {
        assert(this.waiters !== undefined, "Can't unlock a mutex that's not locked");
        const resolve = this.waiters.shift();
        if (resolve !== undefined) {
            // Give the mutex to the first waiter
            task.log(
                `mutex "${this.name}" unlocked and passed to next waiter for "${reason}", ${this.waiters.length} waiters left`,
            );
            resolve();
        } else {
            // No waiters left, so unlock
            task.log(`mutex "${this.name}" unlocked for "${reason}"`);
            this.waiters = undefined;
        }
    }
}
