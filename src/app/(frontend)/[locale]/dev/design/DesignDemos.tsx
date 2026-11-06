'use client'

import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

/** The interactive parts of the style guide: select, radios, tabs, dialog and toast. */
export function SelectDemo() {
  const t = useTranslations('DesignGuide')
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="dg-programme">{t('programme')}</Label>
      <Select>
        <SelectTrigger id="dg-programme">
          <SelectValue placeholder={t('programmePlaceholder')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="design">{t('programmes.design')}</SelectItem>
          <SelectItem value="computing">{t('programmes.computing')}</SelectItem>
          <SelectItem value="business">{t('programmes.business')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

export function RadioDemo() {
  const t = useTranslations('DesignGuide')
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-[0.9rem] font-semibold">{t('pay')}</legend>
      <RadioGroup defaultValue="paid" className="flex flex-wrap gap-x-6 gap-y-1">
        {(['paid', 'unpaid'] as const).map((v) => (
          <div key={v} className="flex min-h-11 items-center gap-3">
            <RadioGroupItem value={v} id={`dg-pay-${v}`} />
            <Label htmlFor={`dg-pay-${v}`} className="font-medium">
              {t(v)}
            </Label>
          </div>
        ))}
      </RadioGroup>
    </fieldset>
  )
}

export function TabsDemo() {
  const t = useTranslations('DesignGuide')
  return (
    <Tabs defaultValue="mine">
      <TabsList>
        <TabsTrigger value="mine">{t('mine')}</TabsTrigger>
        <TabsTrigger value="everyone">{t('everyone')}</TabsTrigger>
      </TabsList>
      <TabsContent value="mine" className="text-muted-foreground">
        {t('mineBody')}
      </TabsContent>
      <TabsContent value="everyone" className="text-muted-foreground">
        {t('everyoneBody')}
      </TabsContent>
    </Tabs>
  )
}

export function OverlayDemo() {
  const t = useTranslations('DesignGuide')
  return (
    <div className="flex flex-wrap gap-2.5">
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="secondary">{t('openDialog')}</Button>
        </DialogTrigger>
        <DialogContent closeLabel={t('close')}>
          <DialogHeader>
            <DialogTitle>{t('dialogTitle')}</DialogTitle>
            <DialogDescription>{t('dialogBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t('cancel')}</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button variant="destructive">{t('confirm')}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Button variant="normal" onClick={() => toast(t('toast'))}>
        {t('showToast')}
      </Button>
    </div>
  )
}
