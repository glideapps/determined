import { assert, exceptionToError, exceptionToString } from "@glideapps/ts-necessities";
import { OwnedAbortSignal } from "./abort-signal.ts";
import { type EntropySource, sample } from "./entropy.ts";
import { ApplicationFailure, CancellationError } from "./errors.ts";
import { isTimerTraceSink, type TimerTraceSink } from "./trace.ts";
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
     *
     * Aborting the optional signal removes the pending timer and rejects the
     * sleep with `signal.reason` — the same contract as Node's cancellable
     * `setTimeout` from `timers/promises`. A sleep given an already-aborted
     * signal rejects immediately, registers no timer, and consumes no
     * entropy.
     */
    sleep(durationMs: number, reason: string, options?: SleepOptions): Promise<void>;
    /**
     * Creates a deadline that aborts its signal `durationMs` from now. The
     * signal aborts when the deadline's timer FIRES, which — like any timer —
     * may be later than the nominal deadline. `cancel()` removes the pending
     * timer (idempotent, and a no-op after the signal aborted); callers must
     * cancel when the guarded work completes, or the timer keeps the
     * simulation alive and the deadline eventually fires.
     */
    createDeadline(durationMs: number, reason: string): Deadline;
    /**
     * Runs `f` with a signal that aborts after `durationMs`, and cancels the
     * deadline when `f` settles. Does NOT force-interrupt `f`: cancellation
     * is cooperative, and every operation inside `f` that can block must
     * accept and honor the signal. In return: when this returns, no work
     * started under it is still running.
     */
    withTimedSignal<T>(f: (signal: AbortSignal) => Promise<T>, durationMs: number, reason: string): Promise<T>;

    abortSimulation(e: unknown): never;
}

export interface SleepOptions {
    readonly signal?: AbortSignal;
}

export interface Deadline {
    readonly signal: AbortSignal;
    cancel(): void;
}

export interface SimulationOptions {
    /**
     * The wall-clock time at virtual monotonic time 0, in milliseconds since
     * the Unix epoch. Defaults to 0.
     */
    readonly wallClockEpoch?: number;
    /**
     * When work under a `withTimedSignal` completes after its signal
     * aborted, the simulation reports it — this almost always means some
     * operation ignored its signal. By default the report is a warning
     * logged via the logger; setting this aborts the simulation instead.
     */
    readonly failOnLateCompletion?: boolean;
    /**
     * Aborts the simulation when it makes more than this many scheduling
     * decisions (task unblocks and timer firings). The failure reports
     * whether virtual time was still advancing: a step budget exhausted at
     * a fixed virtual time is the signature of a zero-duration-timer or
     * checkpoint livelock, while exhaustion with time advancing means the
     * scenario outgrew its budget.
     */
    readonly maxSchedulingSteps?: number;
    /** Aborts the simulation when a timer firing would advance the virtual clock past this. */
    readonly maxVirtualDurationMs?: number;
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

    public sleep(durationMs: number, reason: string, options?: SleepOptions): Promise<void> {
        validateSleepDuration(durationMs, reason);
        const signal = options?.signal;
        if (signal?.aborted) {
            return Promise.reject(signal.reason);
        }
        this.log(`sleep "${reason}" for ${durationMs}ms`);
        return new Promise((resolve, reject) => {
            const onAbort = (): void => {
                clearTimeout(timer);
                reject(signal?.reason);
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, durationMs);
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    public createDeadline(durationMs: number, reason: string): Deadline {
        validateSleepDuration(durationMs, reason);
        const controller = new AbortController();
        const timer = setTimeout(() => {
            controller.abort(
                new CancellationError(
                    `Deadline '${reason}' aborted after ${durationMs}ms`,
                    reason,
                    performance.now(),
                ),
            );
        }, durationMs);
        return {
            signal: controller.signal,
            cancel: () => clearTimeout(timer),
        };
    }

    public async withTimedSignal<T>(
        f: (signal: AbortSignal) => Promise<T>,
        durationMs: number,
        reason: string,
    ): Promise<T> {
        const deadline = this.createDeadline(durationMs, reason);
        try {
            return await f(deadline.signal);
        } finally {
            deadline.cancel();
        }
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

interface ActiveDeadline {
    readonly reason: string;
    /** The task that created the deadline. The signal may since have been passed elsewhere. */
    readonly owner: string;
    readonly deadline: number;
    readonly signal: OwnedAbortSignal;
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
    private readonly activeDeadlines = new Set<ActiveDeadline>();
    private readonly failOnLateCompletion: boolean;
    private readonly maxSchedulingSteps: number | undefined;
    private readonly maxVirtualDurationMs: number | undefined;
    /** Present iff the entropy source can record/validate timer events (see trace.ts). */
    private readonly timerTrace: TimerTraceSink | undefined;
    private steps = 0;
    private lastAdvanceStep = 0;
    /**
     * Set while a user 'abort' listener is dispatching. Task APIs called
     * from listener context corrupt scheduler bookkeeping or entropy-stream
     * stability, so they fail descriptively instead.
     */
    private inUserAbortListener = false;

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
        this.failOnLateCompletion = options.failOnLateCompletion ?? false;
        this.maxSchedulingSteps = options.maxSchedulingSteps;
        this.maxVirtualDurationMs = options.maxVirtualDurationMs;
        this.timerTrace = isTimerTraceSink(entropy) ? entropy : undefined;
    }

    private countStep(): void {
        this.steps++;
        if (this.maxSchedulingSteps === undefined || this.steps <= this.maxSchedulingSteps) return;
        const stuckSteps = this.steps - this.lastAdvanceStep;
        // A budget spent mostly at a fixed virtual time is a livelock
        // signature; a budget spent while time kept advancing means the
        // scenario is just bigger than the budget.
        const detail =
            stuckSteps * 2 >= this.maxSchedulingSteps
                ? `Virtual time has been stuck at t=${this.monotonic}ms for ${stuckSteps} steps — the signature of a zero-duration-timer or checkpoint livelock.`
                : `Virtual time was still advancing (last advance ${stuckSteps} steps ago) — the scenario may have outgrown its step budget.`;
        throw new Error(`Maximum scheduling steps (${this.maxSchedulingSteps}) exceeded at t=${this.monotonic}ms. ${detail}`);
    }

    private assertNotInAbortListener(what: string): void {
        if (this.inUserAbortListener) {
            throw new Error(
                `Task API '${what}' called from within a user 'abort' listener. ` +
                    "Abort listeners must be plain synchronous state changes — they must not " +
                    "call task APIs, operate blocking primitives, or consume entropy.",
            );
        }
    }

    private dispatchUserAbortListener(listener: () => void): void {
        this.inUserAbortListener = true;
        try {
            listener();
        } catch (e) {
            // The platform's report-and-continue dispatch behavior would hide
            // bugs; a throwing listener aborts the simulation instead.
            this.abort(e);
        } finally {
            this.inUserAbortListener = false;
        }
    }

    private abort(e: unknown): never {
        if (this.abortedWithError === undefined) {
            this.abortedWithError = e;
            // Cancellation cleanup: pending timers must not survive an
            // aborted run. (unlockIfNecessary rethrows the abort error
            // before ever firing a timer, but there's no reason to keep
            // them around.)
            this.timers.clear();
            this.activeDeadlines.clear();
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
        this.timerTrace?.timerCreated(id, reason, deadline);
        return id;
    }

    /**
     * Cancels a pending timer as a semantic event (sleep abort, deadline
     * cancel) that is recorded in the trace. No-op if the timer already
     * fired or was cancelled. NOT for exception-path rollback — a rolled-back
     * timer registration is undone bookkeeping, not a replayable event.
     */
    private cancelTimer(id: number, why: string): void {
        const timer = this.timers.get(id);
        if (timer === undefined) return;
        this.timers.delete(id);
        this.logger.log(`TIMER '${timer.reason}' cancelled (${why}) at t=${this.monotonic}ms`);
        this.timerTrace?.timerCancelled(id, timer.reason);
    }

    /**
     * Fires an entropy-chosen pending timer. Any pending timer may fire —
     * deadlines are only lower bounds, so a later-deadline timer may fire
     * before an earlier one. The clock advances to `max(now, deadline)`,
     * which keeps virtual time monotonic even for late firings.
     */
    private fireNextTimer(): void {
        this.countStep();
        const timers = Array.from(this.timers.values());
        const timer = sample(this.entropy, `Picking timer out of ${timers.map((t) => t.reason).join(", ")}`, timers);
        assert(timer !== undefined, "No timers to pick from");
        const newNow = Math.max(this.monotonic, timer.deadline);
        if (this.maxVirtualDurationMs !== undefined && newNow > this.maxVirtualDurationMs) {
            throw new Error(
                `Maximum virtual duration (${this.maxVirtualDurationMs}ms) exceeded: ` +
                    `timer '${timer.reason}' would advance the clock to t=${newNow}ms`,
            );
        }
        this.timers.delete(timer.id);
        if (newNow > this.monotonic) {
            this.monotonic = newNow;
            this.lastAdvanceStep = this.steps;
        }
        this.logger.log(`TIMER '${timer.reason}' fired at t=${this.monotonic}ms (deadline t=${timer.deadline}ms)`);
        this.timerTrace?.timerFired(timer.id, timer.reason, this.monotonic);
        timer.fire();
    }

    private makeDeadlockError(infos: readonly TaskInfo[]): Error {
        const blocked = infos
            .map((i) => `${i.name}${i.parkReason !== undefined ? ` (${i.parkReason})` : ""}`)
            .join(", ");
        let message = `Deadlock at t=${this.monotonic}ms: all tasks are blocked and no timers are pending. Blocked tasks: ${blocked}.`;
        // A blocked task holding an already-aborted signal is the typical
        // signature of a deadline that could not interrupt a non-cancellable
        // wait — calling it out turns a confusing deadlock into a
        // self-explaining one.
        const aborted = Array.from(this.activeDeadlines).filter((d) => d.signal.aborted);
        if (aborted.length > 0) {
            const signals = aborted
                .map((d) => `'${d.reason}' (created by ${d.owner}, aborted at t=${d.signal.abortedAtMs}ms)`)
                .join(", ");
            message += ` Aborted signals still held: ${signals}.`;
        }
        return new Error(message);
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
        this.countStep();
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
        this.activeDeadlines.clear();
        this.steps = 0;
        this.lastAdvanceStep = 0;

        const tasksAndInfos = specs.map((s) => {
            const info: TaskInfo = { name: s.name, resolve: undefined, parkReason: undefined };
            const task: SimulationTask = {
                random(name: string): number {
                    simulation.assertNotInAbortListener("random");
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
                    simulation.assertNotInAbortListener("checkpoint");
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
                    simulation.assertNotInAbortListener("failpoint");
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
                    simulation.assertNotInAbortListener("blockpoint");
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
                sleep(durationMs: number, reason: string, options?: SleepOptions): Promise<void> {
                    simulation.assertNotInAbortListener("sleep");
                    validateSleepDuration(durationMs, reason);
                    assert(simulation.taskInfos.has(task), `Task ${s.name} wants to sleep, but doesn't exist anymore`);
                    const signal = options?.signal;
                    if (signal?.aborted) {
                        // The abort event has already fired and will not fire
                        // again, so parking would sleep forever. Reject
                        // immediately: no timer, no entropy.
                        simulation.logger.log(
                            `${s.name} SLEEP '${reason}' rejected at t=${simulation.monotonic}ms: signal already aborted`,
                        );
                        return Promise.reject(signal.reason);
                    }
                    const deadline = simulation.monotonic + durationMs;
                    simulation.logger.log(
                        `${s.name} SLEEP '${reason}' at t=${simulation.monotonic}ms for ${durationMs}ms until t=${deadline}ms`,
                    );
                    let resolveSleep!: () => void;
                    let rejectSleep!: (e: unknown) => void;
                    const promise = new Promise<void>((resolve, reject) => {
                        resolveSleep = resolve;
                        rejectSleep = reject;
                    });
                    assert(info.resolve === undefined, `Task ${s.name} already has a resolve`);
                    // The task sleeps in its single park slot: blocked like
                    // a blockpoint, woken by exactly one of two events — its
                    // timer firing, or its signal aborting. Each event flips
                    // the slot to a schedulable continuation and disarms the
                    // other, so the task can never be woken twice.
                    info.resolve = false;
                    info.parkReason = `sleeping '${reason}' until t=${deadline}ms`;
                    let timerId: number | undefined;
                    let detachAbort: (() => void) | undefined;
                    const rollBackPark = (): void => {
                        // The task is NOT sleeping — it is running its error
                        // path. The park slot, the just-registered timer,
                        // and the abort hook must all be rolled back,
                        // otherwise either could later ghost-wake a task
                        // that isn't parked. (The pending sleep promise is
                        // abandoned unsettled, like an abandoned checkpoint
                        // promise.)
                        info.resolve = undefined;
                        info.parkReason = undefined;
                        if (timerId !== undefined) simulation.timers.delete(timerId);
                        detachAbort?.();
                    };
                    try {
                        // Outside the promise executor: a trace-divergence
                        // throw from timer registration must propagate
                        // synchronously out of sleep, not reject a promise
                        // nobody will await.
                        timerId = simulation.registerTimer(`${s.name} sleep: ${reason}`, deadline, () => {
                            detachAbort?.();
                            info.parkReason = undefined;
                            info.resolve = resolveSleep;
                        });
                        if (signal !== undefined) {
                            const registeredTimerId = timerId;
                            const onAbort = (): void => {
                                // Dispatches synchronously in whatever stack
                                // aborts the signal — an aborting task, or
                                // the scheduler's clock-advance step when a
                                // deadline expires. The sleeper merely
                                // becomes schedulable; the entropy scheduler
                                // picks up the aborted sleeper later.
                                simulation.cancelTimer(registeredTimerId, "sleep aborted");
                                info.parkReason = undefined;
                                info.resolve = () => rejectSleep(signal.reason);
                            };
                            if (signal instanceof OwnedAbortSignal) {
                                // On a determined-owned signal the sleep
                                // wakeup is privileged: it runs before any
                                // user listener and outside the safety
                                // guard, so the cancelled sleeper is already
                                // settled by the time user code observes the
                                // abort.
                                detachAbort = signal.addInternalCallback(onAbort);
                            } else {
                                signal.addEventListener("abort", onAbort, { once: true });
                                detachAbort = () => signal.removeEventListener("abort", onAbort);
                            }
                        }
                        simulation.unlockIfNecessary();
                    } catch (e) {
                        rollBackPark();
                        throw e;
                    }
                    return promise;
                },
                createDeadline(durationMs: number, reason: string): Deadline {
                    simulation.assertNotInAbortListener("createDeadline");
                    validateSleepDuration(durationMs, reason);
                    assert(
                        simulation.taskInfos.has(task),
                        `Task ${s.name} wants to create a deadline, but doesn't exist anymore`,
                    );
                    const signal = new OwnedAbortSignal({
                        dispatchUserAbortListener: (listener) => simulation.dispatchUserAbortListener(listener),
                    });
                    const deadline = simulation.monotonic + durationMs;
                    const timerReason = `${s.name} deadline: ${reason}`;
                    const active: ActiveDeadline = { reason, owner: s.name, deadline, signal };
                    const timerId = simulation.registerTimer(timerReason, deadline, () => {
                        // The signal aborts when its timer fires, which may
                        // be later than the nominal deadline — aborts are
                        // events, not clock state.
                        const now = simulation.monotonic;
                        signal.abort(
                            new CancellationError(`Deadline '${reason}' aborted at t=${now}ms`, reason, now),
                            now,
                        );
                    });
                    simulation.activeDeadlines.add(active);
                    return {
                        signal: signal as unknown as AbortSignal,
                        cancel: () => {
                            simulation.activeDeadlines.delete(active);
                            simulation.cancelTimer(timerId, "deadline cancelled");
                        },
                    };
                },
                async withTimedSignal<T>(
                    f: (signal: AbortSignal) => Promise<T>,
                    durationMs: number,
                    reason: string,
                ): Promise<T> {
                    const deadline = task.createDeadline(durationMs, reason);
                    try {
                        return await f(deadline.signal);
                    } finally {
                        deadline.cancel();
                        const owned = deadline.signal as unknown as OwnedAbortSignal;
                        const abortedAt = owned.abortedAtMs;
                        // Work settling AFTER the abort instant almost always
                        // means some operation ignored its signal — an
                        // honored cancellation settles at the abort instant
                        // itself. Free and deterministic under virtual time.
                        if (abortedAt !== undefined && simulation.monotonic > abortedAt) {
                            const message =
                                `operation under '${reason}' (${durationMs}ms) completed at ` +
                                `t=${simulation.monotonic}ms, ${simulation.monotonic - abortedAt}ms after its signal aborted`;
                            if (simulation.failOnLateCompletion) {
                                simulation.abort(new Error(message));
                            } else {
                                simulation.logger.error(`WARNING: ${message}`);
                            }
                        }
                    }
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
            // In the try so that a replay divergence on the recorded epoch
            // fails the run like any other divergence.
            this.timerTrace?.runStart(this.wallClockEpoch);
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
