import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSaveQueue } from '@/lib/projects/saveQueue'

const AUTOSAVE_MS = 1200

/** A promise the test resolves by hand, to hold a server call open. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/**
 * The project form as far as ordering goes: a fake server that creates a project when the call
 * has no id (as saveProjectDraftAction and sendProjectForReviewAction do), and a form that reads
 * the id at call time, like the real one.
 */
function form() {
  const projects: { id: number; status: 'draft' | 'submitted' }[] = []
  let id: number | undefined
  let sendGate: Promise<void> = Promise.resolve()
  let saveGate: Promise<void> = Promise.resolve()
  const write = (status: 'draft' | 'submitted') => {
    let project = projects.find((p) => p.id === id)
    if (!project) {
      project = { id: projects.length + 1, status: 'draft' }
      projects.push(project)
    }
    if (project.status !== 'draft') return { status: 'error' as const, id: project.id }
    project.status = status
    id = project.id
    return { status: status === 'submitted' ? ('sent' as const) : ('saved' as const), id }
  }
  const saves = vi.fn(async () => {
    await saveGate
    write('draft')
  })
  const queue = createSaveQueue(AUTOSAVE_MS)
  const send = (outcome: 'sent' | 'fail' = 'sent') =>
    queue.send(
      async () => {
        await sendGate
        return outcome === 'sent' ? write('submitted') : { status: 'error' as const, id }
      },
      (result) => result.status === 'sent',
    )
  return {
    projects,
    saves,
    queue,
    send,
    holdSave: (gate: Promise<void>) => {
      saveGate = gate
    },
    holdSend: () => {
      const gate = deferred<void>()
      sendGate = gate.promise
      return gate.resolve
    },
  }
}

describe('project form save queue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sending within the autosave wait of the last change creates one project, not two', async () => {
    const f = form()
    // The company types the title last, so nothing is saved yet, then sends at once.
    f.queue.schedule(f.saves)
    const release = f.holdSend()
    const sending = f.send()
    // The send is still on the server when the autosave wait runs out.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)
    release()
    const result = await sending
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)

    expect(result).toEqual({ status: 'sent', id: 1 })
    expect(f.saves).not.toHaveBeenCalled()
    expect(f.projects).toEqual([{ id: 1, status: 'submitted' }])
  })

  it('runs no save after a send went through, even when asked', async () => {
    const f = form()
    f.queue.schedule(f.saves)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(f.saves).toHaveBeenCalledTimes(1)

    await f.send()
    f.queue.schedule(f.saves)
    await f.queue.saveNow(f.saves)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2)

    expect(f.saves).toHaveBeenCalledTimes(1)
    expect(f.queue.locked).toBe(true)
    expect(f.projects).toEqual([{ id: 1, status: 'submitted' }])
  })

  it('lets a save already running finish first, so the send uses its project', async () => {
    const f = form()
    const gate = deferred<void>()
    f.holdSave(gate.promise)
    const saving = f.queue.saveNow(f.saves)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.saves).toHaveBeenCalledTimes(1) // running, held on the server
    const sending = f.send()
    gate.resolve()
    await saving
    expect(await sending).toEqual({ status: 'sent', id: 1 })
    expect(f.projects).toEqual([{ id: 1, status: 'submitted' }])
  })

  it('saves again after a send that did not go through', async () => {
    const f = form()
    const result = await f.send('fail')
    expect(result.status).toBe('error')
    expect(f.queue.locked).toBe(false)

    f.queue.schedule(f.saves)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS)
    expect(f.saves).toHaveBeenCalledTimes(1)
  })

  it('unlocks when the send throws', async () => {
    const f = form()
    await expect(
      f.queue.send(
        () => Promise.reject(new Error('network')),
        () => true,
      ),
    ).rejects.toThrow('network')
    expect(f.queue.locked).toBe(false)
  })

  it('waits for the last change before saving, and saves once', async () => {
    const f = form()
    f.queue.schedule(f.saves)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 100)
    f.queue.schedule(f.saves)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 100)
    expect(f.saves).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(f.saves).toHaveBeenCalledTimes(1)
  })
})
