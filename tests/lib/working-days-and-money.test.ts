import { describe, expect, it } from 'vitest'

import { isValidPrice, parsePrice, priceBreakdown } from '@/lib/money'
import { approvalProblem } from '@/lib/projects/publish'
import { canonical, changedFields, reviewSnapshot } from '@/lib/students/fields'
import {
  addWorkingDays,
  calendarDaysBetween,
  easterSunday,
  isWorkingDay,
  norwegianHolidays,
  osloDay,
  promiseState,
  workingDaysBetween,
} from '@/lib/workingDays'

/**
 * The one place that counts working days (Monday to Friday, without Norwegian public holidays, in
 * Oslo time), the price and VAT helpers, and the review snapshot. Plain functions, no database.
 */

describe('Norwegian public holidays', () => {
  it('finds Easter Sunday', () => {
    expect(easterSunday(2025)).toBe('2025-04-20')
    expect(easterSunday(2026)).toBe('2026-04-05')
    expect(easterSunday(2027)).toBe('2027-03-28')
    expect(easterSunday(2038)).toBe('2038-04-25')
  })

  it('lists the fixed and the moving holidays of 2026', () => {
    expect([...norwegianHolidays(2026)].sort()).toEqual([
      '2026-01-01',
      '2026-04-02', // Maundy Thursday
      '2026-04-03', // Good Friday
      '2026-04-06', // Easter Monday
      '2026-05-01',
      '2026-05-14', // Ascension Day
      '2026-05-17',
      '2026-05-25', // Whit Monday
      '2026-12-25',
      '2026-12-26',
    ])
  })

  it('skips weekends and holidays', () => {
    expect(isWorkingDay('2026-11-06')).toBe(true) // Friday
    expect(isWorkingDay('2026-11-07')).toBe(false) // Saturday
    expect(isWorkingDay('2026-04-06')).toBe(false) // Easter Monday
    expect(isWorkingDay('2027-05-17')).toBe(false) // 17 May on a Monday
  })
})

describe('counting working days', () => {
  it('jumps over Easter', () => {
    // Wednesday before Easter: Thursday, Friday and Monday are holidays.
    expect(addWorkingDays('2026-04-01', 1)).toBe('2026-04-07')
    expect(addWorkingDays('2026-04-01', 2)).toBe('2026-04-08')
    expect(workingDaysBetween('2026-04-01', '2026-04-08')).toBe(2)
  })

  it('jumps over 17 May and a weekend', () => {
    expect(addWorkingDays('2027-05-14', 1)).toBe('2027-05-18') // Fri -> Tue (17 May is Monday)
    expect(addWorkingDays('2026-11-06', 2)).toBe('2026-11-10') // Fri -> Tue
    expect(workingDaysBetween('2026-11-06', '2026-11-09')).toBe(1)
    expect(workingDaysBetween('2026-11-09', '2026-11-06')).toBe(-1)
  })

  it('uses the day in Oslo, not in UTC', () => {
    expect(osloDay(new Date('2026-11-06T23:30:00Z'))).toBe('2026-11-07')
    expect(osloDay(new Date('2026-07-01T22:30:00Z'))).toBe('2026-07-02') // summer time
    expect(
      calendarDaysBetween(new Date('2026-11-06T22:59:00Z'), new Date('2026-11-06T23:01:00Z')),
    ).toBe(1)
  })

  it('tells how a 2 working day promise stands', () => {
    const start = new Date('2026-11-06T09:00:00Z') // Friday
    expect(promiseState(start, 2, new Date('2026-11-06T12:00:00Z'))).toEqual({
      dueDay: '2026-11-10',
      left: 2,
      tone: 'ok',
    })
    expect(promiseState(start, 2, new Date('2026-11-09T12:00:00Z')).tone).toBe('soon')
    expect(promiseState(start, 2, new Date('2026-11-10T12:00:00Z'))).toMatchObject({
      left: 0,
      tone: 'soon',
    })
    expect(promiseState(start, 2, new Date('2026-11-11T12:00:00Z'))).toMatchObject({
      left: -1,
      tone: 'late',
    })
    // Late on a weekend is still late.
    expect(promiseState(start, 2, new Date('2026-11-14T12:00:00Z'))).toMatchObject({
      left: -3,
      tone: 'late',
    })
  })
})

describe('price and VAT', () => {
  it('adds 25 % VAT to a price in whole kroner', () => {
    expect(priceBreakdown(6500)).toEqual({ price: 6500, vat: 1625, total: 8125 })
    expect(priceBreakdown(999)).toEqual({ price: 999, vat: 249.75, total: 1248.75 })
  })

  it('reads typed prices and refuses anything that is not whole kroner', () => {
    expect(parsePrice('12 500')).toBe(12_500)
    expect(parsePrice('6500 kr')).toBe(6500)
    expect(parsePrice('6500NOK')).toBe(6500)
    for (const bad of ['', '0', '-1', '12.5', '12,5', 'abc', '99999999999'])
      expect(parsePrice(bad), bad).toBeUndefined()
    expect(isValidPrice(1)).toBe(true)
    expect(isValidPrice(1.5)).toBe(false)
  })

  it('approving needs a pay decision, and a price when paid', () => {
    expect(approvalProblem({ paidOrUnpaid: null, fee: null })).toBe('pay_choice')
    expect(approvalProblem({ paidOrUnpaid: 'paid', fee: null })).toBe('price')
    expect(approvalProblem({ paidOrUnpaid: 'paid', fee: 0 })).toBe('price')
    expect(approvalProblem({ paidOrUnpaid: 'paid', fee: 4000 })).toBeNull()
    expect(approvalProblem({ paidOrUnpaid: 'unpaid', fee: null })).toBeNull()
  })
})

describe('the review snapshot', () => {
  it('keeps ids for the CV, ignores key order, and lists what changed', () => {
    const reviewed = reviewSnapshot({
      name: 'Ola',
      skills: ['Figma'],
      cv: { id: 4, filename: 'cv.pdf' },
      privacy: { shareName: true, shareCv: false },
    })
    expect(reviewed.cv).toBe(4)
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }))
    expect(
      changedFields(reviewed, {
        name: 'Ola',
        skills: ['Figma'],
        cv: 4,
        privacy: { shareCv: false, shareName: true },
      }),
    ).toEqual([])
    expect(
      changedFields(reviewed, { name: 'Ola N.', skills: [], cv: 5, privacy: { shareName: true } }),
    ).toEqual(['name', 'skills', 'cv'])
    expect(changedFields(null, { name: 'x' })).toEqual([])
  })
})
