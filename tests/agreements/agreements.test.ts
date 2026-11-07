import fs from 'node:fs/promises'
import path from 'node:path'

import pg from 'pg'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agreementServerContext } from '@/access/agreements'
import { generateAgreementPdf, requestAgreement, voidAgreement } from '@/lib/agreements/generate'
import { convertDocxToPdf } from '@/lib/agreements/gotenberg'
import { sha256 } from '@/lib/agreements/pdf'
import { signAgreement } from '@/lib/agreements/sign'
import { staticDirFor } from '@/lib/uploads/storage'
import type { Agreement, AgreementPdf, Project, User } from '@/payload-types'

import { makeAgreement, runAgreementJobs, signAs, signedAgreement } from '../helpers/agreements'
import { fileOf } from '../helpers/files'
import {
  asUser,
  createWorld,
  graphql,
  login,
  orgNumberFor,
  readyFields,
  resetDatabase,
  rest,
  selectStudent,
  SENTINEL,
  sessionFor,
  type World,
} from '../helpers/world'

/**
 * Agreements, signatures and their PDFs, checked as each role: who reads what (a company never a
 * student agreement, a third party neither), the signing rules and their order, the two status
 * gates, immutability once signed, two signatures at the same moment, and the email with the PDF.
 */

let w: World
let cookies: Record<
  'admin' | 'companyA' | 'companyB' | 'alpha' | 'beta' | 'none',
  string | undefined
>
const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })
const gotenberg = () =>
  (globalThis as { __gotenberg?: { down: boolean; lastText: string } }).__gotenberg!

const find = async (kind: 'company' | 'student', projectId: number) => {
  const res = await w.payload.find({
    collection: 'agreements',
    where: { and: [{ kind: { equals: kind } }, { project: { equals: projectId } }] },
    depth: 0,
    overrideAccess: true,
  })
  return res.docs[0] as Agreement
}

/**
 * A fresh project for company A, moved to `approved` (ready for its company agreement). Paid with
 * the price given; without a price Konnected decided unpaid.
 */
const approvedProject = async (title = 'Fresh project', fee: number | null = 2000) => {
  const project = await w.payload.create({
    collection: 'projects',
    data: {
      ...readyFields(),
      company: w.companyA.company.id,
      title,
      description: 'd',
      paidOrUnpaid: fee === null ? 'unpaid' : 'paid',
      fee,
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
  return project as Project
}

const pdfOf = async (id: number | AgreementPdf | null | undefined) => {
  const doc = (await w.payload.findByID({
    collection: 'agreement-pdfs',
    id: typeof id === 'object' ? id!.id : id!,
    overrideAccess: true,
  })) as AgreementPdf
  return { doc, data: await fs.readFile(path.join(staticDirFor('agreement-pdfs'), doc.filename!)) }
}

beforeEach(async () => {
  await resetDatabase()
  w = await createWorld()
  cookies = {
    admin: await sessionFor(w.admin.id),
    companyA: await login(w.companyA.user.email),
    companyB: await login(w.companyB.user.email),
    alpha: await login(w.alpha.user.email),
    beta: await login(w.beta.user.email),
    none: undefined,
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('who reads agreements, signatures and PDFs', () => {
  it('admin reads all; each party only its own kind; others nothing (Local API)', async () => {
    const all = await w.payload.find({ collection: 'agreements', ...as(w.admin) })
    // Company agreements of project A and project A open, and alpha's student agreement.
    expect(all.docs.map((d) => d.kind).sort()).toEqual(['company', 'company', 'student'])

    const companyA = await w.payload.find({
      collection: 'agreements',
      depth: 3,
      ...as(w.companyA.user),
    })
    expect(companyA.docs).toHaveLength(2)
    expect(companyA.docs.every((d) => d.kind === 'company')).toBe(true)

    for (const user of [w.companyB.user, w.beta.user]) {
      const none = await w.payload.find({ collection: 'agreements', ...as(user) })
      expect(none.docs).toHaveLength(0)
    }

    const alpha = await w.payload.find({ collection: 'agreements', ...as(w.alpha.user) })
    expect(alpha.docs.map((d) => d.kind)).toEqual(['student'])
  })

  it('a company never reads the student agreement, its signatures or its PDFs (REST, GraphQL)', async () => {
    const student = await find('student', w.projectA.id)
    const studentSigs = await w.payload.find({
      collection: 'signatures',
      where: { agreement: { equals: student.id } },
      overrideAccess: true,
    })
    const { doc: unsigned } = await pdfOf(student.unsignedPdf as number)
    const { doc: signed } = await pdfOf(student.signedPdf as number)

    for (const who of ['companyA', 'companyB', 'beta', 'none'] as const) {
      expect([403, 404]).toContain(
        (await rest.get(`agreements/${student.id}`, cookies[who])).status,
      )
      for (const sig of studentSigs.docs) {
        expect([403, 404]).toContain((await rest.get(`signatures/${sig.id}`, cookies[who])).status)
      }
      for (const file of [unsigned, signed]) {
        expect((await rest.get(`agreement-pdfs/file/${file.filename}`, cookies[who])).status).toBe(
          403,
        )
      }
      const gql = await graphql(
        `{ Agreement(id: ${student.id}) { id values } Signatures { docs { id agreement { id kind } } } }`,
        cookies[who],
      )
      expect(gql.text).not.toContain(SENTINEL.alpha.name)
      expect(gql.text).not.toContain('"kind":"student"')
    }

    // The student and admins can download it; the PDF itself holds the student's name.
    for (const who of ['alpha', 'admin'] as const) {
      const res = await rest.get(`agreement-pdfs/file/${signed.filename}`, cookies[who])
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toContain('attachment')
    }
  })

  it('a company reads its own company agreement PDF; another company and students cannot', async () => {
    const company = await find('company', w.projectA.id)
    const { doc } = await pdfOf(company.signedPdf as number)
    expect((await rest.get(`agreement-pdfs/file/${doc.filename}`, cookies.companyA)).status).toBe(
      200,
    )
    for (const who of ['companyB', 'alpha', 'beta', 'none'] as const) {
      expect((await rest.get(`agreement-pdfs/file/${doc.filename}`, cookies[who])).status).toBe(403)
      expect([403, 404]).toContain(
        (await rest.get(`agreements/${company.id}`, cookies[who])).status,
      )
    }
  })

  it('signatures: parties see the typed names on their own agreement, never the signer account', async () => {
    const company = await find('company', w.projectA.id)
    const res = await rest.get(
      `signatures?where[agreement][equals]=${company.id}&depth=2`,
      cookies.companyA,
    )
    const docs = (res.json as { docs: Record<string, unknown>[] }).docs
    expect(docs.map((d) => d.party).sort()).toEqual(['company', 'konnected'])
    expect(docs.every((d) => d.signer === undefined)).toBe(true)
    const admin = await rest.get(`signatures?where[agreement][equals]=${company.id}`, cookies.admin)
    expect((admin.json as { docs: Record<string, unknown>[] }).docs.every((d) => d.signer)).toBe(
      true,
    )
  })

  it('nobody writes agreements, signatures or PDFs through the API', async () => {
    const company = await find('company', w.projectA.id)
    for (const who of ['admin', 'companyA', 'alpha', 'none'] as const) {
      const create = await rest.post(
        'agreements',
        { reference: 'X', kind: 'company', title: 't', project: w.projectB.id, status: 'signed' },
        cookies[who],
      )
      expect(create.status).toBeGreaterThanOrEqual(400)
      const sig = await rest.post(
        'signatures',
        { agreement: company.id, party: 'company', typedName: 'x', ticked: true },
        cookies[who],
      )
      expect(sig.status).toBeGreaterThanOrEqual(400)
      const upload = await rest.upload(
        'agreement-pdfs',
        { data: Buffer.from('%PDF-1.4 x'), name: 'x.pdf', type: 'application/pdf' },
        { agreement: company.id, variant: 'signed', sha256: 'x' },
        cookies[who],
      )
      expect(upload.status).toBeGreaterThanOrEqual(400)
    }
    const count = await w.payload.count({ collection: 'agreements', overrideAccess: true })
    expect(count.totalDocs).toBe(3)
  })
})

describe('immutability once signed', () => {
  it('no role changes or deletes a signed agreement, a signature or a PDF', async () => {
    const company = await find('company', w.projectA.id)
    const sig = (
      await w.payload.find({
        collection: 'signatures',
        where: { agreement: { equals: company.id } },
        overrideAccess: true,
      })
    ).docs[0]!
    const pdf = await pdfOf(company.signedPdf as number)

    for (const who of ['admin', 'companyA', 'alpha'] as const) {
      expect(
        (await rest.patch(`agreements/${company.id}`, { status: 'void' }, cookies[who])).status,
      ).toBeGreaterThanOrEqual(400)
      expect(
        (await rest.patch(`agreements/${company.id}`, { title: 'changed' }, cookies[who])).status,
      ).toBeGreaterThanOrEqual(400)
      expect(
        (await rest.delete(`agreements/${company.id}`, cookies[who])).status,
      ).toBeGreaterThanOrEqual(400)
      expect(
        (await rest.patch(`signatures/${sig.id}`, { typedName: 'x' }, cookies[who])).status,
      ).toBeGreaterThanOrEqual(400)
      expect(
        (await rest.delete(`signatures/${sig.id}`, cookies[who])).status,
      ).toBeGreaterThanOrEqual(400)
      expect(
        (await rest.delete(`agreement-pdfs/${pdf.doc.id}`, cookies[who])).status,
      ).toBeGreaterThanOrEqual(400)
    }
    const gql = await graphql(
      `mutation { updateAgreement(id: ${company.id}, data: { status: void }) { id } }`,
      cookies.admin,
    )
    expect(gql.text).toMatch(/errors/)

    // Not even server code that skips access control, nor a direct SQL write.
    await expect(
      w.payload.update({
        collection: 'agreements',
        id: company.id,
        data: { signedSha256: 'f'.repeat(64) },
        overrideAccess: true,
        context: { ...agreementServerContext },
      }),
    ).rejects.toThrow()
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await db.connect()
    try {
      await expect(
        db.query(`UPDATE agreements SET signed_sha256 = 'x' WHERE id = $1`, [company.id]),
      ).rejects.toThrow(/cannot be changed/)
      await expect(db.query(`DELETE FROM agreements WHERE id = $1`, [company.id])).rejects.toThrow(
        /kept/,
      )
      await expect(
        db.query(`UPDATE signatures SET typed_name = 'x' WHERE id = $1`, [sig.id]),
      ).rejects.toThrow()
      await expect(db.query(`DELETE FROM signatures WHERE id = $1`, [sig.id])).rejects.toThrow()
      await expect(
        db.query(`UPDATE agreement_pdfs SET sha256 = 'x' WHERE id = $1`, [pdf.doc.id]),
      ).rejects.toThrow()
    } finally {
      await db.end()
    }

    // The stored fingerprints still match the stored files.
    const after = await find('company', w.projectA.id)
    expect(after.status).toBe('signed')
    const signedFile = await pdfOf(after.signedPdf as number)
    const unsignedFile = await pdfOf(after.unsignedPdf as number)
    expect(sha256(signedFile.data)).toBe(after.signedSha256)
    expect(signedFile.doc.sha256).toBe(after.signedSha256)
    expect(sha256(unsignedFile.data)).toBe(after.unsignedSha256)
    expect(sig.documentSha256).toBe(after.unsignedSha256)
  })

  it('the signed PDF is the signed pages plus one signing page', async () => {
    const company = await find('company', w.projectA.id)
    const unsigned = await PDFDocument.load((await pdfOf(company.unsignedPdf as number)).data)
    const signed = await PDFDocument.load((await pdfOf(company.signedPdf as number)).data)
    expect(signed.getPageCount()).toBe(unsigned.getPageCount() + 1)
  })
})

describe('signing', () => {
  it('only the expected signer, in order, ticked, named, with the right fingerprint', async () => {
    const project = await approvedProject()
    const a = await makeAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id })
    expect(a.status).toBe('awaiting_party')
    expect(a.unsignedSha256).toMatch(/^[0-9a-f]{64}$/)

    const sign = (user: User, extra: Partial<Parameters<typeof signAgreement>[2]> = {}) =>
      signAgreement(
        w.payload,
        user,
        {
          agreementId: a.id,
          typedName: 'Kari Nordmann',
          agree: true,
          authority: true,
          documentSha256: a.unsignedSha256!,
          ...extra,
        },
        'password',
      )

    // Strangers do not even see it.
    expect(await sign(w.companyB.user)).toEqual({ ok: false, error: 'not_found' })
    expect(await sign(w.alpha.user)).toEqual({ ok: false, error: 'not_found' })
    // Konnected signs last.
    expect(await sign(w.admin)).toEqual({ ok: false, error: 'not_your_turn' })
    // The checks on the form.
    expect(await sign(w.companyA.user, { agree: false })).toEqual({
      ok: false,
      error: 'not_ticked',
    })
    expect(await sign(w.companyA.user, { authority: false })).toEqual({
      ok: false,
      error: 'authority_not_ticked',
    })
    expect(await sign(w.companyA.user, { typedName: '   ' })).toEqual({
      ok: false,
      error: 'name_required',
    })
    expect(await sign(w.companyA.user, { documentSha256: 'a'.repeat(64) })).toEqual({
      ok: false,
      error: 'document_changed',
    })

    expect(await sign(w.companyA.user)).toEqual({ ok: true, status: 'awaiting_konnected' })
    expect(await sign(w.companyA.user)).toEqual({ ok: false, error: 'not_your_turn' })
    expect(await sign(w.admin)).toEqual({ ok: true, status: 'signed' })
    expect(await sign(w.admin)).toEqual({ ok: false, error: 'already_signed' })

    const sigs = await w.payload.find({
      collection: 'signatures',
      where: { agreement: { equals: a.id } },
      sort: 'signedAt',
      overrideAccess: true,
    })
    expect(sigs.docs.map((s) => [s.party, s.typedName, s.signInMethod])).toEqual([
      ['company', 'Kari Nordmann', 'password'],
      ['konnected', 'Kari Nordmann', 'password'],
    ])
  })

  it('refuses a signature when the stored PDF no longer matches its fingerprint', async () => {
    const project = await approvedProject()
    const a = await makeAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id })
    const { doc } = await pdfOf(a.unsignedPdf as number)
    await fs.appendFile(path.join(staticDirFor('agreement-pdfs'), doc.filename!), 'tampered')
    expect(await signAs(w.payload, w.companyA.user, a)).toEqual({
      ok: false,
      error: 'document_changed',
    })
  })

  it('two signatures at the same moment: exactly one counts', async () => {
    const project = await approvedProject()
    const a = await makeAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id })
    const results = await Promise.allSettled([
      signAs(w.payload, w.companyA.user, a, 'First'),
      signAs(w.payload, w.companyA.user, a, 'Second'),
      signAs(w.payload, w.companyA.user, a, 'Third'),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled' && r.value.ok)
    expect(ok).toHaveLength(1)
    const sigs = await w.payload.count({
      collection: 'signatures',
      where: { agreement: { equals: a.id } },
      overrideAccess: true,
    })
    expect(sigs.totalDocs).toBe(1)
    const after = await find('company', project.id)
    expect(after.status).toBe('awaiting_konnected')
  })

  it('two requests to make the same agreement at once: one agreement', async () => {
    const project = await approvedProject()
    const results = await Promise.all([
      requestAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id }),
      requestAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id }),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: 'already_exists' })
  })

  it('only admins make or withdraw agreements; a withdrawn one cannot be signed and can be replaced', async () => {
    const project = await approvedProject()
    for (const user of [w.companyA.user, w.alpha.user]) {
      expect(
        await requestAgreement(w.payload, user, { kind: 'company', projectId: project.id }),
      ).toEqual({
        ok: false,
        error: 'forbidden',
      })
    }
    const a = await makeAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id })
    expect((await voidAgreement(w.payload, w.companyA.user, a.id)).ok).toBe(false)
    const remade = await voidAgreement(w.payload, w.admin, a.id, { remake: true })
    expect(remade.ok).toBe(true)
    expect(await signAs(w.payload, w.companyA.user, a)).toEqual({
      ok: false,
      error: 'not_your_turn',
    })
    const old = await w.payload.findByID({
      collection: 'agreements',
      id: a.id,
      overrideAccess: true,
    })
    expect(old.status).toBe('void')
    if (remade.ok) {
      const fresh = await w.payload.findByID({
        collection: 'agreements',
        id: remade.id,
        depth: 0,
        overrideAccess: true,
      })
      expect(fresh.replaces).toBe(a.id)
    }
  })

  it('a missing value stops the agreement and says which field', async () => {
    const project = await approvedProject('No price', null)
    expect(
      await requestAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id }),
    ).toEqual({
      ok: false,
      error: 'missing_values',
      fields: ['price.exclVat', 'price.total', 'price.vat'],
    })
  })

  it('needs a published template, and the project at the right step', async () => {
    expect(
      await requestAgreement(w.payload, w.admin, { kind: 'company', projectId: w.projectB.id }),
    ).toEqual({ ok: false, error: 'wrong_status' })
    await w.payload.update({
      collection: 'agreement-templates',
      id: w.templates.company.id,
      data: { status: 'retired' },
      ...as(w.admin),
    })
    const project = await approvedProject()
    expect(
      await requestAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id }),
    ).toEqual({
      ok: false,
      error: 'no_template',
    })
  })
})

describe('making the PDF', () => {
  it('fills the template with the project values (company agreement: no student data)', async () => {
    const project = await approvedProject('Filled project', 6500)
    const a = await makeAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id })
    const text = gotenberg().lastText
    expect(text).toContain('Filled project')
    expect(text).toContain('Company A')
    expect(text).toContain(orgNumberFor('Company A'))
    expect(text).toContain(a.reference)
    // 6 500 + 25 % VAT, Norwegian format.
    expect(text.replace(/\s/g, ' ')).toMatch(/8 125,00 kr/)
    expect(a.templateVersion).toBe(1)
  })

  it('the student agreement carries the student name, and never the company price', async () => {
    const student = await find('student', w.projectA.id)
    expect(student.values).toMatchObject({ 'student.fullName': SENTINEL.alpha.name })
    expect(JSON.stringify(student.values)).not.toMatch(/kr/)
  })

  it('a converter that is down is retried, then the agreement is marked failed and can be made again', async () => {
    const project = await approvedProject()
    const req = await requestAgreement(w.payload, w.admin, {
      kind: 'company',
      projectId: project.id,
    })
    expect(req.ok).toBe(true)
    if (!req.ok) return
    gotenberg().down = true
    await expect(generateAgreementPdf(w.payload, req.id, { lastAttempt: false })).rejects.toThrow(
      /converter/,
    )
    expect(await generateAgreementPdf(w.payload, req.id, { lastAttempt: true })).toBe('failed')
    const failed = await w.payload.findByID({
      collection: 'agreements',
      id: req.id,
      overrideAccess: true,
    })
    expect(failed.status).toBe('failed')
    expect(failed.failure).toBe('converter')
    gotenberg().down = false
    const again = await requestAgreement(w.payload, w.admin, {
      kind: 'company',
      projectId: project.id,
    })
    expect(again.ok).toBe(true)
  })

  it('a newer template version never changes an agreement already made', async () => {
    const company = await find('company', w.projectA.id)
    expect(company.templateVersion).toBe(1)
    const v2 = await w.payload.create({
      collection: 'agreement-templates',
      data: { kind: 'company' } as never,
      file: fileOf(
        await fs.readFile(
          path.join(staticDirFor('agreement-templates'), w.templates.company.filename!),
        ),
        'v2.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
      ...as(w.admin),
    })
    await w.payload.update({
      collection: 'agreement-templates',
      id: v2.id,
      data: { status: 'published' },
      ...as(w.admin),
    })
    const after = await find('company', w.projectA.id)
    expect(after.templateVersion).toBe(1)
    expect(after.signedSha256).toBe(company.signedSha256)
  })
})

describe('the status gates', () => {
  const move = (id: number, status: Project['status'], cookie?: string) =>
    rest.patch(`projects/${id}`, { status }, cookie)

  it('a project is published only after the company AND Konnected signed (Local API, REST, GraphQL)', async () => {
    const project = await approvedProject()
    const publish = () =>
      w.payload.update({
        collection: 'projects',
        id: project.id,
        data: { status: 'published' },
        ...as(w.admin),
      })

    await expect(publish()).rejects.toThrow(/company agreement/)
    expect((await move(project.id, 'published', cookies.admin)).status).toBe(409)
    const gql = await graphql(
      `mutation { updateProject(id: ${project.id}, data: { status: published }) { id status } }`,
      cookies.admin,
    )
    expect(gql.text).toMatch(/company agreement/)

    const a = await makeAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id })
    expect((await signAs(w.payload, w.companyA.user, a)).ok).toBe(true)
    // Signed by the company only: still closed.
    await expect(publish()).rejects.toThrow(/company agreement/)
    // Not even server code that skips access control gets past the gate.
    await expect(
      w.payload.update({
        collection: 'projects',
        id: project.id,
        data: { status: 'published' },
        user: asUser(w.admin),
        overrideAccess: true,
      }),
    ).rejects.toThrow(/company agreement/)

    expect((await signAs(w.payload, w.admin, a)).ok).toBe(true)
    expect((await move(project.id, 'published', cookies.admin)).status).toBe(200)
  })

  it('a withdrawn or unfinished agreement does not open the gate', async () => {
    const project = await approvedProject()
    const a = await makeAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id })
    await voidAgreement(w.payload, w.admin, a.id)
    expect((await move(project.id, 'published', cookies.admin)).status).toBe(409)
  })

  it('the work starts only after the student AND Konnected signed the student agreement', async () => {
    const project = await approvedProject('Gate two')
    await signedAgreement(w.payload, w.admin, w.companyA.user, {
      kind: 'company',
      projectId: project.id,
    })
    await w.payload.update({
      collection: 'projects',
      id: project.id,
      data: { status: 'published' },
      ...as(w.admin),
    })
    // Konnected selects beta: the selection makes the match and moves the project to matched.
    const { match } = await selectStudent(w.payload, w.admin, w.beta, project.id)
    const start = () => move(project.id, 'in_progress', cookies.admin)
    expect((await start()).status).toBe(409)

    const a = await makeAgreement(w.payload, w.admin, { kind: 'student', matchId: match.id })
    // The company cannot sign the student agreement; the student can.
    expect(await signAs(w.payload, w.companyA.user, a)).toEqual({ ok: false, error: 'not_found' })
    expect((await signAs(w.payload, w.beta.user, a)).ok).toBe(true)
    expect((await start()).status).toBe(409)
    expect((await signAs(w.payload, w.admin, a)).ok).toBe(true)
    expect((await start()).status).toBe(200)
  })

  it('the signed company agreement opens the gate only for the price, terms and company signed', async () => {
    const project = await approvedProject('Signed terms', 2000)
    await signedAgreement(w.payload, w.admin, w.companyA.user, {
      kind: 'company',
      projectId: project.id,
    })
    const patch = (data: Record<string, unknown>) =>
      rest.patch(`projects/${project.id}`, data, cookies.admin)

    // A new price in the same request as publishing, or saved first.
    expect((await patch({ fee: 20000, status: 'published' })).status).toBe(409)
    expect((await patch({ title: 'Another scope' })).status).toBe(200)
    expect((await move(project.id, 'published', cookies.admin)).status).toBe(409)
    await expect(
      w.payload.update({
        collection: 'projects',
        id: project.id,
        data: { status: 'published' },
        user: asUser(w.admin),
        overrideAccess: true,
      }),
    ).rejects.toThrow(/no longer matches/)
    expect((await patch({ title: 'Signed terms' })).status).toBe(200)
    // Another company than the one that signed.
    expect((await patch({ company: w.companyB.company.id, status: 'published' })).status).toBe(409)

    // Back to what was signed: the gate opens.
    expect((await move(project.id, 'published', cookies.admin)).status).toBe(200)
    const after = await w.payload.findByID({
      collection: 'projects',
      id: project.id,
      overrideAccess: true,
    })
    expect(after).toMatchObject({ status: 'published', fee: 2000, title: 'Signed terms' })
  })

  it('the signed student agreement opens the start gate only for the student and terms signed', async () => {
    const project = await approvedProject('Gate two, signed terms')
    await signedAgreement(w.payload, w.admin, w.companyA.user, {
      kind: 'company',
      projectId: project.id,
    })
    await w.payload.update({
      collection: 'projects',
      id: project.id,
      data: { status: 'published' },
      ...as(w.admin),
    })
    // Konnected selects beta: the selection makes the match and moves the project to matched.
    const { match } = await selectStudent(w.payload, w.admin, w.beta, project.id)
    await signedAgreement(w.payload, w.admin, w.beta.user, { kind: 'student', matchId: match.id })
    const start = () => move(project.id, 'in_progress', cookies.admin)
    const setMatch = (data: Record<string, unknown>) =>
      w.payload.update({ collection: 'matches', id: match.id, data, ...as(w.admin) })

    // The team cannot swap in another student after beta signed (alpha never signed): a match
    // keeps its student.
    await expect(setMatch({ student: w.alpha.profile.id })).rejects.toThrow(/keeps its student/)

    // The project title the student signed for changed.
    await w.payload.update({
      collection: 'projects',
      id: project.id,
      data: { title: 'Something else' },
      ...as(w.admin),
    })
    expect((await start()).status).toBe(409)
    await w.payload.update({
      collection: 'projects',
      id: project.id,
      data: { title: 'Gate two, signed terms' },
      ...as(w.admin),
    })

    expect((await start()).status).toBe(200)
  })
})

describe('a withdrawal racing a signature or the PDF job', () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  /** Withdraw the agreement in an open transaction, as the team's request would, not committed. */
  const holdWithdrawal = async (agreementId: number) => {
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await db.connect()
    await db.query('BEGIN')
    await db.query(
      `UPDATE agreements SET status = 'void', active_key = NULL, voided_at = now() WHERE id = $1`,
      [agreementId],
    )
    return async () => {
      await db.query('COMMIT')
      await db.end()
    }
  }
  const statusOf = async (id: number) =>
    (await w.payload.findByID({ collection: 'agreements', id, depth: 0, overrideAccess: true }))
      .status
  const signatures = async (id: number) =>
    (
      await w.payload.count({
        collection: 'signatures',
        where: { agreement: { equals: id } },
        overrideAccess: true,
      })
    ).totalDocs

  it('the party signs while the team withdraws: it stays withdrawn, no signature', async () => {
    const project = await approvedProject()
    const a = await makeAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id })
    const commit = await holdWithdrawal(a.id)
    const signing = signAs(w.payload, w.companyA.user, a)
    await pause(300)
    await commit()
    expect(await signing).toEqual({ ok: false, error: 'not_your_turn' })
    expect(await statusOf(a.id)).toBe('void')
    expect(await signatures(a.id)).toBe(0)
  })

  it('Konnected signs last while the team withdraws: never signed, the gate stays closed', async () => {
    const project = await approvedProject()
    const a = await makeAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id })
    expect((await signAs(w.payload, w.companyA.user, a)).ok).toBe(true)
    const commit = await holdWithdrawal(a.id)
    const signing = signAs(w.payload, w.admin, a)
    await pause(300)
    await commit()
    expect(await signing).toEqual({ ok: false, error: 'not_your_turn' })
    expect(await statusOf(a.id)).toBe('void')
    expect(await signatures(a.id)).toBe(1)
    expect(
      (await rest.patch(`projects/${project.id}`, { status: 'published' }, cookies.admin)).status,
    ).toBe(409)
  })

  it('the PDF is finished while the team withdraws: it stays withdrawn', async () => {
    const project = await approvedProject()
    const made = await requestAgreement(w.payload, w.admin, {
      kind: 'company',
      projectId: project.id,
    })
    if (!made.ok) throw new Error(made.error)
    let commit: (() => Promise<void>) | undefined
    const job = generateAgreementPdf(w.payload, made.id, {
      convert: async (docx, name) => {
        const pdf = await convertDocxToPdf(docx, name)
        commit = await holdWithdrawal(made.id)
        return pdf
      },
    })
    await vi.waitFor(() => expect(commit).toBeDefined())
    await pause(300)
    await commit!()
    expect(await job).toBe('skipped')
    const after = await w.payload.findByID({
      collection: 'agreements',
      id: made.id,
      depth: 0,
      overrideAccess: true,
    })
    expect(after).toMatchObject({ status: 'void', unsignedPdf: null, unsignedSha256: null })
  })

  it('withdrawn is final and no step is skipped: not the server, not a direct SQL write', async () => {
    const project = await approvedProject()
    const a = await makeAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id })
    expect((await voidAgreement(w.payload, w.admin, a.id)).ok).toBe(true)
    await expect(
      w.payload.update({
        collection: 'agreements',
        id: a.id,
        data: { status: 'awaiting_konnected' },
        overrideAccess: true,
        context: { ...agreementServerContext },
      }),
    ).rejects.toThrow()

    const fresh = await requestAgreement(w.payload, w.admin, {
      kind: 'company',
      projectId: project.id,
    })
    if (!fresh.ok) throw new Error(fresh.error)
    await expect(
      w.payload.update({
        collection: 'agreements',
        id: fresh.id,
        data: { status: 'signed' },
        overrideAccess: true,
        context: { ...agreementServerContext },
      }),
    ).rejects.toThrow()

    const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await db.connect()
    try {
      for (const status of ['awaiting_party', 'awaiting_konnected', 'signed']) {
        await expect(
          db.query(`UPDATE agreements SET status = $2 WHERE id = $1`, [a.id, status]),
        ).rejects.toThrow(/withdrawn/)
      }
      await expect(
        db.query(`UPDATE agreements SET title = 'x' WHERE id = $1`, [a.id]),
      ).rejects.toThrow(/withdrawn/)
      for (const status of ['awaiting_konnected', 'signed']) {
        await expect(
          db.query(`UPDATE agreements SET status = $2 WHERE id = $1`, [fresh.id, status]),
        ).rejects.toThrow(/cannot move/)
      }
    } finally {
      await db.end()
    }
    expect(await statusOf(a.id)).toBe('void')
    expect(await statusOf(fresh.id)).toBe('generating')
  })
})

describe('emails', () => {
  it('when Konnected signs last, both parties get the signed PDF with its fingerprint', async () => {
    const project = await approvedProject('Emailed project')
    const a = await makeAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id })
    // The company reads Norwegian.
    await w.payload.update({
      collection: 'users',
      id: w.companyA.user.id,
      data: { language: 'no' },
      overrideAccess: true,
    })
    expect((await signAs(w.payload, w.companyA.user, a)).ok).toBe(true)

    // Record each message as it is handed to the mail adapter (the transport may rewrite it).
    type Mail = {
      to: string
      subject: string
      text: string
      attachments?: { content: Buffer; contentType: string }[]
    }
    const sent: (Mail & { attachmentSha?: string[] })[] = []
    const original = w.payload.email.sendEmail.bind(w.payload.email)
    const send = vi.spyOn(w.payload.email, 'sendEmail').mockImplementation(async (message) => {
      const m = message as Mail
      sent.push({ ...m, attachmentSha: m.attachments?.map((x) => sha256(x.content)) })
      return original(message)
    })
    expect((await signAs(w.payload, w.admin, a)).ok).toBe(true)
    await runAgreementJobs(w.payload)

    const done = await find('company', project.id)
    expect(done.emailedAt).toBeTruthy()
    expect(sent.map((m) => m.to).sort()).toEqual([w.admin.email, w.companyA.user.email].sort())
    const grouped = done.signedSha256!.match(/.{4}/g)!.join(' ')
    for (const mail of sent) {
      expect(mail.attachments).toHaveLength(1)
      expect(mail.attachments![0]!.contentType).toBe('application/pdf')
      expect(mail.attachmentSha).toEqual([done.signedSha256])
      expect(mail.text).toContain(grouped)
      expect(mail.text).toContain(done.reference)
    }
    const toCompany = sent.find((m) => m.to === w.companyA.user.email)!
    expect(toCompany.subject).toContain('Signert avtale')
    const toAdmin = sent.find((m) => m.to === w.admin.email)!
    expect(toAdmin.subject).toContain('Signed agreement')
    // A company email never carries student data.
    for (const value of Object.values(SENTINEL.alpha)) expect(toCompany.text).not.toContain(value)

    // Sent once: running the jobs again sends nothing more.
    send.mockClear()
    await runAgreementJobs(w.payload)
    expect(send).not.toHaveBeenCalled()
  })

  it('the party is told when an agreement waits for them', async () => {
    const project = await approvedProject('To sign project')
    const send = vi.spyOn(w.payload.email, 'sendEmail')
    await makeAgreement(w.payload, w.admin, { kind: 'company', projectId: project.id })
    const mails = send.mock.calls.map(([m]) => m as { to: string; text: string })
    expect(mails.map((m) => m.to)).toEqual([w.companyA.user.email])
    expect(mails[0]!.text).toContain('To sign project')
    expect(mails[0]!.text).toMatch(/\/en\/company\/agreements\/\d+/)
  })
})
