'use client'

import { FileTextIcon, LoaderCircleIcon, PlusIcon, UploadIcon, XIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useRouter } from '@/i18n/navigation'
import { submitDeliverableAction } from '@/lib/deliverables/actions'
import {
  DELIVERABLE_IDLE,
  fileSizeText,
  HAND_IN_EXTENSIONS,
  HAND_IN_MAX_BYTES,
  LINK_LABEL_MAX,
  LINK_URL_MAX,
  MAX_LINKS,
  NOTE_MAX,
} from '@/lib/deliverables/fields'

/** At most this many files on one hand-in (owner decision 6 Nov 2026). */
const MAX_FILES = 10

type Uploaded = { id: number; name: string; size: number | null }
type UploadError = 'type' | 'size' | 'tooMany' | 'full' | 'generic'

const ACCEPT = [
  ...HAND_IN_EXTENSIONS.map((e) => `.${e}`),
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/zip',
].join(',')

const extensionOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

/**
 * Upload one file for the match through Payload's REST endpoint as the signed-in student. The
 * server checks everything again: the session, that the match is the student's, the real type
 * from the file's bytes, 50 MB at most, and the limit on files not yet handed in.
 */
async function upload(file: File, matchId: number): Promise<Uploaded | { error: UploadError }> {
  if (!(HAND_IN_EXTENSIONS as readonly string[]).includes(extensionOf(file.name)))
    return { error: 'type' }
  if (file.size > HAND_IN_MAX_BYTES) return { error: 'size' }
  const form = new FormData()
  form.append('file', file)
  form.append('_payload', JSON.stringify({ match: matchId }))
  try {
    const res = await fetch('/api/deliverable-files', {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
    })
    if (res.status === 413) return { error: 'size' }
    if (res.status === 429) return { error: 'tooMany' }
    if (res.status === 400) return { error: 'type' }
    if (!res.ok) return { error: 'generic' }
    const { doc } = (await res.json()) as {
      doc: { id: number; originalName?: string; filesize?: number }
    }
    return { id: doc.id, name: doc.originalName ?? file.name, size: doc.filesize ?? null }
  } catch {
    return { error: 'generic' }
  }
}

/** Remove a file that was uploaded but not handed in. Best effort; the nightly clean-up does the rest. */
async function remove(id: number) {
  try {
    await fetch(`/api/deliverable-files/${id}`, { method: 'DELETE', credentials: 'same-origin' })
  } catch {
    // Left for the clean-up job.
  }
}

/**
 * "Upload your work" ("Final pass" mockup, the student's application page): a drop zone for up to
 * 10 files, links with an optional label, a note, then "Send to Konnected". Konnected checks the
 * work before the company sees anything.
 */
export function HandInForm({ matchId, company }: { matchId: number; company: string }) {
  const t = useTranslations('StudentWork')
  const te = useTranslations('Deliverables.errors')
  const id = useId()
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<Uploaded[]>([])
  const [links, setLinks] = useState<{ key: number; label: string; url: string }[]>([])
  const [note, setNote] = useState('')
  const [uploading, setUploading] = useState(0)
  const [problem, setProblem] = useState<UploadError | null>(null)
  const [state, run, pending] = useActionState(submitDeliverableAction, DELIVERABLE_IDLE)
  const seen = useRef<number | undefined>(undefined)
  const nextKey = useRef(1)

  useEffect(() => {
    if (state.status === 'idle' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    if (state.status === 'done') {
      toast(t('sentToast'))
      // The page then shows the hand-in as waiting for Konnected; the form is gone.
      router.refresh()
    } else if (state.error === 'not_open' || state.error === 'waiting' || state.error === 'done') {
      router.refresh()
    }
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result

  const pick = async (list: FileList | null) => {
    if (!list?.length) return
    setProblem(null)
    const room = MAX_FILES - files.length
    const chosen = Array.from(list).slice(0, Math.max(0, room))
    if (list.length > room) setProblem('full')
    let next = files
    for (const file of chosen) {
      setUploading((n) => n + 1)
      const result = await upload(file, matchId)
      setUploading((n) => n - 1)
      if ('error' in result) {
        setProblem(result.error)
        break
      }
      next = [...next, result]
      setFiles(next)
    }
    if (input.current) input.current.value = ''
  }

  const busy = pending || uploading > 0
  const error = state.status === 'error' ? state.error : null
  const full = files.length >= MAX_FILES

  return (
    <form action={run} className="grid gap-4" aria-busy={busy || undefined}>
      <input type="hidden" name="matchId" value={matchId} />
      {files.map((f) => (
        <input key={f.id} type="hidden" name="file" value={f.id} />
      ))}

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-[0.9rem] font-semibold">{t('filesLegend')}</legend>
        {files.length > 0 && (
          <ul className="grid gap-2" aria-label={t('filesListLabel')}>
            {files.map((file) => (
              <li
                key={file.id}
                className="flex flex-wrap items-center gap-3 rounded-item border-[1.5px] border-line bg-surface px-3.5 py-3"
              >
                <FileTextIcon aria-hidden="true" className="size-[22px] shrink-0 text-primary" />
                <div className="min-w-0 flex-1 basis-40">
                  <p className="font-semibold [overflow-wrap:anywhere]">{file.name}</p>
                  {fileSizeText(file.size) && (
                    <p className="text-[0.85rem] text-muted-foreground">
                      {fileSizeText(file.size)}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setProblem(null)
                    setFiles((list) => list.filter((f) => f.id !== file.id))
                    void remove(file.id)
                  }}
                >
                  {t('removeFile')}
                  <span className="sr-only">: {file.name}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
        {!full && (
          <div className="grid justify-items-center gap-2 rounded-item border-[1.5px] border-dashed border-input bg-surface-2 px-4 py-6 text-center">
            <UploadIcon aria-hidden="true" className="size-[26px] text-primary" />
            <p className="font-semibold">{t('dropTitle')}</p>
            <p className="text-[0.85rem] text-muted-foreground">{t('dropHint')}</p>
            <input
              ref={input}
              id={`${id}-file`}
              type="file"
              multiple
              accept={ACCEPT}
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
              disabled={busy}
              onChange={(e) => pick(e.target.files)}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              {t('chooseFiles')}
            </Button>
          </div>
        )}
        <p className="text-[0.82rem] text-muted-foreground">
          {t('filesCount', { count: files.length, max: MAX_FILES })}
        </p>
        <p role="status" className="text-[0.88rem] text-muted-foreground empty:hidden">
          {uploading > 0 && (
            <span className="inline-flex items-center gap-2">
              <LoaderCircleIcon aria-hidden="true" className="size-4 motion-safe:animate-spin" />
              {t('uploading')}
            </span>
          )}
        </p>
        {problem && (
          <Banner tone="bad" role="alert">
            <p>{t(`uploadErrors.${problem}`, { max: MAX_FILES })}</p>
          </Banner>
        )}
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-[0.9rem] font-semibold">{t('linksLegend')}</legend>
        <p className="-mt-1 text-[0.82rem] text-muted-foreground">{t('linksHint')}</p>
        {links.map((link, i) => (
          <div
            key={link.key}
            className="grid gap-2 rounded-item border-[1.5px] border-line p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] sm:items-end"
          >
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-label-${link.key}`}>{t('linkLabel')}</Label>
              <Input
                id={`${id}-label-${link.key}`}
                name="linkLabel"
                maxLength={LINK_LABEL_MAX}
                value={link.label}
                onChange={(e) =>
                  setLinks((all) =>
                    all.map((l) => (l.key === link.key ? { ...l, label: e.target.value } : l)),
                  )
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-url-${link.key}`}>{t('linkUrl')}</Label>
              <Input
                id={`${id}-url-${link.key}`}
                name="linkUrl"
                type="url"
                inputMode="url"
                required
                maxLength={LINK_URL_MAX}
                placeholder="https://"
                value={link.url}
                onChange={(e) =>
                  setLinks((all) =>
                    all.map((l) => (l.key === link.key ? { ...l, url: e.target.value } : l)),
                  )
                }
              />
            </div>
            <Button
              type="button"
              variant="text"
              size="sm"
              onClick={() => setLinks((all) => all.filter((l) => l.key !== link.key))}
            >
              <XIcon aria-hidden="true" className="size-4" />
              {t('removeLink')}
              <span className="sr-only"> {i + 1}</span>
            </Button>
          </div>
        ))}
        {links.length < MAX_LINKS && (
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                setLinks((all) => [...all, { key: nextKey.current++, label: '', url: '' }])
              }
            >
              <PlusIcon aria-hidden="true" className="size-4" />
              {t('addLink')}
            </Button>
          </div>
        )}
      </fieldset>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-note`}>{t('noteLabel')}</Label>
        <Textarea
          id={`${id}-note`}
          name="note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={NOTE_MAX}
          aria-describedby={`${id}-note-hint`}
        />
        <p id={`${id}-note-hint`} className="text-[0.82rem] text-muted-foreground">
          {t('noteHint', { company })}
        </p>
      </div>

      {error && (
        <Banner tone="bad" role="alert">
          <p>{te(error)}</p>
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy} aria-busy={pending || undefined}>
          {pending && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
          {pending ? t('sending') : t('send')}
        </Button>
        <span className="text-[0.85rem] text-muted-foreground">
          {uploading > 0 ? t('waitForUploads') : t('sendHint', { company })}
        </span>
      </div>
    </form>
  )
}
