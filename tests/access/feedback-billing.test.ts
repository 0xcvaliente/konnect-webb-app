import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { saveCompanyBilling, saveOwnBilling } from '@/lib/companies/billing'
import { feedbackStatus, listProjectFeedback, sendFeedback } from '@/lib/feedback/feedback'
import type { SessionUser } from '@/lib/students/profile'
import { listPaymentLog } from '@/lib/team/payments'
import en from '@/messages/en.json'
import no from '@/messages/no.json'
import type { Deliverable, Feedback, User } from '@/payload-types'

import {
  asUser,
  createWorld,
  graphql,
  login,
  resetDatabase,
  rest,
  sessionFor,
  type World,
  workingMatch,
} from '../helpers/world'

/**
 * Kanban cards "Feedback: collect after close and show to the team" and "Billing details for
 * invoices". Feedback: once per side after a project closes with its work delivered, only the team
 * reads it (the author reads their own row only to know it was sent). Billing: the company edits
 * its own while pending or approved, the team edits any company's, a billing-only save is not an
 * answer to Konnected's review, the payment log shows it, and no student ever reads it. Checked as
 * each role through the Local API with access control on, REST and GraphQL.
 */

let w: World
let work: Awaited<ReturnType<typeof workingMatch>>
let mail: MockInstance

const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })
const session = (user: User) => asUser(user) as unknown as SessionUser
const form = (fields: Record<string, string | number>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, String(v))
  return f
}
const mailsTo = (email: string) =>
  mail.mock.calls
    .map((c) => c[0] as { to: string; subject: string; text: string })
    .filter((m) => m.to === email)

const STUDENT_FB = 'Leak-Feedback-Student-Beta: the brief was clear'
const COMPANY_FB = 'Company-Feedback-A: the summary could be shorter'

/** beta delivers on a paid project of company A; Konnected releases, accepts and closes it. */
async function closeAfterDelivery() {
  const d = (await w.payload.create({
    collection: 'deliverables',
    data: { match: work.match.id, links: [{ url: 'https://example.test/x' }], status: 'submitted' },
    ...as(w.beta.user),
  })) as Deliverable
  for (const status of ['released', 'accepted'] as const) {
    await w.payload.update({
      collection: 'deliverables',
      id: d.id,
      data: { status },
      ...as(w.admin),
    })
  }
  await w.payload.update({
    collection: 'projects',
    id: work.project.id,
    data: { status: 'closed' },
    ...as(w.admin),
  })
}

beforeEach(async () => {
  await resetDatabase()
  w = await createWorld()
  work = await workingMatch(w.payload, w.admin, w.beta, w.companyA, 'Feedback project', {
    fee: 9_000,
    paidOrUnpaid: 'paid',
  })
  mail = vi.spyOn(w.payload.email, 'sendEmail')
  mail.mockClear()
})

describe('feedback after a project', () => {
  it('opens only when the project closes after delivery, and both sides are emailed once', async () => {
    expect(await feedbackStatus(w.payload, session(w.beta.user), work.project.id)).toBe('none')
    expect(
      await sendFeedback(
        w.payload,
        session(w.beta.user),
        form({ projectId: work.project.id, rating: 4 }),
      ),
    ).toMatchObject({ error: 'not_open' })

    await closeAfterDelivery()
    const toBeta = mailsTo(w.beta.user.email).filter((m) => /How did/.test(m.subject))
    const toCompany = mailsTo(w.companyA.user.email).filter((m) => /How did/.test(m.subject))
    expect(toBeta).toHaveLength(1)
    expect(toBeta[0]!.text).toContain(`/student/applications/${work.application.id}/feedback`)
    expect(toCompany).toHaveLength(1)
    expect(toCompany[0]!.text).toContain(`/company/projects/${work.project.id}/feedback`)
    // The company's email names no student.
    expect(toCompany[0]!.text).not.toContain('Sentinel-Name-Beta')

    expect(await feedbackStatus(w.payload, session(w.beta.user), work.project.id)).toBe('open')
    expect(await feedbackStatus(w.payload, session(w.companyA.user), work.project.id)).toBe('open')
    // Not for anyone else.
    expect(await feedbackStatus(w.payload, session(w.alpha.user), work.project.id)).toBe('none')
    expect(await feedbackStatus(w.payload, session(w.companyB.user), work.project.id)).toBe('none')
  })

  it('each side sends once; the author and side come from the session', async () => {
    await closeAfterDelivery()
    const sent = await w.payload.create({
      collection: 'feedback',
      data: {
        project: work.project.id,
        rating: 5,
        wentWell: STUDENT_FB,
        again: true,
        // Ignored: the server sets these.
        author: w.alpha.user.id,
        side: 'company',
      } as never,
      ...as(w.beta.user),
    })
    const stored = (await w.payload.findByID({
      collection: 'feedback',
      id: sent.id,
      depth: 0,
      overrideAccess: true,
    })) as Feedback
    expect(stored).toMatchObject({
      author: w.beta.user.id,
      side: 'student',
      match: work.match.id,
      rating: 5,
      again: true,
    })
    expect(
      await sendFeedback(
        w.payload,
        session(w.beta.user),
        form({ projectId: work.project.id, rating: 3 }),
      ),
    ).toMatchObject({ error: 'already_sent' })
    expect(await feedbackStatus(w.payload, session(w.beta.user), work.project.id)).toBe('sent')

    expect(
      await sendFeedback(
        w.payload,
        session(w.companyA.user),
        form({ projectId: work.project.id, rating: 4, couldBeBetter: COMPANY_FB, again: 'on' }),
      ),
    ).toMatchObject({ status: 'done' })

    // Two at once from one person: one row.
    const again = await Promise.allSettled([
      sendFeedback(
        w.payload,
        session(w.companyA.user),
        form({ projectId: work.project.id, rating: 2 }),
      ),
      sendFeedback(
        w.payload,
        session(w.companyA.user),
        form({ projectId: work.project.id, rating: 2 }),
      ),
    ])
    expect(again.every((r) => r.status === 'fulfilled' && r.value.status === 'error')).toBe(true)
    const rows = await w.payload.find({
      collection: 'feedback',
      where: { project: { equals: work.project.id } },
      overrideAccess: true,
    })
    expect(rows.totalDocs).toBe(2)
  })

  it('a rating from 1 to 5 is needed, and nobody else can send', async () => {
    await closeAfterDelivery()
    for (const rating of ['0', '6', '2.5', 'x']) {
      expect(
        await sendFeedback(
          w.payload,
          session(w.beta.user),
          form({ projectId: work.project.id, rating }),
        ),
      ).toMatchObject({ error: 'rating_required' })
    }
    for (const user of [w.alpha.user, w.companyB.user]) {
      expect(
        await sendFeedback(
          w.payload,
          session(user),
          form({ projectId: work.project.id, rating: 3 }),
        ),
      ).toMatchObject({ error: 'not_found' })
    }
    expect(
      await sendFeedback(
        w.payload,
        session(w.admin),
        form({ projectId: work.project.id, rating: 3 }),
      ),
    ).toMatchObject({ error: 'forbidden' })
    await expect(
      w.payload.create({
        collection: 'feedback',
        data: { project: work.project.id, rating: 3 } as never,
        overrideAccess: false,
      }),
    ).rejects.toThrow()
  })

  it('only the team reads feedback; each author reads only their own; nobody changes it', async () => {
    await closeAfterDelivery()
    const studentRow = await w.payload.create({
      collection: 'feedback',
      data: { project: work.project.id, rating: 5, wentWell: STUDENT_FB } as never,
      ...as(w.beta.user),
    })
    await w.payload.create({
      collection: 'feedback',
      data: { project: work.project.id, rating: 4, couldBeBetter: COMPANY_FB } as never,
      ...as(w.companyA.user),
    })
    const sweep = async (user: User | null) => {
      const cookie = user
        ? user.role === 'admin'
          ? await sessionFor(user.id)
          : await login(user.email)
        : undefined
      const parts = [
        (await rest.get('feedback?depth=3&limit=100', cookie)).text,
        (
          await graphql(
            '{ FeedbackEntries(limit: 100) { docs { id side rating wentWell couldBeBetter again author { id email } match { id } project { id title } } } }',
            cookie,
          )
        ).text,
      ]
      if (user) {
        try {
          parts.push(
            JSON.stringify(await w.payload.find({ collection: 'feedback', depth: 3, ...as(user) })),
          )
        } catch {
          parts.push('')
        }
      }
      return parts.join('\n')
    }
    const admin = await sweep(w.admin)
    expect(admin).toContain(STUDENT_FB)
    expect(admin).toContain(COMPANY_FB)
    const company = await sweep(w.companyA.user)
    expect(company).toContain(COMPANY_FB)
    expect(company).not.toContain(STUDENT_FB)
    const beta = await sweep(w.beta.user)
    expect(beta).toContain(STUDENT_FB)
    expect(beta).not.toContain(COMPANY_FB)
    for (const user of [w.alpha.user, w.companyB.user, null]) {
      const all = await sweep(user)
      expect(all).not.toContain(STUDENT_FB)
      expect(all).not.toContain(COMPANY_FB)
    }
    // Nobody changes feedback, the team included; only the team deletes.
    for (const user of [w.beta.user, w.admin]) {
      await expect(
        w.payload.update({
          collection: 'feedback',
          id: studentRow.id,
          data: { rating: 1 },
          ...as(user),
        }),
      ).rejects.toThrow()
    }
    await expect(
      w.payload.delete({ collection: 'feedback', id: studentRow.id, ...as(w.beta.user) }),
    ).rejects.toThrow()

    // The team's project view lists both, and nobody else gets it.
    const list = await listProjectFeedback(w.payload, session(w.admin), work.project.id)
    expect(list.map((f) => f.side).sort()).toEqual(['company', 'student'])
    expect(await listProjectFeedback(w.payload, session(w.companyA.user), work.project.id)).toEqual(
      [],
    )

    // Each send is in the activity log, without the text.
    const log = await w.payload.find({
      collection: 'activity-logs',
      where: { targetCollection: { equals: 'feedback' } },
      depth: 0,
      overrideAccess: true,
    })
    expect(log.totalDocs).toBe(2)
    expect(JSON.stringify(log.docs)).not.toContain(STUDENT_FB)
  })
})

describe('billing details', () => {
  const billing = { invoiceEmail: 'Faktura@Company-A.example', invoiceReference: 'PO-77' }

  it('the company saves its own; the payment log shows them to the team', async () => {
    expect(
      await saveOwnBilling(
        w.payload,
        session(w.companyA.user),
        form({ ...billing, ehfInvoice: 'on' }),
      ),
    ).toMatchObject({ status: 'done' })
    const company = await w.payload.findByID({
      collection: 'companies',
      id: w.companyA.company.id,
      ...as(w.companyA.user),
    })
    expect(company).toMatchObject({
      invoiceEmail: 'faktura@company-a.example',
      invoiceReference: 'PO-77',
      ehfInvoice: true,
    })
    const log = await listPaymentLog(w.payload, session(w.admin), { filter: 'all' })
    const row = log!.rows.find((r) => r.projectId === work.project.id)!
    expect(row.billing).toEqual({
      invoiceEmail: 'faktura@company-a.example',
      invoiceReference: 'PO-77',
      ehf: true,
    })
    // The change is in the activity log by field name, never the value.
    const changes = await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [
          { targetCollection: { equals: 'companies' } },
          { action: { equals: 'review_change' } },
        ],
      },
      depth: 0,
      overrideAccess: true,
    })
    expect(changes.docs.map((d) => d.field).sort()).toEqual([
      'ehfInvoice',
      'invoiceEmail',
      'invoiceReference',
    ])
    expect(JSON.stringify(changes.docs)).not.toContain('faktura@')
  })

  it('a bad email is refused; the team edits any company; others cannot', async () => {
    expect(
      await saveOwnBilling(w.payload, session(w.companyA.user), form({ invoiceEmail: 'nope' })),
    ).toMatchObject({ status: 'error', fields: { invoiceEmail: 'invalid' } })
    await expect(
      w.payload.update({
        collection: 'companies',
        id: w.companyA.company.id,
        data: { invoiceEmail: 'not an email' },
        ...as(w.admin),
      }),
    ).rejects.toThrow()
    expect(
      await saveCompanyBilling(
        w.payload,
        session(w.admin),
        form({ companyId: w.companyB.company.id, invoiceEmail: 'b@company-b.example' }),
      ),
    ).toMatchObject({ status: 'done' })
    for (const user of [w.companyA.user, w.beta.user]) {
      expect(
        await saveCompanyBilling(
          w.payload,
          session(user),
          form({ companyId: w.companyB.company.id, invoiceEmail: 'x@y.example' }),
        ),
      ).toMatchObject({ error: 'forbidden' })
    }
    // Company A cannot write company B's billing through the API either.
    await expect(
      w.payload.update({
        collection: 'companies',
        id: w.companyB.company.id,
        data: { invoiceEmail: 'x@y.example' },
        ...as(w.companyA.user),
      }),
    ).rejects.toThrow()
    expect(
      (
        await w.payload.findByID({
          collection: 'companies',
          id: w.companyB.company.id,
          overrideAccess: true,
        })
      ).invoiceEmail,
    ).toBe('b@company-b.example')
    expect(await saveOwnBilling(w.payload, session(w.beta.user), form(billing))).toMatchObject({
      error: 'forbidden',
    })
  })

  it('a billing-only save is not an answer to a request for more information', async () => {
    // A new pending company that Konnected asked for more information.
    const user = await w.payload.create({
      collection: 'users',
      data: {
        email: 'pending@company.test',
        password: 'Test-passw0rd-1234',
        role: 'company',
        _verified: true,
      } as never,
      overrideAccess: true,
      disableVerificationEmail: true,
    })
    const company = await w.payload.create({
      collection: 'companies',
      data: {
        name: 'Pending Co',
        orgNumber: '923609016',
        contactName: 'P',
        contactRole: 'CEO',
        sector: 'software',
        description: 'd',
        status: 'pending',
      },
      ...as(user as User),
    })
    await w.payload.update({
      collection: 'companies',
      id: company.id,
      data: { infoRequestedAt: new Date().toISOString(), noteToCompany: 'Add the website' },
      ...as(w.admin),
    })
    const linked = (await w.payload.findByID({
      collection: 'users',
      id: user.id,
      overrideAccess: true,
    })) as User
    expect(await saveOwnBilling(w.payload, session(linked), form(billing))).toMatchObject({
      status: 'done',
    })
    const stored = await w.payload.findByID({
      collection: 'companies',
      id: company.id,
      overrideAccess: true,
    })
    expect(stored.infoRequestedAt).toBeTruthy()
    expect(stored.invoiceReference).toBe('PO-77')
  })

  it('no student reads billing details, at any depth', async () => {
    await saveOwnBilling(w.payload, session(w.companyA.user), form(billing))
    const cookie = await login(w.beta.user.email)
    const texts = [
      (await rest.get('companies?depth=3', cookie)).text,
      (await rest.get('projects?depth=3', cookie)).text,
      (await rest.get('payments?depth=5', cookie)).text,
      (
        await graphql(
          '{ Companies { docs { id invoiceEmail invoiceReference ehfInvoice } } }',
          cookie,
        )
      ).text,
    ]
    for (const text of texts) {
      expect(text).not.toContain('faktura@company-a.example')
      expect(text).not.toContain('PO-77')
    }
    // Positive control: the team reads them.
    const admin = await rest.get('companies?depth=0', await sessionFor(w.admin.id))
    expect(admin.text).toContain('faktura@company-a.example')
  })
})

describe('messages', () => {
  it('every feedback and billing string exists in English and Norwegian', () => {
    const keys = (d: unknown, p = ''): string[] =>
      d && typeof d === 'object' ? Object.entries(d).flatMap(([k, v]) => keys(v, `${p}${k}.`)) : [p]
    for (const ns of ['Feedback', 'TeamFeedback', 'Billing', 'StudentPayments'] as const) {
      expect(keys(no[ns]).sort(), ns).toEqual(keys(en[ns]).sort())
    }
    expect(keys(no.Email.feedback).sort()).toEqual(keys(en.Email.feedback).sort())
  })
})
