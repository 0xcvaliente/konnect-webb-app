'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  type FormEvent,
  type ReactNode,
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'

import { TextField } from '@/components/app/AuthForm'
import { Banner } from '@/components/app/Banner'
import { LogoField, type LogoInfo } from '@/components/app/LogoField'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useRouter } from '@/i18n/navigation'
import { saveCompanyAction } from '@/lib/companies/actions'
import {
  type CompanyField,
  type CompanyFieldProblem,
  type CompanyStatusKey,
  IDLE,
  LIMITS,
  SECTOR_KEYS,
} from '@/lib/companies/fields'

export type CompanyValues = {
  name: string
  orgNumber: string
  contactName: string
  contactRole: string
  website: string
  sector: string
  description: string
}

/** The message for a field problem the server reported. */
function useProblemText() {
  const f = useTranslations('CompanyFields')
  return (field: CompanyField, problem: CompanyFieldProblem | undefined): string | undefined => {
    if (!problem) return undefined
    if (problem === 'locked') return f('errors.locked')
    if (problem === 'required')
      return field === 'sector' ? f('errors.requiredOne') : f('errors.required')
    if (problem === 'too_long') {
      const max = LIMITS[field as keyof typeof LIMITS] ?? 0
      return f('errors.tooLong', { max })
    }
    if (field === 'orgNumber') return f('errors.orgNumberInvalid')
    if (field === 'website') return f('errors.websiteInvalid')
    if (field === 'sector') return f('errors.sectorInvalid')
    if (field === 'logo') return f('errors.logoInvalid')
    return f('errors.required')
  }
}

/**
 * The company details form (mockup "Company profile"). Everything can change while Konnected
 * reviews the company; after approval the name and organisation number are read-only (Konnected
 * checked them). A company Konnected rejected may correct every field once: that save sends it
 * back for review ("Correct and send again"); after that its details are read-only. When Konnected
 * asked for more information, the save is the answer. The server applies the same rules. Sent with
 * startTransition so React does not reset the fields after a save.
 */
export function CompanyForm({
  values,
  logo: initialLogo,
  status,
  canResend = false,
  answering = false,
}: {
  values: CompanyValues
  logo: LogoInfo | null
  status: CompanyStatusKey
  /** Rejected, and the one correction is still unused. */
  canResend?: boolean
  /** Konnected asked for more information: this save is the answer. */
  answering?: boolean
}) {
  const t = useTranslations('CompanyProfile')
  const f = useTranslations('CompanyFields')
  const problemText = useProblemText()
  const [state, dispatch, pending] = useActionState(saveCompanyAction, IDLE)
  const formRef = useRef<HTMLFormElement>(null)
  const [sector, setSector] = useState(values.sector)
  const [logo, setLogo] = useState(initialLogo)
  const [name, setName] = useState(values.name)

  const router = useRouter()
  const resending = status === 'rejected' && canResend
  const readOnly = status === 'rejected' && !resending
  const locked = status === 'approved'

  const error = (field: CompanyField) =>
    state.status === 'error' ? problemText(field, state.fields?.[field]) : undefined

  useEffect(() => {
    if (state.status === 'done') {
      toast(resending ? t('resent') : answering ? t('answered') : t('saved'))
      // The status and the banners above change with these saves.
      if (resending || answering) router.refresh()
    }
    if (state.status === 'error' && state.fields) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    }
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (readOnly) return
    const form = new FormData(event.currentTarget)
    form.set('logo', logo ? String(logo.id) : 'none')
    // Read-only fields are not part of the save: the server keeps what Konnected checked.
    if (locked) {
      form.delete('name')
      form.delete('orgNumber')
    }
    startTransition(() => dispatch(form))
  }

  const formError =
    state.status !== 'error'
      ? null
      : state.fields
        ? t('errors.fix')
        : state.error === 'forbidden'
          ? t('errors.forbidden')
          : state.error === 'not_editable'
            ? t('errors.notEditable')
            : t('errors.generic')

  return (
    <Card>
      <form ref={formRef} onSubmit={onSubmit} noValidate className="grid gap-5">
        <CardHeader>
          <CardTitle>{t('detailsTitle')}</CardTitle>
        </CardHeader>
        {readOnly && (
          <Banner tone="info">
            <p>{t('readOnly')}</p>
          </Banner>
        )}
        {formError && (
          <Banner tone="bad" role="alert">
            <p>{formError}</p>
          </Banner>
        )}

        <fieldset disabled={readOnly || pending} className="grid min-w-0 gap-5">
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <TextField
              id="c-name"
              name="name"
              label={f('name')}
              defaultValue={values.name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="organization"
              readOnly={locked}
              hint={locked ? f('lockedHint') : undefined}
              error={error('name')}
            />
            <TextField
              id="c-org"
              name="orgNumber"
              label={f('orgNumber')}
              defaultValue={values.orgNumber}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              readOnly={locked}
              hint={locked ? f('lockedHint') : f('orgNumberHint')}
              error={error('orgNumber')}
            />
            <TextField
              id="c-website"
              name="website"
              label={f('website')}
              defaultValue={values.website}
              inputMode="url"
              autoComplete="url"
              autoCapitalize="none"
              spellCheck={false}
              hint={f('websiteHint')}
              error={error('website')}
            />
            <div className="grid content-start gap-1.5">
              <Label htmlFor="c-sector">{f('sector')}</Label>
              <Select name="sector" value={sector} onValueChange={setSector} disabled={readOnly}>
                <SelectTrigger
                  id="c-sector"
                  aria-invalid={error('sector') ? true : undefined}
                  aria-describedby={error('sector') ? 'c-sector-error' : undefined}
                >
                  <SelectValue placeholder={f('chooseSector')} />
                </SelectTrigger>
                <SelectContent>
                  {SECTOR_KEYS.map((key) => (
                    <SelectItem key={key} value={key}>
                      {f(`sectorOption.${key}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError id="c-sector-error" message={error('sector')} />
            </div>
          </div>

          <TextAreaField
            id="c-description"
            name="description"
            label={f('description')}
            hint={f('descriptionHint')}
            defaultValue={values.description}
            rows={3}
            error={error('description')}
          />

          <div className="grid items-start gap-4 sm:grid-cols-2">
            <TextField
              id="c-contact-name"
              name="contactName"
              label={f('contactName')}
              defaultValue={values.contactName}
              autoComplete="name"
              error={error('contactName')}
            />
            <TextField
              id="c-contact-role"
              name="contactRole"
              label={f('contactRole')}
              defaultValue={values.contactRole}
              autoComplete="organization-title"
              error={error('contactRole')}
            />
          </div>

          <div className="grid gap-2">
            <p className="text-[0.9rem] leading-snug font-semibold">{f('logo')}</p>
            <LogoField
              logo={logo}
              name={name}
              onChange={setLogo}
              disabled={readOnly}
              busy={pending}
              error={error('logo')}
            />
          </div>
        </fieldset>

        {!readOnly && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
              {pending
                ? t('saving')
                : resending
                  ? t('resend')
                  : answering
                    ? t('answer')
                    : t('save')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  )
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} className="text-[0.88rem] font-semibold text-destructive">
      {message}
    </p>
  )
}

function TextAreaField({
  id,
  name,
  label,
  hint,
  error,
  ...props
}: {
  id: string
  name: string
  label: string
  hint?: ReactNode
  error?: string
  defaultValue?: string
  rows?: number
}) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...props}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  )
}
