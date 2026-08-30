import { describe, expect, it } from 'vitest'
import { displayName, fullName, type Player } from './types'

function p(id: string, firstName: string, lastName?: string): Player {
  return {
    id,
    teamId: 't',
    firstName,
    ...(lastName ? { lastName } : {}),
    active: true,
    gk: 'willing',
    preferredGroups: [],
    avoidGroups: [],
    createdAt: 0,
  }
}

describe('displayName', () => {
  it('uses the first name alone when it is unambiguous', () => {
    const squad = [p('1', 'Emerson', 'Rinker'), p('2', 'Theo', 'Newman')]
    expect(displayName(squad[0]!, squad)).toBe('Emerson')
    expect(displayName(squad[1]!, squad)).toBe('Theo')
  })

  it('still uses first names when players share a LAST name', () => {
    // Two Smiths are not a problem — nobody shouts a surname across a pitch.
    const squad = [p('1', 'Emma', 'Smith'), p('2', 'Jack', 'Smith')]
    expect(displayName(squad[0]!, squad)).toBe('Emma')
    expect(displayName(squad[1]!, squad)).toBe('Jack')
  })

  it('adds a surname initial only when first names collide', () => {
    const squad = [p('1', 'Harrison', 'Blah'), p('2', 'Harrison', 'Smith')]
    expect(displayName(squad[0]!, squad)).toBe('Harrison B.')
    expect(displayName(squad[1]!, squad)).toBe('Harrison S.')
  })

  it('leaves a colliding first name alone when there is no surname to add', () => {
    const squad = [p('1', 'Harrison'), p('2', 'Harrison', 'Smith')]
    expect(displayName(squad[0]!, squad)).toBe('Harrison')
    expect(displayName(squad[1]!, squad)).toBe('Harrison S.')
  })

  it('is case-insensitive about collisions', () => {
    const squad = [p('1', 'harrison', 'Blah'), p('2', 'Harrison', 'Smith')]
    expect(displayName(squad[1]!, squad)).toBe('Harrison S.')
  })

  it('shows a whole name typed into the first-name box, unshortened', () => {
    // Documents the one way a full name reaches a player chip: it was entered
    // as the first name, so the app has no surname to shorten away.
    const squad = [p('1', 'Harrison Smith'), p('2', 'Theo Newman')]
    expect(displayName(squad[0]!, squad)).toBe('Harrison Smith')
  })
})

describe('fullName', () => {
  it('joins first and last', () => {
    expect(fullName(p('1', 'Emma', 'Smith'))).toBe('Emma Smith')
  })

  it('copes with no surname', () => {
    expect(fullName(p('1', 'Emma'))).toBe('Emma')
  })
})
