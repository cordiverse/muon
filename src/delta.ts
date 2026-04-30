import { isIndexKey, Mutation, MutationKind, PathSegment } from './common'

export type DeltaOp = 'SET' | 'APPEND' | 'TRUNCATE' | 'DELETE' | 'BATCH'

export interface Delta {
  p?: string
  o?: DeltaOp
  v?: any
}

function encodePath(path: PathSegment[]): string {
  return path.join('/')
}

function decodePath(p: string): PathSegment[] {
  if (!p) return []
  const out: PathSegment[] = []
  for (const part of p.split('/')) {
    if (part === '') continue
    out.push(isIndexKey(part) ? Number(part) : part)
  }
  return out
}

export class DeltaState {
  private p = ''
  private o: DeltaOp = 'SET'

  load(delta: Delta): Mutation {
    if (delta.o !== undefined) this.o = delta.o
    if (delta.p !== undefined) this.p = delta.p
    const path = decodePath(this.p)
    const kind = this.loadKind(delta.v)
    return { path, kind }
  }

  private loadKind(v: any): MutationKind {
    switch (this.o) {
      case 'SET':
        return { type: 'replace', value: v }
      case 'APPEND':
        return { type: 'append', value: v }
      case 'TRUNCATE':
        if (typeof v !== 'number') throw new TypeError('muon: TRUNCATE delta requires numeric value')
        return { type: 'truncate', count: v }
      case 'DELETE':
        return { type: 'delete' }
      case 'BATCH': {
        if (!Array.isArray(v)) throw new TypeError('muon: BATCH delta requires array value')
        const inner = new DeltaState()
        const items = v.map((d: Delta) => inner.load(d))
        return { type: 'batch', items }
      }
    }
  }

  dump(mutation: Mutation): Delta {
    const newP = encodePath(mutation.path)
    let newO: DeltaOp
    let v: any
    let hasV = true
    switch (mutation.kind.type) {
      case 'replace':
        newO = 'SET'
        v = mutation.kind.value
        break
      case 'append':
        newO = 'APPEND'
        v = mutation.kind.value
        break
      case 'truncate':
        newO = 'TRUNCATE'
        v = mutation.kind.count
        break
      case 'delete':
        newO = 'DELETE'
        v = undefined
        hasV = false
        break
      case 'batch': {
        newO = 'BATCH'
        const inner = new DeltaState()
        v = mutation.kind.items.map((m) => inner.dump(m))
        break
      }
    }
    const delta: Delta = {}
    if (this.p !== newP) {
      this.p = newP
      delta.p = newP
    }
    if (this.o !== newO) {
      this.o = newO
      delta.o = newO
    }
    if (hasV) delta.v = v
    return delta
  }
}
