export type RequestToken<Key> = { key: Key; generation: number }

/** Invalidates every older async response, including another request for the same key. */
export function createRequestGeneration<Key>() {
  let generation = 0
  return {
    begin(key: Key): RequestToken<Key> {
      generation += 1
      return { key, generation }
    },
    invalidate() {
      generation += 1
    },
    isCurrent(token: RequestToken<Key>, currentKey: Key) {
      return token.generation === generation && token.key === currentKey
    },
  }
}
