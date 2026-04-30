import { ArrayNode } from './array'
import { BaseNode, registerNodeFactory } from './base'
import { isPlainObject, Mutation } from './common'
import { ObjectNode } from './object'

function createNode(target: any): BaseNode {
  if (Array.isArray(target)) return new ArrayNode(target)
  if (isPlainObject(target)) return new ObjectNode(target)
  throw new TypeError('muon: expected plain object or array')
}

registerNodeFactory(createNode)

export function observe<T extends object>(data: T, fn: (data: T) => void): Mutation | null {
  const root = createNode(data)
  fn(root.makeProxy())
  return root.flush()
}

export * from './apply'
export * from './array'
export * from './base'
export * from './common'
export * from './delta'
export * from './object'
