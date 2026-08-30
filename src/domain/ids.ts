/** Short, sortable, collision-resistant ids. String so records can merge later. */
export function newId(prefix = ''): string {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return prefix ? `${prefix}_${t}${r}` : `${t}${r}`
}

/** Deterministic PRNG so a plan seed reproduces the same chart. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
