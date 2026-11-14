/** A first-in, first-out lock for work that must not overlap, such as two writers of one git repository. */
export class Lock {
  private tail: Promise<unknown> = Promise.resolve();

  /** Runs `fn` after every earlier caller has finished, and returns its result. A failure does not block the next caller. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
