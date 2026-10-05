import { EventEmitter } from 'node:events';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { OfficeEvent, Task } from './db/schema.js';

export type BusMessage = { type: 'event'; event: OfficeEvent } | { type: 'task'; task: Task };

/**
 * Persists task events and fans them out to live listeners (the board's
 * WebSocket today, Slack in phase 2).
 */
export class EventBus {
  private emitter = new EventEmitter();

  constructor(private db: Db) {
    this.emitter.setMaxListeners(100);
  }

  emit(taskId: number | null, type: string, payload: Record<string, unknown> = {}, runId?: number): OfficeEvent {
    const event = this.db
      .insert(schema.events)
      .values({ taskId, runId: runId ?? null, type, payload })
      .returning()
      .get();
    this.emitter.emit('message', { type: 'event', event } satisfies BusMessage);
    return event;
  }

  taskChanged(task: Task): void {
    this.emitter.emit('message', { type: 'task', task } satisfies BusMessage);
  }

  subscribe(listener: (msg: BusMessage) => void): () => void {
    this.emitter.on('message', listener);
    return () => this.emitter.off('message', listener);
  }
}
