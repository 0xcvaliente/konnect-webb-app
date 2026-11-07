/**
 * Orders the project form's calls to the server. Autosaves run one after another, a moment after
 * the last change. A send cancels the pending autosave, waits for a save already running, and
 * blocks new saves until it fails; after a successful send no save runs again. Without this, an
 * autosave that fires during a send runs after it (Next.js runs Server Actions one at a time)
 * and, while the form has no project id yet, creates a second project.
 */
export type SaveQueue = ReturnType<typeof createSaveQueue>

export function createSaveQueue(delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let tail: Promise<unknown> = Promise.resolve()
  /** True while a send runs, and for good once one went through. */
  let locked = false

  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
  }

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task)
    tail = next.catch(() => undefined)
    return next
  }

  /** Save now, after any save already running. Does nothing while or after a send. */
  const saveNow = (save: () => Promise<void>): Promise<void> => {
    cancel()
    return enqueue(async () => {
      if (!locked) await save()
    })
  }

  return {
    saveNow,
    /** Save a moment after the last change (each call restarts the wait). */
    schedule(save: () => Promise<void>) {
      cancel()
      if (!locked) timer = setTimeout(() => void saveNow(save), delayMs)
    },
    /**
     * Run the send after any save already running, with no autosave before or after it. `sent`
     * says whether it went through; if not, saving works again.
     */
    async send<T>(task: () => Promise<T>, sent: (result: T) => boolean): Promise<T> {
      cancel()
      locked = true
      try {
        const result = await enqueue(task)
        if (!sent(result)) locked = false
        return result
      } catch (error) {
        locked = false
        throw error
      }
    },
    /** Drop the pending autosave (when the form goes away). */
    cancel,
    get locked() {
      return locked
    },
  }
}
