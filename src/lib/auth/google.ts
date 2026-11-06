import * as client from 'openid-client'

import { GOOGLE_CALLBACK_PATH, googleEnv } from './env'
import type { OidcChecks } from './oidcCookie'

/**
 * Google's OpenID Connect endpoints. Fixed here so starting a sign-in needs no network call.
 * They match https://accounts.google.com/.well-known/openid-configuration. The ID token is still
 * checked against Google's current signing keys (jwks_uri) when the code is exchanged.
 */
const GOOGLE_METADATA = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
}

export const googleConfiguration = (): client.Configuration => {
  const { clientId, clientSecret } = googleEnv()
  return new client.Configuration(GOOGLE_METADATA, clientId, clientSecret)
}

/**
 * Build the Google sign-in address. Authorization code flow with PKCE (S256), `state` and `nonce`.
 * Only `openid email profile` are requested, and no Google token is ever stored.
 */
export async function startGoogleSignIn(): Promise<{ url: URL; checks: OidcChecks }> {
  const { appUrl } = googleEnv()
  const verifier = client.randomPKCECodeVerifier()
  const state = client.randomState()
  const nonce = client.randomNonce()
  const url = client.buildAuthorizationUrl(googleConfiguration(), {
    redirect_uri: `${appUrl}${GOOGLE_CALLBACK_PATH}`,
    scope: 'openid email profile',
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
    prompt: 'select_account',
  })
  return { url, checks: { state, nonce, verifier } }
}

export type GoogleClaims = { sub: string; email?: string; emailVerified: boolean }

/**
 * Exchange the code from Google's redirect. The library checks the issuer, audience, expiry,
 * signature, `state`, `nonce` and the PKCE verifier. `email_verified` is checked by the caller.
 */
export async function exchangeGoogleCode(
  callbackUrl: URL,
  checks: OidcChecks,
): Promise<GoogleClaims> {
  const tokens = await client.authorizationCodeGrant(googleConfiguration(), callbackUrl, {
    pkceCodeVerifier: checks.verifier,
    expectedState: checks.state,
    expectedNonce: checks.nonce,
    idTokenExpected: true,
  })
  const claims = tokens.claims()
  if (!claims) throw new Error('Google returned no ID token')
  const verified = claims.email_verified as unknown
  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    emailVerified: verified === true || verified === 'true',
  }
}
