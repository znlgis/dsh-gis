/**
 * The dataset registry: an in-process catalog with an optional durable home.
 *
 * Two rules shape this class:
 *
 * 1. **Memory is authoritative for the running process.** Every read is
 *    synchronous against the Map, so handlers never wait on storage. A durable
 *    write that fails is logged and swallowed -- losing the ability to survive a
 *    restart is not a reason to lose the dataset for this session.
 * 2. **Storage is optional.** `gis-core` must activate in a profile that never
 *    mounts the storage hub, so the registry starts memory-only and *adopts* a
 *    table when one is opened (see `GisService`). Adopting hydrates what was
 *    stored and flushes what was registered while storage was missing.
 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { toDataset, toStoredDataset, type StoredDataset } from './registry-domain.ts'
import type { Dataset } from './types.ts'

/** Whether ids survive the process. Reported for diagnostics. */
export type PersistenceMode = 'memory' | 'storage'

/** The registry of registered datasets. */
export class DatasetRegistry {
  private readonly datasets = new Map<string, Dataset>()

  private table: KvTable<string, StoredDataset> | undefined

  /**
   * @param warn - sink for non-fatal storage failures; storage is derived data,
   *   so a failure degrades the registry instead of failing the caller.
   */
  constructor(private readonly warn: (message: string) => void) {}

  /** Current backing: `storage` once a domain table was adopted. */
  get persistence(): PersistenceMode {
    return this.table === undefined ? 'memory' : 'storage'
  }

  /**
   * Look one dataset up.
   * @param id - dataset id.
   * @returns the dataset, or `undefined` when this process never saw it.
   */
  resolve(id: string): Dataset | undefined {
    return this.datasets.get(id)
  }

  /**
   * Every dataset this process knows about.
   * @returns a snapshot array.
   */
  list(): readonly Dataset[] {
    return [...this.datasets.values()]
  }

  /**
   * Add or replace one dataset, durably when a table is attached.
   * @param dataset - the dataset to register.
   * @returns resolution after the durable write, if there is storage.
   */
  async register(dataset: Dataset): Promise<void> {
    this.datasets.set(dataset.id, dataset)
    await this.persist(dataset.id)
  }

  /**
   * Drop one dataset, durably when a table is attached.
   * @param id - dataset id.
   * @returns resolution after the durable delete.
   */
  async forget(id: string): Promise<void> {
    this.datasets.delete(id)
    const table = this.table
    if (table === undefined) return
    try {
      await table.delete(id)
    } catch (error) {
      this.warn(`gis-core: stale dataset ${id} survived on the medium: ${String(error)}`)
    }
  }

  /**
   * Adopt an opened domain table: hydrate stored records, then flush anything
   * registered before storage became available.
   * @param table - the opened `datasets` table.
   * @returns resolution after both passes.
   */
  async attach(table: KvTable<string, StoredDataset>): Promise<void> {
    this.table = table
    for (const [key, record] of table.entries()) {
      if (record.id !== key) {
        this.warn(`gis-core: stored dataset record ${key} carries id ${record.id}; ignored`)
        continue
      }
      // An in-process registration is fresher than the medium, so it wins.
      if (!this.datasets.has(key)) this.datasets.set(key, toDataset(record))
    }
    for (const id of [...this.datasets.keys()]) {
      if (table.get(id) === undefined) await this.persist(id)
    }
  }

  /** Forget the attached table. Memory keeps working; writes stop being durable. */
  detach(): void {
    this.table = undefined
  }

  /** Write one in-memory dataset through, if there is anywhere to write it. */
  private async persist(id: string): Promise<void> {
    const table = this.table
    const dataset = this.datasets.get(id)
    if (table === undefined || dataset === undefined) return
    try {
      await table.put(id, toStoredDataset(dataset))
    } catch (error) {
      this.warn(`gis-core: dataset ${id} is registered for this session only: ${String(error)}`)
    }
  }
}
