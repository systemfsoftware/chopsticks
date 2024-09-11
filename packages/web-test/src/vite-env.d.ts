/// <reference types="vite/client" />

import { ApiPromise } from '@polkadot/api'
import { Blockchain } from '@systemfsoftware/chopsticks-core'

declare global {
  // eslint-disable-next-line no-var
  var chain: Blockchain
  // eslint-disable-next-line no-var
  var api: ApiPromise
}
