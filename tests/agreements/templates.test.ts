import { deflateRawSync } from 'node:zlib'

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { checkTemplate } from '@/lib/agreements/docx'
import type { TemplateProblem } from '@/lib/agreements/fields'
import { checkZip } from '@/lib/agreements/zip'
import type { User } from '@/payload-types'

import { uploadTemplate } from '../helpers/agreements'
import { buildDocx, companyTemplateDocx, studentTemplateDocx } from '../helpers/docx'
import { fileOf, makePdf } from '../helpers/files'
import {
  asUser,
  createWorld,
  getTestPayload,
  graphql,
  login,
  resetDatabase,
  rest,
  sessionFor,
  type World,
} from '../helpers/world'

/**
 * Agreement templates: admin only, .docx only, within the size limits, and only fields from the
 * allowed list for the kind. Versions, publish and retire.
 */

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** A zip with one entry, deflated, that unzips to `size` bytes of zeros. */
function zipBomb(size: number): Buffer {
  const data = deflateRawSync(Buffer.alloc(size))
  const name = Buffer.from('word/document.xml')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(size, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(size, 24)
  central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(46 + name.length, 12)
  end.writeUInt32LE(30 + name.length + data.length, 16)
  return Buffer.concat([local, name, data, central, name, end])
}

const problemOf = async (buffer: Buffer, kind: 'company' | 'student' = 'company') => {
  const result = await checkTemplate(buffer, kind)
  return result.ok ? null : result.problem
}

describe('template checks (no database)', () => {
  it('accepts a template with known fields, also when Word split a field across runs', async () => {
    for (const split of [false, true]) {
      const result = await checkTemplate(companyTemplateDocx({ split }), 'company')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.fields).toEqual(
          expect.arrayContaining(['company.name', 'project.title', 'price.total']),
        )
      }
    }
  })

  it('refuses fields that are not on the list, and says which', async () => {
    const docx = buildDocx(['Title', 'Hello {{student.phone}} and {{project.title}}'])
    expect(await problemOf(docx)).toEqual<TemplateProblem>({
      code: 'unknown_fields',
      tags: ['student.phone'],
    })
  })

  it('keeps student data out of the company agreement and the price out of the student one', async () => {
    expect(await problemOf(buildDocx(['T', '{{student.fullName}}']), 'company')).toEqual({
      code: 'not_allowed_here',
      tags: ['student.fullName'],
    })
    expect(await problemOf(buildDocx(['T', '{{price.total}}']), 'student')).toEqual({
      code: 'not_allowed_here',
      tags: ['price.total'],
    })
  })

  it('refuses loops, conditions and raw XML', async () => {
    expect((await problemOf(buildDocx(['T', '{{#items}}x{{/items}}'])))?.code).toBe('logic_tags')
    expect((await problemOf(buildDocx(['T', '{{@raw}}'])))?.code).toBe('logic_tags')
  })

  it('refuses a field that is not closed', async () => {
    expect((await problemOf(buildDocx(['T', 'Hello {{project.title'])))?.code).toBe('malformed')
  })

  it('refuses a template without fields', async () => {
    expect((await problemOf(buildDocx(['Only text'])))?.code).toBe('no_fields')
  })

  it('refuses macro files (.docm) and macro parts, by content', async () => {
    expect((await problemOf(buildDocx(['T', '{{project.title}}'], { macro: true })))?.code).toBe(
      'macros',
    )
  })

  it('refuses anything that is not a .docx, whatever its name', async () => {
    expect((await problemOf(makePdf('not word')))?.code).toBe('not_docx')
    expect((await problemOf(Buffer.from('plain text')))?.code).toBe('not_docx')
  })

  it('refuses files that are too large, packed or unpacked', async () => {
    const big = Buffer.concat([companyTemplateDocx(), Buffer.alloc(5 * 1024 * 1024)])
    expect((await problemOf(big))?.code).toBe('too_large')
    // 40 MB of zeros packs into a few KB; it must not be unpacked whole.
    const bomb = zipBomb(40 * 1024 * 1024)
    expect(bomb.length).toBeLessThan(200_000)
    expect(checkZip(bomb, { maxEntries: 10, maxUnzippedBytes: 25 * 1024 * 1024 })).toEqual({
      ok: false,
      problem: 'unzipped_too_large',
    })
    expect(
      checkZip(Buffer.from('not a zip at all, just text'), {
        maxEntries: 10,
        maxUnzippedBytes: 1000,
      }),
    ).toEqual({ ok: false, problem: 'broken_file' })
  })
})

describe('agreement templates collection', () => {
  let w: World
  let cookies: Record<'admin' | 'company' | 'student' | 'none', string | undefined>
  const as = (user: User) => ({ user: asUser(user), overrideAccess: false as const })

  beforeAll(async () => {
    await getTestPayload()
  })

  beforeEach(async () => {
    await resetDatabase()
    w = await createWorld()
    cookies = {
      admin: await sessionFor(w.admin.id),
      company: await login(w.companyA.user.email),
      student: await login(w.alpha.user.email),
      none: undefined,
    }
  })

  it('only admin can upload a template, through every API', async () => {
    const file = { data: companyTemplateDocx(), name: 'c.docx', type: DOCX }
    for (const who of ['company', 'student', 'none'] as const) {
      const res = await rest.upload('agreement-templates', file, { kind: 'company' }, cookies[who])
      expect(res.status).toBe(403)
    }
    for (const user of [w.companyA.user, w.alpha.user]) {
      await expect(
        uploadTemplate(w.payload, user, 'company', companyTemplateDocx()),
      ).rejects.toThrow()
    }
    const ok = await rest.upload('agreement-templates', file, { kind: 'company' }, cookies.admin)
    expect(ok.status).toBe(201)
    const doc = (ok.json as { doc: { version: number; status: string; fields: string[] } }).doc
    // The world already published version 1 of each kind.
    expect(doc.version).toBe(2)
    expect(doc.status).toBe('draft')
    expect(doc.fields).toContain('company.name')
  })

  it('only admin reads templates (REST, GraphQL, Local API)', async () => {
    for (const who of ['company', 'student', 'none'] as const) {
      const list = await rest.get('agreement-templates', cookies[who])
      expect([403, 200]).toContain(list.status)
      expect((list.json as { docs?: unknown[] }).docs ?? []).toHaveLength(0)
      const file = await rest.get(
        `agreement-templates/file/${w.templates.company.filename}`,
        cookies[who],
      )
      expect(file.status).toBe(403)
      const gql = await graphql('{ AgreementTemplates { docs { id fields } } }', cookies[who])
      expect(gql.text).not.toContain('company.name')
    }
    await expect(
      w.payload.find({ collection: 'agreement-templates', ...as(w.companyA.user) }),
    ).rejects.toThrow()
    const admin = await rest.get('agreement-templates', cookies.admin)
    expect((admin.json as { docs: unknown[] }).docs.length).toBe(2)
  })

  it('a refused upload says why, so the team screen can show it', async () => {
    const bad = {
      data: buildDocx(['T', '{{student.phone}}']),
      name: 'bad.docx',
      type: DOCX,
    }
    const res = await rest.upload('agreement-templates', bad, { kind: 'student' }, cookies.admin)
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.json)).toContain('unknown_fields')
    expect(JSON.stringify(res.json)).toContain('student.phone')

    const docm = {
      data: buildDocx(['T', '{{project.title}}'], { macro: true }),
      name: 'macro.docm',
      type: 'application/vnd.ms-word.document.macroEnabled.12',
    }
    const macro = await rest.upload('agreement-templates', docm, { kind: 'company' }, cookies.admin)
    expect(macro.status).toBe(400)
    expect(JSON.stringify(macro.json)).toContain('macros')

    const pdf = { data: makePdf('x'), name: 'fake.docx', type: DOCX }
    const notDocx = await rest.upload(
      'agreement-templates',
      pdf,
      { kind: 'company' },
      cookies.admin,
    )
    expect(notDocx.status).toBe(400)
    expect(JSON.stringify(notDocx.json)).toContain('not_docx')

    const noKind = await rest.upload(
      'agreement-templates',
      { data: companyTemplateDocx(), name: 'c.docx', type: DOCX },
      {},
      cookies.admin,
    )
    expect(noKind.status).toBe(400)
  })

  it('versions go up per kind; publishing retires the old one; only drafts can be deleted', async () => {
    const admin = w.admin
    const v2 = await uploadTemplate(w.payload, admin, 'student', studentTemplateDocx())
    expect(v2.version).toBe(2)
    expect(v2.status).toBe('draft')

    // The kind, version and fields cannot be changed through the API.
    const tampered = await w.payload.update({
      collection: 'agreement-templates',
      id: v2.id,
      data: { kind: 'company', version: 99, fields: ['x'] } as never,
      ...as(admin),
    })
    expect(tampered.kind).toBe('student')
    expect(tampered.version).toBe(2)
    expect(tampered.fields).not.toContain('x')

    await w.payload.update({
      collection: 'agreement-templates',
      id: v2.id,
      data: { status: 'published' },
      ...as(admin),
    })
    const old = await w.payload.findByID({
      collection: 'agreement-templates',
      id: w.templates.student.id,
      ...as(admin),
    })
    expect(old.status).toBe('retired')
    const published = await w.payload.find({
      collection: 'agreement-templates',
      where: { and: [{ kind: { equals: 'student' } }, { status: { equals: 'published' } }] },
      ...as(admin),
    })
    expect(published.docs.map((d) => d.id)).toEqual([v2.id])

    // A retired template cannot come back, and published or retired ones cannot be deleted.
    await expect(
      w.payload.update({
        collection: 'agreement-templates',
        id: old.id,
        data: { status: 'published' },
        ...as(admin),
      }),
    ).rejects.toThrow()
    const adminCookie = cookies.admin
    expect((await rest.delete(`agreement-templates/${old.id}`, adminCookie)).status).not.toBe(200)
    expect((await rest.delete(`agreement-templates/${v2.id}`, adminCookie)).status).not.toBe(200)

    const draft = await uploadTemplate(w.payload, admin, 'student', studentTemplateDocx())
    expect(draft.version).toBe(3)
    expect((await rest.delete(`agreement-templates/${draft.id}`, adminCookie)).status).toBe(200)

    // A new file never replaces a stored version.
    await expect(
      w.payload.update({
        collection: 'agreement-templates',
        id: v2.id,
        data: {},
        file: fileOf(studentTemplateDocx(), 's.docx', DOCX),
        ...as(admin),
      }),
    ).rejects.toThrow(/new version/)
  })
})
