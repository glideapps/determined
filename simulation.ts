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

    /** Current monotonic time in milliseconds. Virtual in simulation, real in production. */
    monotonicNow(): number;
    /** Current wall-clock time in milliseconds, comparable to `Date.now()`. */
    wallNow(): number;
    /**
     * Blocks until monotonic time reaches at least `now + durationMs`. The
     * duration is a lower bound: in simulation the timer fires at an
     * entropy-chosen point at or after the deadline, so a longer sleep may
     * complete before a shorter one. Negative or non-finite durations throw
     * a `TypeError`.
     */
    sleep(durationMs: number, reason: string): Promise<void>;

    abortSimulation(e: unknown): never;
}

export interface SimulationOptions {
    /**
     * The wall-clock time at virtual monotonic time 0, in milliseconds since
     * the Unix epoch. Defaults to 0.
     */
    readonly wallClockEpoch?: number;
}

function validateSleepDuration(durationMs: number, reason: string): void {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
        // The stricter precedent of `AbortSignal.timeout`, which throws a
        // `TypeError` on negative durations — `setTimeout` would silently
        // clamp them to zero, and only in production.
        throw new TypeError(`Sleep duration must be a finite non-negative number, got ${durationMs} for "${reason}"`);
    }
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

    public monotonicNow(): number {
        return performance.now();
    }

    public wallNow(): number {
        return Date.now();
    }

    public sleep(durationMs: number, reason: string): Promise<void> {
        validateSleepDuration(durationMs, reason);
        this.log(`sleep "${reason}" for ${durationMs}ms`);
        return new Promise((resolve) => setTimeout(resolve, durationMs));
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
    /** Why the task is blocked, for deadlock reports. Only meaningful while `resolve` is `false`. */
    parkReason: string | undefined;
}

interface PendingTimer {
    readonly id: number;
    /** Task-decorated reason, e.g. `myTask sleep: retry backoff`. */
    readonly reason: string;
    /** Absolute virtual monotonic deadline in milliseconds — a lower bound on the firing time. */
    readonly deadline: number;
    /**
     * Runs synchronously when the timer fires, with the clock already
     * advanced. Must only flip scheduler bookkeeping (e.g. make a sleeping
     * task schedulable) — no task code runs inside it.
     */
    readonly fire: () => void;
}

export class SimulationImpl implements Simulation {
    private readonly logger: Logger;
    private readonly entropy: EntropySource;
    private readonly failpointFailureProbability: (...log: readonly unknown[]) => number;
    private readonly wallClockEpoch: number;
    // FIXME: Should this just be a `TaskInfo[]`, since we never look at the task anyway?
    private readonly taskInfos = new Map<SimulationTask, TaskInfo>();
    private abortedWithError: unknown;
    /** Virtual monotonic time in milliseconds. Reset per `runTasks` call. */
    private monotonic = 0;
    private readonly timers = new Map<number, PendingTimer>();
    private nextTimerId = 1;

    constructor(
        logger: Logger,
        entropy: EntropySource,
        failpointFailureProbability: (...log: readonly unknown[]) => number,
        options: SimulationOptions = {},
    ) {
        this.logger = logger;
        this.entropy = entropy;
        this.failpointFailureProbability = failpointFailureProbability;
        this.wallClockEpoch = options.wallClockEpoch ?? 0;
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

    /**
     * Runs `unlockIfNecessary` on behalf of a task that has just parked
     * (registered its `resolve` at a checkpoint/failpoint/blockpoint).
     * `unlockIfNecessary` can throw — the entropy source may throw from the
     * scheduling pick (DST resource guards like draw budgets do this), and an
     * aborted simulation rethrows its abort error. Such a throw propagates
     * synchronously out of the park call into the parking task, which is
     * therefore NOT parked — it is running its error path. Its just-registered
     * `resolve` must be deregistered, otherwise the bookkeeping is corrupted:
     * the next park trips `assert(info.resolve === undefined)` ("Task X
     * already has a resolve"), and a wake-up meant for a live task can be
     * delivered to the abandoned promise instead.
     */
    private unlockIfNecessaryAfterPark(info: TaskInfo, cleanup?: () => void): void {
        try {
            this.unlockIfNecessary();
        } catch (e) {
            info.resolve = undefined;
            info.parkReason = undefined;
            cleanup?.();
            throw e;
        }
    }

    private registerTimer(reason: string, deadline: number, fire: () => void): number {
        const id = this.nextTimerId++;
        this.timers.set(id, { id, reason, deadline, fire });
        this.logger.log(`TIMER '${reason}' created at t=${this.monotonic}ms with deadline t=${deadline}ms`);
        return id;
    }

    /**
     * Fires an entropy-chosen pending timer. Any pending timer may fire —
     * deadlines are only lower bounds, so a later-deadline timer may fire
     * before an earlier one. The clock advances to `max(now, deadline)`,
     * which keeps virtual time monotonic even for late firings.
     */
    private fireNextTimer(): void {
        const timers = Array.from(this.timers.values());
        const timer = sample(this.entropy, `Picking timer out of ${timers.map((t) => t.reason).join(", ")}`, timers);
        assert(timer !== undefined, "No timers to pick from");
        this.timers.delete(timer.id);
        this.monotonic = Math.max(this.monotonic, timer.deadline);
        this.logger.log(`TIMER '${timer.reason}' fired at t=${this.monotonic}ms (deadline t=${timer.deadline}ms)`);
        timer.fire();
    }

    private makeDeadlockError(infos: readonly TaskInfo[]): Error {
        const blocked = infos
            .map((i) => `${i.name}${i.parkReason !== undefined ? ` (${i.parkReason})` : ""}`)
            .join(", ");
        return new Error(
            `Deadlock at t=${this.monotonic}ms: all tasks are blocked and no timers are pending. Blocked tasks: ${blocked}`,
        );
    }

    private unlockIfNecessary(): void {
        if (this.abortedWithError !== undefined) throw this.abortedWithError;

        if (this.taskInfos.size === 0) return;

        const infos = Array.from(this.taskInfos.values());
        if (infos.some((i) => i.resolve === undefined)) {
            // Some tasks are still running, so there's nothing to do yet.
            return;
        }
        const checkpointed = () => infos.filter((i) => i.resolve !== undefined && i.resolve !== false);
        let candidates = checkpointed();
        while (candidates.length === 0) {
            // No task is runnable. If timers are pending, one of them fires
            // and virtual time advances — the simulation must never advance
            // time while runnable tasks exist, and must never deadlock while
            // a timer could still wake somebody.
            if (this.timers.size === 0) {
                throw this.makeDeadlockError(infos);
            }
            this.fireNextTimer();
            candidates = checkpointed();
        }
        const info = this.pickTask(candidates);
        this.logger.log(`${info.name} UNBLOCKED at t=${this.monotonic}ms from ${infos.map((i) => i.name).join(", ")}`);
        const { resolve } = info;
        assert(resolve !== undefined && resolve !== false);
        info.resolve = undefined;
        info.parkReason = undefined;
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

        // Timer and clock state is per-run: a fresh `runTasks` on a reused
        // instance must not observe timers or virtual time from an earlier
        // run.
        this.monotonic = 0;
        this.timers.clear();
        this.nextTimerId = 1;

        const tasksAndInfos = specs.map((s) => {
            const info: TaskInfo = { name: s.name, resolve: undefined, parkReason: undefined };
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
                        info.parkReason = undefined;
                    });
                    simulation.unlockIfNecessaryAfterPark(info);
                    return promise;
                },
                failpoint(...log: readonly unknown[]): Promise<void> {
                    assert(
                        simulation.taskInfos.has(task),
                        `Task ${s.name} wants to failpoint, but doesn't exist anymore`,
                    );

                    const failureProbability = simulation.failpointFailureProbability(...log);
                    assert(
                        failureProbability >= 0 && failureProbability <= 1,
                        "failpointFailureProbability must return a value between 0 and 1",
                    );
                    const shouldFail =
                        failureProbability > 0 &&
                        simulation.entropy.random(`${s.name} failpoint: ${log.join(" ")}`) < failureProbability;
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
                        info.parkReason = undefined;
                    });
                    simulation.unlockIfNecessaryAfterPark(info);
                    return promise;
                },
                blockpoint(...log: readonly unknown[]): void {
                    simulation.logger.log(`${s.name} BLOCKPOINT:`, ...log);
                    assert(simulation.taskInfos.has(task));
                    assert(info.resolve === undefined, `Task ${s.name} already has a resolve`);
                    info.resolve = false;
                    info.parkReason = log.map(String).join(" ");
                    simulation.unlockIfNecessaryAfterPark(info);
                },
                monotonicNow(): number {
                    return simulation.monotonic;
                },
                wallNow(): number {
                    return simulation.wallClockEpoch + simulation.monotonic;
                },
                sleep(durationMs: number, reason: string): Promise<void> {
                    validateSleepDuration(durationMs, reason);
                    assert(simulation.taskInfos.has(task), `Task ${s.name} wants to sleep, but doesn't exist anymore`);
                    const deadline = simulation.monotonic + durationMs;
                    simulation.logger.log(
                        `${s.name} SLEEP '${reason}' at t=${simulation.monotonic}ms for ${durationMs}ms until t=${deadline}ms`,
                    );
                    let timerId: number | undefined;
                    const promise = new Promise<void>((resolve) => {
                        assert(info.resolve === undefined, `Task ${s.name} already has a resolve`);
                        // The task sleeps in its single park slot: blocked
                        // like a blockpoint, woken by exactly one timer. The
                        // timer's `fire` flips the slot to a schedulable
                        // continuation; the scheduler then picks the task
                        // like any other checkpointed one.
                        info.resolve = false;
                        info.parkReason = `sleeping '${reason}' until t=${deadline}ms`;
                        timerId = simulation.registerTimer(`${s.name} sleep: ${reason}`, deadline, () => {
                            info.parkReason = undefined;
                            info.resolve = resolve;
                        });
                    });
                    // Exception safety: a synchronous throw out of the
                    // scheduling that follows the park (entropy guard, abort)
                    // means the task is NOT sleeping — it is running its
                    // error path. Both the park slot and the just-registered
                    // timer must be rolled back, otherwise the timer would
                    // later ghost-wake a task that isn't parked.
                    simulation.unlockIfNecessaryAfterPark(info, () => {
                        if (timerId !== undefined) simulation.timers.delete(timerId);
                    });
                    return promise;
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
            // A synchronous throw out of a START checkpoint (e.g. an entropy
            // guard tripping during the scheduling pick) propagates out of the
            // `.map()` above, bypassing the per-task abort handler. The failed
            // run's tasks then stay in `taskInfos` forever (their `.finally`
            // cleanup never runs), so the instance must be poisoned like any
            // other failed run — otherwise a later `runTasks` would deadlock
            // waiting on the thrower's "still running" entry, or ghost-wake a
            // parked task from the failed run.
            if (this.abortedWithError === undefined) {
                this.abortedWithError = e;
            }
            return err(exceptionToError(e));
        }
    }
}
