import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { answerRelay, askQuestion, loadAskerQuestions } from '@/lib/questions/asker'
import { ANSWER_DAYS } from '@/lib/questions/fields'
import { answerDueDay, sendQuestionReminders } from '@/lib/questions/reminder'
import {
  addSavedAnswer,
  answerQuestion,
  listQuestionQueue,
  listSavedAnswers,
  loadTeamQuestion,
  questionsCount,
  relayQuestion,
} from '@/lib/questions/team'
import type { SessionUser } from '@/lib/students/profile'
import { loadToday } from '@/lib/team/today'
import en from '@/messages/en.json'
import no from '@/messages/no.json'
import type { Application, Question, User } from '@/payload-types'
import { addWorkingDays, osloDay, promiseState } from '@/lib/workingDays'

import {
  asUser,
  createWorld,
  graphql,
  login,
  resetDatabase,
  rest,
  sessionFor,
  type World,
} from '../helpers/world'

/**
 * Kanban card "Ask Konnected: questions and answers". A student asks about their own
 * application, a company about its own project; the question lands with the project's owner on
 * the team (or the pool) with a 2-working-day countdown; only the team answers, once, and the
 * asker gets it by email and in the app; the team may relay a question to the other side in its
 * own words, and that side answers once; only the asker (or the relay's recipient) and the team
 * read a row. Checked as each role through the Local API with access control on, REST and GraphQL.
 */

let w: World
let betaApplication: Application
let mail: MockInstance

const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })
const session = (user: User) => asUser(user) as unknown as SessionUser
const form = (fields: Record<string, string | number>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, String(v))
  return f
}

const STUDENT_Q = 'Leak-Student-Question-Beta: can I use Figma?'
const COMPANY_Q = 'Company-Question-A: can we add a page?'
const RELAY = 'Konnected-Relay-To-Company: is Figma fine for you?'
const ANSWER = 'Konnected-Answer: yes, Figma is fine.'
const COMPANY_REPLY = 'Company-Reply: Figma is fine.'

const mailsTo = (email: string) =>
  mail.mock.calls
    .map((c) => c[0] as { to: string; subject: string; text: string; html: string })
    .filter((m) => m.to === email)

beforeEach(async () => {
  await resetDatabase()
  w = await createWorld()
  // beta applies to company A's open project.
  betaApplication = (await w.payload.create({
    collection: 'applications',
    data: { project: w.projectOpen.id, note: 'Beta applies' } as never,
    ...as(w.beta.user),
  })) as Application
  mail = vi.spyOn(w.payload.email, 'sendEmail')
  mail.mockClear()
})

const studentAsks = (body = STUDENT_Q, user = w.beta.user, applicationId = betaApplication.id) =>
  w.payload.create({
    collection: 'questions',
    data: { application: applicationId, body } as never,
    ...as(user),
  }) as Promise<Question>

const companyAsks = (body = COMPANY_Q, projectId = w.projectA.id, user = w.companyA.user) =>
  w.payload.create({
    collection: 'questions',
    data: { project: projectId, body } as never,
    ...as(user),
  }) as Promise<Question>

describe('asking', () => {
  it('a student asks about their own application; asker, project and side come from the server', async () => {
    const q = await w.payload
      .create({
        collection: 'questions',
        data: {
          application: betaApplication.id,
          body: `  ${STUDENT_Q}  `,
          // Ignored: the server sets these.
          project: w.projectB.id,
          recipient: w.companyA.user.id,
          askedBy: w.alpha.user.id,
          side: 'company',
          kind: 'relay',
          status: 'answered',
          answer: 'Self-answered',
        } as never,
        ...as(w.beta.user),
      })
      .catch((e) => e)
    // A new question must start open; the status in the request is refused, not ignored.
    expect(q).toBeInstanceOf(Error)
    const ok = await w.payload.create({
      collection: 'questions',
      data: {
        application: betaApplication.id,
        body: `  ${STUDENT_Q}  `,
        project: w.projectB.id,
        recipient: w.companyA.user.id,
        side: 'company',
        kind: 'relay',
      } as never,
      ...as(w.beta.user),
    })
    const stored = await w.payload.findByID({
      collection: 'questions',
      id: ok.id,
      depth: 0,
      overrideAccess: true,
    })
    expect(stored).toMatchObject({
      kind: 'ask',
      project: w.projectOpen.id,
      application: betaApplication.id,
      side: 'student',
      recipient: w.beta.user.id,
      askedBy: w.beta.user.id,
      body: STUDENT_Q,
      status: 'open',
      answer: null,
    })
  })

  it('a student cannot ask about another student’s application', async () => {
    await expect(studentAsks(STUDENT_Q, w.alpha.user)).rejects.toThrow(/not yours/)
    expect(
      await askQuestion(
        w.payload,
        session(w.alpha.user),
        form({ applicationId: betaApplication.id, body: 'x' }),
      ),
    ).toMatchObject({ status: 'error', error: 'not_found' })
  })

  it('a company asks about its own project only', async () => {
    const q = await companyAsks()
    expect(
      await w.payload.findByID({
        collection: 'questions',
        id: q.id,
        depth: 0,
        overrideAccess: true,
      }),
    ).toMatchObject({ kind: 'ask', side: 'company', project: w.projectA.id })
    await expect(companyAsks(COMPANY_Q, w.projectA.id, w.companyB.user)).rejects.toThrow(
      /not yours/,
    )
    await expect(companyAsks(COMPANY_Q, w.projectB.id)).rejects.toThrow(/not yours/)
  })

  it('anonymous cannot ask, and the team asks only by relaying', async () => {
    await expect(
      w.payload.create({
        collection: 'questions',
        data: { project: w.projectA.id, body: 'x' } as never,
        overrideAccess: false,
      }),
    ).rejects.toThrow()
    expect(
      (await rest.post('questions', { project: w.projectA.id, body: 'x' })).status,
    ).toBeGreaterThanOrEqual(401)
    await expect(
      w.payload.create({
        collection: 'questions',
        data: { project: w.projectA.id, body: 'x' } as never,
        ...as(w.admin),
      }),
    ).rejects.toThrow(/existing question/)
  })

  it('at most 3 open questions per person and project', async () => {
    for (let i = 0; i < 3; i++) await studentAsks(`Q${i}`)
    await expect(studentAsks('Q4')).rejects.toThrow(/open questions/)
    expect(
      await askQuestion(
        w.payload,
        session(w.beta.user),
        form({ applicationId: betaApplication.id, body: 'Q4' }),
      ),
    ).toMatchObject({ error: 'too_many' })
    // The company's own questions count separately.
    await companyAsks(COMPANY_Q, w.projectOpen.id)
  })

  it('empty or too long questions are refused', async () => {
    expect(
      await askQuestion(
        w.payload,
        session(w.beta.user),
        form({ applicationId: betaApplication.id, body: '   ' }),
      ),
    ).toMatchObject({ error: 'text_required' })
    expect(
      await askQuestion(
        w.payload,
        session(w.beta.user),
        form({ applicationId: betaApplication.id, body: 'x'.repeat(2001) }),
      ),
    ).toMatchObject({ error: 'too_long' })
  })
})

describe('who reads a question', () => {
  let studentQ: Question
  let companyQ: Question

  beforeEach(async () => {
    studentQ = await studentAsks()
    companyQ = await companyAsks()
  })

  const sweep = async (user: User | null) => {
    const cookie = user
      ? user.role === 'admin'
        ? await sessionFor(user.id)
        : await login(user.email)
      : undefined
    const parts = [
      (await rest.get('questions?depth=3&limit=100', cookie)).text,
      (await rest.get(`questions/${studentQ.id}?depth=3`, cookie)).text,
      (
        await graphql(
          '{ Questions(limit: 100) { docs { id kind side body answer status answeredByName application { id note student { id name } } project { id title } recipient { id email } askedBy { id email } relayOf { id body } } } }',
          cookie,
        )
      ).text,
    ]
    if (user) {
      try {
        parts.push(
          JSON.stringify(await w.payload.find({ collection: 'questions', depth: 3, ...as(user) })),
        )
      } catch {
        parts.push('')
      }
    }
    return parts.join('\n')
  }

  it('admin reads every question (positive control)', async () => {
    const all = await sweep(w.admin)
    expect(all).toContain(STUDENT_Q)
    expect(all).toContain(COMPANY_Q)
  })

  it('the asker reads their own question only', async () => {
    const beta = await sweep(w.beta.user)
    expect(beta).toContain(STUDENT_Q)
    expect(beta).not.toContain(COMPANY_Q)
    const company = await sweep(w.companyA.user)
    expect(company).toContain(COMPANY_Q)
    expect(company).not.toContain(STUDENT_Q)
  })

  it('the company never reads the student’s question, even about its own project', async () => {
    const all = await sweep(w.companyA.user)
    expect(all).not.toContain(STUDENT_Q)
    expect(all).not.toContain('Beta applies')
    expect(
      (await rest.get(`questions/${studentQ.id}`, await login(w.companyA.user.email))).status,
    ).toBeGreaterThanOrEqual(403)
  })

  it('another student, another company and anonymous read nothing', async () => {
    for (const user of [w.alpha.user, w.companyB.user, null]) {
      const all = await sweep(user)
      expect(all).not.toContain(STUDENT_Q)
      expect(all).not.toContain(COMPANY_Q)
    }
  })

  it('the card shows the asker their own questions and the promised day', async () => {
    const mine = await loadAskerQuestions(w.payload, session(w.beta.user), w.projectOpen.id)
    expect(mine!.asked).toHaveLength(1)
    expect(mine!.asked[0]).toMatchObject({
      body: STUDENT_Q,
      answer: null,
      answerBy: addWorkingDays(osloDay(new Date(studentQ.createdAt)), ANSWER_DAYS),
    })
    expect(mine!.canAsk).toBe(true)
    const theirs = await loadAskerQuestions(w.payload, session(w.companyA.user), w.projectOpen.id)
    expect(theirs!.asked).toHaveLength(0)
    void companyQ
  })
})

describe('answering', () => {
  it('only the team answers, once; the asker gets it by email and in the app', async () => {
    const q = await studentAsks()
    for (const user of [w.beta.user, w.alpha.user, w.companyA.user]) {
      await expect(
        w.payload.update({
          collection: 'questions',
          id: q.id,
          data: { status: 'answered', answer: 'Self' },
          ...as(user),
        }),
      ).rejects.toThrow()
    }
    expect(
      await answerQuestion(w.payload, session(w.beta.user), form({ id: q.id, answer: 'x' })),
    ).toMatchObject({ error: 'forbidden' })

    mail.mockClear()
    expect(
      await answerQuestion(w.payload, session(w.admin), form({ id: q.id, answer: ANSWER })),
    ).toMatchObject({ status: 'done' })
    const stored = await w.payload.findByID({
      collection: 'questions',
      id: q.id,
      depth: 0,
      ...as(w.beta.user),
    })
    expect(stored).toMatchObject({ status: 'answered', answer: ANSWER })
    expect(stored.answeredByName).toBeTruthy()
    // The asker's email has the answer and their question; nobody else is emailed.
    const toBeta = mailsTo(w.beta.user.email)
    expect(toBeta).toHaveLength(1)
    expect(toBeta[0]!.text).toContain(ANSWER)
    expect(toBeta[0]!.text).toContain(STUDENT_Q)
    expect(toBeta[0]!.text).toContain(`/student/applications/${betaApplication.id}`)
    expect(mailsTo(w.companyA.user.email)).toHaveLength(0)

    // Once: a second answer is refused, and nothing else changes on a later save.
    expect(
      await answerQuestion(w.payload, session(w.admin), form({ id: q.id, answer: 'Again' })),
    ).toMatchObject({ error: 'not_open' })
    await w.payload.update({
      collection: 'questions',
      id: q.id,
      data: { body: 'Changed', recipient: w.companyA.user.id, kind: 'relay' },
      ...as(w.admin),
    })
    expect(
      await w.payload.findByID({
        collection: 'questions',
        id: q.id,
        overrideAccess: true,
        depth: 0,
      }),
    ).toMatchObject({ body: STUDENT_Q, answer: ANSWER, recipient: w.beta.user.id })

    // The card shows the answer.
    const card = await loadAskerQuestions(w.payload, session(w.beta.user), w.projectOpen.id)
    expect(card!.asked[0]).toMatchObject({ answer: ANSWER })

    // Created and answered are in the activity log, without the text.
    const log = await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [
          { targetCollection: { equals: 'questions' } },
          { targetId: { equals: String(q.id) } },
        ],
      },
      depth: 0,
      overrideAccess: true,
    })
    expect(log.docs.map((r) => r.action).sort()).toEqual(['create', 'status_change'])
    expect(JSON.stringify(log.docs)).not.toContain(ANSWER)
  })

  it('an empty answer is refused', async () => {
    const q = await studentAsks()
    expect(
      await answerQuestion(w.payload, session(w.admin), form({ id: q.id, answer: '  ' })),
    ).toMatchObject({ error: 'text_required' })
  })
})

describe('relaying to the other side', () => {
  it('the team passes a student’s question to the company; the company reads only the relay and answers once', async () => {
    const q = await studentAsks()
    mail.mockClear()
    expect(
      await relayQuestion(w.payload, session(w.admin), form({ id: q.id, body: RELAY })),
    ).toMatchObject({ status: 'done' })
    const relays = await w.payload.find({
      collection: 'questions',
      where: { relayOf: { equals: q.id } },
      overrideAccess: true,
      depth: 0,
    })
    const relay = relays.docs[0] as Question
    expect(relay).toMatchObject({
      kind: 'relay',
      side: 'company',
      recipient: w.companyA.user.id,
      askedBy: w.admin.id,
      body: RELAY,
      application: null,
    })
    // The company is emailed the team's words, never the student's question.
    const toCompany = mailsTo(w.companyA.user.email)
    expect(toCompany).toHaveLength(1)
    expect(toCompany[0]!.text).toContain(RELAY)
    expect(toCompany[0]!.text).not.toContain(STUDENT_Q)

    // What the company reads: the relay, without the link back to the student's question.
    const companyCookie = await login(w.companyA.user.email)
    const read = await rest.get('questions?depth=3', companyCookie)
    expect(read.text).toContain(RELAY)
    expect(read.text).not.toContain(STUDENT_Q)
    const doc = (read.json as { docs: Record<string, unknown>[] }).docs[0]
    expect(doc).not.toHaveProperty('relayOf')
    expect(doc).not.toHaveProperty('askedBy')
    // The student does not read the relay.
    expect((await rest.get('questions', await login(w.beta.user.email))).text).not.toContain(RELAY)

    // The company answers once; nobody else answers its relay.
    for (const user of [w.beta.user, w.companyB.user]) {
      expect(
        await answerRelay(w.payload, session(user), form({ id: relay.id, answer: 'Not mine' })),
      ).toMatchObject({ status: 'error' })
    }
    expect(
      await answerRelay(
        w.payload,
        session(w.companyA.user),
        form({ id: relay.id, answer: COMPANY_REPLY }),
      ),
    ).toMatchObject({ status: 'done' })
    expect(
      await answerRelay(
        w.payload,
        session(w.companyA.user),
        form({ id: relay.id, answer: 'Again' }),
      ),
    ).toMatchObject({ status: 'error' })
    // The company cannot answer the student's own question through the relay route.
    expect(
      await answerRelay(w.payload, session(w.companyA.user), form({ id: q.id, answer: 'x' })),
    ).toMatchObject({ status: 'error' })

    // The team sees the reply with the question; the student's question is still open.
    const view = await loadTeamQuestion(w.payload, session(w.admin), q.id)
    expect(view).toMatchObject({ status: 'open', canRelay: true })
    expect(view!.relays).toEqual([
      expect.objectContaining({ side: 'company', body: RELAY, answer: COMPANY_REPLY }),
    ])
    // The student never reads the company's reply.
    const beta = await rest.get('questions?depth=3', await login(w.beta.user.email))
    expect(beta.text).not.toContain(COMPANY_REPLY)
  })

  it('a company’s question goes to the student only once Konnected selected one', async () => {
    const onOpen = await companyAsks(COMPANY_Q, w.projectOpen.id)
    expect(
      await relayQuestion(w.payload, session(w.admin), form({ id: onOpen.id, body: 'For whom?' })),
    ).toMatchObject({ error: 'no_recipient' })
    expect((await loadTeamQuestion(w.payload, session(w.admin), onOpen.id))!.canRelay).toBe(false)

    // Project A runs with alpha: the relay goes to alpha, with alpha's application for the link.
    const onA = await companyAsks()
    mail.mockClear()
    await relayQuestion(w.payload, session(w.admin), form({ id: onA.id, body: 'Ask-Alpha' }))
    const relay = (
      await w.payload.find({
        collection: 'questions',
        where: { relayOf: { equals: onA.id } },
        overrideAccess: true,
        depth: 0,
      })
    ).docs[0] as Question
    expect(relay).toMatchObject({
      side: 'student',
      recipient: w.alpha.user.id,
      application: w.application.id,
    })
    expect(mailsTo(w.alpha.user.email)[0]!.text).toContain(
      `/student/applications/${w.application.id}`,
    )
    expect(mailsTo(w.alpha.user.email)[0]!.text).not.toContain(COMPANY_Q)
    const card = await loadAskerQuestions(w.payload, session(w.alpha.user), w.projectA.id)
    expect(card!.relays).toEqual([expect.objectContaining({ body: 'Ask-Alpha', answer: null })])
    expect(card!.asked).toHaveLength(0)
  })

  it('only the team relays', async () => {
    const q = await studentAsks()
    for (const user of [w.beta.user, w.companyA.user]) {
      await expect(
        w.payload.create({
          collection: 'questions',
          data: { relayOf: q.id, body: 'x' } as never,
          ...as(user),
        }),
      ).rejects.toThrow()
      expect(
        await relayQuestion(w.payload, session(user), form({ id: q.id, body: 'x' })),
      ).toMatchObject({ error: 'forbidden' })
    }
  })
})

describe('the team’s queue, Today and the reminder', () => {
  it('open questions show with the project’s owner and the 2-working-day countdown', async () => {
    const q = await studentAsks()
    const project = await w.payload.findByID({
      collection: 'projects',
      id: w.projectOpen.id,
      depth: 0,
      overrideAccess: true,
    })
    const queue = await listQuestionQueue(w.payload, session(w.admin))
    expect(queue).toHaveLength(1)
    expect(queue![0]).toMatchObject({
      id: q.id,
      side: 'student',
      asker: 'Sentinel-Name-Beta',
      title: 'Project A open',
      ownerId: project.owner ?? null,
      due: promiseState(new Date(q.createdAt), 2),
    })
    expect(await questionsCount(w.payload, session(w.admin))).toBe(1)
    const today = await loadToday(w.payload, session(w.admin))
    expect(today!.items.find((i) => i.kind === 'question')).toMatchObject({
      href: `/team/questions?item=${q.id}`,
      due: promiseState(new Date(q.createdAt), 2),
    })
    // Not for anyone else.
    expect(await listQuestionQueue(w.payload, session(w.beta.user))).toBeNull()
    expect(await questionsCount(w.payload, session(w.companyA.user))).toBe(0)

    await answerQuestion(w.payload, session(w.admin), form({ id: q.id, answer: ANSWER }))
    expect(await listQuestionQueue(w.payload, session(w.admin))).toHaveLength(0)
  })

  it('the owner is reminded once, the working day before the answer is due', async () => {
    const q = await studentAsks()
    const due = answerDueDay(q.createdAt)
    // 08:30 in Oslo on the working day before the due day (Oslo is UTC+1 in November).
    const dayBefore = addWorkingDays(osloDay(new Date(q.createdAt)), ANSWER_DAYS - 1)
    const morning = new Date(`${dayBefore}T07:30:00.000Z`)
    expect(due > dayBefore).toBe(true)
    mail.mockClear()
    const sent = await sendQuestionReminders(w.payload, morning)
    expect(sent).toBeGreaterThan(0)
    const toAdmin = mailsTo(w.admin.email)
    expect(toAdmin.length).toBeGreaterThan(0)
    // Who asked and what is not in the email.
    expect(toAdmin[0]!.text).not.toContain(STUDENT_Q)
    expect(toAdmin[0]!.text).not.toContain('Sentinel-Name-Beta')
    expect(await sendQuestionReminders(w.payload, morning)).toBe(0)
    // The stamp is the only change.
    expect(
      await w.payload.findByID({ collection: 'questions', id: q.id, overrideAccess: true }),
    ).toMatchObject({ status: 'open', body: STUDENT_Q })
  })

  it('the reminder job runs on the maintenance queue', () => {
    const task = w.payload.config.jobs.tasks?.find((t) => t.slug === 'questionReminder')
    expect(task?.schedule?.[0]).toMatchObject({ queue: 'maintenance' })
  })
})

describe('saved answers', () => {
  it('only the team keeps and reads saved answers', async () => {
    expect(
      await addSavedAnswer(w.payload, session(w.admin), form({ title: 'Own tools', body: 'Yes.' })),
    ).toMatchObject({ status: 'done' })
    expect(await listSavedAnswers(w.payload, session(w.admin))).toEqual([
      expect.objectContaining({ title: 'Own tools', body: 'Yes.' }),
    ])
    for (const user of [w.beta.user, w.companyA.user]) {
      expect(
        await addSavedAnswer(w.payload, session(user), form({ title: 'x', body: 'y' })),
      ).toMatchObject({ error: 'forbidden' })
      await expect(w.payload.find({ collection: 'saved-answers', ...as(user) })).rejects.toThrow()
      const res = await rest.get('saved-answers', await login(user.email))
      expect(res.status).toBe(403)
      expect(res.text).not.toContain('Own tools')
    }
    expect((await rest.get('saved-answers')).status).toBe(403)
  })
})

describe('messages', () => {
  it('every Ask Konnected string exists in English and Norwegian', () => {
    const keys = (d: unknown, p = ''): string[] =>
      d && typeof d === 'object' ? Object.entries(d).flatMap(([k, v]) => keys(v, `${p}${k}.`)) : [p]
    for (const ns of ['AskKonnected', 'TeamQuestions'] as const) {
      expect(keys(no[ns]).sort(), ns).toEqual(keys(en[ns]).sort())
    }
    expect(keys(no.Email.questions).sort()).toEqual(keys(en.Email.questions).sort())
    expect(keys(no.Email.questionReminder).sort()).toEqual(keys(en.Email.questionReminder).sort())
  })
})
