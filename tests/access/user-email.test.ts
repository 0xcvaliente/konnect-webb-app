import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { completeEmailLinkLogin, completeGoogleLogin } from '@/lib/auth/accounts'
import type { User } from '@/payload-types'

import {
  ADMIN_EMAIL,
  asUser,
  createWorld,
  graphql,
  resetDatabase,
  rest,
  sessionFor,
  type World,
} from '../helpers/world'

/**
 * Only an admin can change the email on an account. Email-link and Google sign-in link to an
 * existing account by email, so a user who could set their own email to someone else's address
 * (with no proof) would have that person land in their account later, or become admin when a
 * newly listed admin first signs in with Google.
 */

let w: World

beforeEach(async () => {
  await resetDatabase()
  w = await createWorld()
})

afterEach(() => {
  process.env.ADMIN_EMAILS = ADMIN_EMAIL
})

const emailOf = async (id: number) =>
  (await w.payload.findByID({ collection: 'users', id, depth: 0, overrideAccess: true })).email

/** Try every transport to set `target` as the user's own email. */
async function tryEveryTransport(user: User, target: string) {
  const cookie = await sessionFor(user.id)

  await rest.patch(`users/${user.id}`, { email: target }, cookie)
  expect(await emailOf(user.id)).toBe(user.email)

  await graphql(
    `mutation { updateUser(id: ${user.id}, data: { email: "${target}" }) { id } }`,
    cookie,
  )
  expect(await emailOf(user.id)).toBe(user.email)

  await w.payload
    .update({
      collection: 'users',
      id: user.id,
      data: { email: target },
      user: asUser(user),
      overrideAccess: false,
    })
    .catch(() => undefined)
  expect(await emailOf(user.id)).toBe(user.email)
}

describe('changing the email on an account', () => {
  it('a student, a company user and a new (pending) user cannot change their own email', async () => {
    const pending = (await completeEmailLinkLogin(w.payload, 'new.person@example.test', 'en'))!
    for (const user of [w.alpha.user, w.companyA.user, pending]) {
      await tryEveryTransport(user, `taken.over.${user.id}@uni.test`)
    }
  })

  it('an anonymous request cannot change anyone’s email', async () => {
    const id = w.alpha.user.id
    const res = await rest.patch(`users/${id}`, { email: 'anon@uni.test' })
    expect([401, 403]).toContain(res.status)
    await graphql(`mutation { updateUser(id: ${id}, data: { email: "anon@uni.test" }) { id } }`)
    await w.payload
      .update({ collection: 'users', id, data: { email: 'anon@uni.test' }, overrideAccess: false })
      .catch(() => undefined)
    expect(await emailOf(id)).toBe(w.alpha.user.email)
  })

  it('an admin can change a user’s email (positive control)', async () => {
    const cookie = await sessionFor(w.admin.id)
    const res = await rest.patch(`users/${w.alpha.user.id}`, { email: 'fixed@uni.test' }, cookie)
    expect(res.status).toBe(200)
    expect(await emailOf(w.alpha.user.id)).toBe('fixed@uni.test')

    // The same mutation the other roles send, so their GraphQL check is not vacuous.
    const gql = await graphql(
      `mutation { updateUser(id: ${w.alpha.user.id}, data: { email: "fixed.gql@uni.test" }) { id } }`,
      cookie,
    )
    expect(gql.json.errors).toBeUndefined()
    expect(await emailOf(w.alpha.user.id)).toBe('fixed.gql@uni.test')

    await w.payload.update({
      collection: 'users',
      id: w.alpha.user.id,
      data: { email: 'fixed.again@uni.test' },
      user: asUser(w.admin),
      overrideAccess: false,
    })
    expect(await emailOf(w.alpha.user.id)).toBe('fixed.again@uni.test')
  })

  it('a victim who later signs in by link or Google does not land in the attacker’s account', async () => {
    const attacker = (await completeEmailLinkLogin(w.payload, 'attacker@example.test', 'en'))!
    await tryEveryTransport(attacker, 'victim@uni.test')

    const viaLink = await completeEmailLinkLogin(w.payload, 'victim@uni.test', 'en')
    expect(viaLink!.id).not.toBe(attacker.id)
    const viaGoogle = await completeGoogleLogin(w.payload, {
      sub: 'g-victim',
      email: 'victim@uni.test',
      emailVerified: true,
    })
    expect(viaGoogle.id).not.toBe(attacker.id)
  })

  it('a user cannot take a newly listed admin address and become admin on its first Google sign-in', async () => {
    const newAdmin = 'new.admin@konnected.test'
    process.env.ADMIN_EMAILS = `${ADMIN_EMAIL},${newAdmin}`
    const attacker = (await completeEmailLinkLogin(w.payload, 'attacker@example.test', 'en'))!
    const cookie = await sessionFor(attacker.id)
    await tryEveryTransport(attacker, newAdmin)

    const admin = await completeGoogleLogin(w.payload, {
      sub: 'g-new-admin',
      email: newAdmin,
      emailVerified: true,
    })
    expect(admin.id).not.toBe(attacker.id)
    expect(admin.role).toBe('admin')

    // The attacker's session is still an ordinary one.
    const me = await rest.get('users/me', cookie)
    expect((me.json.user as User).id).toBe(attacker.id)
    expect((me.json.user as User).role).toBe('pending')
  })
})
