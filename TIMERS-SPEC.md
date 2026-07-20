# Deterministic Time Requirements for `determined`

> **Status:** Initial requirements for deterministic wall-clock simulation needed by pi-orb. This document describes the problem and desired behavior; it does not prescribe the final `determined` API.

## 1. Problem

[`determined`](https://www.npmjs.com/package/determined) controls cooperative task scheduling, entropy, failpoints, blocking, and replay. It does not currently virtualize wall-clock or monotonic time.

pi-orb has concurrency-critical behavior whose outcome depends on both task interleaving and time:

- runtime health and busy heartbeat intervals;
- health timeout and idle-stop decisions;
- persistence retry backoff;
- database and control-plane outages of varying duration;
- controlled shutdown repeatedly pulling and committing history until no new complete records remain;
- request and operation deadlines;
- reconnect delays;
- host restart backoff and retry limits;
- expiring bootstrap credentials;
- eventual garbage-collection and retention policies.

Using real `Date.now()`, `setTimeout()`, or sleeping in deterministic simulations would make tests slow and non-reproducible. Scheduling decisions could replay exactly while timeout behavior still changed between runs.

We need time to be part of the deterministic simulation.

## 2. Goals

A time-capable simulation should:

1. Run timeout-heavy scenarios without waiting for real time.
2. Reproduce the same scheduling, entropy, failure, and timer decisions exactly.
3. Let production code use real time through `noSimulation` without separate business logic.
4. Make sleeping tasks and pending timers participate correctly in scheduler quiescence and deadlock detection.
5. Support cancellation and deadlines used by normal TypeScript code.
6. Produce diagnostics that explain virtual-time changes and timer wakeups.
7. Avoid global monkey-patching as the primary integration mechanism.

## 3. Non-goals

Initially, deterministic time does not need to:

- emulate operating-system scheduling or CPU execution time;
- monkey-patch every third-party use of `Date`, `setTimeout`, or `setInterval`;
- model real network throughput;
- reproduce timezone, daylight-saving, or civil-calendar behavior;
- make external Docker, PostgreSQL, browser, or GCP operations deterministic;
- infer latency automatically for arbitrary promises;
- add timed mutex or condition-variable APIs solely for pi-orb.

External systems remain behind simulated adapters in DST and are covered separately by integration tests.

## 4. Required clock concepts

### 4.1 Monotonic time

Timeouts and durations require a monotonic virtual clock that never moves backward.

Conceptually:

```ts
interface SimulationClock {
  monotonicNow(): number;
}
```

The unit should be explicit and consistent, preferably milliseconds represented as a number for compatibility with JavaScript timer APIs.

### 4.2 Wall-clock time

Some application data requires a timestamp comparable to `Date.now()`.

```ts
interface SimulationClock {
  wallNow(): number;
}
```

A simulation should have a configured wall-clock epoch. Advancing monotonic time advances wall time by the same duration. Tests must be able to choose a fixed epoch.

Production `noSimulation` should use the real monotonic and wall clocks.

### 4.3 Deterministic sleep

A task must be able to block until virtual time reaches at least a deadline, optionally interrupted by an `AbortSignal`:

```ts
await task.sleep(5_000, "persistence retry backoff", { signal });
```

In simulation:

- the task becomes blocked rather than using a real timer;
- the scheduler may run other runnable tasks;
- when no runnable task remains, an entropy-chosen pending timer fires and virtual time advances to at least its deadline (section 5);
- aborting the optional signal removes the pending timer and settles the sleep by rejecting with the signal's abort reason (`signal.reason`) — the same contract as Node's cancellable `setTimeout` from `timers/promises`, which `noSimulation` may use directly;
- a sleep given an already-aborted signal rejects immediately with the abort reason, registers no timer, and consumes no entropy — implementations must check the signal before parking, since the abort event has already fired and will not fire again.

In production, the same operation uses a real timer and observes the same cancellation contract.

## 5. Timer firing semantics

### 5.1 Deadlines are lower bounds

A timer's duration is only a lower bound: a 1,000 ms timer may fire at any virtual time at or after 1,000 ms, not exactly at it. This matches the actual contract of `setTimeout` — lateness from event-loop lag, GC pauses, or a suspended process is allowed in production, so the simulation must be able to explore it. In particular, a 2,000 ms timer may fire before a 1,000 ms timer created at the same instant.

Timer firing order is therefore entropy-controlled, not deadline-controlled. Code must not depend on the relative firing order of pending timers.

### 5.2 Firing rule

The simulation must not advance time while runnable tasks exist merely to make a timer fire sooner.

When no task is runnable:

- if timers are pending, the scheduler entropy-picks **any** pending timer, sets virtual time to `max(now, deadline)`, and fires it;
- if no timers are pending and tasks remain blocked, report deadlock;
- if no tasks remain, complete the simulation.

Consequences:

- virtual time never moves backward — the `max` preserves monotonicity even when a later-deadline timer fires first;
- firing order is an entropy decision, recorded and replayed like any other scheduling choice;
- a single pending timer is a forced choice and consumes no entropy (consistent with `sample()`);
- long backoffs and idle periods remain computationally cheap.

There is no privileged notion of simultaneous timers: deadline ties are just two eligible timers, ordered by entropy like any other pair.

### 5.3 Aborts are events, not state

A deadline's `AbortSignal` aborts when its timer fires, which may be later than its nominal deadline — exactly as in production, where `AbortSignal.timeout` is itself a timer callback subject to the same lateness. Code that polls `monotonicNow()` against a saved deadline observes exact clock state; code that reacts to an abort inherits timer lateness. Both behaviors are intended and must replay exactly.

### 5.4 Pick policy

Unbiased picking can make time gallop: choosing a pending 24-hour retention timer while a 100 ms heartbeat timer is pending jumps the clock a day. That is legal — a suspended process does the same — but is usually a poor default search policy.

Analogous to the existing `failpointFailureProbability` callback, the timer pick distribution should be a configurable policy, e.g. biased strongly toward the earliest deadline with occasional late firings. Policy shapes exploration only; replay just replays the recorded entropy and is unaffected by the policy that produced it.

### 5.5 Zero and negative durations

The API must define zero and negative durations. A reasonable default is:

- negative durations are rejected;
- a zero duration creates a timer due immediately: it requires no time advance, but like any timer it may fire after other timers have moved the clock forward.

The choice must be stable under record/replay and identical in both modes: `noSimulation`'s sleep must apply the same validation before delegating to the real timer, because `setTimeout` silently clamps negative delays to zero — otherwise the same code would throw in simulation but quietly proceed in production. Rejection follows the stricter precedent of `AbortSignal.timeout`, which throws a `TypeError` on negative durations.

### 5.6 Intervals

First-class intervals are not essential initially. Production code can implement an interval as a loop around deterministic sleep. If intervals are added, missed-tick and drift semantics must be explicit.

## 6. Deadlines and timeouts

Code needs to bound work with a deadline without using native real timers.

The preferred form owns both the timer and cancellation lifecycle:

```ts
await task.withTimedSignal(
  (signal) => operation(signal),
  10_000,
  "runtime request deadline",
);
```

A lower-level form must return a cancellable/disposable deadline handle rather than only a bare signal:

```ts
const deadline = task.createDeadline(10_000, "runtime health timeout");
try {
  await operation(deadline.signal);
} finally {
  deadline.cancel();
}
```

An `AbortSignal` is not itself awaited. APIs that can block receive it and abort their own awaited work. Only low-level timer/adapter implementations should convert the abort event into a promise when necessary.

Requirements:

- timeout expiration is driven by virtual time;
- cancellation is observable through `AbortSignal` where practical;
- state-machine polling is acceptable for periodic checks and persisted deadlines, but cannot replace cancellation for an individual HTTP, process, or provider call that might never return;
- completing work cancels/removes its pending timeout;
- cancelled timers cannot wake a task later;
- completion-versus-timeout ordering is an ordinary entropy-controlled scheduling decision and replays exactly; there is no special same-instant case (section 5);
- an `AbortSignal` interrupts only cancellable sleeps: a task blocked on a mutex or condition variable does not observe its deadline until it unblocks, so a non-cancellable wait inside a timeout is not bounded by that timeout;
- a deadline aborts its signal with a `TimeoutError`-style reason that includes the deadline's reason string and the virtual abort time;
- aborting a sleep makes the sleeping task schedulable like any other timer wakeup — it does not run inline inside the aborting task's execution; the aborter continues until it parks, and the entropy scheduler picks up the aborted sleeper later;
- timeout decisions replay without consuming unexpected entropy.

`withTimedSignal` does not force-interrupt its callback. No race is created: the call returns only when the callback returns. A callback that ignores its signal — by blocking in a non-cancellable primitive, sleeping without passing the signal, or awaiting an operation that does not honor it — is not bounded by the timeout. This is deliberate: forced interruption would abandon in-flight work, which is unsound in simulation and leaks zombie work in production. Cancellation is cooperative, and every operation that can block must accept and honor the signal. In return, `withTimedSignal` gives a guarantee that racing helpers cannot: when it returns, no work started under it is still running — every `finally` has run and every resource is released.

Cancellation must be distinguishable from failure. Failpoints throw `ApplicationFailure`, and retry logic is expected to catch and retry those; a cancellation rejection is the opposite — retry logic must always propagate it. A retry loop that catches an abort and retries defeats the shutdown that requested it, spinning through instantly-rejecting pre-aborted backoff sleeps. `determined` must therefore provide a cancellation predicate (e.g. `isCancellation(e)`) alongside the existing `isApplicationFailure(e)`, and cancellation rejections must not be `ApplicationFailure`s. As with any other exception, a cancellation that escapes a task uncaught aborts the simulation — expected cancellations must be handled inside the task.

`'abort'` listeners dispatch synchronously in whatever stack aborts the signal: inside the scheduler's clock-advance step when a deadline expires (no task is running at all), or inside the aborting task's execution for an explicit abort. User listeners must therefore be plain synchronous state changes — set a flag, clear a reference, settle a low-level promise. They must not call task APIs (`checkpoint`, `failpoint`, `blockpoint`, `sleep`), operate blocking primitives, or consume entropy; any of these from listener context corrupts scheduler bookkeeping or entropy-stream stability. Tasks react to aborts by sleeping cancellably with the signal or calling `signal.throwIfAborted()` at wakeup points — never by attaching behavior to the event. A user listener that throws aborts the simulation with that error; the platform's report-and-continue dispatch behavior would hide bugs.

In simulation, the signal is a `determined`-owned implementation of the `AbortSignal` interface (native signals are neither constructible nor subclassable). Owning the signal separates internal plumbing from user code: the framework's sleep wakeups are privileged callbacks, not listeners, and run before any user listener — by the time user code observes an abort, the cancelled sleeper is already settled and schedulable. Only user listeners registered through the public `addEventListener` run under the safety guard of section 13. The owned signal also carries the diagnostic metadata — deadline reason, virtual abort time, owning operation — that sections 10 and 14 require. Application code must rely only on standard `AbortSignal` behavior: no `instanceof AbortSignal`, and no handing the signal to native APIs inside simulation. `noSimulation` hands out real signals, so the app-facing contract is exactly the standard one.

A lower-level cancellable sleep primitive is mandatory. pi-orb may initially implement `withTimedSignal` in a small wrapper if `determined` does not provide it directly.

## 7. Sleeping and scheduler quiescence

pi-orb does not require timed mutex or condition-variable operations. Its concurrency-critical coordination uses database compare-and-swap, explicit lifecycle state machines, serialized in-process mutation queues, and cancellable adapter operations rather than lock waiting.

A deterministic sleep must still register the task as sleeping/blocked with a pending timer. This lets the scheduler distinguish:

- no runnable task plus a pending timer, which advances virtual time;
- no runnable task and no timer, which is a true deadlock;
- a cancelled timer, which must no longer keep the simulation alive.

A general-purpose `determined` API may later compose timers with its existing blocking primitives, but that is outside pi-orb's minimum requirement. Operation-versus-timeout ordering must still be deterministic, cancellable, and replayable through the sleep/deadline/abort API.

## 8. Deterministic latency and failure scenarios

Simulated adapters need to express outcomes such as:

- a database commit succeeds after 100 ms;
- the control plane is unavailable for 30 seconds;
- a polling worker crashes immediately before or after a database commit;
- a health response arrives so close to its timeout that entropy can drive either order;
- a host stop operation takes longer than its deadline.

The basic mechanism can be ordinary deterministic sleep plus existing entropy/failpoints. `determined` does not need a domain-specific network simulator.

Example:

```ts
async function commit(task: SimulationTask, batch: Batch) {
  await task.sleep(task.random("commit latency") * 1_000, "database commit latency");
  await task.failpoint("database commit");
  return committed(batch);
}
```

All entropy requests and timer behavior must be included in replay diagnostics.

## 9. Record and replay requirements

A captured failure must include enough information to reproduce:

- entropy choices;
- failpoint outcomes;
- task scheduling choices;
- configured initial wall-clock epoch;
- explicit timer records: creation (reason and deadline), cancellation, and firing;
- virtual-time advances (derivable from the timer firing records; separate recording is optional validation).

Timer records are explicit, not derived from entropy. Entropy-only derivation cannot detect timer divergence in general: forced choices consume no entropy by design (the `sample()` single-element rule), so a run with a single pending timer — or a single task — leaves no entropy footprint in which a changed reason or deadline could be noticed. The trace therefore becomes a typed sequence of entropy records and timer records, validated in order during replay. This extends the existing entropy-only `(name, value)` record format and is a compatibility change to saved failure traces.

Replay should fail descriptively when code diverges, for example:

- a timer reason/name differs;
- a timer is created or cancelled in a different order;
- a different deadline is requested;
- the replay trace is exhausted;
- recorded timer events remain unused.

Diagnostics should report task name, timer reason, requested deadline, current virtual time, and trace position.

## 10. Logging and observability

Simulation logs should make time understandable. Each scheduling/checkpoint/failpoint log entry should be able to include the current virtual monotonic time.

Useful optional diagnostics include:

- pending timers ordered by deadline;
- blocked tasks and their reasons;
- the candidate deadlines for the next clock advance;
- timer creation and cancellation;
- which timer fired at each advance, and to what virtual time the clock moved.

Deadlock reports must distinguish:

- true deadlock with no pending timers;
- tasks blocked while a future timer exists;
- a simulation prevented from advancing by a runnable task that never yields.

Deadlock reports must also call out blocked tasks that hold an already-aborted signal, including the signal's reason and abort time. This is the typical signature of a deadline that could not interrupt a non-cancellable wait (section 6), and it turns a confusing deadlock into a self-explaining one.

That report has a completion-side twin: when work under a deadline completes well after its signal aborted, the simulation should report it, for example "operation under 'status deadline' (10,000 ms) completed at t=60,000, 50,000 ms after its signal aborted". This almost always means some operation ignored its signal (section 6). The check is free and deterministic under virtual time; it should warn by default and be escalatable to a failure in strict test configurations.

## 11. Production behavior

`noSimulation` should provide the same clock-facing API using real time:

- monotonic time from an appropriate monotonic source;
- wall time from `Date.now()`;
- cancellable sleep using real timers;
- timeout cancellation without leaked timers;
- normal `AbortSignal` behavior.

Business logic should not need `if (simulation)` branches.

## 12. Integration style

The preferred design is explicit dependency injection through `SimulationTask`, a `Clock`, or a small timer interface. Global replacement of `Date` and timer functions may be useful in a test helper, but should not be required for correctness.

pi-orb code should route all domain-level timing through this abstraction. Third-party libraries that use real timers remain outside deterministic control and should be wrapped by simulated adapters where their timing affects domain behavior.

A task is a single sequential coroutine and must never have two `determined`-parking operations in flight at once: `Promise.race` or `Promise.all` over checkpoint-bearing operations — checkpoints, failpoints, sleeps, mutex or condition-variable waits — within a single task is unsupported. The scheduler models exactly one park per task, and a second concurrent park corrupts its bookkeeping. Concurrency is expressed with multiple tasks; bounding work with a deadline is expressed with `withTimedSignal` and cooperative cancellation (section 6), which exist precisely so that intra-task races are never needed.

## 13. Safety requirements

The simulation should protect against accidental nontermination:

- configurable maximum scheduling steps;
- configurable maximum virtual duration;
- useful failure when either limit is exceeded;
- when the maximum-step guard trips, the failure must report whether virtual time was still advancing — a step budget exhausted at a fixed virtual time is the signature of a zero-duration-timer or checkpoint livelock, while exhaustion with time advancing means the scenario outgrew its budget;
- detection of task-API calls from a user `'abort'` listener, failing with a descriptive error — enforceable because only public `addEventListener` dispatch runs under the guard (section 6);
- cancellation cleanup when a simulation aborts;
- no timer state leaking between `SimulationImpl` runs.

Like the existing simulation runner, a failed/aborted time-capable simulation may remain single-use if that keeps semantics simple.

## 14. Minimum acceptance tests

A first usable implementation should demonstrate:

1. A one-hour sleep completes without one hour of real waiting.
2. While one task sleeps, another runnable task continues.
3. With all tasks sleeping, an entropy-chosen timer fires and virtual time advances to at least its deadline.
4. Timer firing order is entropy-controlled and replayable: deadline ties are broken by entropy, and a later-deadline timer can fire before an earlier one with virtual time advancing monotonically.
5. A pending timer prevents false deadlock detection.
6. No timers plus only blocked tasks produces a deadlock.
7. Cancelling a timer prevents a later wakeup.
8. Work completing before a timeout cancels the timeout.
9. An operation completing close to its timeout can be driven by entropy to either order — completion before abort, or abort before completion — and each replays exactly.
10. Recorded scheduling and timer behavior replay exactly.
11. Changing a timer reason or deadline produces a clear replay-divergence error.
12. `noSimulation` executes the same code using real time.
13. Maximum-step and maximum-virtual-time guards terminate pathological tests; a step budget exhausted at a fixed virtual time is reported as a livelock.
14. A pi-orb-style retry/backoff plus shutdown-flush scenario runs and replays deterministically.
15. A deadlock report identifies a blocked task holding an already-aborted signal.
16. A `withTimedSignal` callback that ignores its signal is not interrupted — it completes late, and the ignored-signal diagnostic reports the late completion.
17. A sleep given an already-aborted signal rejects immediately with the abort reason — no timer is registered and no entropy is consumed.
18. A retry loop retries simulated failpoint failures but immediately propagates a cancellation, distinguishing the two via the cancellation predicate, and replays exactly.
19. A task API called from a user `'abort'` listener fails with a clear error, while the internal sleep wakeup on the same signal works normally.
20. A negative sleep duration is rejected in both simulation and `noSimulation`; a zero-duration sleep yields through the scheduler without requiring a time advance.

## 15. Open API questions

- Should time live directly on `SimulationTask`, on a separate injected `Clock`, or both?
- Should production monotonic timestamps use milliseconds as floating point or a higher-precision representation?
