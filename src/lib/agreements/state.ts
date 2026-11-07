/** The answer of an agreement Server Action, for the forms on the agreement screens. */
export type AgreementActionState =
  | { status: 'idle' }
  | { status: 'done'; doneAt: number; id?: number; result?: string }
  | { status: 'error'; error: string; fields?: string[]; doneAt: number }

export const IDLE: AgreementActionState = { status: 'idle' }
