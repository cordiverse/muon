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
