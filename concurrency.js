'use strict';

// FIFO semaphore. acquire() resolves when a slot opens; release() must be
// called (preferably in a finally block) to return the slot.
// isCancelled is checked on each queue tick so cancellation is felt promptly.
class Semaphore {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Semaphore limit must be >= 1');
    this._limit   = limit;
    this._active  = 0;
    this._queue   = [];
  }

  acquire(isCancelled) {
    if (isCancelled?.()) return Promise.reject(new Error('CANCELLED'));

    return new Promise((resolve, reject) => {
      const tryAcquire = () => {
        if (isCancelled?.()) { reject(new Error('CANCELLED')); return; }
        if (this._active < this._limit) {
          this._active++;
          resolve();
        } else {
          this._queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  release() {
    this._active = Math.max(0, this._active - 1);
    while (this._queue.length && this._active < this._limit) {
      const next = this._queue.shift();
      next();
    }
  }

  // Convenience: run fn() inside an acquired slot.
  async run(fn, isCancelled) {
    await this.acquire(isCancelled);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get active()  { return this._active; }
  get queued()  { return this._queue.length; }
  get limit()   { return this._limit; }
}

module.exports = { Semaphore };
