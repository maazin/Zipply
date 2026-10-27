import type { Adapter } from './types'
import { genericConfirmation } from './types'
import { workday } from './workday'
import { icims } from './icims'
import { greenhouse } from './greenhouse'
import { lever } from './lever'
import { ashby } from './ashby'
import { oracle } from './oracle'

/** Any other form: the rule-based matcher does all the work. */
export const fallback: Adapter = {
  name: 'Other',
  detect: () => true,
  isConfirmation: (doc) => genericConfirmation(doc),
}

export const ADAPTERS: Adapter[] = [workday, icims, greenhouse, lever, ashby, oracle]

export function pickAdapter(url: URL, doc: Document): Adapter {
  return ADAPTERS.find((a) => a.hosts?.test(url.hostname)) ?? ADAPTERS.find((a) => a.detect(url, doc)) ?? fallback
}

export type { Adapter }
