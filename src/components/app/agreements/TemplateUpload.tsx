'use client'

import { FileUpIcon, LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useRouter } from '@/i18n/navigation'
import { templateAction } from '@/lib/agreements/actions'
import { AGREEMENT_KINDS, type AgreementKind, TEMPLATE_MAX_BYTES } from '@/lib/agreements/fields'
import { IDLE } from '@/lib/agreements/state'

type Problem = { code: string; tags?: string[] }

/**
 * Upload a template through Payload's REST endpoint as the signed-in team member. The server
 * checks everything (admin only, .docx by content, sizes, the fields) and says what is wrong; the
 * checks here only give a faster answer.
 */
async function upload(
  file: File,
  kind: AgreementKind,
): Promise<{ version: number } | { problem: Problem }> {
  if (!file.name.toLowerCase().endsWith('.docx')) {
    return { problem: { code: file.name.toLowerCase().endsWith('.docm') ? 'macros' : 'not_docx' } }
  }
  if (file.size > TEMPLATE_MAX_BYTES) return { problem: { code: 'too_large' } }
  const form = new FormData()
  form.append('file', file)
  form.append('_payload', JSON.stringify({ kind }))
  try {
    const res = await fetch('/api/agreement-templates', {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
    })
    const body = (await res.json().catch(() => ({}))) as {
      doc?: { version?: number }
      errors?: { data?: { problem?: Problem } }[]
    }
    if (res.ok && body.doc) return { version: body.doc.version ?? 0 }
    if (res.status === 413) return { problem: { code: 'too_large' } }
    return { problem: body.errors?.[0]?.data?.problem ?? { code: 'generic' } }
  } catch {
    return { problem: { code: 'generic' } }
  }
}

export function TemplateUpload({ defaultKind = 'company' }: { defaultKind?: AgreementKind }) {
  const t = useTranslations('AgreementTemplates')
  const k = useTranslations('Agreements')
  const id = useId()
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState<AgreementKind>(defaultKind)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  // Only the latest upload's answer counts.
  const latest = useRef(0)

  const pick = async (file: File | undefined) => {
    if (!file) return
    const mine = ++latest.current
    setProblem(null)
    setBusy(true)
    const result = await upload(file, kind)
    if (mine !== latest.current) return
    setBusy(false)
    if (input.current) input.current.value = ''
    if ('problem' in result) {
      setProblem(result.problem)
      return
    }
    toast(t('uploadedToast', { version: result.version }))
    router.refresh()
  }

  const known = [
    'kind',
    'not_docx',
    'too_large',
    'unzipped_too_large',
    'too_many_parts',
    'broken_file',
    'macros',
    'malformed',
    'unknown_fields',
    'not_allowed_here',
    'logic_tags',
    'no_fields',
  ] as const
  const code =
    problem && (known as readonly string[]).includes(problem.code) ? problem.code : 'generic'

  return (
    <div className="grid gap-4" aria-busy={busy || undefined}>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-[0.9rem] font-semibold">{t('kind')}</legend>
        <div className="flex flex-wrap gap-2">
          {AGREEMENT_KINDS.map((value) => (
            <label
              key={value}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border-[1.5px] border-line px-4 font-semibold has-checked:border-transparent has-checked:bg-tint has-checked:text-tint-foreground has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary sm:min-h-9"
            >
              <input
                type="radio"
                name={`${id}-kind`}
                value={value}
                checked={kind === value}
                onChange={() => setKind(value)}
                className="sr-only"
              />
              {k(`kind.${value}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid justify-items-center gap-2 rounded-item border-[1.5px] border-dashed border-input bg-surface-2 px-4 py-6 text-center">
        <FileUpIcon aria-hidden="true" className="size-[26px] text-primary" />
        <Label htmlFor={`${id}-file`} className="sr-only">
          {t('choose')}
        </Label>
        <input
          ref={input}
          id={`${id}-file`}
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          disabled={busy}
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
          {busy ? t('uploading') : t('choose')}
        </Button>
        <p className="text-[0.85rem] text-muted-foreground">
          {t('fileHint', {
            example: '{{project.title}}',
            max: Math.round(TEMPLATE_MAX_BYTES / (1024 * 1024)),
          })}
        </p>
      </div>
      {problem && (
        <Banner tone="bad" role="alert">
          <p>{t(`problems.${code}`, { tags: (problem.tags ?? []).join(', ') })}</p>
        </Banner>
      )}
    </div>
  )
}

/** Publish, retire or delete one template version. */
export function TemplateButtons({
  templateId,
  status,
}: {
  templateId: number
  status: 'draft' | 'published' | 'retired'
}) {
  const t = useTranslations('AgreementTemplates')
  const router = useRouter()
  const [state, run, pending] = useActionState(templateAction, IDLE)
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (state.status === 'idle' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    if (state.status === 'done') {
      const message = { publish: 'publishedToast', retire: 'retiredToast', delete: 'deletedToast' }[
        state.result as 'publish' | 'retire' | 'delete'
      ]
      toast(t(message ?? 'publishedToast'))
      router.refresh()
    }
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result

  if (status === 'retired') return null
  return (
    <form action={run} className="grid gap-2">
      <input type="hidden" name="templateId" value={templateId} />
      <div className="flex flex-wrap gap-2">
        {status === 'draft' && (
          <Button type="submit" name="action" value="publish" size="sm" disabled={pending}>
            {t('publish')}
          </Button>
        )}
        <Button
          type="submit"
          name="action"
          value="retire"
          size="sm"
          variant="secondary"
          disabled={pending}
        >
          {t('retire')}
        </Button>
        {status === 'draft' && (
          <Button
            type="submit"
            name="action"
            value="delete"
            size="sm"
            variant="text"
            disabled={pending}
          >
            {t('delete')}
          </Button>
        )}
      </div>
      {state.status === 'error' && (
        <Banner tone="bad" role="alert">
          <p>{t('notAllowed')}</p>
        </Banner>
      )}
    </form>
  )
}
