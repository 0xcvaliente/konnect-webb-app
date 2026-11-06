import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { MB } from '@/lib/uploads/fileRules'
import type { User } from '@/payload-types'

import { fileOf, makeDocx, makePdf, makePng, makeZip } from '../helpers/files'
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
 * Private files: CVs, deliverable files and brief attachments. Every read rule is checked as each
 * role through all four ways in: the Local API with access control on, REST by id, GraphQL by id,
 * and the file URL itself (`/api/<collection>/file/<name>`).
 */

type Who = 'admin' | 'alpha' | 'beta' | 'companyA' | 'companyB' | 'anonymous'
const ROLES: Who[] = ['admin', 'alpha', 'beta', 'companyA', 'companyB', 'anonymous']

type FileSlug = 'cvs' | 'deliverable-files' | 'brief-files'
const SINGULAR: Record<FileSlug, string> = {
  cvs: 'Cv',
  'deliverable-files': 'DeliverableFile',
  'brief-files': 'BriefFile',
}

type FileDoc = { id: number; filename?: string | null }

let w: World
let cookies: Record<Who, string | undefined>

const userOf = (who: Who): User | undefined =>
  ({
    admin: w.admin,
    alpha: w.alpha.user,
    beta: w.beta.user,
    companyA: w.companyA.user,
    companyB: w.companyB.user,
    anonymous: undefined,
  })[who]

/** Local API options that act as `who` with access control on. */
const as = (who: Who) => {
  const user = userOf(who)
  return { user: user ? asUser(user) : undefined, overrideAccess: false as const }
}

async function setup() {
  await resetDatabase()
  w = await createWorld()
  cookies = {
    admin: await sessionFor(w.admin.id),
    alpha: await login(w.alpha.user.email),
    beta: await login(w.beta.user.email),
    companyA: await login(w.companyA.user.email),
    companyB: await login(w.companyB.user.email),
    anonymous: undefined,
  }
}

/** Can `who` read this file document and download the file, through each way in? */
async function reads(slug: FileSlug, doc: FileDoc, who: Who) {
  const local = await w.payload
    .findByID({ collection: slug, id: doc.id, depth: 0, ...as(who) })
    .then((d) => d?.id === doc.id)
    .catch(() => false)
  const byId = await rest.get(`${slug}/${doc.id}?depth=0`, cookies[who])
  const name = SINGULAR[slug]
  const gql = await graphql(`{ ${name}(id: ${doc.id}) { id } }`, cookies[who])
  const gqlDoc = (gql.json.data as Record<string, { id: number } | null> | undefined)?.[name]
  const file = await rest.get(`${slug}/file/${doc.filename}`, cookies[who])
  return {
    local,
    rest: byId.status === 200 && byId.json.id === doc.id,
    graphql: gqlDoc?.id === doc.id,
    file: file.status === 200,
  }
}

async function expectReads(slug: FileSlug, doc: FileDoc, allowed: Partial<Record<Who, boolean>>) {
  for (const who of ROLES) {
    const can = allowed[who] ?? false
    expect(await reads(slug, doc, who), `${slug} ${doc.id} as ${who}`).toEqual({
      local: can,
      rest: can,
      graphql: can,
      file: can,
    })
  }
}

const shareCv = (who: 'alpha' | 'beta', value: boolean) =>
  w.payload.update({
    collection: 'student-profiles',
    id: w[who].profile.id,
    data: { privacy: { shareCv: value } },
    ...as(who),
  })

const pdf = (name: string) => fileOf(makePdf(name), name, 'application/pdf')

/** A file of `size` bytes that starts like a real PDF. */
const bigPdf = (size: number) =>
  Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(size - 9, 0x20)])

describe('CVs: read as each role', () => {
  beforeAll(setup)

  it('a CV nobody shared: only its student and admins', async () => {
    await expectReads('cvs', w.alphaCv, { admin: true, alpha: true })
    await expectReads('cvs', w.betaCv, { admin: true, beta: true })
  })

  it('a selected student who ticks "share my CV": the company of that project only', async () => {
    await shareCv('alpha', true)
    await expectReads('cvs', w.alphaCv, { admin: true, alpha: true, companyA: true })

    // The company finds it through the match, and nothing else in the list.
    const match = await rest.get(`matches/${w.match.id}?depth=0`, cookies.companyA)
    expect((match.json.sharedInfo as { cv: number }).cv).toBe(w.alphaCv.id)
    const list = await rest.get('cvs?depth=0', cookies.companyA)
    expect((list.json.docs as { id: number }[]).map((d) => d.id)).toEqual([w.alphaCv.id])
    // The owner (a student user id) is not part of what the company gets.
    expect(list.json.docs).not.toContainEqual(expect.objectContaining({ owner: expect.anything() }))
  })

  it('a student who shares but was not selected: no company can read the CV', async () => {
    await shareCv('beta', true)
    await expectReads('cvs', w.betaCv, { admin: true, beta: true })
  })

  it('only the CV on the profile is shared, not an older upload', async () => {
    const older = await w.payload.create({
      collection: 'cvs',
      data: {} as never,
      file: pdf('older-cv.pdf'),
      ...as('alpha'),
    })
    await expectReads('cvs', older, { admin: true, alpha: true })
  })

  it('unticking stops the sharing at once, also for the match copy', async () => {
    await shareCv('alpha', false)
    await expectReads('cvs', w.alphaCv, { admin: true, alpha: true })
    const match = await rest.get(`matches/${w.match.id}?depth=0`, cookies.companyA)
    expect((match.json.sharedInfo as { cv: number | null }).cv).toBeNull()
  })

  it('a company probing by id, by file URL or with a where filter finds nothing', async () => {
    for (const doc of [w.alphaCv, w.betaCv]) {
      expect((await rest.get(`cvs/${doc.id}`, cookies.companyA)).status).toBe(403)
      expect((await rest.get(`cvs/file/${doc.filename}`, cookies.companyA)).status).toBe(403)
    }
    const probe = await rest.get(
      `cvs?where[filename][equals]=${w.betaCv.filename}`,
      cookies.companyA,
    )
    expect(probe.json.docs ?? []).toHaveLength(0)
  })
})

describe('CVs: write as each role', () => {
  beforeAll(setup)

  it('a student uploads a CV for themselves only, whatever the request says', async () => {
    const res = await rest.upload(
      'cvs?depth=0',
      { data: makePdf(), name: 'My CV.pdf', type: 'application/pdf' },
      { owner: w.beta.user.id },
      cookies.alpha,
    )
    expect(res.status).toBe(201)
    const doc = res.json.doc as {
      id: number
      owner: number
      filename: string
      originalName: string
    }
    expect(doc.owner).toBe(w.alpha.user.id)
    // Stored under a random name; the uploaded name is kept for display only.
    expect(doc.filename).toMatch(/^[0-9a-f-]{36}\.pdf$/)
    expect(doc.originalName).toBe('My CV.pdf')
  })

  it('companies and anonymous visitors cannot upload a CV', async () => {
    const file = { data: makePdf(), name: 'cv.pdf', type: 'application/pdf' }
    expect((await rest.upload('cvs', file, {}, cookies.companyA)).status).toBe(403)
    expect((await rest.upload('cvs', file, {}, undefined)).status).toBe(403)
  })

  it('an admin uploads a CV for a named student, and must name one', async () => {
    const made = await w.payload.create({
      collection: 'cvs',
      data: { owner: w.beta.user.id },
      file: pdf('from-admin.pdf'),
      depth: 0,
      ...as('admin'),
    })
    expect(made.owner).toBe(w.beta.user.id)
    await expect(
      w.payload.create({
        collection: 'cvs',
        data: {} as never,
        file: pdf('x.pdf'),
        ...as('admin'),
      }),
    ).rejects.toThrow()
  })

  it('a student cannot put another student’s CV on their profile', async () => {
    await expect(
      w.payload.update({
        collection: 'student-profiles',
        id: w.alpha.profile.id,
        data: { cv: w.betaCv.id },
        ...as('alpha'),
      }),
    ).rejects.toThrow(/does not belong/)
  })

  it('only the owner and admins can change or delete a CV', async () => {
    for (const who of ['beta', 'companyA', 'companyB'] as const) {
      expect((await rest.patch(`cvs/${w.alphaCv.id}`, { owner: 1 }, cookies[who])).status).toBe(403)
      expect((await rest.delete(`cvs/${w.alphaCv.id}`, cookies[who])).status).toBe(403)
    }
    expect((await rest.delete(`cvs/${w.alphaCv.id}`, undefined)).status).toBe(403)

    // The owner cannot hand the CV to someone else.
    await rest.patch(`cvs/${w.alphaCv.id}`, { owner: w.beta.user.id }, cookies.alpha)
    const after = await w.payload.findByID({ collection: 'cvs', id: w.alphaCv.id, depth: 0 })
    expect(after.owner).toBe(w.alpha.user.id)

    const spare = await w.payload.create({
      collection: 'cvs',
      data: {} as never,
      file: pdf('spare.pdf'),
      ...as('alpha'),
    })
    expect((await rest.delete(`cvs/${spare.id}`, cookies.alpha)).status).toBe(200)
    // Deleting the document removes the file from the disk too.
    const dir = path.join(process.env.MEDIA_DIR!, 'cvs')
    expect(await readdir(dir)).not.toContain(spare.filename)
  })

  it('every upload and delete writes an activity log row', async () => {
    const made = await w.payload.create({
      collection: 'cvs',
      data: {} as never,
      file: pdf('logged.pdf'),
      ...as('alpha'),
    })
    await w.payload.delete({ collection: 'cvs', id: made.id, ...as('alpha') })
    const rows = await w.payload.find({
      collection: 'activity-logs',
      where: {
        and: [{ targetCollection: { equals: 'cvs' } }, { targetId: { equals: String(made.id) } }],
      },
      overrideAccess: true,
    })
    expect(rows.docs.map((r) => r.action).sort()).toEqual(['create', 'delete'])
  })
})

describe('upload checks: real type, matching name, size', () => {
  beforeAll(setup)

  const upload = (slug: FileSlug, file: ReturnType<typeof fileOf>, data: object = {}) =>
    w.payload.create({ collection: slug, data: data as never, file, ...as('admin') })

  it('a CV must really be a PDF: a fake extension is refused', async () => {
    const png = await makePng()
    // A PNG renamed to .pdf, and given a PDF MIME type by the "browser".
    const res = await rest.upload(
      'cvs',
      { data: png, name: 'cv.pdf', type: 'application/pdf' },
      {},
      cookies.alpha,
    )
    expect(res.status).toBe(400)
    expect(res.text).toMatch(/not allowed/)
    // Plain text called .pdf, a Word file called .pdf, a real PDF called .docx.
    const owner = { owner: w.alpha.user.id }
    await expect(
      upload('cvs', fileOf(Buffer.from('hello'), 'cv.pdf', 'application/pdf'), owner),
    ).rejects.toThrow(/not allowed/)
    await expect(
      upload('cvs', fileOf(makeDocx(), 'cv.pdf', 'application/pdf'), owner),
    ).rejects.toThrow(/not allowed/)
    await expect(
      upload('cvs', fileOf(makePdf(), 'cv.docx', 'application/pdf'), owner),
    ).rejects.toThrow(/does not match/)
  })

  it('a CV above 10 MB is refused', async () => {
    const res = await rest.upload(
      'cvs',
      { data: bigPdf(10 * MB + 1), name: 'big.pdf', type: 'application/pdf' },
      {},
      cookies.alpha,
    )
    expect(res.status).toBe(413)
  })

  it('deliverable files: the listed types pass, a disguised file does not', async () => {
    const data = { match: w.match.id }
    const ok = [
      fileOf(makePdf(), 'report.pdf', 'application/pdf'),
      fileOf(makeDocx(), 'report.docx', 'application/octet-stream'),
      fileOf(await makePng(), 'screen.png', 'image/png'),
      fileOf(makeZip({ 'code/main.ts': 'export {}' }), 'code.zip', 'application/zip'),
    ]
    for (const file of ok) {
      const made = await upload('deliverable-files', file, data)
      expect(made.filename).toMatch(new RegExp(`\\.${file.name.split('.').pop()}$`))
    }
    // A zip called .docx, text called .docx, a PNG called .jpg.
    await expect(
      upload(
        'deliverable-files',
        fileOf(makeZip({ a: 'b' }), 'report.docx', 'application/zip'),
        data,
      ),
    ).rejects.toThrow(/does not match/)
    await expect(
      upload('deliverable-files', fileOf(Buffer.from('<html>'), 'report.docx', 'text/html'), data),
    ).rejects.toThrow(/not allowed/)
    await expect(
      upload('deliverable-files', fileOf(await makePng(), 'photo.jpg', 'image/jpeg'), data),
    ).rejects.toThrow(/does not match/)
  })

  it('deliverable files above 50 MB are stopped by the server', async () => {
    await expect(
      upload('deliverable-files', fileOf(bigPdf(50 * MB + 1), 'huge.pdf', 'application/pdf'), {
        match: w.match.id,
      }),
    ).rejects.toThrow(/too large/)
    // Over HTTP the multipart parser itself stops it.
    const res = await rest.upload(
      'deliverable-files',
      { data: bigPdf(50 * MB + 1), name: 'huge.pdf', type: 'application/pdf' },
      { match: w.match.id },
      cookies.alpha,
    )
    expect(res.status).toBe(413)
  })

  it('brief files: no zip, and nothing above 20 MB', async () => {
    const data = { company: w.companyA.company.id }
    await expect(
      upload('brief-files', fileOf(makeZip({ a: 'b' }), 'brief.zip', 'application/zip'), data),
    ).rejects.toThrow(/not allowed/)
    await expect(
      upload('brief-files', fileOf(bigPdf(20 * MB + 1), 'brief.pdf', 'application/pdf'), data),
    ).rejects.toThrow(/too large/)
    const ok = await upload('brief-files', fileOf(makePdf(), 'brief.pdf', 'application/pdf'), data)
    expect(ok.mimeType).toBe('application/pdf')
  })

  it('every file is sent as a download the browser must not sniff or cache', async () => {
    const res = await rest.get(`cvs/file/${w.alphaCv.filename}`, cookies.alpha)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.text.startsWith('%PDF-')).toBe(true)

    const brief = await rest.get(`brief-files/file/${w.briefA.filename}`, cookies.companyA)
    expect(brief.headers.get('content-disposition')).toBe('attachment')
    expect(brief.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('files are stored under MEDIA_DIR, one directory per collection', async () => {
    const dir = path.join(process.env.MEDIA_DIR!, 'cvs')
    expect(await readdir(dir)).toContain(w.alphaCv.filename)
  })
})

describe('deliverable files as each role', () => {
  beforeAll(setup)

  it('released: the matched student, admins and the project’s company', async () => {
    await expectReads('deliverable-files', w.fileReleased, {
      admin: true,
      alpha: true,
      companyA: true,
    })
  })

  it('not released yet: the company cannot read it, by id or by URL', async () => {
    await expectReads('deliverable-files', w.fileHidden, { admin: true, alpha: true })
  })

  it('once Konnected releases the deliverable, the company can read the file', async () => {
    await w.payload.update({
      collection: 'deliverables',
      id: w.deliverableHidden.id,
      data: { status: 'released' },
      ...as('admin'),
    })
    await expectReads('deliverable-files', w.fileHidden, {
      admin: true,
      alpha: true,
      companyA: true,
    })
  })

  it('only the matched student (and admins) can upload for a match', async () => {
    const file = { data: makePdf(), name: 'work.pdf', type: 'application/pdf' }
    const data = { match: w.match.id }
    expect((await rest.upload('deliverable-files', file, data, cookies.beta)).status).toBe(403)
    expect((await rest.upload('deliverable-files', file, data, cookies.companyA)).status).toBe(403)
    expect((await rest.upload('deliverable-files', file, data, undefined)).status).toBe(403)
    expect((await rest.upload('deliverable-files', file, data, cookies.alpha)).status).toBe(201)
  })

  it('a deliverable lists only files of its own match, at most 10', async () => {
    // beta gets a match on another project and uploads a file for it.
    const betaMatch = await w.payload.create({
      collection: 'matches',
      data: { project: w.projectOpen.id, student: w.beta.profile.id },
      ...as('admin'),
    })
    const betaFile = await w.payload.create({
      collection: 'deliverable-files',
      data: { match: betaMatch.id },
      file: pdf('beta.pdf'),
      ...as('beta'),
    })
    await expect(
      w.payload.create({
        collection: 'deliverables',
        data: { match: w.match.id, files: [betaFile.id], status: 'submitted' },
        ...as('alpha'),
      }),
    ).rejects.toThrow(/does not belong/)

    const eleven = []
    for (let i = 0; i < 11; i++) {
      eleven.push(
        (
          await w.payload.create({
            collection: 'deliverable-files',
            data: { match: w.match.id },
            file: pdf(`part-${i}.pdf`),
            ...as('alpha'),
          })
        ).id,
      )
    }
    await expect(
      w.payload.create({
        collection: 'deliverables',
        data: { match: w.match.id, files: eleven, status: 'submitted' },
        ...as('alpha'),
      }),
    ).rejects.toThrow()
    const ten = await w.payload.create({
      collection: 'deliverables',
      data: { match: w.match.id, files: eleven.slice(0, 10), status: 'submitted' },
      ...as('alpha'),
    })
    expect(ten.files).toHaveLength(10)
  })

  it('nobody but admins changes a file; the student deletes only unreleased ones', async () => {
    const spare = await w.payload.create({
      collection: 'deliverable-files',
      data: { match: w.match.id },
      file: pdf('spare.pdf'),
      ...as('alpha'),
    })
    for (const who of ['alpha', 'beta', 'companyA'] as const) {
      expect(
        (await rest.patch(`deliverable-files/${spare.id}`, { match: 1 }, cookies[who])).status,
      ).toBe(403)
    }
    for (const who of ['beta', 'companyA', 'anonymous'] as const) {
      expect((await rest.delete(`deliverable-files/${spare.id}`, cookies[who])).status).toBe(403)
    }
    // Released files stay as the company received them.
    expect(
      (await rest.delete(`deliverable-files/${w.fileReleased.id}`, cookies.alpha)).status,
    ).toBe(403)
    expect((await rest.delete(`deliverable-files/${spare.id}`, cookies.alpha)).status).toBe(200)
  })
})

describe('brief files as each role', () => {
  beforeAll(setup)

  it('a matched project: the company, admins and only the selected student', async () => {
    await expectReads('brief-files', w.briefA, { admin: true, companyA: true, alpha: true })
  })

  it('a published project nobody is selected for: no student, even if they can see the project', async () => {
    await expectReads('brief-files', w.briefOpen, { admin: true, companyA: true })
    const project = await rest.get(`projects/${w.projectOpen.id}?depth=1`, cookies.beta)
    expect(project.status).toBe(200)
    // At most the id: the file document itself is not readable.
    expect(JSON.stringify(project.json.attachments)).not.toContain('brief-open.png')
  })

  it('a company uploads for its own company only; students and anonymous cannot', async () => {
    const file = { data: makePdf(), name: 'brief.pdf', type: 'application/pdf' }
    const res = await rest.upload(
      'brief-files?depth=0',
      file,
      { company: w.companyA.company.id },
      cookies.companyB,
    )
    expect(res.status).toBe(201)
    expect((res.json.doc as { company: number }).company).toBe(w.companyB.company.id)
    expect((await rest.upload('brief-files', file, {}, cookies.alpha)).status).toBe(403)
    expect((await rest.upload('brief-files', file, {}, undefined)).status).toBe(403)
  })

  it('a company attaches only its own files, while it can still edit the project', async () => {
    await expect(
      w.payload.update({
        collection: 'projects',
        id: w.projectB.id,
        data: { attachments: [w.briefA.id] },
        ...as('companyB'),
      }),
    ).rejects.toThrow(/does not belong/)

    const own = await w.payload.create({
      collection: 'brief-files',
      data: {} as never,
      file: pdf('own.pdf'),
      ...as('companyB'),
    })
    const updated = await w.payload.update({
      collection: 'projects',
      id: w.projectB.id,
      data: { attachments: [own.id] },
      depth: 0,
      ...as('companyB'),
    })
    expect(updated.attachments).toEqual([own.id])
  })

  it('delete: not once Konnected has the project, not by others', async () => {
    // Project A is in progress: its brief stays.
    expect((await rest.delete(`brief-files/${w.briefA.id}`, cookies.companyA)).status).toBe(403)
    for (const who of ['alpha', 'companyB', 'anonymous'] as const) {
      expect((await rest.delete(`brief-files/${w.briefA.id}`, cookies[who])).status).toBe(403)
    }
    const loose = await w.payload.create({
      collection: 'brief-files',
      data: {} as never,
      file: pdf('loose.pdf'),
      ...as('companyA'),
    })
    expect((await rest.delete(`brief-files/${loose.id}`, cookies.companyA)).status).toBe(200)
    expect((await rest.delete(`brief-files/${w.briefOpen.id}`, cookies.admin)).status).toBe(200)
  })

  it('nobody but admins changes a brief file', async () => {
    for (const who of ['companyA', 'alpha'] as const) {
      expect(
        (await rest.patch(`brief-files/${w.briefA.id}`, { company: 1 }, cookies[who])).status,
      ).toBe(403)
    }
  })
})
