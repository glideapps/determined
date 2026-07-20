import type { EntropySource } from "./entropy.ts";

/**
 * One event in a simulation trace. Timer records are explicit, not derived
 * from entropy: forced choices consume no entropy by design (the `sample()`
 * single-element rule), so a run with a single pending timer — or a single
 * task — leaves no entropy footprint in which a changed reason or deadline
 * could be noticed. The trace is a typed sequence of entropy and timer
 * records, validated in order during replay.
 */
export type TraceRecord =
    | { readonly type: "run-start"; readonly wallClockEpoch: number }
    | { readonly type: "entropy"; readonly name: string; readonly value: number }
    | { readonly type: "timer-create"; readonly id: number; readonly reason: string; readonly deadline: number }
    | { readonly type: "timer-cancel"; readonly id: number; readonly reason: string }
    | { readonly type: "timer-fire"; readonly id: number; readonly reason: string; readonly virtualTime: number };

/**
 * Receives timer events from the simulation. `SimulationImpl` feeds these
 * events to its entropy source iff the source implements this interface —
 * `RecordingTraceSource` records them, `ReplayingTraceSource` validates
 * them. Plain entropy sources keep working, but cannot detect timer
 * divergence.
 */
export interface TimerTraceSink {
    runStart(wallClockEpoch: number): void;
    timerCreated(id: number, reason: string, deadline: number): void;
    timerCancelled(id: number, reason: string): void;
    timerFired(id: number, reason: string, virtualTime: number): void;
}

export function isTimerTraceSink(entropy: EntropySource): entropy is EntropySource & TimerTraceSink {
    const sink = entropy as Partial<TimerTraceSink>;
    return (
        typeof sink.runStart === "function" &&
        typeof sink.timerCreated === "function" &&
        typeof sink.timerCancelled === "function" &&
        typeof sink.timerFired === "function"
    );
}

function describeRecord(record: TraceRecord): string {
    switch (record.type) {
        case "run-start":
            return `run-start (wall-clock epoch ${record.wallClockEpoch})`;
        case "entropy":
            return `entropy "${record.name}"`;
        case "timer-create":
            return `timer-create #${record.id} "${record.reason}" (deadline t=${record.deadline}ms)`;
        case "timer-cancel":
            return `timer-cancel #${record.id} "${record.reason}"`;
        case "timer-fire":
            return `timer-fire #${record.id} "${record.reason}" (at t=${record.virtualTime}ms)`;
    }
}

/** Records a full simulation trace — entropy and timer events — for replay. */
export class RecordingTraceSource implements EntropySource, TimerTraceSink {
    private readonly underlying: EntropySource;
    private readonly records: TraceRecord[] = [];

    constructor(underlying: EntropySource) {
        this.underlying = underlying;
    }

    public random(name: string): number {
        const value = this.underlying.random(name);
        this.records.push({ type: "entropy", name, value });
        return value;
    }

    public runStart(wallClockEpoch: number): void {
        this.records.push({ type: "run-start", wallClockEpoch });
    }

    public timerCreated(id: number, reason: string, deadline: number): void {
        this.records.push({ type: "timer-create", id, reason, deadline });
    }

    public timerCancelled(id: number, reason: string): void {
        this.records.push({ type: "timer-cancel", id, reason });
    }

    public timerFired(id: number, reason: string, virtualTime: number): void {
        this.records.push({ type: "timer-fire", id, reason, virtualTime });
    }

    public getTrace(): readonly TraceRecord[] {
        return this.records;
    }
}

/**
 * Replays a recorded trace, validating every entropy and timer event in
 * order. Throws a descriptive divergence error when the replaying code
 * requests anything other than what was recorded.
 */
export class ReplayingTraceSource implements EntropySource, TimerTraceSink {
    private readonly records: readonly TraceRecord[];
    private position = 0;

    constructor(records: readonly TraceRecord[]) {
        this.records = records.slice();
    }

    private next<T extends TraceRecord["type"]>(type: T, actual: string): Extract<TraceRecord, { type: T }> {
        const record = this.records[this.position];
        if (record === undefined) {
            throw new Error(`Replay trace exhausted at position ${this.position}: the replay produced ${actual}`);
        }
        if (record.type !== type) {
            throw new Error(
                `Replay divergence at position ${this.position}: recorded ${describeRecord(record)}, ` +
                    `but the replay produced ${actual}`,
            );
        }
        this.position++;
        return record as Extract<TraceRecord, { type: T }>;
    }

    private mismatch(record: TraceRecord, actual: string): never {
        throw new Error(
            `Replay divergence at position ${this.position - 1}: recorded ${describeRecord(record)}, ` +
                `but the replay produced ${actual}`,
        );
    }

    public random(name: string): number {
        const record = this.next("entropy", `entropy request "${name}"`);
        if (record.name !== name) this.mismatch(record, `entropy request "${name}"`);
        return record.value;
    }

    public runStart(wallClockEpoch: number): void {
        const record = this.next("run-start", `run-start (wall-clock epoch ${wallClockEpoch})`);
        if (record.wallClockEpoch !== wallClockEpoch) {
            this.mismatch(record, `run-start (wall-clock epoch ${wallClockEpoch})`);
        }
    }

    public timerCreated(id: number, reason: string, deadline: number): void {
        const actual = `timer-create #${id} "${reason}" (deadline t=${deadline}ms)`;
        const record = this.next("timer-create", actual);
        if (record.id !== id || record.reason !== reason || record.deadline !== deadline) {
            this.mismatch(record, actual);
        }
    }

    public timerCancelled(id: number, reason: string): void {
        const actual = `timer-cancel #${id} "${reason}"`;
        const record = this.next("timer-cancel", actual);
        if (record.id !== id || record.reason !== reason) this.mismatch(record, actual);
    }

    public timerFired(id: number, reason: string, virtualTime: number): void {
        const actual = `timer-fire #${id} "${reason}" (at t=${virtualTime}ms)`;
        const record = this.next("timer-fire", actual);
        if (record.id !== id || record.reason !== reason || record.virtualTime !== virtualTime) {
            this.mismatch(record, actual);
        }
    }

    /**
     * Throws if recorded events remain unused — the replaying code did less
     * than the recorded run, which is a divergence just like doing something
     * different.
     */
    public assertFullyConsumed(): void {
        const remaining = this.records.length - this.position;
        if (remaining > 0) {
            const record = this.records[this.position];
            throw new Error(
                `${remaining} recorded trace event(s) remain unused at position ${this.position}` +
                    (record === undefined ? "" : `; next is ${describeRecord(record)}`),
            );
        }
    }
}
