'use strict';

class TokenBucket {
  constructor({ requestsPerMinute, burstSize }) {
    this._rate     = requestsPerMinute / 60;             // tokens / second
    this._capacity = burstSize ?? requestsPerMinute;
    this._tokens   = this._capacity;
    this._lastTime = performance.now();
  }

  _refill() {
    const now     = performance.now();
    const elapsed = Math.max(0, (now - this._lastTime) / 1000);
    this._tokens  = Math.min(this._capacity, this._tokens + elapsed * this._rate);
    this._lastTime = now;
  }

  // Resolves when a token is available, optionally calling onWait(waitMs) before sleeping.
  // isCancelled() is checked before each poll so cancellation interrupts long waits.
  // Wait notifications are throttled; the polling loop stays fast for cancellation,
  // but UI callers do not receive a duplicate update every 100 ms.
  acquire(onWait, isCancelled) {
    return new Promise((resolve, reject) => {
      let lastWaitNotificationAt = 0;
      const attempt = () => {
        if (isCancelled?.()) { reject(new Error('CANCELLED')); return; }
        this._refill();
        if (this._tokens >= 1) {
          this._tokens -= 1;
          resolve();
        } else {
          const waitMs = Math.ceil((1 - this._tokens) / this._rate * 1000);
          const now = performance.now();
          if (onWait && (lastWaitNotificationAt === 0 || now - lastWaitNotificationAt >= 1000)) {
            lastWaitNotificationAt = now;
            onWait(waitMs);
          }
          setTimeout(attempt, Math.min(waitMs, 100));   // poll ≤ 100 ms so cancel is felt quickly
        }
      };
      attempt();
    });
  }
}

// Registry of token buckets built from config. Existing per-command keys still
// work, and agents can opt into finer buckets with an explicit rateLimitKey:
// { "some-cli": {...}, "provider:model-tier": {...}, "my-provider:fast-model": {...} }
class RateLimiterRegistry {
  constructor(limits = {}) {
    this._limits  = limits;
    this._buckets = new Map();
  }

  keyFor(agentCfgOrCommand) {
    if (typeof agentCfgOrCommand === 'string') return agentCfgOrCommand;

    const command = agentCfgOrCommand?.command;
    if (!command) return '';
    return agentCfgOrCommand.rateLimitKey || command;
  }

  _bucket(agentCfgOrCommand) {
    const key = this.keyFor(agentCfgOrCommand);
    const cfg = this._limits[key];
    if (!cfg) return null;
    if (!this._buckets.has(key)) {
      this._buckets.set(key, new TokenBucket(cfg));
    }
    return this._buckets.get(key);
  }

  // Waits for a token for the given agent/key. No-op if no limit is configured.
  async acquire(agentCfgOrCommand, onWait, isCancelled) {
    const bucket = this._bucket(agentCfgOrCommand);
    if (bucket) await bucket.acquire(onWait, isCancelled);
  }

  // Diagnostic: tokens currently available for an agent/key.
  available(agentCfgOrCommand) {
    const key = this.keyFor(agentCfgOrCommand);
    const b = this._buckets.get(key);
    if (!b) return Infinity;
    b._refill();
    return Math.floor(b._tokens);
  }
}

module.exports = { RateLimiterRegistry };
