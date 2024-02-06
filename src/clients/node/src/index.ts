export * from './bindings'
import {
  Account,
  Transfer,
  CreateAccountsError,
  CreateTransfersError,
  Operation,
  AccountFilter,
  AccountBalance,
} from './bindings'
import { randomFillSync } from 'node:crypto'

const binding: Binding = (() => {
  const { arch, platform } = process

  const archMap = {
    "arm64": "aarch64",
    "x64": "x86_64"
  }

  const platformMap = {
    "linux": "linux",
    "darwin": "macos",
    "win32" : "windows",
  }

  if (! (arch in archMap)) {
    throw new Error(`Unsupported arch: ${arch}`)
  }

  if (! (platform in platformMap)) {
    throw new Error(`Unsupported platform: ${platform}`)
  }

  let extra = ''

  /**
   * We need to detect during runtime which libc we're running on to load the correct NAPI.
   * binary.
   *
   * Rationale: The /proc/self/map_files/ subdirectory contains entries corresponding to
   * memory-mapped files loaded by Node.
   * https://man7.org/linux/man-pages/man5/proc.5.html: We detect a musl-based distro by
   * checking if any library contains the name "musl".
   *
   * Prior art: https://github.com/xerial/sqlite-jdbc/issues/623
   */

  const fs = require('fs')
  const path = require('path')

  if (platform === 'linux') {
    extra = '-gnu'

    for (const file of fs.readdirSync("/proc/self/map_files/")) {
      const realPath = fs.readlinkSync(path.join("/proc/self/map_files/", file))
      if (realPath.includes('musl')) {
        extra = '-musl'
        break
      }
    }
  }

  const filename = `./bin/${archMap[arch]}-${platformMap[platform]}${extra}/client.node`
  return require(filename)
})()

export type Context = object // tb_client
export type AccountID = bigint // u128
export type TransferID = bigint // u128
export type Event = Account | Transfer | AccountID | TransferID | AccountFilter
export type Result = CreateAccountsError | CreateTransfersError | Account | Transfer | AccountBalance
export type ResultCallback = (error: Error | null, results: Result[] | null) => void

interface BindingInitArgs {
  cluster_id: bigint, // u128
  concurrency: number, // u32
  replica_addresses: Buffer,
}

interface Binding {
  init: (args: BindingInitArgs) => Context
  submit: (context: Context, operation: Operation, batch: Event[], callback: ResultCallback) => void
  deinit: (context: Context) => void,
}

export interface ClientInitArgs {
  cluster_id: bigint, // u128
  concurrency_max?: number, // u32
  replica_addresses: Array<string | number>,
}

export interface Client {
  createAccounts: (batch: Account[]) => Promise<CreateAccountsError[]>
  createTransfers: (batch: Transfer[]) => Promise<CreateTransfersError[]>
  lookupAccounts: (batch: AccountID[]) => Promise<Account[]>
  lookupTransfers: (batch: TransferID[]) => Promise<Transfer[]>
  getAccountTransfers: (filter: AccountFilter) => Promise<Transfer[]>
  getAccountHistory: (filter: AccountFilter) => Promise<AccountBalance[]>
  destroy: () => void
}

export function createClient (args: ClientInitArgs): Client {
  const concurrency_max_default = 256 // arbitrary
  const context = binding.init({
    cluster_id: args.cluster_id,
    concurrency: args.concurrency_max || concurrency_max_default,
    replica_addresses: Buffer.from(args.replica_addresses.join(',')),
  })

  const request = <T extends Result>(operation: Operation, batch: Event[]): Promise<T[]> => {
    return new Promise((resolve, reject) => {
      try {
        binding.submit(context, operation, batch, (error, result) => {
          if (error) {
            reject(error)
          } else if (result) {
            resolve(result as T[])
          } else {
            throw new Error("UB: Binding invoked callback without error or result")
          }
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  return {
    createAccounts(batch) { return request(Operation.create_accounts, batch) },
    createTransfers(batch) { return request(Operation.create_transfers, batch) },
    lookupAccounts(batch) { return request(Operation.lookup_accounts, batch) },
    lookupTransfers(batch) { return request(Operation.lookup_transfers, batch) },
    getAccountTransfers(filter) { return request(Operation.get_account_transfers, [filter]) },
    getAccountHistory(filter) { return request(Operation.get_account_history, [filter]) },
    destroy() { binding.deinit(context) },
  }
}

let idLastTimestamp = 0;
let idLastBuffer = new DataView(new ArrayBuffer(16));

/**
 * Generates a Universally Unique and Binary Sortable Identifier as a u128 bigint.
 * 
 * @remarks
 * IDs returned are monotonically increasing 
 */
export function createID(): bigint {
  // Ensure timestamp monotonically increases and generate a new random on each new timestamp.
  let timestamp = Date.now()
  if (timestamp <= idLastTimestamp) {
    timestamp = idLastTimestamp
  } else {
    idLastTimestamp = timestamp
    randomFillSync(idLastBuffer)
  }

  // Increment the u80 in idLastBuffer using carry arithmetic on u32s (as JS doesn't have fast u64).
  const littleEndian = true
  const randomLo32 = idLastBuffer.getUint32(0, littleEndian) + 1
  const randomHi32 = idLastBuffer.getUint32(4, littleEndian) + (randomLo32 > 0xFFFFFFFF ? 1 : 0)
  const randomHi16 = idLastBuffer.getUint16(8, littleEndian) + (randomHi32 > 0xFFFFFFFF ? 1 : 0)
  if (randomHi16 > 0xFFFF) {
    throw new Error('random bits overflow on monotonic increment')
  }

  // Store the incremented random monotonic and the timestamp into the buffer.
  idLastBuffer.setUint32(0, randomLo32 & 0xFFFFFFFF, littleEndian)
  idLastBuffer.setUint32(4, randomHi32 & 0xFFFFFFFF, littleEndian)
  idLastBuffer.setUint16(8, randomHi16, littleEndian) // No need to mask since checked above.
  idLastBuffer.setUint16(10, timestamp & 0xFFFF, littleEndian) // timestamp lo.
  idLastBuffer.setUint32(12, (timestamp >>> 16) & 0xFFFFFFFF, littleEndian) // timestamp hi.

  // Then return the buffer's contents as a little-endian u128 bigint.
  const lo = idLastBuffer.getBigUint64(0, littleEndian)
  const hi = idLastBuffer.getBigUint64(8, littleEndian)
  return (hi << 64n) | lo
}
