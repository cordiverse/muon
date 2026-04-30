export type PathSegment = string | number

export namespace Mutation {
  export interface Replace {
    type: 'replace'
    value: any
  }

  export interface Append {
    type: 'append'
    value: any
  }

  export interface Truncate {
    type: 'truncate'
    count: number
  }

  export interface Delete {
    type: 'delete'
  }

  export interface Batch {
    type: 'batch'
    items: Mutation[]
  }
}

export type MutationKind =
  | Mutation.Replace
  | Mutation.Append
  | Mutation.Truncate
  | Mutation.Delete
  | Mutation.Batch

export interface Mutation {
  path: PathSegment[]
  kind: MutationKind
}

export function isPlainObject(value: any): value is Record<string, any> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function trackable(value: any): boolean {
  return Array.isArray(value) || isPlainObject(value)
}

function isIndexKey(key: string | symbol): key is string {
  if (typeof key !== 'string') return false
  if (key === '') return false
  const n = Number(key)
  return Number.isInteger(n) && n >= 0 && String(n) === key
}

interface ChangeSet {
  kind: 'set'
  value: any
}

interface ChangeDelete {
  kind: 'delete'
}

type Change = ChangeSet | ChangeDelete

export abstract class BaseNode {
  invalidated = false
  children = new Map<PathSegment, BaseNode>()
  childProxies = new Map<PathSegment, object>()

  abstract target: object
  abstract flush(): Mutation | null
  abstract makeProxy(): any

  wrapChild(key: PathSegment, value: any): any {
    if (!trackable(value)) return value
    const cached = this.childProxies.get(key)
    if (cached) {
      const cachedNode = this.children.get(key)
      if (cachedNode && cachedNode.target === value) return cached
    }
    const child = createNode(value)
    this.children.set(key, child)
    const proxy = child.makeProxy()
    this.childProxies.set(key, proxy)
    return proxy
  }

  dropChild(key: PathSegment): void {
    this.children.delete(key)
    this.childProxies.delete(key)
  }
}

export class ObjectNode extends BaseNode {
  changes = new Map<string, Change>()
  originals = new Map<string, any>()

  constructor(public target: Record<string, any>) {
    super()
  }

  recordSet(key: string, oldValue: any, newValue: any): void {
    if (!this.originals.has(key)) {
      this.originals.set(key, oldValue)
    }
    this.dropChild(key)
    this.changes.set(key, { kind: 'set', value: newValue })
  }

  recordDelete(key: string, oldValue: any): void {
    if (!this.originals.has(key)) {
      this.originals.set(key, oldValue)
    }
    this.dropChild(key)
    this.changes.set(key, { kind: 'delete' })
  }

  invalidate(): void {
    this.invalidated = true
    this.children.clear()
    this.childProxies.clear()
    this.changes.clear()
  }

  flush(): Mutation | null {
    if (this.invalidated) {
      return { path: [], kind: { type: 'replace', value: this.target } }
    }
    const items: Mutation[] = []
    for (const [key, change] of this.changes) {
      if (change.kind === 'delete') {
        items.push({ path: [key], kind: { type: 'delete' } })
      } else {
        const original = this.originals.get(key)
        const next = this.target[key]
        if (
          typeof original === 'string'
          && typeof next === 'string'
          && next.length > original.length
          && next.startsWith(original)
        ) {
          items.push({
            path: [key],
            kind: { type: 'append', value: next.slice(original.length) },
          })
        } else {
          items.push({ path: [key], kind: { type: 'replace', value: next } })
        }
      }
    }
    for (const [key, child] of this.children) {
      if (this.changes.has(key as string)) continue
      const sub = child.flush()
      if (sub) {
        items.push({ path: [key, ...sub.path], kind: sub.kind })
      }
    }
    if (!items.length) return null
    if (items.length === 1) return items[0]
    return collapseBatch(items, this.target)
  }

  makeProxy() {
    const target = this.target
    return new Proxy(target, {
      get: (_t, key) => {
        if (typeof key === 'symbol') return (target as any)[key]
        const value = (target as any)[key]
        if (trackable(value) && !this.changes.has(key)) {
          return this.wrapChild(key, value)
        }
        return value
      },
      set: (_t, key, value) => {
        if (typeof key === 'symbol') {
          ;(target as any)[key] = value
          return true
        }
        const old = (target as any)[key]
        ;(target as any)[key] = value
        this.recordSet(key, old, value)
        return true
      },
      deleteProperty: (_t, key) => {
        if (typeof key === 'symbol') return Reflect.deleteProperty(target, key)
        const old = (target as any)[key]
        const ok = Reflect.deleteProperty(target, key)
        if (ok) this.recordDelete(key, old)
        return ok
      },
      has: (_t, key) => {
        return Reflect.has(target, key)
      },
      ownKeys: () => {
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor: (_t, key) => {
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
  }
}

export class ArrayNode extends BaseNode {
  baselineLength: number
  appendIndex: number
  truncateCount = 0
  changes = new Map<number, any>()

  constructor(public target: any[]) {
    super()
    this.baselineLength = target.length
    this.appendIndex = target.length
  }

  invalidate(): void {
    this.invalidated = true
    this.children.clear()
    this.childProxies.clear()
    this.changes.clear()
    this.truncateCount = 0
  }

  recordIndexSet(idx: number, value: any, prevLen: number): void {
    if (idx > prevLen) {
      // setting past current end with a gap creates holes
      this.invalidate()
      return
    }
    if (idx >= this.appendIndex) {
      // inside (or extending) the appended region; covered by trailing slice
      this.dropChild(idx)
      return
    }
    this.dropChild(idx)
    this.changes.set(idx, value)
  }

  recordLengthSet(newLength: number): void {
    const cur = this.target.length
    if (newLength === cur) return
    if (newLength > cur) {
      this.invalidate()
      return
    }
    if (newLength >= this.appendIndex) {
      // shrink within the appended region only; do nothing
      // drop trackers/changes for indices that no longer exist
      for (const k of [...this.children.keys()]) {
        if (typeof k === 'number' && k >= newLength) this.dropChild(k)
      }
      for (const k of [...this.changes.keys()]) {
        if (k >= newLength) this.changes.delete(k)
      }
      return
    }
    // shrinking into baseline: only valid if there were no in-bounds changes
    // and no appended region we'd be cutting through inconsistently
    if (this.target.length > this.appendIndex) {
      // some appended elements still exist but we're cutting deeper
      this.invalidate()
      return
    }
    if (this.changes.size || this.children.size) {
      this.invalidate()
      return
    }
    this.truncateCount += this.appendIndex - newLength
    this.appendIndex = newLength
    this.baselineLength = newLength
  }

  recordPop(): void {
    if (this.target.length >= this.appendIndex) return
    if (this.changes.size || this.children.size) {
      this.invalidate()
      return
    }
    this.truncateCount += 1
    this.appendIndex = this.target.length
    this.baselineLength = this.target.length
  }

  flush(): Mutation | null {
    if (this.invalidated) {
      return { path: [], kind: { type: 'replace', value: this.target } }
    }
    const items: Mutation[] = []
    if (this.truncateCount > 0) {
      items.push({ path: [], kind: { type: 'truncate', count: this.truncateCount } })
    }
    for (const [idx, value] of this.changes) {
      items.push({ path: [idx], kind: { type: 'replace', value } })
    }
    for (const [key, child] of this.children) {
      if (typeof key === 'number' && this.changes.has(key)) continue
      const sub = child.flush()
      if (sub) {
        items.push({ path: [key, ...sub.path], kind: sub.kind })
      }
    }
    if (this.target.length > this.appendIndex) {
      items.push({
        path: [],
        kind: { type: 'append', value: this.target.slice(this.appendIndex) },
      })
    }
    if (!items.length) return null
    if (items.length === 1) return items[0]
    return collapseBatch(items, this.target)
  }

  makeProxy() {
    const target = this.target
    return new Proxy(target, {
      get: (_t, key) => {
        if (typeof key === 'string' && ARRAY_INVALIDATING_METHODS.has(key)) {
          const method = (target as any)[key] as (...a: any[]) => any
          return (...args: any[]) => {
            this.invalidate()
            return method.apply(target, args)
          }
        }
        if (key === 'push') {
          return (...items: any[]) => target.push(...items)
        }
        if (key === 'pop') {
          return () => {
            if (target.length === 0) return undefined
            const value = target.pop()
            this.recordPop()
            return value
          }
        }
        if (typeof key === 'symbol') return (target as any)[key]
        if (isIndexKey(key)) {
          const idx = Number(key)
          const value = target[idx]
          if (
            trackable(value)
            && !this.changes.has(idx)
            && idx < this.appendIndex
          ) {
            return this.wrapChild(idx, value)
          }
          return value
        }
        return (target as any)[key]
      },
      set: (_t, key, value) => {
        if (key === 'length') {
          const n = Number(value)
          this.recordLengthSet(n)
          target.length = n
          return true
        }
        if (typeof key === 'symbol') {
          ;(target as any)[key] = value
          return true
        }
        if (isIndexKey(key)) {
          const idx = Number(key)
          const prevLen = target.length
          target[idx] = value
          this.recordIndexSet(idx, value, prevLen)
          return true
        }
        ;(target as any)[key] = value
        return true
      },
      deleteProperty: (_t, key) => {
        if (typeof key === 'string' && isIndexKey(key)) {
          this.invalidate()
        }
        return Reflect.deleteProperty(target, key)
      },
      has: (_t, key) => {
        return Reflect.has(target, key)
      },
      ownKeys: () => {
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor: (_t, key) => {
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
  }
}

function collapseBatch(items: Mutation[], target: object): Mutation {
  // If every item is a root-level Replace covering all keys of target, collapse to
  // a single Replace of the whole composite.
  if (Array.isArray(target)) {
    if (
      items.length === target.length
      && items.every(
        (m, _i) =>
          m.path.length === 1
          && typeof m.path[0] === 'number'
          && m.kind.type === 'replace',
      )
    ) {
      const seen = new Set<number>()
      for (const m of items) seen.add(m.path[0] as number)
      if (seen.size === target.length) {
        return { path: [], kind: { type: 'replace', value: target } }
      }
    }
  } else {
    const keys = Object.keys(target)
    if (
      items.length === keys.length
      && items.every(
        (m) => m.path.length === 1 && typeof m.path[0] === 'string' && m.kind.type === 'replace',
      )
    ) {
      const seen = new Set<string>()
      for (const m of items) seen.add(m.path[0] as string)
      if (seen.size === keys.length && keys.every(k => seen.has(k))) {
        return { path: [], kind: { type: 'replace', value: target } }
      }
    }
  }
  return { path: [], kind: { type: 'batch', items } }
}

function createNode(target: any): BaseNode {
  if (Array.isArray(target)) return new ArrayNode(target)
  if (isPlainObject(target)) return new ObjectNode(target)
  throw new TypeError('muon: expected plain object or array')
}

const ARRAY_INVALIDATING_METHODS = new Set([
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'copyWithin',
  'fill',
])

export function observe<T extends object>(data: T, fn: (data: T) => void): Mutation | null {
  const root = createNode(data)
  fn(root.makeProxy())
  return root.flush()
}

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

export function apply<T>(target: T, mutation: Mutation): T {
  return applyAt(target, mutation, 0) as T
}

function applyAt(target: any, m: Mutation, depth: number): any {
  if (depth === m.path.length) {
    return applyKind(target, m.kind)
  }
  if (depth === m.path.length - 1 && m.kind.type === 'delete') {
    const seg = m.path[depth]
    if (isPlainObject(target) && typeof seg === 'string') {
      delete (target as Record<string, any>)[seg]
      return target
    }
    throw new TypeError('muon: delete requires an object parent at the final path segment')
  }
  const seg = m.path[depth]
  if (Array.isArray(target) && typeof seg === 'number') {
    target[seg] = applyAt(target[seg], m, depth + 1)
    return target
  }
  if (isPlainObject(target) && typeof seg === 'string') {
    target[seg] = applyAt(target[seg], m, depth + 1)
    return target
  }
  throw new TypeError(`muon: cannot navigate path segment ${String(seg)} at depth ${depth}`)
}

function applyKind(value: any, kind: MutationKind): any {
  switch (kind.type) {
    case 'replace':
      return kind.value
    case 'append':
      if (typeof value === 'string' && typeof kind.value === 'string') {
        return value + kind.value
      }
      if (Array.isArray(value) && Array.isArray(kind.value)) {
        value.push(...kind.value)
        return value
      }
      throw new TypeError('muon: append requires matching string or array value')
    case 'truncate':
      if (typeof value === 'string') {
        const n = Math.max(0, value.length - kind.count)
        return value.slice(0, n)
      }
      if (Array.isArray(value)) {
        value.length = Math.max(0, value.length - kind.count)
        return value
      }
      throw new TypeError('muon: truncate requires a string or array target')
    case 'delete':
      throw new TypeError('muon: cannot apply delete at root')
    case 'batch': {
      let cur = value
      for (const item of kind.items) {
        cur = applyAt(cur, item, 0)
      }
      return cur
    }
  }
}
