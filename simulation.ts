import { assert, exceptionToError, exceptionToString } from "@glideapps/ts-necessities";
import { type EntropySource, sample } from "./entropy.ts";
import { ApplicationFailure } from "./errors.ts";
import { err, ok, type Result } from "neverthrow";

export interface Logger {
    log(...log: readonly unknown[]): void;
    error(...log: readonly unknown[]): void;
}

export interface SimulationTask extends Logger, EntropySource {
    checkpoint(...log: readonly unknown[]): Promise<void>;
    failpoint(...log: readonly unknown[]): Promise<void>;
    blockpoint(...log: readonly unknown[]): void;

    abortSimulation(e: unknown): never;
}

export interface TaskSpec<T> {
    readonly name: string;
    readonly f: (task: SimulationTask) => Promise<T>;
}

export interface Simulation {
    runTasks<TSpecs extends readonly TaskSpec<any>[]>(
        specs: TSpecs,
    ): Promise<
        Result<
            {
                [K in keyof TSpecs]: TSpecs[K] extends TaskSpec<infer R> ? R : never;
            },
            Error
        >
    >;
}

export class NoSimulationTask implements SimulationTask {
    private readonly taskName: string;
    private readonly shouldLog: boolean;

    constructor(taskName: string, shouldLog: boolean) {
        this.taskName = taskName;
        this.shouldLog = shouldLog;
    }

    public log(...log: readonly unknown[]): void {
        if (this.shouldLog) {
            console.log(`${this.taskName}: `, ...log);
        }
    }

    public error(...log: readonly unknown[]): void {
        console.error(`${this.taskName}: `, ...log);
    }

    public random(): number {
        return Math.random();
    }

    public checkpoint(...log: readonly unknown[]): Promise<void> {
        this.log(...log);
        return Promise.resolve();
    }

    public failpoint(...log: readonly unknown[]): Promise<void> {
        this.log(...log);
        return Promise.resolve();
    }

    public blockpoint(...log: readonly unknown[]): void {
        this.log(...log);
    }

    public abortSimulation(e: unknown): never {
        throw exceptionToError(e);
    }
}

class NoSimulation implements Simulation {
    private readonly log: boolean;

    constructor(log: boolean) {
        this.log = log;
    }

    public async runTasks<TSpecs extends readonly TaskSpec<any>[]>(
        specs: TSpecs,
    ): Promise<
        Result<
            {
                [K in keyof TSpecs]: TSpecs[K] extends TaskSpec<infer R> ? R : never;
            },
            Error
        >
    > {
        const shouldLog = this.log;
        try {
            const results = (await Promise.all(
                specs.map(({ name: taskName, f }) => {
                    const task = new NoSimulationTask(taskName, shouldLog);
                    return f(task);
                }),
            )) as {
                [K in keyof TSpecs]: TSpecs[K] extends TaskSpec<infer R> ? R : never;
            };
            return ok(results);
        } catch (e: unknown) {
            return err(exceptionToError(e));
        }
    }
}

export const noSimulation = new NoSimulation(false);

interface TaskInfo {
    readonly name: string;
    /**
     * If this is
     * - a function, then the task is at a checkpoint, and the function
     *   is its `resolve` continuation.
     * - `undefined`, then the task is currently running.
     * - `false`, then the task is blocked and waiting on some other task.
     */
    resolve: (() => void) | undefined | false;
}

export class SimulationImpl implements Simulation {
    private readonly logger: Logger;
    private readonly entropy: EntropySource;
    private readonly failureProbability: number;
    // FIXME: Should this just be a `TaskInfo[]`, since we never look at the task anyway?
    private readonly taskInfos = new Map<SimulationTask, TaskInfo>();
    private abortedWithError: unknown;

    constructor(logger: Logger, entropy: EntropySource, failureProbability: number) {
        this.logger = logger;
        this.entropy = entropy;
        this.failureProbability = failureProbability;
    }

    private abort(e: unknown): never {
        if (this.abortedWithError === undefined) {
            this.abortedWithError = e;
            this.logger.error(`Aborting simulation: ${exceptionToString(e)}`);
        }
        throw e;
    }

    private pickTask(tasks: readonly TaskInfo[]): TaskInfo {
        const task = sample(this.entropy, `Picking task out of ${tasks.map((t) => t.name).join(", ")}`, tasks);
        assert(task !== undefined, "No tasks to pick from");
        return task;
    }

    private unlockIfNecessary(): void {
        if (this.abortedWithError !== undefined) throw this.abortedWithError;

        if (this.taskInfos.size === 0) return;

        const entries = Array.from(this.taskInfos.entries());
        if (entries.some(([, i]) => i.resolve === undefined)) {
            // Some tasks are still runing, so there's nothing to do yet.
            return;
        }
        const checkpointEntries = entries.filter(([, i]) => i.resolve !== undefined && i.resolve !== false);
        assert(checkpointEntries.length > 0, "All tasks are blocked");
        const info = this.pickTask(checkpointEntries.map(([, i]) => i));
        this.logger.log(`${info.name} UNBLOCKED from ${entries.map(([, i]) => i.name).join(", ")}`);
        const { resolve } = info;
        assert(resolve !== undefined && resolve !== false);
        info.resolve = undefined;
        resolve();
    }

    public async runTasks<TSpecs extends readonly TaskSpec<any>[]>(
        specs: TSpecs,
    ): Promise<
        Result<
            {
                [K in keyof TSpecs]: TSpecs[K] extends TaskSpec<infer R> ? R : never;
            },
            Error
        >
    > {
        const simulation = this;

        const tasksAndInfos = specs.map((s) => {
            const info: TaskInfo = { name: s.name, resolve: undefined };
            const task: SimulationTask = {
                random(name: string): number {
                    const r = simulation.entropy.random(`${s.name} random number: ${name}`);
                    simulation.logger.log(`${s.name} RANDOM ${name}: ${r}`);
                    return r;
                },
                log(...log: readonly unknown[]): void {
                    simulation.logger.log(`${s.name}:`, ...log);
                },
                error(...log: readonly unknown[]): void {
                    simulation.logger.error(`${s.name}:`, ...log);
                },
                checkpoint(...log: readonly unknown[]): Promise<void> {
                    simulation.logger.log(`${s.name} CHECKPOINT:`, ...log);
                    assert(
                        simulation.taskInfos.has(task),
                        `Task ${s.name} wants to checkpoint, but doesn't exist anymore`,
                    );
                    const promise = new Promise<void>((resolve) => {
                        assert(info.resolve === undefined || info.resolve === false);
                        info.resolve = resolve;
                    });
                    simulation.unlockIfNecessary();
                    return promise;
                },
                failpoint(...log: readonly unknown[]): Promise<void> {
                    assert(
                        simulation.taskInfos.has(task),
                        `Task ${s.name} wants to failpoint, but doesn't exist anymore`,
                    );

                    const shouldFail =
                        simulation.failureProbability > 0 &&
                        simulation.entropy.random(`${s.name} failpoint: ${log.join(" ")}`) <
                            simulation.failureProbability;
                    if (shouldFail) {
                        simulation.logger.log(`${s.name} FAILING:`, ...log);
                        return Promise.reject(
                            new ApplicationFailure(`Simulated failure at failpoint: ${log.join(" ")}`),
                        );
                    }

                    simulation.logger.log(`${s.name} FAILPOINT:`, ...log);
                    const promise = new Promise<void>((resolve) => {
                        assert(
                            info.resolve === undefined || info.resolve === false,
                            `Task ${s.name} already has a resolve`,
                        );
                        info.resolve = resolve;
                    });
                    simulation.unlockIfNecessary();
                    return promise;
                },
                blockpoint(...log: readonly unknown[]): void {
                    simulation.logger.log(`${s.name} BLOCKPOINT:`, ...log);
                    assert(simulation.taskInfos.has(task));
                    assert(info.resolve === undefined, `Task ${s.name} already has a resolve`);
                    info.resolve = false;
                    simulation.unlockIfNecessary();
                },
                abortSimulation(e): never {
                    return simulation.abort(e);
                },
            };
            return [s, task, info] as const;
        });
        // We do this separately so that none of the promises started
        // before all the `taskInfos` are set up.
        for (const [, task, info] of tasksAndInfos) {
            this.taskInfos.set(task, info);
        }

        try {
            const results = (await Promise.all(
                tasksAndInfos.map(([s, task]) => {
                    return task
                        .checkpoint("START")
                        .then(() => s.f(task))
                        .catch((e) => this.abort(e))
                        .finally(() => {
                            this.taskInfos.delete(task);
                            this.logger.log(
                                `FINISHED ${s.name}, still left ${Array.from(this.taskInfos.values())
                                    .map((i) => i.name)
                                    .join(", ")}`,
                            );
                            this.unlockIfNecessary();
                        });
                }),
            )) as any; // I wish we could type this better
            return ok(results);
        } catch (e: unknown) {
            return err(exceptionToError(e));
        }
    }
}
