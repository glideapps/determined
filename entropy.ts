export interface EntropySource {
    random(reason: string): number;
}

export class SimpleEntropySource implements EntropySource {
    public random(): number {
        return Math.random();
    }
}

interface EntropyRecord {
    readonly name: string;
    readonly value: number;
}

export class RecordingEntropySource implements EntropySource {
    private readonly underlying: EntropySource;
    private readonly records: EntropyRecord[] = [];

    constructor(underlying: EntropySource) {
        this.underlying = underlying;
    }

    public random(name: string): number {
        const value = this.underlying.random(name);
        this.records.push({ name, value });
        return value;
    }

    public getRecords(): readonly EntropyRecord[] {
        return this.records;
    }
}

export class ReplayingEntropySource implements EntropySource {
    private readonly records: EntropyRecord[];
    private position = 0;

    constructor(records: readonly EntropyRecord[]) {
        this.records = records.slice();
    }

    public random(name: string): number {
        // console.log(`Picking at ${this.position} for ${name}`);
        const record = this.records[this.position];
        if (record === undefined) {
            throw new Error(`No more entropy records available when requesting "${name}"`);
        }
        if (record.name !== name) {
            throw new Error(
                `Entropy record name mismatch at position ${this.position}: expected "${record.name}", got "${name}"`,
            );
        }
        this.position++;
        return record.value;
    }
}

export function sample<T>(entropy: EntropySource, name: string, items: readonly T[]): T | undefined {
    if (items.length < 2) return items[0];
    const index = Math.floor(entropy.random(name) * items.length);
    return items[index];
}
