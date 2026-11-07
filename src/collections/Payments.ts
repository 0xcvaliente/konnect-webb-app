import type { Where } from 'payload'
import { APIError, type CollectionConfig } from 'payload'

import {
  adminOnlyField,
  adminOrCompanyField,
  adminOrStudentField,
  companyIdOf,
  isAdmin,
  isStudent,
  relationId,
} from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { lockRow } from '@/lib/db/locks'
import { isValidPrice } from '@/lib/money'
import {
  datesProblem,
  INVOICE_NUMBER_MAX,
  PAYMENT_NOTES_MAX,
  type PaymentError,
  STUDENT_PAYOUT_STATUSES,
  studentPayoutStatus,
} from '@/lib/payments/fields'
import { storedToDay, todayInOslo } from '@/lib/projects/fields'

type Rel = number | { id: number } | null | undefined

/** Context keys the server sets. A client cannot set `req.context` through any API. */
export type PaymentContext = {
  /**
   * The row's `updatedAt` when the team member's form loaded. The save is refused when the row
   * changed since, so one member's save never silently undoes another's (savePayment).
   */
  paymentVersion?: string
}

/** An APIError with a code the team's screen maps to its own message. */
const fail = (code: PaymentError, message: string, status = 400): APIError =>
  new APIError(message, status, { code }, true)

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * The manual payment log (lib/payments/fields.ts): one row per paid match, made by the server when
 * Konnected selects a student for a paid project (Matches hook). Version 1 has no payment
 * provider; the team records the dates by hand.
 *
 * Admin reads and writes everything. A company reads a summary of its own invoices: the price
 * (excluding VAT), the invoice number and when the invoice was sent and paid. A student reads only
 * where their pay stands (waiting for the company, in the next pay run, paid), the day they were
 * paid and what they are paid, if the team set it. Konnected's share and the team's notes are
 * admin-only. Nobody but admins writes.
 */
export const Payments: CollectionConfig = {
  slug: 'payments',
  admin: { defaultColumns: ['match', 'projectFee', 'invoiceSentAt', 'invoicePaidAt'] },
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user)) return { 'match.student.user': { equals: user!.id } }
      const companyId = companyIdOf(user)
      return companyId ? { 'match.project.company': { equals: companyId } } : false
    },
    create: ({ req: { user } }) => isAdmin(user),
    update: ({ req: { user } }) => isAdmin(user),
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc: loaded, operation, req, context }) => {
        let originalDoc = loaded
        const matchId = relationId((data.match ?? originalDoc?.match) as Rel)
        if (!matchId) throw fail('not_found', 'A payment needs a match', 400)
        if (operation === 'update' && matchId !== relationId(originalDoc?.match as Rel)) {
          throw new APIError('A payment keeps its match', 400)
        }

        if (operation === 'update') {
          // Two saves of one row run one after the other. Each reads the row again after the lock,
          // so the date checks below see what the other one saved.
          const id = originalDoc!.id as number
          await lockRow(req, 'payments', id)
          const fresh = await req.payload.findByID({
            collection: 'payments',
            id,
            depth: 0,
            overrideAccess: true,
            disableErrors: true,
            req,
          })
          if (!fresh) throw fail('not_found', 'The payment does not exist', 404)
          const expected = (context as PaymentContext | undefined)?.paymentVersion
          if (expected !== undefined && fresh.updatedAt !== expected) {
            throw fail('not_open', 'Someone saved this row meanwhile. Load it again.', 409)
          }
          originalDoc = fresh
        }

        if (operation === 'create') {
          // Bypass: the server reads the match's project to apply the paid-or-unpaid rule.
          const match = await req.payload.findByID({
            collection: 'matches',
            id: matchId,
            depth: 0,
            select: { project: true },
            overrideAccess: true,
            disableErrors: true,
            req,
          })
          const projectId = relationId(match?.project as Rel)
          const project = projectId
            ? await req.payload.findByID({
                collection: 'projects',
                id: projectId,
                depth: 0,
                select: { paidOrUnpaid: true, fee: true, studentPay: true },
                overrideAccess: true,
                disableErrors: true,
                req,
              })
            : null
          if (!project) throw fail('not_found', 'The match has no project', 404)
          // An unpaid project has no payment rows (owner decision 2026-11-05).
          if (project.paidOrUnpaid !== 'paid') {
            throw fail('unpaid', 'An unpaid project has no payments', 400)
          }
          // The fixed price Konnected set at review, unless the team typed one.
          if (data.projectFee === undefined || data.projectFee === null) {
            data.projectFee = isValidPrice(project.fee) ? project.fee : null
          }
          // What the student is paid, if Konnected decided it at review, unless the team typed one.
          if (data.studentPay === undefined || data.studentPay === null) {
            data.studentPay = isValidPrice(project.studentPay) ? project.studentPay : null
          }
        }
        if (
          data.projectFee !== undefined &&
          data.projectFee !== null &&
          !isValidPrice(data.projectFee)
        ) {
          throw new APIError('The price must be a whole amount', 400)
        }

        if (data.invoiceNumber !== undefined) {
          data.invoiceNumber = text(data.invoiceNumber)
          if ((data.invoiceNumber?.length ?? 0) > INVOICE_NUMBER_MAX)
            throw fail('too_long', 'The invoice number is too long')
        }
        if (data.notes !== undefined) {
          data.notes = text(data.notes)
          if ((data.notes?.length ?? 0) > PAYMENT_NOTES_MAX)
            throw fail('too_long', 'The notes are too long')
        }

        // The dates in order, none ahead of today, checked on the row as it will be saved.
        const pick = (key: 'invoiceSentAt' | 'invoicePaidAt' | 'studentPaidAt') =>
          storedToDay(key in data ? data[key] : originalDoc?.[key])
        const problem = datesProblem(
          {
            invoiceSent: pick('invoiceSentAt'),
            invoicePaid: pick('invoicePaidAt'),
            studentPaid: pick('studentPaidAt'),
          },
          todayInOslo(),
        )
        if (problem) throw fail(problem, `The payment dates are not possible (${problem})`)
        // The student's status follows the dates on every save (never typed by anyone).
        data.studentPayout = studentPayoutStatus({
          invoicePaid: pick('invoicePaidAt'),
          studentPaid: pick('studentPaidAt'),
        })
        return data
      },
    ],
    afterChange: [
      logActivityAfterChange({
        alsoLog: ['invoiceSentAt', 'invoicePaidAt', 'studentPaidAt', 'projectFee', 'invoiceNumber'],
      }),
    ],
    afterDelete: [logActivityAfterDelete()],
  },
  indexes: [{ fields: ['match'], unique: true }],
  fields: [
    {
      name: 'match',
      type: 'relationship',
      relationTo: 'matches',
      required: true,
      index: true,
    },
    {
      // The fixed price excluding VAT, copied from the project when the row is made. 25 % VAT and
      // the total are worked out from it (lib/money.ts), not stored.
      name: 'projectFee',
      label: 'Price (NOK, excl. VAT)',
      type: 'number',
      min: 0,
      access: { read: adminOrCompanyField },
    },
    { name: 'konnectedShare', type: 'number', min: 0, access: { read: adminOnlyField } },
    {
      // What the student is paid for this project, if the team set it. The student reads their
      // own (on the Payments page); a company never does.
      name: 'studentPay',
      type: 'number',
      min: 0,
      access: { read: adminOrStudentField },
    },
    {
      name: 'invoiceNumber',
      type: 'text',
      maxLength: INVOICE_NUMBER_MAX,
      access: { read: adminOrCompanyField },
    },
    { name: 'invoiceSentAt', type: 'date', access: { read: adminOrCompanyField } },
    { name: 'invoicePaidAt', type: 'date', access: { read: adminOrCompanyField } },
    {
      // Paid in the monthly pay run, only after the company paid. The student sees this date.
      name: 'studentPaidAt',
      type: 'date',
      access: { read: adminOrStudentField },
    },
    {
      // Where the student's pay stands, worked out from the dates by the hook above: waiting for
      // the company to pay, in the next monthly pay run, or paid. The student reads only this
      // (not when or whether the company paid); a company never does.
      name: 'studentPayout',
      type: 'select',
      defaultValue: 'waiting_company',
      options: [...STUDENT_PAYOUT_STATUSES],
      access: { read: adminOrStudentField },
      admin: { readOnly: true },
    },
    {
      // The team's own notes. Never shown to the company or the student.
      name: 'notes',
      type: 'textarea',
      maxLength: PAYMENT_NOTES_MAX,
      access: { read: adminOnlyField },
    },
  ],
}
