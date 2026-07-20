/**
 * Dispatches a user-registered `'abort'` listener. Provided by the
 * simulation so that user listeners run under its safety guard (task APIs
 * called from a listener fail descriptively, and a throwing listener aborts
 * the simulation), while the framework's own internal callbacks stay
 * privileged and unguarded.
 */
export interface UserListenerDispatcher {
    dispatchUserAbortListener(listener: () => void): void;
}

interface UserListener {
    readonly listener: (ev: Event) => void;
    readonly once: boolean;
}

/**
 * A `determined`-owned implementation of the `AbortSignal` interface, used
 * for deadline signals in simulation (native signals are neither
 * constructible nor subclassable). Owning the signal separates internal
 * plumbing from user code: the framework's sleep wakeups are privileged
 * callbacks, not listeners, and run before any user listener — by the time
 * user code observes an abort, the cancelled sleeper is already settled and
 * schedulable.
 *
 * Application code must rely only on standard `AbortSignal` behavior: no
 * `instanceof AbortSignal`, and no handing the signal to native APIs inside
 * simulation.
 */
export class OwnedAbortSignal {
    private _aborted = false;
    private _reason: unknown;
    private _abortedAtMs: number | undefined;
    private readonly internalCallbacks: (() => void)[] = [];
    private userListeners: UserListener[] = [];
    private readonly dispatcher: UserListenerDispatcher;
    public onabort: ((ev: Event) => void) | null = null;

    constructor(dispatcher: UserListenerDispatcher) {
        this.dispatcher = dispatcher;
    }

    public get aborted(): boolean {
        return this._aborted;
    }

    public get reason(): unknown {
        return this._reason;
    }

    /** The virtual monotonic time at which the signal aborted, for diagnostics. */
    public get abortedAtMs(): number | undefined {
        return this._abortedAtMs;
    }

    public throwIfAborted(): void {
        if (this._aborted) throw this._reason;
    }

    public addEventListener(
        type: string,
        listener: (ev: Event) => void,
        options?: boolean | { readonly once?: boolean },
    ): void {
        if (type !== "abort") return;
        // Standard semantics: the abort event is one-shot and never re-fires,
        // so listeners added after the abort are never called.
        if (this._aborted) return;
        const once = typeof options === "object" ? (options.once ?? false) : false;
        this.userListeners.push({ listener, once });
    }

    public removeEventListener(type: string, listener: (ev: Event) => void): void {
        if (type !== "abort") return;
        const index = this.userListeners.findIndex((l) => l.listener === listener);
        if (index >= 0) this.userListeners.splice(index, 1);
    }

    public dispatchEvent(): boolean {
        throw new Error("dispatchEvent is not supported on a determined-owned AbortSignal");
    }

    /**
     * Registers a privileged internal callback, run synchronously on abort
     * BEFORE any user listener and outside the user-listener safety guard.
     * Returns a detach function.
     */
    public addInternalCallback(callback: () => void): () => void {
        this.internalCallbacks.push(callback);
        return () => {
            const index = this.internalCallbacks.indexOf(callback);
            if (index >= 0) this.internalCallbacks.splice(index, 1);
        };
    }

    /**
     * Aborts the signal. Internal callbacks run first (settling cancelled
     * sleepers), then user listeners, each under the dispatcher's guard.
     * Idempotent: only the first abort has any effect.
     */
    public abort(reason: unknown, abortedAtMs: number): void {
        if (this._aborted) return;
        this._aborted = true;
        this._reason = reason;
        this._abortedAtMs = abortedAtMs;
        const internal = this.internalCallbacks.splice(0);
        for (const callback of internal) {
            callback();
        }
        const listeners = this.userListeners;
        this.userListeners = [];
        const event = { type: "abort", target: this } as unknown as Event;
        for (const { listener } of listeners) {
            this.dispatcher.dispatchUserAbortListener(() => listener.call(this, event));
        }
        const { onabort } = this;
        if (onabort !== null) {
            this.dispatcher.dispatchUserAbortListener(() => onabort.call(this, event));
        }
    }
}
