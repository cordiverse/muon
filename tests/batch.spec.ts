import { expect } from 'chai'
import { observe } from '../src'

describe('batch', () => {
  it('wraps multiple sibling mutations', () => {
    const data = { a: 1, b: 2, c: 3 }
    const m = observe(data, (d) => {
      d.a = 10
      d.b = 20
    })
    expect(m).to.deep.equal({
      path: [],
      kind: {
        type: 'batch',
        items: [
          { path: ['a'], kind: { type: 'replace', value: 10 } },
          { path: ['b'], kind: { type: 'replace', value: 20 } },
        ],
      },
    })
  })

  it('combines nested mutations across paths', () => {
    const data = { foo: { x: 1 }, bar: [1, 2] }
    const m = observe(data, (d) => {
      d.foo.x = 9
      d.bar.push(3)
    })
    expect(m?.kind.type).to.equal('batch')
    if (m?.kind.type !== 'batch') return
    expect(m.kind.items).to.have.lengthOf(2)
    expect(m.kind.items).to.deep.include({
      path: ['foo', 'x'],
      kind: { type: 'replace', value: 9 },
    })
    expect(m.kind.items).to.deep.include({
      path: ['bar'],
      kind: { type: 'append', value: [3] },
    })
  })

  it('collapses when every key of the parent is replaced', () => {
    const data = { a: 1, b: 2 }
    const m = observe(data, (d) => {
      d.a = 10
      d.b = 20
    })
    // both keys replaced -> single Replace of the whole object
    // (collapse implemented in flush)
    expect(m).to.deep.equal({
      path: [],
      kind: { type: 'replace', value: { a: 10, b: 20 } },
    })
  })

  it('does not collapse when only some keys are replaced', () => {
    const data = { a: 1, b: 2, c: 3 }
    const m = observe(data, (d) => {
      d.a = 10
      d.b = 20
    })
    expect(m?.kind.type).to.equal('batch')
  })
})
