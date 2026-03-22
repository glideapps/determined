import type { SimulationTask } from "./simulation.ts";

export class ConditionVariable {
    private readonly waiters: (() => void)[] = [];
    private readonly name: string;

    constructor(name: string) {
        this.name = name;
    }

    public wait(task: SimulationTask, reason: string): Promise<void> {
        task.blockpoint(`condition "${this.name}" wait for "${reason}", ${this.waiters.length} other waiters`);
        return new Promise((resolve) => {
            this.waiters.push(async () => {
                await task.checkpoint(`condition "${this.name}" woken up for "${reason}"`);
                resolve();
            });
        });
    }

    public notifyAll(task: SimulationTask, reason: string): void {
        task.log(`condition "${this.name}" notifying ${this.waiters.length} for "${reason}"`);
        for (const resolve of this.waiters) {
            resolve();
        }
        this.waiters.length = 0;
    }
}
