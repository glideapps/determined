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
- **`failpoint(...log)`** — Like checkpoint, but may also inject a simulated failure (an `ApplicationFailure`) based on `failureProbability`. If the failpoint passes, it acts as a scheduling point. When `failureProbability` is 0, no entropy is consumed for the fail decision (important for replay determinism).
- **`blockpoint(...log)`** — Marks the task as blocked (waiting on an external condition like a mutex or condition variable). Unlike checkpoint, blocked tasks are excluded from scheduling until something unblocks them. If all tasks are blocked, the simulation detects deadlock.
- **`abortSimulation(error)`** — Immediately aborts the entire simulation run with the given error.
- **`random(reason)`** — Returns a random number in [0, 1) from the simulation's entropy source.
- **`log(...)`** / **`error(...)`** — Logging, routed through the simulation's logger.

#### `SimulationImpl`

The deterministic simulation runner. Constructed with:

```typescript
new SimulationImpl(logger: Logger, entropy: EntropySource, failureProbability: number)
```

Call `runTasks(specs)` with an array of `TaskSpec` objects. Each spec has a `name` and an async function `f` that receives a `SimulationTask`. All tasks start at an implicit `checkpoint("START")`, and the scheduler picks which one runs first.

Returns `Result<T[], Error>` — either the array of results (in spec order) or the first error that occurred.

**Scheduling algorithm**: When all running tasks have reached a checkpoint or blockpoint, the scheduler picks one of the checkpointed tasks using `sample()` (entropy-driven). Blocked tasks are excluded. If no tasks are checkpointed and all are blocked, a deadlock error is raised.

#### `NoSimulationTask` / `noSimulation`

Production-mode implementations where `checkpoint()` and `failpoint()` resolve immediately, `blockpoint()` is a no-op, and `random()` uses `Math.random()`. The `noSimulation` singleton runs all tasks concurrently via `Promise.all`.

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

### errors.ts

#### `ApplicationFailure`

Extends `Error` with:

- **`type?: ErrorType`** — A branded string for categorizing errors.
- **`nonRetryable: boolean`** — Defaults to `false`. When `true`, indicates the error should not be retried.

Used by failpoints to distinguish simulated failures from real bugs.

#### `isApplicationFailure(error)`

Type guard for `ApplicationFailure`.

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
const sim = new SimulationImpl(new ConsoleLogger(), recording, 0.05);

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
const sim = new SimulationImpl(new ConsoleLogger(), replay, 0.05);

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
    const sim = new SimulationImpl(logger, entropy, failureProbability);

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
    const replaySim = new SimulationImpl(logger, replayEntropy, failureProbability);
    const replayResult = await runMyTest(replaySim);
    assert(result.isOk() === replayResult.isOk(), "Replay must match original");
}
```

## Recording and Replaying Failures

The typical workflow:

1. **Run with recording**: Use `RecordingEntropySource` wrapping a `SimpleEntropySource`.
2. **On failure**: Save `recording.getRecords()` to a JSON file.
3. **Replay**: Load the records and pass them to `ReplayingEntropySource`. The simulation will make the exact same scheduling decisions, hit the exact same failpoints, and reproduce the failure.

The `ReplayingEntropySource` validates that each entropy request matches the recorded name. A mismatch means the code has changed in a way that alters the entropy consumption pattern, and it throws a descriptive error with position and both names.

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

- All concurrency is cooperative, not preemptive. Tasks only yield control at explicit `checkpoint`, `failpoint`, or `blockpoint` calls.
- The simulation runs in a single JS event loop turn between scheduling decisions. There is no actual parallelism.
- `SimulationImpl` should be treated as single-use per `runTasks` call. After a failed run (error or deadlock), the instance is permanently poisoned (`abortedWithError` is never reset) and subsequent `runTasks` calls will immediately fail.
- The `sample()` function's "no entropy for single item" optimization is critical for replay correctness — it ensures the entropy consumption sequence doesn't depend on transient pool sizes.
