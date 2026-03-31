'use strict';

const { EventEmitter } = require('events');

class TaskManager extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.currentTask = null;
    this.running = false;
    this.paused = false;
    this.lastActivityTime = Date.now();
  }

  enqueue(task) {
    this.queue.push(task);
    this.emit('task:enqueued', task);
    if (this.running && !this.currentTask && !this.paused) {
      this._next();
    }
  }

  prioritize(task) {
    this.queue.unshift(task);
    this.emit('task:prioritized', task);
    if (this.running && !this.currentTask && !this.paused) {
      this._next();
    }
  }

  start() {
    this.running = true;
    this.paused = false;
    this.emit('started');
    this._next();
  }

  stop() {
    this.running = false;
    this.emit('stopped');
  }

  pause() {
    this.paused = true;
    this.emit('paused');
  }

  resume() {
    this.paused = false;
    this.emit('resumed');
    if (this.running && !this.currentTask) {
      this._next();
    }
  }

  async _next() {
    if (!this.running || this.paused) return;

    if (this.queue.length === 0) {
      try { this.emit('idle'); } catch {}
      // Check again — idle handler may have enqueued tasks
      if (this.queue.length > 0) {
        setImmediate(() => this._next());
      }
      return;
    }

    this.currentTask = this.queue.shift();
    this.lastActivityTime = Date.now();
    try { this.emit('task:start', this.currentTask); } catch {}

    try {
      const result = await this.currentTask.execute();
      try { this.emit('task:complete', { task: this.currentTask, result }); } catch {}
    } catch (err) {
      try { this.emit('task:error', { task: this.currentTask, error: err }); } catch {}
    } finally {
      this.currentTask = null;
      this.lastActivityTime = Date.now();
      if (this.running && !this.paused) {
        // Use setImmediate to avoid stack overflow on long chains
        // and ensure enqueue from event handlers is processed
        setImmediate(() => this._next());
      }
    }
  }

  getStatus() {
    return {
      running: this.running,
      paused: this.paused,
      currentTask: this.currentTask ? this.currentTask.name : null,
      queueLength: this.queue.length,
      queuedTasks: this.queue.map(t => t.name)
    };
  }
}

const createTask = (name, executeFn) => {
  return { name, execute: executeFn, createdAt: new Date().toISOString() };
}

module.exports = { TaskManager, createTask };
