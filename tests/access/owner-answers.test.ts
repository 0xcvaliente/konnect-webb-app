import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { runningProjectCount } from '@/lib/applications/rules'
import { paymentEmail, teamProblemEmail } from '@/lib/email/templates'
import { todayInOslo } from '@/lib/projects/fields'
import type { SessionUser } from '@/lib/students/profile'
import { selectApplication } from '@/lib/team/matching'
import {
  changeProjectPay,
  closeWithoutDelivery,
  endMatchAndReopen,
  loadTeamProject,
} from '@/lib/team/projects'
import { addDays } from '@/lib/workingDays'
import type { Application, Payment, User } from '@/payload-types'

import {
  ADMIN_EMAIL,
  asUser,
  createWorld,
  dayFromNow,
  graphql,
  login,
  PASSWORD,
  resetDatabase,
  rest,
  SENTINEL,
  sessionFor,
  type World,
  workingMatch,
} from '../helpers/world'
import { signedAgreement } from '../helpers/agreements'

/**
 * The owner's answers 42, 50, 51 and 52 (7 Nov 2026):
 * - 42: the team changes a published project's price and the student's pay from the team's
 *   project page; admins only; each change logged with old and new value and who; a warning (and a
 *   tick) when a signed agreement keeps the old amount.
 * - 50: payment emails to the company (invoice sent, paid) and the student (paid in the pay run),
 *   once per transition.
 * - 51: after "match again", earlier applicants who were not selected go back into the pool,
 *   except who withdrew and the replaced student; the selection rules still hold.
 * - 52: a problem report emails the project's owner on the team straight away, or the whole team
 *   for the shared pool; never the note or the student.
 * Every change is tried as each role (the team, the student, the company, anonymous) through the
 * Local API with access control on, and through REST and GraphQL where a role could try it.
 */

let w: World
let mail: MockInstance

const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })
const session = (user: User) => asUser(user) as unknown as SessionUser
const form = (values: Record<string, string | number>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(values)) f.set(k, String(v))
  return f
}
type Sent = { to: string; subject: string; text: string; html: string }
const sent = () => mail.mock.calls.map((c) => c[0] as Sent)
const mailsTo = (email: string) => sent().filter((m) => m.to === email)
const allMail = () =>
  sent()
    .map((m) => `${m.subject}${m.text}${m.html}`)
    .join('\n')

const projectOf = (id: number) =>
  w.payload.findByID({ collection: 'projects', id, depth: 0, overrideAccess: true })
const activity = async (collection: string, id: number) =>
  (
    await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [{ targetCollection: { equals: collection } }, { targetId: { equals: String(id) } }],
      },
      sort: 'createdAt',
      pagination: false,
      depth: 0,
      overrideAccess: true,
    })
  ).docs
const paymentOf = async (matchId: number) =>
  (
    await w.payload.find({
      collection: 'payments',
      where: { match: { equals: matchId } },
      depth: 0,
      overrideAccess: true,
    })
  ).docs[0] as Payment

/** One more student, reviewed by Konnected. */
async function student(key: string) {
  const user = (await w.payload.create({
    collection: 'users',
    data: {
      email: `${key}@student.test`,
      password: PASSWORD,
      role: 'student',
      _verified: true,
    } as never,
    overrideAccess: true,
    disableVerificationEmail: true,
  })) as User
  const profile = await w.payload.create({
    collection: 'student-profiles',
    data: { user: user.id, name: `Student ${key}`, skills: ['Figma'], privacy: {} },
    overrideAccess: true,
  })
  await w.payload.update({
    collection: 'student-profiles',
    id: profile.id,
    data: { reviewStatus: 'reviewed' },
    ...as(w.admin),
  })
  return { user, profile }
}

const makeAdmin = async (email: string, name: string, language: 'en' | 'no' = 'en') =>
  (await w.payload.create({
    collection: 'users',
    data: {
      email,
      name,
      password: PASSWORD,
      role: 'admin',
      language,
      _verified: true,
      emailVerifiedAt: new Date().toISOString(),
    } as never,
    overrideAccess: true,
    disableVerificationEmail: true,
  })) as User

beforeEach(async () => {
  await resetDatabase()
  w = await createWorld()
  mail?.mockRestore()
  mail = vi.spyOn(w.payload.email, 'sendEmail')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------------------------
describe('42: the team changes the price and the student pay after publishing', () => {
  let work: Awaited<ReturnType<typeof workingMatch>>

  beforeEach(async () => {
    // beta works on a paid project of company A: both agreements are signed.
    work = await workingMatch(w.payload, w.admin, w.beta, w.companyA, 'Repriced project', {
      fee: 10_000,
      studentPay: 4_000,
      paidOrUnpaid: 'paid',
    })
    mail.mockClear()
  })

  const change = (user: User, values: Record<string, string | number>) =>
    changeProjectPay(
      w.payload,
      session(user),
      form({ id: work.project.id, wasFee: 10_000, wasPay: 4_000, ...values }),
    )

  it('saves both amounts, logs old and new with who, and moves an unsent invoice to the new price', async () => {
    const res = await change(w.admin, { price: '12 000', studentPay: '5000', confirm: '1' })
    expect(res.status).toBe('done')
    const project = await projectOf(work.project.id)
    expect(project).toMatchObject({ fee: 12_000, studentPay: 5_000, status: 'in_progress' })
    const rows = (await activity('projects', work.project.id)).filter(
      (r) => r.action === 'review_change',
    )
    expect(rows.find((r) => r.field === 'fee')).toMatchObject({
      fromStatus: '10000',
      toStatus: '12000',
      actor: w.admin.id,
    })
    expect(rows.find((r) => r.field === 'studentPay')).toMatchObject({
      fromStatus: '4000',
      toStatus: '5000',
      actor: w.admin.id,
    })
    // No invoice was sent: the payment log row takes the new price (and logs it).
    const row = await paymentOf(work.match.id)
    expect(row.projectFee).toBe(12_000)
    expect(
      (await activity('payments', row.id)).some(
        (r) => r.field === 'projectFee' && r.toStatus === '12000',
      ),
    ).toBe(true)
    // Nobody gets an email about it.
    expect(sent()).toHaveLength(0)
    // The team page shows it.
    const view = await loadTeamProject(w.payload, session(w.admin), work.project.id)
    expect(view!.pay).toMatchObject({ fee: 12_000, studentPay: 5_000, editable: true })
  })

  it('a signed agreement: the team must confirm it keeps the old amount; nothing is regenerated', async () => {
    const view = await loadTeamProject(w.payload, session(w.admin), work.project.id)
    expect(view!.pay).toMatchObject({ companySigned: true, studentSigned: true })
    expect(await change(w.admin, { price: 11_000, studentPay: 4_000 })).toMatchObject({
      status: 'error',
      error: 'confirm',
    })
    expect((await projectOf(work.project.id)).fee).toBe(10_000)

    const before = await w.payload.find({
      collection: 'agreements',
      where: { project: { equals: work.project.id } },
      depth: 0,
      overrideAccess: true,
    })
    expect(await change(w.admin, { price: 11_000, studentPay: 4_000, confirm: '1' })).toMatchObject(
      { status: 'done' },
    )
    const after = await w.payload.find({
      collection: 'agreements',
      where: { project: { equals: work.project.id } },
      depth: 0,
      overrideAccess: true,
    })
    // The same agreements, still signed, with the old price in them.
    expect(after.docs.map((a) => [a.id, a.status])).toEqual(
      before.docs.map((a) => [a.id, a.status]),
    )
    const company = after.docs.find((a) => a.kind === 'company')!
    expect((company.values as Record<string, string>)['price.exclVat']).toContain('10')
    expect((company.values as Record<string, string>)['price.exclVat']).not.toContain('11')
  })

  it('the tick is needed only for the amount a signed agreement holds', async () => {
    // A new student pay after the student signed needs it too.
    expect(await change(w.admin, { price: 10_000, studentPay: 4_500 })).toMatchObject({
      error: 'confirm',
    })
    // A published project with only the company agreement signed and no student yet: a new pay
    // needs no tick, a new price does.
    const open = (studentPay: number | string, price = 1000, confirm = '') =>
      changeProjectPay(
        w.payload,
        session(w.admin),
        form({ id: w.projectOpen.id, wasFee: 1000, wasPay: '', price, studentPay, confirm }),
      )
    const view = await loadTeamProject(w.payload, session(w.admin), w.projectOpen.id)
    expect(view!.pay).toMatchObject({ companySigned: true, studentSigned: false, editable: true })
    expect(await open(800)).toMatchObject({ status: 'done' })
    expect(await projectOf(w.projectOpen.id)).toMatchObject({ fee: 1000, studentPay: 800 })
    expect(
      await changeProjectPay(
        w.payload,
        session(w.admin),
        form({ id: w.projectOpen.id, wasFee: 1000, wasPay: 800, price: 1200, studentPay: 800 }),
      ),
    ).toMatchObject({ error: 'confirm' })
  })

  it('an invoice already sent keeps its price in the payment log', async () => {
    const row = await paymentOf(work.match.id)
    await w.payload.update({
      collection: 'payments',
      id: row.id,
      data: { invoiceSentAt: new Date().toISOString() },
      ...as(w.admin),
    })
    const view = await loadTeamProject(w.payload, session(w.admin), work.project.id)
    expect(view!.pay!.invoiceSent).toBe(todayInOslo())
    expect(await change(w.admin, { price: 15_000, studentPay: 4_000, confirm: '1' })).toMatchObject(
      { status: 'done' },
    )
    expect((await paymentOf(work.match.id)).projectFee).toBe(10_000)
  })

  it('an invoice recorded as sent while the price changes keeps the price it was sent with', async () => {
    const row = await paymentOf(work.match.id)
    await w.payload.update({
      collection: 'payments',
      id: row.id,
      data: { invoiceSentAt: new Date().toISOString() },
      ...as(w.admin),
    })
    // The write the Projects hook makes when the price changes, after it read the row as unsent.
    await w.payload.update({
      collection: 'payments',
      id: row.id,
      data: { projectFee: 99_000 },
      ...as(w.admin),
      context: { feeFollowsProject: true },
    })
    expect((await paymentOf(work.match.id)).projectFee).toBe(10_000)
  })

  it('after a change the company never reads the pay and the student never reads the price', async () => {
    expect(await change(w.admin, { price: 13_000, studentPay: 6_000, confirm: '1' })).toMatchObject(
      { status: 'done' },
    )
    const id = work.project.id
    const company = await login(w.companyA.user.email)
    const student = await login(w.beta.user.email)
    for (const path of [`projects/${id}?depth=2`, 'payments?depth=2', 'matches?depth=2']) {
      const res = await rest.get(path, company)
      expect(res.text).not.toContain('studentPay')
      expect(res.text).not.toContain('6000')
    }
    const gql = await graphql(
      `
        {
          Projects {
            docs {
              id
              fee
              studentPay
            }
          }
        }
      `,
      company,
    )
    expect(gql.text).not.toContain('6000')
    const local = await w.payload.findByID({ collection: 'projects', id, ...as(w.companyA.user) })
    expect(local).not.toHaveProperty('studentPay')
    expect(local.fee).toBe(13_000)
    for (const path of ['payments?depth=2', 'matches?depth=2']) {
      const res = await rest.get(path, student)
      expect(res.text).not.toContain('13000')
      expect(res.text).not.toContain('projectFee')
    }
    const studentGql = await graphql(
      `
        {
          Payments {
            docs {
              id
              projectFee
            }
          }
        }
      `,
      student,
    )
    expect(studentGql.text).not.toContain('13000')
  })

  it('refuses bad amounts, a stale form, no change, an unpaid or closed project', async () => {
    expect(await change(w.admin, { price: 'ten', confirm: '1' })).toMatchObject({
      error: 'price_invalid',
    })
    expect(await change(w.admin, { price: 0, confirm: '1' })).toMatchObject({
      error: 'price_invalid',
    })
    expect(await change(w.admin, { price: 5_000, studentPay: 6_000, confirm: '1' })).toMatchObject({
      error: 'student_pay_invalid',
    })
    expect(await change(w.admin, { price: 10_000, studentPay: 4_000, confirm: '1' })).toMatchObject(
      { error: 'same' },
    )
    expect(
      await changeProjectPay(
        w.payload,
        session(w.admin),
        form({ id: work.project.id, wasFee: 9_000, wasPay: 4_000, price: 11_000, confirm: '1' }),
      ),
    ).toMatchObject({ error: 'changed' })
    // A draft is not changed here (the approval queue sets the price at review).
    expect(
      await changeProjectPay(
        w.payload,
        session(w.admin),
        form({ id: w.projectB.id, wasFee: 1000, wasPay: '', price: 2000 }),
      ),
    ).toMatchObject({ error: 'not_open' })
    expect((await projectOf(work.project.id)).fee).toBe(10_000)
  })

  it('the company and the student cannot change the price or pay through any API', async () => {
    const id = work.project.id
    for (const user of [w.companyA.user, w.beta.user, w.alpha.user, w.companyB.user]) {
      expect(await change(user, { price: 1, studentPay: 1, confirm: '1' })).toMatchObject({
        status: 'error',
        error: 'forbidden',
      })
      // Local API with access control on: refused, or the fields dropped.
      await w.payload
        .update({ collection: 'projects', id, data: { fee: 1, studentPay: 1 }, ...as(user) })
        .catch(() => null)
    }
    for (const cookie of [
      await login(w.companyA.user.email),
      await login(w.beta.user.email),
      undefined,
    ]) {
      await rest.patch(`projects/${id}`, { fee: 2, studentPay: 2 }, cookie)
      await graphql(
        `mutation { updateProject(id: ${id}, data: { fee: 3, studentPay: 3 }) { id } }`,
        cookie,
      )
    }
    expect(await projectOf(id)).toMatchObject({ fee: 10_000, studentPay: 4_000 })
    expect((await paymentOf(work.match.id)).projectFee).toBe(10_000)
    // And no price change was logged.
    expect(
      (await activity('projects', id)).some(
        (r) => r.action === 'review_change' && r.field === 'fee' && r.toStatus !== '10000',
      ),
    ).toBe(false)
    // The team member's own REST change works the same way (the hook logs it).
    const admin = await sessionFor(w.admin.id)
    const res = await rest.patch(`projects/${id}`, { fee: 10_500 }, admin)
    expect(res.status).toBe(200)
    expect((await projectOf(id)).fee).toBe(10_500)
  })
})

// ---------------------------------------------------------------------------------------------
describe('50: payment emails, once per transition', () => {
  let work: Awaited<ReturnType<typeof workingMatch>>
  let row: Payment

  beforeEach(async () => {
    work = await workingMatch(w.payload, w.admin, w.beta, w.companyA, 'Invoice project', {
      fee: 12_000,
      studentPay: 5_000,
      paidOrUnpaid: 'paid',
    })
    row = await paymentOf(work.match.id)
    await w.payload.update({
      collection: 'payments',
      id: row.id,
      data: { notes: 'Team-Only-Payment-Notes', invoiceNumber: 'INV-SECRET-1' },
      ...as(w.admin),
    })
    mail.mockClear()
  })

  const save = (data: Partial<Payment>, user: User = w.admin) =>
    w.payload.update({ collection: 'payments', id: row.id, data, ...as(user) })
  const today = () => new Date().toISOString()

  it('invoice sent, then paid: one email each to the company, with title and amount', async () => {
    await save({ invoiceSentAt: today() })
    let toCompany = mailsTo(w.companyA.user.email)
    expect(toCompany).toHaveLength(1)
    expect(toCompany[0]!.subject).toContain('Invoice project')
    // 12 000 excl. VAT, 15 000 with 25 % VAT, due in 14 days.
    expect(toCompany[0]!.text).toMatch(/12[\s,.  ]?000/)
    expect(toCompany[0]!.text).toMatch(/15[\s,.  ]?000/)
    expect(toCompany[0]!.text).toContain('/en/company/payments')

    // Saving the row again, or changing the date, sends nothing more.
    await save({ notes: 'Another note' })
    await save({ invoiceSentAt: today(), invoiceNumber: 'INV-2' })
    expect(mailsTo(w.companyA.user.email)).toHaveLength(1)

    await save({ invoicePaidAt: today() })
    toCompany = mailsTo(w.companyA.user.email)
    expect(toCompany).toHaveLength(2)
    expect(toCompany[1]!.subject).toMatch(/Payment received/)
    expect(toCompany[1]!.text).toMatch(/15[\s,.  ]?000/)
    await save({ invoicePaidAt: today() })
    expect(mailsTo(w.companyA.user.email)).toHaveLength(2)
    // The student hears nothing about the company's invoice.
    expect(mailsTo(w.beta.user.email)).toHaveLength(0)
  })

  it('paid in the pay run: one email to the student, with their pay and no company price', async () => {
    await save({ invoiceSentAt: today(), invoicePaidAt: today() })
    mail.mockClear()
    await save({ studentPaidAt: today() })
    const toStudent = mailsTo(w.beta.user.email)
    expect(toStudent).toHaveLength(1)
    expect(toStudent[0]!.subject).toContain('Invoice project')
    expect(toStudent[0]!.text).toMatch(/5[\s,.  ]?000/)
    expect(toStudent[0]!.text).not.toMatch(/12[\s,.  ]?000|15[\s,.  ]?000/)
    expect(toStudent[0]!.text).toContain('/en/student/payments')
    expect(mailsTo(w.companyA.user.email)).toHaveLength(0)
    await save({ studentPaidAt: today(), notes: 'x' })
    expect(mailsTo(w.beta.user.email)).toHaveLength(1)
  })

  it('no personal data or team notes in any payment email', async () => {
    await save({ invoiceSentAt: today() })
    await save({ invoicePaidAt: today() })
    await save({ studentPaidAt: today() })
    expect(sent()).toHaveLength(3)
    const company = mailsTo(w.companyA.user.email)
      .map((m) => `${m.subject}${m.text}${m.html}`)
      .join('\n')
    for (const value of Object.values(SENTINEL.beta)) expect(company).not.toContain(value)
    const all = allMail()
    expect(all).not.toContain('Team-Only-Payment-Notes')
    expect(all).not.toContain('INV-SECRET-1')
    expect(all).not.toContain('INV-2')
  })

  it('in the recipient’s language', async () => {
    await w.payload.update({
      collection: 'users',
      id: w.companyA.user.id,
      data: { language: 'no' },
      overrideAccess: true,
    })
    await save({ invoiceSentAt: today() })
    const [email] = mailsTo(w.companyA.user.email)
    expect(email!.subject).toMatch(/^Faktura sendt/)
    expect(email!.text).toContain('/no/company/payments')
  })

  it('a date cleared and recorded again sends nothing new', async () => {
    await save({ invoiceSentAt: today() })
    await save({ invoiceSentAt: null })
    await save({ invoiceSentAt: today() })
    expect(mailsTo(w.companyA.user.email)).toHaveLength(1)
  })

  it('two saves at once send the notice once', async () => {
    await Promise.allSettled([
      save({ invoiceSentAt: today() }),
      save({ invoiceSentAt: today(), invoiceNumber: 'INV-RACE' }),
    ])
    expect(mailsTo(w.companyA.user.email)).toHaveLength(1)
  })

  it('a company or a student cannot record a payment, so no email goes out', async () => {
    for (const user of [w.companyA.user, w.beta.user]) {
      await expect(save({ invoiceSentAt: today(), studentPaidAt: today() }, user)).rejects.toThrow()
    }
    for (const cookie of [
      await login(w.companyA.user.email),
      await login(w.beta.user.email),
      undefined,
    ]) {
      const res = await rest.patch(`payments/${row.id}`, { invoiceSentAt: today() }, cookie)
      expect([401, 403, 404]).toContain(res.status)
      await graphql(
        `mutation { updatePayment(id: ${row.id}, data: { invoicePaidAt: "${today()}" }) { id } }`,
        cookie,
      )
    }
    const stored = await paymentOf(work.match.id)
    expect(stored.invoiceSentAt ?? null).toBeNull()
    expect(stored.invoicePaidAt ?? null).toBeNull()
    expect(sent()).toHaveLength(0)
  })

  it('every payment email renders completely in English and Norwegian', () => {
    for (const locale of ['en', 'no'] as const) {
      const emails = [
        paymentEmail(locale, 'invoiceSent', {
          title: 'T',
          price: { price: 100, total: 125 },
          dueDay: addDays(todayInOslo(), 14),
          href: 'http://x.test/a',
        }),
        paymentEmail(locale, 'invoiceSent', { title: 'T', price: null, href: 'http://x.test/a' }),
        paymentEmail(locale, 'invoicePaid', {
          title: 'T',
          price: { price: 100, total: 125 },
          href: 'http://x.test/a',
        }),
        paymentEmail(locale, 'studentPaid', { title: 'T', amount: 50, href: 'http://x.test/a' }),
        paymentEmail(locale, 'studentPaid', { title: 'T', amount: null, href: 'http://x.test/a' }),
        teamProblemEmail(locale, { title: 'T', kind: 'more_time', pool: true, href: 'http://x' }),
        teamProblemEmail(locale, {
          title: 'T',
          kind: 'cannot_finish',
          pool: false,
          href: 'http://x',
        }),
      ]
      for (const email of emails) {
        for (const part of [email.subject, email.html, email.text]) {
          expect(part).not.toMatch(/undefined|\{\w+\}|\[object/)
        }
        expect(email.html).not.toMatch(/<img|<script|<iframe/i)
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------
describe('51: match again puts the earlier applicants back into the pool', () => {
  let projectId: number
  let gamma: Awaited<ReturnType<typeof student>>
  let delta: Awaited<ReturnType<typeof student>>
  let apps: Record<'alpha' | 'beta' | 'gamma' | 'delta', Application>

  /**
   * A paid project of company B with four applicants: beta is selected (and later replaced),
   * alpha and gamma are not selected, delta withdrew.
   */
  beforeEach(async () => {
    gamma = await student('gamma')
    delta = await student('delta')
    const project = await w.payload.create({
      collection: 'projects',
      data: {
        company: w.companyB.company.id,
        title: 'Match again',
        description: 'x',
        deliverable: 'y',
        desiredSkills: ['Figma'],
        workloadHours: 20,
        durationWeeks: 2,
        workMode: 'remote',
        paidOrUnpaid: 'paid',
        fee: 1000,
        deadline: dayFromNow(7),
        startDate: dayFromNow(14),
        status: 'draft',
      },
      overrideAccess: true,
    })
    projectId = project.id
    for (const status of ['submitted', 'approved'] as const) {
      await w.payload.update({
        collection: 'projects',
        id: projectId,
        data: { status },
        ...as(w.admin),
      })
    }
    await signedAgreement(w.payload, w.admin, w.companyB.user, { kind: 'company', projectId })
    await w.payload.update({
      collection: 'projects',
      id: projectId,
      data: { status: 'published' },
      ...as(w.admin),
    })
    await w.payload.update({
      collection: 'student-profiles',
      id: w.beta.profile.id,
      data: { reviewStatus: 'reviewed' },
      ...as(w.admin),
    })
    await w.payload.update({
      collection: 'student-profiles',
      id: w.alpha.profile.id,
      data: { reviewStatus: 'reviewed' },
      ...as(w.admin),
    })
    const apply = (user: User) =>
      w.payload.create({
        collection: 'applications',
        data: { project: projectId, note: 'Why I fit' } as never,
        ...as(user),
      }) as Promise<Application>
    apps = {
      alpha: await apply(w.alpha.user),
      beta: await apply(w.beta.user),
      gamma: await apply(gamma.user),
      delta: await apply(delta.user),
    }
    await w.payload.update({
      collection: 'applications',
      id: apps.delta.id,
      data: { status: 'withdrawn' },
      ...as(delta.user),
    })
    await w.payload.update({
      collection: 'applications',
      id: apps.gamma.id,
      data: { status: 'shortlisted' },
      ...as(w.admin),
    })
    expect(
      await selectApplication(w.payload, session(w.admin), form({ id: apps.beta.id })),
    ).toMatchObject({ status: 'done' })
    mail.mockClear()
  })

  const statusOf = async (id: number) =>
    (await w.payload.findByID({ collection: 'applications', id, depth: 0, overrideAccess: true }))
      .status

  const matchAgain = () =>
    endMatchAndReopen(
      w.payload,
      session(w.admin),
      form({ id: projectId, date: dayFromNow(8).slice(0, 10) }),
    )

  it('not selected go back to applied; the replaced student and who withdrew stay out; logged', async () => {
    expect(await statusOf(apps.alpha.id)).toBe('not_selected')
    expect(await matchAgain()).toMatchObject({ status: 'done' })
    expect(await statusOf(apps.alpha.id)).toBe('applied')
    expect(await statusOf(apps.gamma.id)).toBe('applied')
    expect(await statusOf(apps.beta.id)).toBe('match_ended')
    expect(await statusOf(apps.delta.id)).toBe('withdrawn')
    const alpha = await w.payload.findByID({
      collection: 'applications',
      id: apps.alpha.id,
      overrideAccess: true,
    })
    expect(alpha.decidedAt ?? null).toBeNull()
    expect(alpha.shortlistedAt ?? null).toBeNull()

    // The project's history says how many came back, with who did it.
    const rows = await activity('projects', projectId)
    expect(rows.find((r) => r.field === 'applicationsBack')).toMatchObject({
      action: 'review_change',
      toStatus: '2',
      actor: w.admin.id,
    })
    // Each application's own move is logged too.
    expect(
      (await activity('applications', apps.alpha.id)).some(
        (r) => r.fromStatus === 'not_selected' && r.toStatus === 'applied',
      ),
    ).toBe(true)
    // The student reads their application as in review again; no email about it.
    const own = await w.payload.findByID({
      collection: 'applications',
      id: apps.alpha.id,
      ...as(w.alpha.user),
    })
    expect(own.status).toBe('applied')
    expect(mailsTo(w.alpha.user.email)).toHaveLength(0)
  })

  it('the new selection still meets every rule: one of them is picked, the others not selected again', async () => {
    await matchAgain()
    expect(
      await selectApplication(w.payload, session(w.admin), form({ id: apps.gamma.id })),
    ).toMatchObject({ status: 'done' })
    expect(await statusOf(apps.gamma.id)).toBe('selected')
    expect(await statusOf(apps.alpha.id)).toBe('not_selected')
    expect(await statusOf(apps.beta.id)).toBe('match_ended')
    expect(await statusOf(apps.delta.id)).toBe('withdrawn')
  })

  it('at most 2 running projects still holds for a student back in the pool', async () => {
    await matchAgain()
    // alpha gets running projects up to the limit of 2.
    for (let n = 1; (await runningProjectCount(w.payload, w.alpha.profile.id)) < 2; n++) {
      await workingMatch(w.payload, w.admin, w.alpha, w.companyA, `Alpha running ${n}`)
    }
    expect(
      await selectApplication(w.payload, session(w.admin), form({ id: apps.alpha.id })),
    ).toMatchObject({ error: 'too_many' })
    expect(await statusOf(apps.alpha.id)).toBe('applied')
    expect((await projectOf(projectId)).status).toBe('published')
  })

  it('nobody moves an application back into the pool by hand, through any API', async () => {
    for (const user of [w.admin, w.alpha.user, w.companyB.user]) {
      await expect(
        w.payload.update({
          collection: 'applications',
          id: apps.alpha.id,
          data: { status: 'applied' },
          ...as(user),
        }),
      ).rejects.toThrow()
    }
    for (const cookie of [
      await sessionFor(w.admin.id),
      await login(w.alpha.user.email),
      await login(w.companyB.user.email),
      undefined,
    ]) {
      const res = await rest.patch(`applications/${apps.alpha.id}`, { status: 'applied' }, cookie)
      expect(res.status).toBeGreaterThanOrEqual(400)
      await graphql(
        `mutation { updateApplication(id: ${apps.alpha.id}, data: { status: applied }) { id } }`,
        cookie,
      )
    }
    expect(await statusOf(apps.alpha.id)).toBe('not_selected')
    // A withdrawn application never comes back, not even with match again.
    await matchAgain()
    expect(await statusOf(apps.delta.id)).toBe('withdrawn')
  })

  it('closing without delivery puts nobody back', async () => {
    expect(
      await closeWithoutDelivery(
        w.payload,
        session(w.admin),
        form({ id: projectId, reason: 'It ended' }),
      ),
    ).toMatchObject({ status: 'done' })
    expect(await statusOf(apps.alpha.id)).toBe('not_selected')
  })
})

// ---------------------------------------------------------------------------------------------
describe('52: a problem report emails the team straight away', () => {
  const AMANDA = 'amanda@konnected.test'
  const JULIE = 'julie@konnected.test'
  const PAUSED = 'paused@konnected.test'
  const NOTE = 'Problem-Note-For-The-Team-Only'
  let work: Awaited<ReturnType<typeof workingMatch>>
  let amanda: User
  let julie: User

  beforeEach(async () => {
    vi.stubEnv('ADMIN_EMAILS', `${ADMIN_EMAIL},${AMANDA},${JULIE},${PAUSED}`)
    amanda = await makeAdmin(AMANDA, 'Amanda Berg')
    julie = await makeAdmin(JULIE, 'Julie Lie', 'no')
    const paused = await makeAdmin(PAUSED, 'Paul Paused')
    await w.payload.update({
      collection: 'users',
      id: paused.id,
      data: { accountStatus: 'paused' },
      overrideAccess: true,
    })
    work = await workingMatch(w.payload, w.admin, w.beta, w.companyA, 'Troubled project')
    mail.mockClear()
  })

  const report = (kind = 'cannot_finish') =>
    w.payload.create({
      collection: 'problem-reports',
      data: { match: work.match.id, kind, note: NOTE } as never,
      ...as(w.beta.user),
    })

  const setOwners = async (project: number | null, company: number | null) => {
    await w.payload.update({
      collection: 'projects',
      id: work.project.id,
      data: { owner: project, takenBy: null },
      overrideAccess: true,
      context: { skipActivityLog: true },
    })
    await w.payload.update({
      collection: 'companies',
      id: w.companyA.company.id,
      data: { teamOwner: company, takenBy: null },
      overrideAccess: true,
      context: { skipActivityLog: true },
    })
  }

  it('to the project owner only, with the title, the kind and a link; never the note or the student', async () => {
    await setOwners(amanda.id, null)
    await report('cannot_finish')
    const toAmanda = mailsTo(AMANDA)
    expect(toAmanda).toHaveLength(1)
    expect(toAmanda[0]!.subject).toContain('Troubled project')
    expect(toAmanda[0]!.text).toContain('cannot finish')
    expect(toAmanda[0]!.text).toContain(`/en/team/projects/${work.project.id}`)
    expect(mailsTo(ADMIN_EMAIL)).toHaveLength(0)
    expect(mailsTo(JULIE)).toHaveLength(0)
    const team = toAmanda.map((m) => `${m.subject}${m.text}${m.html}`).join('\n')
    expect(team).not.toContain(NOTE)
    for (const value of Object.values(SENTINEL.beta)) expect(team).not.toContain(value)
    // The student still gets their own "we have your message".
    expect(mailsTo(w.beta.user.email)).toHaveLength(1)
  })

  it('the project has no owner: the company’s owner gets it', async () => {
    await setOwners(null, julie.id)
    await report('more_time')
    const toJulie = mailsTo(JULIE)
    expect(toJulie).toHaveLength(1)
    // Julie reads Norwegian.
    expect(toJulie[0]!.subject).toMatch(/^Problem meldt/)
    expect(toJulie[0]!.text).toContain(`/no/team/projects/${work.project.id}`)
    expect(mailsTo(AMANDA)).toHaveLength(0)
  })

  it('the shared pool: every active team member who is not away, never a paused one', async () => {
    await setOwners(null, null)
    // Julie is away today (Amanda covers).
    await w.payload.create({
      collection: 'team-members',
      data: {
        user: julie.id,
        awayFrom: dayFromNow(-1),
        awayUntil: dayFromNow(2),
        coveredBy: amanda.id,
      },
      overrideAccess: true,
      context: { skipActivityLog: true },
    })
    await report()
    expect(mailsTo(ADMIN_EMAIL)).toHaveLength(1)
    expect(mailsTo(AMANDA)).toHaveLength(1)
    expect(mailsTo(JULIE)).toHaveLength(0)
    expect(mailsTo(PAUSED)).toHaveLength(0)
    expect(mailsTo(AMANDA)[0]!.text).toMatch(/whole team/)
  })

  it('an owner who left the team counts as the pool', async () => {
    await setOwners(julie.id, null)
    vi.stubEnv('ADMIN_EMAILS', `${ADMIN_EMAIL},${AMANDA}`)
    await report()
    expect(mailsTo(JULIE)).toHaveLength(0)
    expect(mailsTo(ADMIN_EMAIL)).toHaveLength(1)
    expect(mailsTo(AMANDA)).toHaveLength(1)
  })

  it('an owner who is away: the owner and whoever covers them', async () => {
    await setOwners(julie.id, null)
    await w.payload.create({
      collection: 'team-members',
      data: {
        user: julie.id,
        awayFrom: dayFromNow(-1),
        awayUntil: dayFromNow(2),
        coveredBy: amanda.id,
      },
      overrideAccess: true,
      context: { skipActivityLog: true },
    })
    await report()
    expect(mailsTo(JULIE)).toHaveLength(1)
    expect(mailsTo(AMANDA)).toHaveLength(1)
    expect(mailsTo(ADMIN_EMAIL)).toHaveLength(0)
  })

  it('only the matched student can report; nobody else triggers the email', async () => {
    await setOwners(amanda.id, null)
    for (const user of [w.alpha.user, w.companyA.user, w.admin]) {
      await expect(
        w.payload.create({
          collection: 'problem-reports',
          data: { match: work.match.id, kind: 'more_time', note: NOTE } as never,
          ...as(user),
        }),
      ).rejects.toThrow()
    }
    for (const cookie of [
      await login(w.alpha.user.email),
      await login(w.companyA.user.email),
      undefined,
    ]) {
      const res = await rest.post(
        'problem-reports',
        { match: work.match.id, kind: 'more_time', note: NOTE },
        cookie,
      )
      expect(res.status).toBeGreaterThanOrEqual(400)
    }
    expect(mailsTo(AMANDA)).toHaveLength(0)
  })
})
