import Docxtemplater from 'docxtemplater'
import InspectModule from 'docxtemplater/js/inspect-module.js'
import { fileTypeFromBuffer } from 'file-type'
import PizZip from 'pizzip'

import {
  ALL_TEMPLATE_FIELDS,
  type AgreementKind,
  DELIMITERS,
  TEMPLATE_FIELDS,
  TEMPLATE_MAX_BYTES,
  TEMPLATE_MAX_ENTRIES,
  TEMPLATE_MAX_UNZIPPED_BYTES,
  type TemplateProblem,
} from './fields'
import { checkZip } from './zip'

/**
 * Reading and filling Konnected's Word templates (docxtemplater with pizzip). Placeholders are
 * `{{field.name}}`; docxtemplater finds them even when Word splits one across text runs.
 *
 * Only plain fields from the allowed list are accepted: no loops, conditions, raw XML or any other
 * docxtemplater feature, so a template can only put known values in known places.
 */

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export type TemplateCheck = { ok: true; fields: string[] } | { ok: false; problem: TemplateProblem }

type TemplateErrorDetail = { properties?: { id?: string; xtag?: string; context?: string } }

const unique = (values: string[]) => [...new Set(values)].sort()

/** Open the template with docxtemplater. Throws its TemplateError for a malformed template. */
function open(buffer: Buffer, modules: InspectModule[] = []) {
  return new Docxtemplater(new PizZip(buffer), {
    delimiters: DELIMITERS,
    paragraphLoop: true,
    linebreaks: true,
    // docxtemplater prints template errors to the console by default; we report them ourselves.
    errorLogging: false,
    modules,
  })
}

/**
 * Check an uploaded template: a real .docx (by content, never a .docm or anything with macros),
 * within the size limits packed and unpacked, readable by docxtemplater, and using only fields
 * this kind of agreement may hold. Returns the fields found, or the first problem.
 */
export async function checkTemplate(buffer: Buffer, kind: AgreementKind): Promise<TemplateCheck> {
  if (buffer.length > TEMPLATE_MAX_BYTES) return { ok: false, problem: { code: 'too_large' } }
  const type = await fileTypeFromBuffer(buffer).catch(() => undefined)
  if (type?.mime !== DOCX_MIME) {
    const macro = type?.mime?.includes('macroenabled')
    return { ok: false, problem: { code: macro ? 'macros' : 'not_docx' } }
  }

  const zip = checkZip(buffer, {
    maxEntries: TEMPLATE_MAX_ENTRIES,
    maxUnzippedBytes: TEMPLATE_MAX_UNZIPPED_BYTES,
  })
  if (!zip.ok) return { ok: false, problem: { code: zip.problem } }
  // Macros live in a VBA part, whatever the file claims to be.
  if (zip.names.some((name) => /vbaProject|vbaData|\.bin$/i.test(name))) {
    return { ok: false, problem: { code: 'macros' } }
  }

  const inspect = new InspectModule()
  try {
    open(buffer, [inspect])
  } catch (error) {
    const details = ((error as { properties?: { errors?: TemplateErrorDetail[] } }).properties
      ?.errors ?? []) as TemplateErrorDetail[]
    if (details.length || (error as Error).name === 'TemplateError') {
      const tags = details.map((d) => d.properties?.context ?? d.properties?.xtag ?? '?')
      return { ok: false, problem: { code: 'malformed', tags: unique(tags).slice(0, 10) } }
    }
    return { ok: false, problem: { code: 'broken_file' } }
  }

  const parts = inspect.getAllStructuredTags() as { module?: string; value?: string }[]
  const logic = parts.filter((p) => p.module).map((p) => String(p.value ?? ''))
  if (logic.length) {
    return { ok: false, problem: { code: 'logic_tags', tags: unique(logic).slice(0, 20) } }
  }
  const found = unique(parts.map((p) => String(p.value ?? '').trim()))
  if (!found.length) return { ok: false, problem: { code: 'no_fields' } }

  const known = new Set<string>(ALL_TEMPLATE_FIELDS)
  const unknown = found.filter((f) => !known.has(f))
  if (unknown.length) {
    return { ok: false, problem: { code: 'unknown_fields', tags: unknown.slice(0, 20) } }
  }
  const allowed = new Set<string>(TEMPLATE_FIELDS[kind])
  const wrongKind = found.filter((f) => !allowed.has(f))
  if (wrongKind.length) {
    return { ok: false, problem: { code: 'not_allowed_here', tags: wrongKind } }
  }
  return { ok: true, fields: found }
}

/** A field with no value: filling stops (docxtemplater's nullGetter throws). */
export class MissingValueError extends Error {
  constructor(public readonly field: string) {
    super(`The agreement has no value for ${field}`)
    this.name = 'MissingValueError'
  }
}

/**
 * Fill a checked template with the agreement's values and return the new .docx. Values are text
 * only (docxtemplater escapes them for XML). Any field without a value throws MissingValueError,
 * so an agreement is never made with a blank where the legal text expects something.
 */
export function fillTemplate(buffer: Buffer, values: Record<string, string>): Buffer {
  const doc = new Docxtemplater(new PizZip(buffer), {
    delimiters: DELIMITERS,
    paragraphLoop: true,
    linebreaks: true,
    errorLogging: false,
    nullGetter(part) {
      throw new MissingValueError(String(part.value ?? ''))
    },
  })
  const data: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' && value.trim()) data[key] = value
  }
  try {
    doc.render(data)
  } catch (error) {
    // docxtemplater wraps the nullGetter's error in a multi error; surface ours.
    const inner = (
      error as { properties?: { errors?: { properties?: { rootError?: unknown } }[] } }
    ).properties?.errors?.[0]?.properties?.rootError
    if (inner instanceof MissingValueError) throw inner
    if (error instanceof MissingValueError) throw error
    throw error
  }
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer
}
