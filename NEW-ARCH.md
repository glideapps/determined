# All-quiescence scheduling: a simpler architecture, not (yet) adopted

This document writes up a simplification of the scheduler that came out of
fixing cross-task promise sharing (a task awaiting a promise settled by
another task used to hang the simulation silently). It describes the
current two-path architecture, the proposed single-path alternative, and
the trade-offs that kept the alternative out of the codebase for now.

## Background: what the bookkeeping can and cannot know

The scheduler tracks each task in one of three states (`TaskInfo.resolve`):

| State | Meaning | Nature |
| --- | --- | --- |
| a function | parked at a checkpoint/failpoint; the function is its continuation | **fact** — the scheduler holds the wake mechanism |
| `false` | blocked (sleeping on a timer, waiting on a mutex/CV) | **fact** — a timer fire or a notify routes the wake back through the scheduler |
| `undefined` | "running" | **prediction** — "this task will re-enter the scheduler at its next park or finish" |

The first two states are exact because nothing outside the scheduler can
invalidate them. The third is a bet, and JavaScript provides no hook at
the moment a task awaits something, so the scheduler cannot observe
suspension — it can only assume re-entry. The bet is wrong in exactly one
situation: the task awaited a promise the scheduler doesn't manage
(another task's promise, a bare deferred). And the wrongness is
observable at exactly one kind of moment: *quiescence*, when the
microtask queue has drained and the predicted re-entry has demonstrably
not happened.

## The current architecture: two paths

1. **Synchronous path** (`unlockIfNecessary` → `scheduleNext`): runs
   inside park/finish calls. If any task is marked running, it does
   nothing (someone will re-enter). Otherwise every state is a fact, and
   it is safe to make scheduling decisions immediately and to fire
   several timers in a row until a task becomes schedulable.
2. **Quiescence probe** (`armQuiescenceProbe` → `onQuiescence`): armed
   whenever the scheduler hands control to user code; fires as a
   macrotask, i.e. strictly after the whole microtask queue has drained.
   A task still marked running at that point is provably suspended on an
   unmanaged promise, and the probe treats it as blocked. Unlike the
   synchronous path it fires at most **one** timer per probe and then
   re-arms: a fired timer may settle promises via deadline abort
   listeners, and those wake-ups sit in the microtask queue until the
   probe returns — firing further timers would advance time past a
   wake-up already in flight, or misreport a deadlock. Errors raised in a
   probe have no task stack, so they fail `runTasks` through an
   out-of-band rejection channel (`Promise.race`).

One-line summary: **bookkeeping where it's fact, observation where it's
prediction.**

## The proposed simplification: quiescence as the only scheduling point

Delete the synchronous path. Park calls only register their continuation
and arm the probe; *every* scheduling decision — picking a parked task,
firing a timer, declaring deadlock — happens in a probe, at quiescence.

What this removes:

- `unlockIfNecessary` and its someone-is-running early return. The
  "running" state stops mattering entirely: at quiescence nobody is
  running, so the scheduler never needs to ask.
- The dual firing rule. Fire-one-then-yield becomes the only rule, and
  it is the safer one everywhere.
- `unlockIfNecessaryAfterPark` and its rollback contract. It exists only
  because the synchronous path can throw *through* a parking task's
  stack, which corrupts the park slot unless carefully rolled back. With
  no synchronous scheduling, park calls that don't themselves consume
  entropy cannot throw, and the subtlest exception-path code in the
  scheduler disappears. (`sleep`'s rollback survives in reduced form:
  timer registration can still raise a trace-divergence error in task
  context.)
- The two-channel error story. All scheduling errors go through the
  out-of-band channel; only task-attributable errors (failpoint draws,
  `task.random`, timer-creation divergence) still throw in task context.

Scheduling decisions would depend on the same scheduler states in the
same order — a decision made "immediately when the last task parks"
observes the same candidates and draws the same entropy as the same
decision deferred to the quiescence that immediately follows — so
recorded traces are expected to replay unchanged for closed-world
workloads. This must be verified (golden traces recorded on the current
scheduler, replayed on the new one) before adopting.

## Why it hasn't been adopted

1. **It changes the error-injection contract.** Today an entropy source
   that throws from a scheduling pick (a DST resource guard tripping)
   throws synchronously into whichever task happened to park last, and
   that task can catch it and recover — documented, tested behavior. In
   the all-quiescence design the pick happens in a macrotask, so every
   scheduling error fails the run out-of-band; no task can intercept it.
   Arguably cleaner (the current attribution — "whoever parked last eats
   the throw" — is accidental), but it is a deliberate breaking change,
   not a refactor, and it deletes a feature: recoverable entropy-guard
   trips.
2. **Every scheduling step costs a macrotask hop.** The current
   synchronous path schedules thousands of steps per run purely in
   microtasks. Deferring every decision to `setImmediate` adds a real
   constant factor to step-dense simulations, and DST workloads run many
   iterations.
3. **The win is smaller than it looks.** The probe machinery (arming,
   run tokens, the out-of-band channel) is needed in both designs; the
   synchronous path that would be deleted is the simple, well-tested
   part. The genuinely subtle deletion — the park rollback contract —
   only shrinks, because timer-registration divergence still throws in
   task context.

## When to adopt it

In a major version, if/when breaking the "tasks can catch scheduler
throws from park calls" contract is acceptable. The migration should:

- move all scheduling-pick entropy draws and deadlock/budget errors to
  the out-of-band channel, keeping task-context throws only for
  failpoint draws, `task.random`, and timer-creation divergence;
- verify trace compatibility with golden traces recorded on the old
  scheduler (same scenario, replay must fully consume);
- benchmark step-dense simulations to size the macrotask-hop cost;
- re-run the existing suite expecting failures *only* in tests that
  assert the sync error-injection contract, and rewrite those as
  out-of-band assertions.
