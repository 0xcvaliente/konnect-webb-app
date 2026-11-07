import { beforeEach, describe, expect, it } from 'vitest'

import { dueDay, paymentStatus } from '@/lib/payments/fields'
import { listCompanyInvoices, listStudentPayments } from '@/lib/payments/views'
import { dayToStored, todayInOslo } from '@/lib/projects/fields'
import type { SessionUser } from '@/lib/students/profile'
import { listPaymentLog, savePayment } from '@/lib/team/payments'
import en from '@/messages/en.json'
import no from '@/messages/no.json'
import type { Payment, User } from '@/payload-types'
import { addDays } from '@/lib/workingDays'

import {
  asUser,
  createWorld,
  graphql,
  login,
  readyFields,
  resetDatabase,
  selectStudent,
  rest,
  sessionFor,
  type World,
  workingMatch,
} from '../helpers/world'
import { signedAgreement } from '../helpers/agreements'

/**
 * Kanban card "Manual payment log in admin": one row per paid match, made by the server when
 * Konnected selects the student; the team records the invoice and the payments by hand; the company
 * reads a summary of its own invoices; the student reads only whether they were paid. Checked as
 * each role (admin, the student, another student, the company, another company, anonymous)
 * through the Local API with access control on, REST and GraphQL.
 */

let w: World
let paid: Awaited<ReturnType<typeof workingMatch>>
let row: Payment

const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })
const session = (user: User) => asUser(user) as unknown as SessionUser

const NOTES = 'Team-Only-Payment-Notes'
const INVOICE = 'INV-PAY-7781'
const day = (offset: number) => addDays(todayInOslo(), offset)
/** The row's version as the team's form loads it (its `updatedAt`). */
const versionOf = async (id: number) =>
  (await w.payload.findByID({ collection: 'payments', id, overrideAccess: true })).updatedAt

beforeEach(async () => {
  await resetDatabase()
  w = await createWorld()
  paid = await workingMatch(w.payload, w.admin, w.beta, w.companyA, 'Paid project', {
    fee: 12_000,
    paidOrUnpaid: 'paid',
  })
  const found = await w.payload.find({
    collection: 'payments',
    where: { match: { equals: paid.match.id } },
    overrideAccess: true,
  })
  row = found.docs[0]!
})

describe('one row per paid match, made by the server', () => {
  it('selecting a student for a paid project makes one row with the fixed price', async () => {
    expect(row).toMatchObject({ projectFee: 12_000 })
    const all = await w.payload.count({
      collection: 'payments',
      where: { match: { equals: paid.match.id } },
      overrideAccess: true,
    })
    expect(all.totalDocs).toBe(1)
  })

  it('an unpaid project gets no row, and none can be added by hand', async () => {
    // Published as paid (the test agreement template has a price), then Konnected decides unpaid
    // before it selects the student.
    const project = await w.payload.create({
      collection: 'projects',
      data: {
        ...readyFields(),
        company: w.companyB.company.id,
        title: 'Unpaid',
        fee: 1000,
        status: 'draft',
      },
      overrideAccess: true,
    })
    for (const status of ['submitted', 'approved'] as const) {
      await w.payload.update({
        collection: 'projects',
        id: project.id,
        data: { status },
        ...as(w.admin),
      })
    }
    await signedAgreement(w.payload, w.admin, w.companyB.user, {
      kind: 'company',
      projectId: project.id,
    })
    await w.payload.update({
      collection: 'projects',
      id: project.id,
      data: { status: 'published' },
      ...as(w.admin),
    })
    await w.payload.update({
      collection: 'projects',
      id: project.id,
      data: { paidOrUnpaid: 'unpaid', unpaidBenefit: 'A reference letter' },
      ...as(w.admin),
    })
    const unpaid = await selectStudent(w.payload, w.admin, w.alpha, project.id)
    const rows = await w.payload.count({
      collection: 'payments',
      where: { match: { equals: unpaid.match.id } },
      overrideAccess: true,
    })
    expect(rows.totalDocs).toBe(0)
    await expect(
      w.payload.create({
        collection: 'payments',
        data: { match: unpaid.match.id },
        ...as(w.admin),
      }),
    ).rejects.toThrow(/unpaid/)
  })

  it('a second row for the same match is refused', async () => {
    await expect(
      w.payload.create({ collection: 'payments', data: { match: paid.match.id }, ...as(w.admin) }),
    ).rejects.toThrow()
  })
})

describe('who reads what', () => {
  beforeEach(async () => {
    await w.payload.update({
      collection: 'payments',
      id: row.id,
      data: {
        invoiceNumber: INVOICE,
        invoiceSentAt: dayToStored(day(-3)),
        notes: NOTES,
        studentPay: 8_765,
        konnectedShare: 3_235,
      },
      ...as(w.admin),
    })
  })

  const sweep = async (user: User | null) => {
    const cookie = user
      ? user.role === 'admin'
        ? await sessionFor(user.id)
        : await login(user.email)
      : undefined
    const parts = [
      (await rest.get('payments?depth=3&limit=100', cookie)).text,
      (await rest.get(`payments/${row.id}?depth=3`, cookie)).text,
      (
        await graphql(
          '{ Payments(limit: 100) { docs { id projectFee konnectedShare studentPay invoiceNumber invoiceSentAt invoicePaidAt studentPaidAt notes } } }',
          cookie,
        )
      ).text,
    ]
    if (user) {
      try {
        parts.push(
          JSON.stringify(await w.payload.find({ collection: 'payments', depth: 3, ...as(user) })),
        )
      } catch {
        parts.push('')
      }
    }
    return parts.join('\n')
  }

  it('admin reads everything (positive control)', async () => {
    const all = await sweep(w.admin)
    for (const value of [INVOICE, NOTES, '8765', '3235', '12000']) expect(all).toContain(value)
  })

  it('the company reads its own invoice summary, never the notes or the student side', async () => {
    const all = await sweep(w.companyA.user)
    expect(all).toContain(INVOICE)
    expect(all).toContain('12000')
    for (const value of [NOTES, '8765', '3235']) expect(all).not.toContain(value)
    const local = await w.payload.findByID({
      collection: 'payments',
      id: row.id,
      depth: 0,
      ...as(w.companyA.user),
    })
    for (const key of ['notes', 'studentPay', 'konnectedShare', 'studentPaidAt'])
      expect(local, key).not.toHaveProperty(key)
  })

  it('another company reads nothing', async () => {
    const all = await sweep(w.companyB.user)
    for (const value of [INVOICE, NOTES, '12000']) expect(all).not.toContain(value)
  })

  it('the student reads only whether they were paid: no price, no invoice, no notes', async () => {
    const all = await sweep(w.beta.user)
    for (const value of [INVOICE, NOTES, '12000', '8765', '3235']) expect(all).not.toContain(value)
    const local = await w.payload.findByID({
      collection: 'payments',
      id: row.id,
      depth: 0,
      ...as(w.beta.user),
    })
    expect(local).toHaveProperty('studentPaidAt')
    for (const key of ['projectFee', 'invoiceNumber', 'invoiceSentAt', 'invoicePaidAt', 'notes'])
      expect(local, key).not.toHaveProperty(key)
  })

  it('another student and anonymous read nothing', async () => {
    for (const all of [await sweep(w.alpha.user), await sweep(null)]) {
      for (const value of [INVOICE, NOTES, '12000']) expect(all).not.toContain(value)
    }
    expect((await rest.get(`payments/${row.id}`)).status).toBe(403)
  })
})

describe('only the team writes, and the dates follow the rules', () => {
  it('no other role can change a row, through the Local API or REST', async () => {
    for (const user of [w.beta.user, w.alpha.user, w.companyA.user, w.companyB.user]) {
      await expect(
        w.payload.update({
          collection: 'payments',
          id: row.id,
          data: { invoicePaidAt: dayToStored(day(-1)) },
          ...as(user),
        }),
      ).rejects.toThrow()
      const cookie = await login(user.email)
      expect(
        (await rest.patch(`payments/${row.id}`, { notes: 'x' }, cookie)).status,
        user.email,
      ).toBe(403)
      expect((await rest.delete(`payments/${row.id}`, cookie)).status).toBe(403)
    }
    expect((await rest.patch(`payments/${row.id}`, { notes: 'x' })).status).toBe(403)
  })

  it('the company pays after the invoice; the student after the company; nothing in the future', async () => {
    const update = (data: Partial<Payment>) =>
      w.payload.update({ collection: 'payments', id: row.id, data, ...as(w.admin) })
    await expect(update({ invoicePaidAt: dayToStored(day(-1)) })).rejects.toThrow()
    await expect(update({ invoiceSentAt: dayToStored(day(1)) })).rejects.toThrow()
    await update({ invoiceSentAt: dayToStored(day(-10)) })
    await expect(update({ invoicePaidAt: dayToStored(day(-11)) })).rejects.toThrow()
    await expect(update({ studentPaidAt: dayToStored(day(-2)) })).rejects.toThrow()
    await update({ invoicePaidAt: dayToStored(day(-5)) })
    await expect(update({ studentPaidAt: dayToStored(day(-6)) })).rejects.toThrow()
    // Clearing the company's payment while the student is paid would break the order.
    await update({ studentPaidAt: dayToStored(day(-2)) })
    await expect(update({ invoicePaidAt: null })).rejects.toThrow()
    // The price is copied from the project, and a row keeps its match.
    await expect(update({ match: w.match.id })).rejects.toThrow()
  })

  it('each recorded date is in the activity log with the team member', async () => {
    const form = new FormData()
    form.set('id', String(row.id))
    form.set('version', await versionOf(row.id))
    form.set('invoiceNumber', INVOICE)
    form.set('invoiceSent', day(-4))
    form.set('invoicePaid', day(-1))
    form.set('studentPaid', '')
    form.set('notes', NOTES)
    expect((await savePayment(w.payload, session(w.admin), form)).status).toBe('saved')
    const logs = await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [
          { targetCollection: { equals: 'payments' } },
          { targetId: { equals: String(row.id) } },
        ],
      },
      depth: 0,
      ...as(w.admin),
    })
    const fields = logs.docs.filter((l) => l.action === 'status_change').map((l) => l.field)
    expect(fields).toEqual(
      expect.arrayContaining(['invoiceNumber', 'invoiceSentAt', 'invoicePaidAt']),
    )
    for (const l of logs.docs.filter((l) => l.action === 'status_change')) {
      expect(l.actor).toBe(w.admin.id)
      // The team's notes are not copied into the log.
      expect(JSON.stringify(l)).not.toContain(NOTES)
    }
  })

  it('savePayment refuses anyone but the team, and wrong dates', async () => {
    const form = new FormData()
    form.set('id', String(row.id))
    form.set('invoiceSent', day(-2))
    for (const user of [w.beta.user, w.companyA.user]) {
      expect(await savePayment(w.payload, session(user), form)).toMatchObject({
        error: 'forbidden',
      })
    }
    expect(await savePayment(w.payload, null, form)).toMatchObject({ error: 'forbidden' })
    form.set('studentPaid', day(-1))
    expect(await savePayment(w.payload, session(w.admin), form)).toMatchObject({
      error: 'student_before_company',
    })
    form.set('studentPaid', 'yesterday')
    expect(await savePayment(w.payload, session(w.admin), form)).toMatchObject({
      error: 'bad_date',
    })
  })
})

describe('two team members on one row', () => {
  const formFor = (version: string, fields: Record<string, string>) => {
    const form = new FormData()
    form.set('id', String(row.id))
    form.set('version', version)
    for (const [k, v] of Object.entries(fields)) form.set(k, v)
    return form
  }
  const stored = () =>
    w.payload.findByID({ collection: 'payments', id: row.id, overrideAccess: true })

  it('a save from a form loaded before someone else saved is refused, and undoes nothing', async () => {
    // A and B open the same empty row.
    const loaded = await versionOf(row.id)
    expect(
      (await listPaymentLog(w.payload, session(w.admin), { filter: 'all' }))!.rows.find(
        (r) => r.id === row.id,
      )!.version,
    ).toBe(loaded)

    // B records the invoice as sent today.
    expect(
      await savePayment(w.payload, session(w.admin), formFor(loaded, { invoiceSent: day(0) })),
    ).toMatchObject({ status: 'saved' })
    // A adds a note on the form A loaded earlier, which still has no invoice date.
    expect(
      await savePayment(w.payload, session(w.admin), formFor(loaded, { notes: NOTES })),
    ).toMatchObject({ status: 'error', error: 'not_open' })
    expect(await stored()).toMatchObject({
      invoiceSentAt: dayToStored(day(0)),
      notes: null,
    })

    // B records the company's payment; A's stale form (with the invoice date) cannot clear it.
    const afterInvoice = await versionOf(row.id)
    expect(
      await savePayment(
        w.payload,
        session(w.admin),
        formFor(afterInvoice, { invoiceSent: day(0), invoicePaid: day(0) }),
      ),
    ).toMatchObject({ status: 'saved' })
    expect(
      await savePayment(
        w.payload,
        session(w.admin),
        formFor(afterInvoice, { invoiceSent: day(0), notes: NOTES }),
      ),
    ).toMatchObject({ error: 'not_open' })
    expect((await stored()).invoicePaidAt).toBe(dayToStored(day(0)))

    // Loaded again, A's save goes through.
    expect(
      await savePayment(
        w.payload,
        session(w.admin),
        formFor(await versionOf(row.id), {
          invoiceSent: day(0),
          invoicePaid: day(0),
          notes: NOTES,
        }),
      ),
    ).toMatchObject({ status: 'saved' })
    expect(await stored()).toMatchObject({ invoicePaidAt: dayToStored(day(0)), notes: NOTES })
  })

  it('two saves of one loaded form at the same moment: one wins, the other is refused', async () => {
    const loaded = await versionOf(row.id)
    const results = await Promise.all([
      savePayment(w.payload, session(w.admin), formFor(loaded, { invoiceSent: day(-1) })),
      savePayment(w.payload, session(w.admin), formFor(loaded, { notes: NOTES })),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['error', 'saved'])
    expect(results.find((r) => r.status === 'error')).toMatchObject({ error: 'not_open' })
  })

  it('a form without the version it loaded is refused', async () => {
    const form = new FormData()
    form.set('id', String(row.id))
    form.set('notes', NOTES)
    expect(await savePayment(w.payload, session(w.admin), form)).toMatchObject({
      error: 'not_open',
    })
    expect((await stored()).notes ?? null).toBeNull()
  })
})

describe('the log, the company summary and the student status', () => {
  const save = async (fields: Record<string, string>) => {
    const form = new FormData()
    form.set('id', String(row.id))
    form.set('version', await versionOf(row.id))
    for (const [k, v] of Object.entries(fields)) form.set(k, v)
    return savePayment(w.payload, session(w.admin), form)
  }
  const status = async () =>
    (await listPaymentLog(w.payload, session(w.admin), { filter: 'all' }))!.rows.find(
      (r) => r.id === row.id,
    )!

  it('a row moves from not released to settled, and the filters follow', async () => {
    expect((await status()).status).toBe('not_released')
    expect((await status()).amounts).toEqual({ price: 12_000, vat: 3_000, total: 15_000 })

    // Konnected releases the student's work: the invoice is due to be sent.
    const d = await w.payload.create({
      collection: 'deliverables',
      data: {
        match: paid.match.id,
        links: [{ url: 'https://example.test/x' }],
        status: 'submitted',
      },
      ...as(w.beta.user),
    })
    await w.payload.update({
      collection: 'deliverables',
      id: d.id,
      data: { status: 'released' },
      ...as(w.admin),
    })
    expect((await status()).status).toBe('to_invoice')
    const action = await listPaymentLog(w.payload, session(w.admin))
    expect(action!.rows.map((r) => r.id)).toContain(row.id)

    await save({ invoiceSent: day(-1) })
    expect(await status()).toMatchObject({ status: 'invoice_sent', due: addDays(day(-1), 14) })
    await save({ invoiceSent: day(-20) })
    expect((await status()).status).toBe('overdue')
    await save({ invoiceSent: day(-20), invoicePaid: day(-2) })
    expect((await status()).status).toBe('student_to_pay')
    await save({ invoiceSent: day(-20), invoicePaid: day(-2), studentPaid: day(0) })
    expect((await status()).status).toBe('settled')
    const settled = await listPaymentLog(w.payload, session(w.admin), { filter: 'settled' })
    expect(settled!.rows.map((r) => r.id)).toEqual([row.id])
    const open = await listPaymentLog(w.payload, session(w.admin), { filter: 'action' })
    expect(open!.rows.map((r) => r.id)).not.toContain(row.id)
  })

  it('the log is the team’s only', async () => {
    for (const user of [w.beta.user, w.companyA.user]) {
      expect(await listPaymentLog(w.payload, session(user))).toBeNull()
    }
  })

  it('the company sees its invoice; the student sees paid or waiting, nothing more', async () => {
    await save({ invoiceNumber: INVOICE, invoiceSent: day(-3) })
    const invoices = await listCompanyInvoices(w.payload, session(w.companyA.user))
    const mine = invoices!.find((i) => i.id === row.id)!
    expect(mine).toMatchObject({
      title: 'Paid project',
      invoiceNumber: INVOICE,
      status: 'sent',
      due: addDays(day(-3), 14),
      amounts: { price: 12_000, vat: 3_000, total: 15_000 },
    })
    expect(JSON.stringify(mine)).not.toContain(NOTES)
    expect(
      (await listCompanyInvoices(w.payload, session(w.companyB.user)))!.map((i) => i.id),
    ).not.toContain(row.id)
    expect(await listCompanyInvoices(w.payload, session(w.beta.user))).toBeNull()

    const waiting = await listStudentPayments(w.payload, session(w.beta.user))
    expect(waiting).toEqual([
      {
        id: row.id,
        title: 'Paid project',
        companyName: 'Company A',
        paidOn: null,
        applicationId: paid.application.id,
      },
    ])
    await save({
      invoiceNumber: INVOICE,
      invoiceSent: day(-3),
      invoicePaid: day(-2),
      studentPaid: day(-1),
    })
    expect((await listStudentPayments(w.payload, session(w.beta.user)))![0]!.paidOn).toBe(day(-1))
    expect(
      (await listStudentPayments(w.payload, session(w.alpha.user)))!.map((p) => p.id),
    ).not.toContain(row.id)
    expect(await listStudentPayments(w.payload, session(w.companyA.user))).toBeNull()
  })
})

describe('the rules, without a database', () => {
  it('status and due day', () => {
    const t = '2026-11-20'
    expect(dueDay('2026-11-01')).toBe('2026-11-15')
    expect(
      paymentStatus({ invoiceSent: null, invoicePaid: null, studentPaid: null }, false, t),
    ).toBe('not_released')
    expect(
      paymentStatus({ invoiceSent: '2026-11-10', invoicePaid: null, studentPaid: null }, true, t),
    ).toBe('invoice_sent')
    expect(
      paymentStatus({ invoiceSent: '2026-11-05', invoicePaid: null, studentPaid: null }, true, t),
    ).toBe('overdue')
  })
})

describe('messages', () => {
  it('every payment and deliverable screen string exists in English and Norwegian', () => {
    const keys = (d: unknown, p = ''): string[] =>
      d && typeof d === 'object' ? Object.entries(d).flatMap(([k, v]) => keys(v, `${p}${k}.`)) : [p]
    for (const ns of [
      'Deliverables',
      'StudentWork',
      'CompanyWork',
      'TeamDeliverables',
      'TeamPayments',
      'CompanyPayments',
      'StudentPayments',
    ] as const) {
      expect(keys(no[ns]).sort(), ns).toEqual(keys(en[ns]).sort())
    }
    expect(keys(no.Email.deliverables).sort()).toEqual(keys(en.Email.deliverables).sort())
  })
})
