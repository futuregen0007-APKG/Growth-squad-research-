/**
 * semaphore.js
 * ==============
 * Minimal async concurrency gate. Used to cap global concurrency for a
 * given kind of external call (discovery/download/OpenAI) independently of
 * how many companies the batch runner processes in parallel -- e.g.
 * company-concurrency=2 with openaiConcurrency=1 must still mean only ONE
 * OpenAI call in flight at a time across BOTH companies, not two.
 */
export class Semaphore {
  constructor(maxConcurrent) {
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 1);
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.maxConcurrent) {
      this.current += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.current += 1;
  }

  release() {
    this.current -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export default Semaphore;
