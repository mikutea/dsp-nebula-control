import type { JobRecord, ServerStatus } from '../domain.js'

export type ControlEvent =
  | { type: 'job.updated'; data: JobRecord }
  | { type: 'status.updated'; data: ServerStatus }

type Subscriber = (event: ControlEvent) => void

export class EventHub {
  readonly #subscribers = new Set<Subscriber>()

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber)
    return () => this.#subscribers.delete(subscriber)
  }

  publish(event: ControlEvent): void {
    for (const subscriber of this.#subscribers) subscriber(event)
  }
}
