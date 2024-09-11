import { ApiPromise, HttpProvider, WsProvider } from '@polkadot/api'
import { HexString } from '@polkadot/util/types'
import { Mock, beforeAll, beforeEach, expect, vi } from 'vitest'
import { Observable } from 'rxjs'
import { ProviderInterface } from '@polkadot/rpc-provider/types'
import { RegisteredTypes } from '@polkadot/types/types'
import { SubstrateClient, createClient } from '@polkadot-api/substrate-client'
import { getObservableClient } from '@polkadot-api/observable-client'
import { getWsProvider } from '@polkadot-api/ws-provider/node'

import { Api } from '@systemfsoftware/chopsticks'
import { Blockchain, BuildBlockMode, StorageValues } from '@systemfsoftware/chopsticks-core'
import { SqliteDatabase } from '@systemfsoftware/chopsticks-db'
import { createServer } from '@systemfsoftware/chopsticks/server.js'
import { defer } from '@systemfsoftware/chopsticks-core/utils/index.js'
import { genesisFromUrl } from '@systemfsoftware/chopsticks/context.js'
import { handler } from '@systemfsoftware/chopsticks/rpc/index.js'
import { inherentProviders } from '@systemfsoftware/chopsticks-core/blockchain/inherent/index.js'
import { withExpect } from '@systemfsoftware/chopsticks-testing'

export { testingPairs, setupContext } from '@systemfsoftware/chopsticks-testing'

export type SetupOption = {
  endpoint?: string | string[]
  blockHash?: HexString
  mockSignatureHost?: boolean
  allowUnresolvedImports?: boolean
  genesis?: string
  registeredTypes?: RegisteredTypes
  runtimeLogLevel?: number
  processQueuedMessages?: boolean
}

export const env = {
  acala: {
    endpoint: 'wss://acala-rpc.aca-api.network',
    // 3,800,000
    blockHash: '0x0df086f32a9c3399f7fa158d3d77a1790830bd309134c5853718141c969299c7' as HexString,
  },
  acalaV15: {
    endpoint: 'wss://acala-rpc.aca-api.network',
    // 6,800,000
    blockHash: '0x6c74912ce35793b05980f924c3a4cdf1f96c66b2bedd0c7b7378571e60918145' as HexString,
  },
  rococo: {
    endpoint: 'wss://rococo-rpc.polkadot.io',
    blockHash: '0xd7fef00504decd41d5d2e9a04346f6bc639fd428083e3ca941f636a8f88d456a' as HexString,
  },
}

export const setupAll = async ({
  endpoint,
  blockHash,
  mockSignatureHost,
  allowUnresolvedImports,
  genesis,
  registeredTypes = {},
  runtimeLogLevel,
  processQueuedMessages,
}: SetupOption) => {
  let provider: ProviderInterface
  if (genesis) {
    provider = await genesisFromUrl(genesis)
  } else if (typeof endpoint === 'string' && /^(https|http):\/\//.test(endpoint || '')) {
    provider = new HttpProvider(endpoint)
  } else {
    provider = new WsProvider(endpoint, 3_000)
  }
  const api = new Api(provider)

  await api.isReady

  const header = await api.getHeader(blockHash)
  if (!header) {
    throw new Error(`Cannot find header for ${blockHash}`)
  }

  const setup = async () => {
    blockHash ??= await api.getBlockHash().then((hash) => hash ?? undefined)
    if (!blockHash) {
      throw new Error('Cannot find block hash')
    }

    const chain = new Blockchain({
      api,
      buildBlockMode: BuildBlockMode.Manual,
      inherentProviders,
      header: {
        hash: blockHash,
        number: Number(header.number),
      },
      mockSignatureHost,
      allowUnresolvedImports,
      registeredTypes,
      runtimeLogLevel,
      db: !process.env.RUN_TESTS_WITHOUT_DB ? new SqliteDatabase('e2e-tests-db.sqlite') : undefined,
      processQueuedMessages,
    })

    if (genesis) {
      // build 1st block
      await chain.newBlock()
    }

    const { port, close } = await createServer(handler({ chain }), 0)
    const ws = new WsProvider(`ws://localhost:${port}`, 3_000, undefined, 300_000)

    return {
      chain,
      port,
      ws,
      async teardown() {
        await delay(100)
        await close()
      },
    }
  }

  return {
    async setupPjs() {
      const { chain, ws, teardown } = await setup()

      const apiPromise = await ApiPromise.create({
        provider: ws,
        noInitWarn: true,
      })

      await apiPromise.isReady

      return {
        chain,
        ws,
        api: apiPromise,
        async teardown() {
          await apiPromise.disconnect()
          await teardown()
        },
      }
    },
    async setupPolkadotApi(): Promise<TestPolkadotApi> {
      const { chain, port, ws, teardown } = await setup()

      const substrateClient = createClient(getWsProvider(`ws://localhost:${port}`))
      const observableClient = getObservableClient(substrateClient)

      return {
        chain,
        substrateClient,
        observableClient,
        ws,
        async teardown() {
          observableClient.destroy()
          substrateClient.destroy()
          await teardown()
        },
      }
    },
    async teardownAll() {
      await delay(100)
      await api.disconnect()
    },
  }
}

interface TestPolkadotApi {
  ws: WsProvider
  chain: Blockchain
  substrateClient: SubstrateClient
  observableClient: ObservableClient
  teardown: () => Promise<void>
}

export let api: ApiPromise
export let chain: Blockchain
export let ws: WsProvider

export const setupApi = (option: SetupOption) => {
  let setup: Awaited<ReturnType<typeof setupAll>>['setupPjs']

  beforeAll(async () => {
    const res = await setupAll(option)
    setup = res.setupPjs

    return res.teardownAll
  })

  beforeEach(async () => {
    const res = await setup()
    api = res.api
    chain = res.chain
    ws = res.ws

    return res.teardown
  })
}

type ObservableClient = ReturnType<typeof getObservableClient>
export const setupPolkadotApi = async (option: SetupOption) => {
  let setup: Awaited<ReturnType<typeof setupAll>>['setupPolkadotApi']
  const result = {
    chain: null as unknown as Blockchain,
    substrateClient: null as unknown as SubstrateClient,
    observableClient: null as unknown as ObservableClient,
    ws: null as unknown as WsProvider,
  }

  beforeAll(async () => {
    const res = await setupAll(option)
    setup = res.setupPolkadotApi

    return res.teardownAll
  })

  beforeEach(async () => {
    const res = await setup()
    ws = result.ws = res.ws
    chain = result.chain = res.chain
    result.substrateClient = res.substrateClient
    result.observableClient = res.observableClient

    return res.teardown
  })

  return result
}

export const dev = {
  newBlock: (param?: { count?: number; to?: number }): Promise<string> => {
    return ws.send('dev_newBlock', [param])
  },
  setStorage: (values: StorageValues, blockHash?: string) => {
    return ws.send('dev_setStorage', [values, blockHash])
  },
  timeTravel: (date: string | number) => {
    return ws.send<number>('dev_timeTravel', [date])
  },
  setHead: (hashOrNumber: string | number) => {
    return ws.send('dev_setHead', [hashOrNumber])
  },
}

export const mockCallback = () => {
  let next = defer()
  const callback = vi.fn((...args) => {
    next.resolve(args)
    next = defer()
  })

  return {
    callback,
    async next() {
      return next.promise
    },
  }
}

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const { check, checkHex, checkSystemEvents } = withExpect(expect)

export { defer, check, checkHex, checkSystemEvents }

export const observe = <T>(observable$: Observable<T>) => {
  const next: Mock<[T], void> = vi.fn()
  const error: Mock<any, void> = vi.fn()
  const complete: Mock<[], void> = vi.fn()

  const getEmissions = () => next.mock.calls.map((v) => v[0])

  let resolvePromise: ((value: T) => void) | null = null
  let rejectPromise: ((error: any) => void) | null = null
  let promise: Promise<T> | null = null
  const nextValue = () =>
    promise ??
    (promise = new Promise<T>((resolve, reject) => {
      rejectPromise = reject
      resolvePromise = (v) => {
        promise = null
        resolve(v)
      }
    }))

  const subscription = observable$.subscribe({
    next: (v) => {
      resolvePromise?.(v)
      next(v)
    },
    error: (e) => {
      rejectPromise?.(e)
      error(e)
    },
    complete: () => {
      rejectPromise?.(new Error('Subscription completed without a new value'))
      complete()
    },
  })
  return { getEmissions, nextValue, next, error, complete, subscription }
}
