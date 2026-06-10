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

/**
 * Like FixedEntropySource, but throws exactly once, at the given draw index,
 * then continues serving the fixed values. Models a DST resource guard that
 * throws from random() and recovers (e.g. a transient guard trip). Draws that
 * throw do not consume a value.
 */
export class ThrowOnceEntropySource implements EntropySource {
    private readonly values: number[];
    private readonly throwAtDraw: number;
    private draw = 0;
    private valueIndex = 0;
    constructor(values: number[], throwAtDraw: number) {
        this.values = values;
        this.throwAtDraw = throwAtDraw;
    }
    random(): number {
        const draw = this.draw;
        this.draw++;
        if (draw === this.throwAtDraw) throw new Error("entropy guard trip");
        const v = this.values[this.valueIndex];
        if (v === undefined) throw new Error(`ThrowOnceEntropySource exhausted at draw ${draw}`);
        this.valueIndex++;
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
