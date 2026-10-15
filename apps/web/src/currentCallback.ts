export type CallbackRef<Args extends unknown[], Result> = { current: (...args: Args) => Result }

export function callCurrent<Args extends unknown[], Result>(ref: CallbackRef<Args, Result>, ...args: Args): Result {
  return ref.current(...args)
}
