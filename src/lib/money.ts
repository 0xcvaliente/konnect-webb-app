/**
 * Prices (konnected-product-rules, money.md). Konnected sets one fixed price per paid project at
 * review, in whole Norwegian kroner, excluding VAT. 25 % VAT is added on the invoice (the
 * accountant is to confirm). Payment terms are 14 days. Nothing here imports server code.
 */

export const VAT_RATE = 0.25
export const PAYMENT_TERMS_DAYS = 14

/** The highest price the review form accepts, as a guard against typing errors. */
export const PRICE_MAX = 10_000_000

/** A price is a whole number of kroner, at least 1. */
export const isValidPrice = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= PRICE_MAX

export type PriceBreakdown = { price: number; vat: number; total: number }

/** Price excluding VAT, the VAT and the total the company pays. VAT is rounded to whole øre. */
export function priceBreakdown(price: number): PriceBreakdown {
  const vat = Math.round(price * VAT_RATE * 100) / 100
  return { price, vat, total: Math.round((price + vat) * 100) / 100 }
}

/** Read a typed price: digits with optional spaces ("12 500"). Undefined when it is not one. */
export function parsePrice(value: string): number | undefined {
  const cleaned = value.replace(/[\s ]/g, '').replace(/(kr|nok)$/i, '')
  if (!/^\d+$/.test(cleaned)) return undefined
  const price = Number(cleaned)
  return isValidPrice(price) ? price : undefined
}
