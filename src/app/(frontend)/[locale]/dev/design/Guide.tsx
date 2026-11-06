import { getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'

import { Banner } from '@/components/app/Banner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'

import { OverlayDemo, RadioDemo, SelectDemo, TabsDemo } from './DesignDemos'

const TOKENS = [
  '--bg',
  '--surface',
  '--surface-2',
  '--line',
  '--edge',
  '--ink',
  '--ink-2',
  '--band',
  '--band-ink',
  '--band-ink-2',
  '--band-link',
  '--primary',
  '--on-primary',
  '--tint',
  '--tint-ink',
  '--data',
  '--ok',
  '--warn',
  '--bad',
]

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      {children}
    </Card>
  )
}

/** Every token and component on one page, inside whichever shell the route uses. */
export async function Guide() {
  const t = await getTranslations('DesignGuide')

  return (
    <>
      <Section title={t('colours')}>
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3">
          {TOKENS.map((token) => (
            <li key={token} className="grid gap-1.5">
              <span
                className="block h-12 rounded-full border border-line"
                style={{ background: `var(${token})` }}
              />
              <code className="text-[0.8rem] text-muted-foreground">{token}</code>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t('type')}>
        <div className="grid gap-3">
          <p className="text-[1.6rem] leading-tight font-semibold tracking-[-0.015em] sm:text-[1.9rem]">
            {t('typePageTitle')}
          </p>
          <p className="text-base font-semibold tracking-[-0.015em]">{t('typeSectionTitle')}</p>
          <p className="max-w-[62ch]">{t('typeBody')}</p>
          <p className="text-muted-foreground">{t('typeSecondary')}</p>
          <p className="tabular-nums">{t('typeNumbers')}: 1 250,00 · 11 111 · 9 999</p>
        </div>
      </Section>

      <Section title={t('buttons')}>
        <div className="grid gap-5">
          <div className="flex flex-wrap gap-2.5">
            <Button>{t('main')}</Button>
            <Button variant="normal">{t('normal')}</Button>
            <Button variant="secondary">{t('secondary')}</Button>
            <Button variant="text">{t('text')}</Button>
            <Button disabled>{t('disabled')}</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2.5 rounded-item bg-band p-4 text-band-foreground">
            <span className="mr-2 text-band-muted">{t('onBand')}</span>
            <Button variant="band">{t('main')}</Button>
          </div>
        </div>
      </Section>

      <div className="grid gap-6 md:grid-cols-2">
        <Section title={t('inputs')}>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="dg-email">{t('email')}</Label>
              <Input
                id="dg-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.no"
                aria-describedby="dg-email-hint"
              />
              <p id="dg-email-hint" className="text-[0.82rem] text-muted-foreground">
                {t('emailHint')}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="dg-desc">{t('description')}</Label>
              <Textarea id="dg-desc" rows={3} />
            </div>
            <SelectDemo />
            <div className="flex min-h-11 items-start gap-3 py-1">
              <Checkbox id="dg-agree" className="mt-0.5" />
              <Label htmlFor="dg-agree" className="font-medium">
                {t('agree')}
              </Label>
            </div>
            <RadioDemo />
          </div>
        </Section>

        <div className="grid content-start gap-6">
          <Section title={t('pills')}>
            <div className="grid gap-4">
              <div className="flex flex-wrap gap-2">
                <Badge tone="info">{t('status.submitted')}</Badge>
                <Badge tone="ok">{t('status.published')}</Badge>
                <Badge tone="warn">{t('status.dueSoon')}</Badge>
                <Badge tone="bad">{t('status.rejected')}</Badge>
                <Badge tone="mute">{t('status.closed')}</Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="tag">{t('tag')}</Badge>
                <Badge variant="new">{t('new')}</Badge>
              </div>
              <Banner tone="info">{t('mineBody')}</Banner>
              <Banner tone="warn">{t('status.dueSoon')}</Banner>
            </div>
          </Section>

          <Section title={t('tabs')}>
            <TabsDemo />
          </Section>

          <Section title={t('overlays')}>
            <OverlayDemo />
          </Section>
        </div>
      </div>

      <Section title={t('cards')}>
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('cardTitle')}</CardTitle>
              <CardDescription>{t('cardBody')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                <Badge variant="tag">{t('tag')}</Badge>
                <Badge tone="ok">{t('status.published')}</Badge>
              </div>
            </CardContent>
            <CardFooter>
              <Button variant="normal">{t('cardAction')}</Button>
            </CardFooter>
          </Card>
          <Card aria-busy="true">
            <span className="sr-only">{t('loading')}</span>
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Separator />
            <Skeleton className="h-11 w-32 rounded-full" />
          </Card>
        </div>
      </Section>
    </>
  )
}
