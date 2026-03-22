import type { Logger } from "./simulation.ts";
import type { EntropySource } from "./entropy.ts";

export class ArrayLogger implements Logger {
    readonly logs: string[] = [];
    readonly errors: string[] = [];
    log(...args: readonly unknown[]): void {
        this.logs.push(args.map(String).join(" "));
    }
    error(...args: readonly unknown[]): void {
        this.errors.push(args.map(String).join(" "));
    }
}

export class FixedEntropySource implements EntropySource {
    private readonly values: number[];
    private index = 0;
    constructor(values: number[]) {
        this.values = values;
    }
    random(): number {
        const v = this.values[this.index];
        if (v === undefined) throw new Error(`FixedEntropySource exhausted at index ${this.index}`);
        this.index++;
        return v;
    }
}

/** Like FixedEntropySource but also records the names passed to random(). */
export class SpyEntropySource implements EntropySource {
    readonly calledNames: string[] = [];
    private readonly values: number[];
    private index = 0;
    constructor(values: number[]) {
        this.values = values;
    }
    random(name: string): number {
        this.calledNames.push(name);
        const v = this.values[this.index];
        if (v === undefined) throw new Error(`SpyEntropySource exhausted at index ${this.index}`);
        this.index++;
        return v;
    }
}
