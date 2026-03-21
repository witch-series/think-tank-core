'use strict';

const { EventEmitter } = require('events');

class TaskManager extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.currentTask = null;
    this.running = false;
    this.paused = false;
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
      this.emit('idle');
      return;
    }

    this.currentTask = this.queue.shift();
    this.emit('task:start', this.currentTask);

    try {
      const result = await this.currentTask.execute();
      this.emit('task:complete', { task: this.currentTask, result });
    } catch (err) {
      this.emit('task:error', { task: this.currentTask, error: err });
    } finally {
      this.currentTask = null;
      if (this.running && !this.paused) {
        this._next();
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

function createTask(name, executeFn) {
  return { name, execute: executeFn, createdAt: new Date().toISOString() };
}

module.exports = { TaskManager, createTask };
