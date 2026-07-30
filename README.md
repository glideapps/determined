# determined

A deterministic simulation testing (DST) framework for TypeScript. It provides controlled scheduling of concurrent tasks, reproducible entropy, and concurrency primitives — all designed so that bugs found during simulation can be replayed exactly.

## Overview

In production, concurrent tasks run with real async scheduling, real randomness, and real concurrency primitives. During testing, `determined` replaces all of these with deterministic equivalents controlled by an entropy source. This means:

- **Every scheduling decision** (which task runs next) is driven by entropy, not the JS event loop.
- **Failpoints** can be injected probabilistically to test error paths.
- **Failures are reproducible**: record the entropy, replay it, get the exact same execution.

## Installation

```bash
npm install determined
```

Works with both ESM and CommonJS:

```typescript
// ESM
import { SimulationImpl, noSimulation, Mutex, ConditionVariable } from "determined";

// CJS
const { SimulationImpl, noSimulation, Mutex, ConditionVariable } = require("determined");
```

## Modules

### simulation.ts

The core of the framework. Defines the `SimulationTask` interface and two implementations of the `Simulation` runner.

#### `SimulationTask`

The interface every task function receives. It extends `Logger` and `EntropySource` and provides:

- **`checkpoint(...log)`** — A yield point. The task suspends and the scheduler picks which task to resume next. Use this at every point where you want the simulation to explore different interleavings.
- **`failpoint(...log)`** — Like checkpoint, but may also inject a simulated failure (an `ApplicationFailure`) based on the configured `failpointFailureProbability` callback. If the failpoint passes, it acts as a scheduling point. When the callback returns 0, no entropy is consumed for the fail decision (important for replay determinism).
- **`blockpoint(...log)`** — Marks the task as blocked (waiting on an external condition like a mutex or condition variable). Unlike checkpoint, blocked tasks are excluded from scheduling until something unblocks them. If all tasks are blocked, the simulation detects deadlock.
- **`abortSimulation(error)`** — Immediately aborts the entire simulation run with the given error.
- **`random(reason)`** — Returns a random number in [0, 1) from the simulation's entropy source.
- **`monotonicNow()`** / **`wallNow()`** — The current monotonic and wall-clock time in milliseconds. Virtual in simulation (wall time is a configurable epoch plus monotonic time), real in production.
- **`sleep(durationMs, reason, { signal? })`** — Blocks until virtual time reaches at least `now + durationMs`; cancellable via an `AbortSignal` (see "Deterministic time" below).
- **`createDeadline(durationMs, reason)`** / **`withTimedSignal(f, durationMs, reason)`** — Deadline handles and scoped timeouts (see "Deterministic time" below).
- **`log(...)`** / **`error(...)`** — Logging, routed through the simulation's logger.

#### `SimulationImpl`

The deterministic simulation runner. Constructed with:

```typescript
new SimulationImpl(
    logger: Logger,
    entropy: EntropySource,
    failpointFailureProbability: (...log: readonly unknown[]) => number,
    options?: SimulationOptions,
)
```

`SimulationOptions`:

- **`wallClockEpoch`** — Wall-clock time at virtual monotonic time 0 (default 0).
- **`maxSchedulingSteps`** — Aborts runs that make more scheduling decisions than this. The failure reports whether virtual time was still advancing — a budget exhausted at a fixed virtual time is the signature of a zero-duration-timer or checkpoint livelock.
- **`maxVirtualDurationMs`** — Aborts runs whose virtual clock would advance past this.
- **`failOnLateCompletion`** — Escalates the ignored-signal diagnostic (work under a `withTimedSignal` completing after its signal aborted) from a warning to a failure.
- **`pickTimerIndex`** — Timer firing policy; see "Deterministic time".

Call `runTasks(specs)` with an array of `TaskSpec` objects. Each spec has a `name` and an async function `f` that receives a `SimulationTask`. All tasks start at an implicit `checkpoint("START")`, and the scheduler picks which one runs first.

`failpointFailureProbability` is called with the same `...log` arguments passed to `failpoint` and must return a probability between 0 and 1. Use `() => 0` to disable simulated failpoint failures, `() => 0.1` for a constant 10% failure probability, or inspect the log arguments to vary probability by failpoint.

Returns `Result<T[], Error>` — either the array of results (in spec order) or the first error that occurred.

**Scheduling algorithm**: When all running tasks have reached a checkpoint or blockpoint, the scheduler picks one of the checkpointed tasks using `sample()` (entropy-driven). Blocked tasks are excluded. If no tasks are checkpointed and all are blocked, a deadlock error is raised.

**Cross-task promises**: A task may await a promise that another task will settle — the singleflight/coalescing shape, or a `Promise.all` spanning tasks. The scheduler's task states are facts except one: "parked" and "blocked" are exact because the scheduler itself holds the wake mechanism, but "running" is a *prediction* — "this task will re-enter the scheduler at its next park or finish" — and awaiting a promise the scheduler doesn't manage breaks exactly that prediction. So whenever the scheduler hands control to user code, it arms a one-shot *quiescence probe* (a macrotask, which runs only once the entire microtask queue has drained). A task still marked running when the probe fires is provably suspended on an unmanaged promise, and the probe treats it as blocked: parked tasks keep running, pending timers fire one at a time — yielding after each fire so that settling cascades (e.g. a deadline abort listener resolving a deferred) drain before the next decision — and virtual time advances until the awaited promise settles. If nothing can progress — a task awaits a promise nobody will ever settle and no timers are pending — the run fails with a deadlock report naming the task as awaiting a promise not managed by the simulation, instead of hanging silently.

Two consequences to be aware of: tasks resumed by a promise settling run in native promise-reaction order, not entropy order — deterministic and replayable, but that resumption order is not part of the explored schedule space; and the quiescence inference assumes a closed world — a task awaiting real async work (I/O, real timers) looks identical to one awaiting an unmanaged promise, so the scheduler may advance virtual time while that work is still in flight. Real async work inside simulation tasks is outside the library's contract regardless, since it breaks determinism on its own.

#### Deterministic time

The simulation has a virtual monotonic clock, starting at 0 per run. Time never passes for real: `task.sleep(3_600_000, "one hour")` completes instantly in real time.

**Timer deadlines are lower bounds.** A 1,000ms timer may fire at any virtual time at or after 1,000ms — exactly the real contract of `setTimeout`, where event-loop lag or a suspended process can delay any timer. When no task is runnable, an entropy-chosen pending timer — *any* of them — fires, and the clock advances to `max(now, deadline)`. A 2,000ms timer can therefore fire before a 1,000ms timer; code must not depend on relative firing order. Firing order is recorded and replayed like every other entropy decision, and a single pending timer is a forced choice that consumes no entropy.

Because unbiased picking can make time gallop (choosing a pending 24-hour retention timer over a 100ms heartbeat jumps the clock a day), the pick distribution is a configurable policy via `options.pickTimerIndex` — e.g. biased strongly toward the earliest deadline. The policy shapes exploration only; replay is unaffected.

**Cancellation is cooperative.** A sleep given a `signal` rejects with `signal.reason` when the signal aborts (the same contract as Node's cancellable `setTimeout` from `timers/promises`); the pending timer is removed, and a sleep given an already-aborted signal rejects immediately without registering a timer or consuming entropy. Nothing else is interruptible: a task blocked on a mutex or condition variable does not observe a deadline until it unblocks.

```typescript
// Preferred: a scoped timeout owning both timer and cancellation lifecycle.
const value = await task.withTimedSignal(
    (signal) => operation(signal),   // operation must honor the signal
    10_000,
    "runtime request deadline",
);

// Lower-level: a cancellable deadline handle.
const deadline = task.createDeadline(10_000, "runtime health timeout");
try {
    await operation(deadline.signal);
} finally {
    deadline.cancel();
}
```

`withTimedSignal` never force-interrupts its callback: it returns only when the callback returns, so when it returns, no work started under it is still running. A callback that ignores its signal completes late — and the simulation reports it ("completed N ms after its signal aborted"), as a warning by default or a failure with `failOnLateCompletion`.

A deadline's signal aborts when its timer *fires*, which may be later than the nominal deadline — aborts are events, not clock state. The abort reason is a `CancellationError` carrying the deadline's reason and the virtual abort time. Distinguish cancellations from simulated failures with `isCancellation(e)`: retry loops retry `ApplicationFailure`s but must always propagate cancellations.

`'abort'` listeners dispatch synchronously in whatever stack aborts the signal. User listeners must be plain synchronous state changes: calling task APIs from a listener fails with a descriptive error, and a listener that throws aborts the simulation. (Internally, sleep wakeups on a deadline signal are privileged callbacks that run before any user listener.) In simulation the deadline signal is a `determined`-owned implementation of the `AbortSignal` interface — rely only on standard signal behavior: no `instanceof AbortSignal`, and don't hand it to native APIs.

Sleeping tasks count as blocked with a pending timer, so they never trigger false deadlock detection; a deadlock report includes each blocked task's park reason and calls out aborted-but-uncancelled deadline signals — the signature of a deadline that could not interrupt a non-cancellable wait.

#### `NoSimulationTask` / `noSimulation`

Production-mode implementations where `checkpoint()` and `failpoint()` resolve immediately, `blockpoint()` is a no-op, and `random()` uses `Math.random()`. The clock-facing API uses real time: `performance.now()`/`Date.now()`, real cancellable timers for `sleep`, and `AbortController`-backed deadlines that abort with the same `CancellationError` shape — business logic needs no `if (simulation)` branches. Negative sleep durations throw a `TypeError` in both modes (real `setTimeout` would silently clamp them). The `noSimulation` singleton runs all tasks concurrently via `Promise.all`.

### entropy.ts

Pluggable entropy for deterministic randomness.

#### `EntropySource`

```typescript
interface EntropySource {
    random(reason: string): number; // returns [0, 1)
}
```

The `reason` parameter is a human-readable label used for recording and replay diagnostics.

#### Implementations

- **`SimpleEntropySource`** — Wraps `Math.random()`. Used in production.
- **`RecordingEntropySource`** — Wraps another source, records every `(name, value)` pair. Use during test runs to capture entropy for later replay.
- **`ReplayingEntropySource`** — Replays a recorded sequence. Throws on name mismatch (detects divergence from the recorded run) or exhaustion. Use to reproduce failures.

#### `sample(entropy, name, items)`

Picks a random element from an array using the entropy source. Returns `undefined` for empty arrays. For single-element arrays, returns the element without consuming entropy (important for replay: avoids spurious entropy consumption when the choice is forced).

### trace.ts

The preferred record/replay mechanism for time-capable simulations. Entropy-only traces cannot detect timer divergence in general: forced choices consume no entropy, so a run with a single pending timer leaves no entropy footprint in which a changed reason or deadline could be noticed. The trace is a typed sequence of records — the run's wall-clock epoch, entropy draws, and explicit timer creation/cancellation/firing events — validated in order during replay.

- **`RecordingTraceSource`** — Wraps an entropy source and records the full trace; `getTrace()` returns it.
- **`ReplayingTraceSource`** — Replays a trace, throwing descriptive divergence errors (position, recorded vs. actual) on any mismatch; `assertFullyConsumed()` catches runs that did less than the recording.

`SimulationImpl` feeds timer events to its entropy source whenever the source implements `TimerTraceSink`, so plain entropy sources keep working — they just can't validate timer behavior.

### errors.ts

#### `ApplicationFailure`

Extends `Error` with:

- **`type?: ErrorType`** — A branded string for categorizing errors.
- **`nonRetryable: boolean`** — Defaults to `false`. When `true`, indicates the error should not be retried.

Used by failpoints to distinguish simulated failures from real bugs.

#### `isApplicationFailure(error)`

Type guard for `ApplicationFailure`.

#### `CancellationError` / `isCancellation(error)`

The rejection used when a sleep is aborted or a deadline expires; carries the deadline's reason string and the (virtual) abort time. Deliberately not an `ApplicationFailure`: retry logic retries application failures but must always propagate cancellations — a retry loop that swallows an abort defeats the shutdown that requested it. `isCancellation` also recognizes the platform's `DOMException` `AbortError`/`TimeoutError`, so the predicate works in production.

### mutex.ts

An async mutex for use inside simulated tasks.

```typescript
const mutex = new Mutex("my-lock");

// In a task:
await mutex.lock(task, "critical section");
try {
    // ... exclusive access ...
} finally {
    mutex.unlock(task, "critical section");
}
```

- **`lock(task, reason)`** — If unlocked, acquires immediately. If locked, calls `blockpoint` (marking the task as blocked) and enqueues. When the lock is released, the first waiter is woken via `checkpoint`.
- **`unlock(task, reason)`** — Releases the lock. If waiters are queued, passes the lock to the first one (FIFO).
- **`isLocked`** — Read-only property.

### condition-variable.ts

A condition variable for signaling between simulated tasks. Unlike classical condition variables, this is not paired with a mutex — it's a simple waiter list.

```typescript
const cv = new ConditionVariable("data-ready");

// Waiting task:
await cv.wait(task, "new data");

// Notifying task:
cv.notifyAll(task, "data arrived");
```

- **`wait(task, reason)`** — Calls `blockpoint` (task is blocked), then parks. The task resumes via `checkpoint` when `notifyAll` is called.
- **`notifyAll(task, reason)`** — Wakes all waiting tasks. Does nothing if no waiters. Notifications are **not sticky** — if `notifyAll` is called before `wait`, the notification is lost and the waiter will block forever (deadlock).

## Usage Example

The sync engine uses `determined` to test concurrent sync and mutation operations. Here's a condensed version showing the key patterns:

### Writing code that works with both simulation and production

The `Simulation` interface abstracts over `SimulationImpl` (testing) and `noSimulation` (production). Your code takes a `SimulationTask` and uses its methods to yield control:

```typescript
import {
    type Simulation, type SimulationTask,
    ConditionVariable, Mutex, sample, isApplicationFailure,
} from "determined";

const mutex = new Mutex("db-lock");

async function writer(task: SimulationTask, data: string[]) {
    await mutex.lock(task, "write");
    try {
        // failpoint: may inject a simulated failure here during testing
        await task.failpoint("before write");
        data.push("written");
        // checkpoint: allows the scheduler to switch to another task
        await task.checkpoint("after write");
    } finally {
        mutex.unlock(task, "write");
    }
}

async function reader(task: SimulationTask, data: string[]) {
    await mutex.lock(task, "read");
    try {
        task.log("current data:", data);
    } finally {
        mutex.unlock(task, "read");
    }
}
```

Use a `ConditionVariable` to signal between tasks:

```typescript
async function producer(task: SimulationTask, cv: ConditionVariable, done: { value: boolean }) {
    await task.checkpoint("producing");
    done.value = true;
    cv.notifyAll(task, "data ready");
}

async function consumer(task: SimulationTask, cv: ConditionVariable, done: { value: boolean }) {
    if (!done.value) {
        await cv.wait(task, "waiting for data");
    }
    task.log("consumed");
}
```

Use `sample()` and `task.random()` for any random decisions, so they're captured in the entropy trace:

```typescript
async function pickAction(task: SimulationTask) {
    const actions = ["insert", "update", "delete"] as const;
    const action = sample(task, "pick action", actions);
    // ...
}
```

### Running a simulation

```typescript
import {
    SimulationImpl, RecordingEntropySource, ReplayingEntropySource,
    SimpleEntropySource, type Logger,
} from "determined";

// A logger that captures output
class ConsoleLogger implements Logger {
    log(...args: readonly unknown[]) { console.log(...args); }
    error(...args: readonly unknown[]) { console.error(...args); }
}

// Run with recording
const recording = new RecordingEntropySource(new SimpleEntropySource());
const sim = new SimulationImpl(new ConsoleLogger(), recording, () => 0.05);

const result = await sim.runTasks([
    { name: "writer", f: (task) => writer(task, data) },
    { name: "reader", f: (task) => reader(task, data) },
]);

if (result.isErr()) {
    // Save entropy for replay
    const record = { config: { /* options */ }, record: recording.getRecords() };
    await fs.writeFile("failure.json", JSON.stringify(record));
}
```

### Replaying a failure

```typescript
const file = JSON.parse(await fs.readFile("failure.json", "utf-8"));
const replay = new ReplayingEntropySource(file.record);
const sim = new SimulationImpl(new ConsoleLogger(), replay, () => 0.05);

// Produces the exact same scheduling decisions and failpoint outcomes
const result = await sim.runTasks([
    { name: "writer", f: (task) => writer(task, data) },
    { name: "reader", f: (task) => reader(task, data) },
]);
```

### Running in production (no simulation)

```typescript
import { noSimulation } from "determined";

// Tasks run concurrently via Promise.all, checkpoints are no-ops
const result = await noSimulation.runTasks([
    { name: "writer", f: (task) => writer(task, data) },
    { name: "reader", f: (task) => reader(task, data) },
]);
```

### Iterating over many random interleavings

The playground pattern: run thousands of iterations with different random entropy, automatically saving failures for replay:

```typescript
for (let i = 0; i < 1000; i++) {
    const entropy = new RecordingEntropySource(new SimpleEntropySource());
    const sim = new SimulationImpl(logger, entropy, () => failureProbability);

    const result = await runMyTest(sim);

    if (result.isErr()) {
        // Save for later replay
        await fs.writeFile(
            `failure-${i}.json`,
            JSON.stringify({ config: options, record: entropy.getRecords() }),
        );
    }

    // Verify replay produces the same result
    const replayEntropy = new ReplayingEntropySource(entropy.getRecords());
    const replaySim = new SimulationImpl(logger, replayEntropy, () => failureProbability);
    const replayResult = await runMyTest(replaySim);
    assert(result.isOk() === replayResult.isOk(), "Replay must match original");
}
```

## Recording and Replaying Failures

The typical workflow:

1. **Run with recording**: Use `RecordingTraceSource` wrapping a `SimpleEntropySource`.
2. **On failure**: Save `recording.getTrace()` to a JSON file.
3. **Replay**: Load the trace and pass it to `ReplayingTraceSource`. The simulation will make the exact same scheduling decisions, hit the exact same failpoints, fire the exact same timers, and reproduce the failure.

The replaying source validates every entropy request and timer event against the recording. A mismatch means the code has changed in a way that alters the run, and it throws a descriptive error with the position and both the recorded and actual event.

(`RecordingEntropySource`/`ReplayingEntropySource` are the older entropy-only variants; they still work but cannot detect timer divergence.)

## Commands

```bash
# Run all tests
npm test

# Run a single test file
node --experimental-strip-types --test simulation.test.ts

# Type check
npm run typecheck
```

## Design Notes

See [TIMERS-SPEC.md](./TIMERS-SPEC.md) for the full requirements and semantics of deterministic time.

- All concurrency is cooperative, not preemptive. Tasks only yield control at explicit `checkpoint`, `failpoint`, `blockpoint`, or `sleep` calls — or by awaiting a promise another task settles (see "Cross-task promises" above).
- A task is a single sequential coroutine: never race two parking operations (checkpoints, failpoints, sleeps, mutex/condition-variable waits) within one task via `Promise.race`/`Promise.all`. The scheduler models exactly one park per task. Concurrency is expressed with multiple tasks; bounding work with a deadline is expressed with `withTimedSignal` and cooperative cancellation.
- Timer durations are lower bounds, and firing order is entropy-controlled — never depend on the relative firing order of pending timers.
- The simulation makes scheduling decisions synchronously (in microtasks) while its bookkeeping is provably exact, and defers to a macrotask-based quiescence probe only when a task might be suspended on an unmanaged promise. There is no actual parallelism. [NEW-ARCH.md](./NEW-ARCH.md) writes up a simpler all-quiescence alternative and why it hasn't been adopted.
- Scheduling errors (a deadlock, an exhausted step budget, an entropy source that throws from a scheduling pick) normally propagate synchronously into the task whose park call triggered the decision — which is what lets a task catch and recover from a transient entropy-guard trip. Errors raised from a quiescence probe have no task stack, so they fail `runTasks` directly through an out-of-band channel.
- `SimulationImpl` should be treated as single-use per `runTasks` call. After a failed run (error or deadlock), the instance is permanently poisoned (`abortedWithError` is never reset) and subsequent `runTasks` calls will immediately fail.
- The `sample()` function's "no entropy for single item" optimization is critical for replay correctness — it ensures the entropy consumption sequence doesn't depend on transient pool sizes.
