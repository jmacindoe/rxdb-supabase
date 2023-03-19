import { addRxPlugin, createRxDatabase, RxCollection, RxConflictHandler, RxConflictHandlerInput, RxDatabase, RxError, WithDeleted } from "rxdb";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { RxReplicationState } from "rxdb/plugins/replication";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SupabaseReplication, SupabaseReplicationCheckpoint, SupabaseReplicationOptions } from "../supabase-replication";
import { Human, HumanRow, HUMAN_SCHEMA } from "./test-types.js";
import { SupabaseBackendMock } from "./supabase-backend-mock.js";

describe.skipIf(process.env.TEST_SUPABASE_URL)("replicateSupabase", () => {
  let supabaseMock: SupabaseBackendMock
  let db: RxDatabase
  let collection: RxCollection<Human>

  beforeAll(() => {
    addRxPlugin(RxDBDevModePlugin);
  })

  beforeEach(async () => {
    // Create an in-memory RxDB database.
    db = await createRxDatabase({name: 'test', storage: getRxStorageMemory(), ignoreDuplicate: true});
    collection = (await db.addCollections({
      humans: { schema: HUMAN_SCHEMA },
    }))['humans']

    // Supabase client with mocked HTTP.
    supabaseMock = new SupabaseBackendMock()
  })

  describe("initial pull", () => {
    describe("without initial checkpoint", () => {
      it("pulls all rows from supabase", async () => {
        expectPull().thenReturn(createHumans(1))
        await replication()

        expect(await rxdbContents()).toEqual([
          {id: '1', name: 'Human 1', age: 11}
        ])
      })
    })

    describe("with previous checkpoint", () => {
      it("pulls only modified rows", async () => {
        let checkpoint: SupabaseReplicationCheckpoint = {
          modified: 'timestamp',
          primaryKeyValue: 'pkv'
        }
        expectPull(checkpoint).thenReturn(createHumans(1))
        await replication({pull: {initialCheckpoint: checkpoint}})

        expect(await rxdbContents()).toEqual([
          {id: '1', name: 'Human 1', age: 11}
        ])  
      })
    })

    describe("with zero rows", () => {
      it("pulls no rows", async () => {
        expectPull().thenReturn([])
        await replication()

        expect(await rxdbContents()).toEqual([])  
      })
    })

    describe("with many rows", () => {
      it("pulls in batches", async () => {
        const expectedCheckpoint = (id: number): SupabaseReplicationCheckpoint => {
          return {
            modified: createHuman(id)._modified,
            primaryKeyValue: createHuman(id).id
          }
        } 

        // Expect three queries
        const BATCH_SIZE = 13
        const humans = createHumans(BATCH_SIZE * 2 + 3)
        expectPull(undefined, BATCH_SIZE).thenReturn(humans.slice(0, BATCH_SIZE))
        expectPull(expectedCheckpoint(BATCH_SIZE), BATCH_SIZE).thenReturn(humans.slice(BATCH_SIZE, BATCH_SIZE * 2))
        expectPull(expectedCheckpoint(BATCH_SIZE * 2), BATCH_SIZE).thenReturn(humans.slice(BATCH_SIZE * 2))

        await replication({pull: {batchSize: BATCH_SIZE}})

        expect(await rxdbContents()).toHaveLength(humans.length)
      })
    })

    describe("with query failing", () => {
      it.skip("retries automatically", async () => {
        // TODO
      })
    })

    describe("with deletion", () => {
      it.skip("deletes row locally", async () => {
        // TODO
      })
    })

    describe("with deletion and custom _delete field name", () => {
      it.skip("deletes row locally", async () => {
        // TODO
      })
    })

    // TODO: Test custom modified field
  })

  describe('with client-side insertion', () => {
    describe('with single insertion', () => {
      it('inserts row to supabase', async () => {
        await collection.insert({id: '1', name: 'Alice', age: null})
        expectPull().thenReturn([])
        expectInsert('{"id":"1","name":"Alice","age":null,"_deleted":false}').thenReturn()

        await replication()
      })
    })

    describe('with multiple insertions', () => {
      it('triggers multiple INSERT calls', async () => {
        // TODO: Batch insertion would be nice in this case.
        await collection.insert({id: '1', name: 'Alice', age: null})
        await collection.insert({id: '2', name: 'Bob', age: 42})
        expectPull().thenReturn([])
        expectInsert('{"id":"1","name":"Alice","age":null,"_deleted":false}').thenReturn()
        expectInsert('{"id":"2","name":"Bob","age":42,"_deleted":false}').thenReturn()

        await replication()
      })
    })

    describe('with custom _delete field', () => {
      it('uses specified field', async () => {
        await collection.insert({id: '1', name: 'Alice', age: null})
        expectPull().thenReturn([])
        expectInsert('{"id":"1","name":"Alice","age":null,"removed":false}').thenReturn()

        await replication({deletedField: 'removed'})
      })
    })

    describe('with network error', () => {
      it('automatically retries', async () => {
        await collection.insert({id: '1', name: 'Alice', age: null})
        expectPull().thenReturn([])
        expectInsert('{"id":"1","name":"Alice","age":null,"_deleted":false}').thenFail()
        expectInsert('{"id":"1","name":"Alice","age":null,"_deleted":false}').thenReturn()

        const errors = await replication({retryTime: 10}, async () => {}, true)
        expect(errors).toHaveLength(1)
      })
    })

    describe('with postgres error', () => {
      it('automatically retries', async () => {
        // TODO
      })
    })

    describe('with duplicate key error', () => {
      it('fetches current state and invokes conflict handler ', async () => {
        // TODO
      })
    })

  })

  // TODO: test for escaping of search params

  describe('with client-side update', () => {
    describe('without conflict', () => {
      it('performs UPDATE with equality checks', async () => {
        await collection.insert({id: '1', name: 'Alice', age: null})
        expectPull().thenReturn([])
        expectInsert('{"id":"1","name":"Alice","age":null,"_deleted":false}').thenReturn()

        await replication({}, async (replication) => {
          supabaseMock.expectQuery('UPDATE Alice', {
            table: 'humans',
            body: '{"id":"1","name":"Alice 2","age":42,"_deleted":false}',
            params: 'id=eq.%221%22&name=eq.%22Alice%22&age=is.null&_deleted=is.false',
            method: 'PATCH'
          }).thenReturn({}, {'Content-Range': '0-1/1'})  // TODO: Not sure this is the correct header result
          await collection.upsert({id: '1', name: 'Alice 2', age: 42})
        })

        expect(await rxdbContents()).toEqual([
          {id: '1', name: 'Alice 2', age: 42}
        ])
      })
    })
  })


  /*
  TODO
  - with client-side update
    - checks for equalty
    - throws on JSON types
    - invokes conflict handler
    - uses custom updateHandler
    - query error
  - with client-side delete
    - updates field
    - updates custom field
  - with live pull
    - ...

  */


  /**
   * Run the given callback while a replication is running. Also returns all errors
   * that happened during the replication, and throws in case expectErrors is false.
   */
  // TODO: Move this into a utility file
  let replication = (options: Partial<SupabaseReplicationOptions<Human>> = {}, 
                    callback: (state: RxReplicationState<Human, SupabaseReplicationCheckpoint>) => Promise<void> = async() => {},
                    expectErrors: boolean = false): Promise<Error[]> => {
    return new Promise(async (resolve, reject) => {
      const errors: Error[] = []
      const state = startReplication(options)
      state.error$.subscribe(error => {
        if (expectErrors) {
          errors.push(error)
        } else {
          console.error("Replication emitted an unexpected error:", error)
          reject(error.rxdb ? error.parameters.errors![0] : error)
        }
      })
      await state.awaitInitialReplication()
      await callback(state)
      await state.awaitInSync()
      await state.cancel()
      resolve(errors)
    })
  }

  let startReplication = (options: Partial<SupabaseReplicationOptions<Human>> = {}): RxReplicationState<Human, SupabaseReplicationCheckpoint> => {
    return new SupabaseReplication({
      replicationIdentifier: 'test',
      supabaseClient: supabaseMock.client,
      collection,
      pull: {},
      push: {},
      // TODO: disable live repl
      ...options
    })
  }

  let expectPull = (checkpoint?: SupabaseReplicationCheckpoint, limit: number = 100, primaryKey: string = '', modifiedField: string = '_modified') => {
    // TODO: should be allowing for equal timestamp and have inequality for primary key.
    // TODO: test double quotes inside a search string
    const filter = checkpoint ? `&${modifiedField}=gt.%22${checkpoint.modified}%22` : ''
    return supabaseMock.expectQuery(`Pull query with checkpoint ${checkpoint?.modified}`, {
      table: 'humans', 
      params: `select=*${filter}&order=_modified.asc%2Cid.asc&limit=${limit}`
    })
  }

  let expectInsert = (body: string) => {
    return supabaseMock.expectInsert('humans', body)
  }

  // TODO: move to utility file
  let resolveConflictWithName = <T>(name: string): RxConflictHandler<T> => {
    return async (input: RxConflictHandlerInput<T>) => {
      return {
        isEqual: false,
        documentData: {...input.newDocumentState, name}
      }
    }
  }

  let rxdbContents = async (): Promise<Human[]> => {
    const results = await collection.find().exec()
    return results.map(doc => doc.toJSON())
  }

  let createHumans = (count: number) => {
    return Array.from(Array(count).keys()).map(id => createHuman(id + 1))
  }

  let createHuman = (id: number): HumanRow => {
    return {
      id: id.toString(),
      name: `Human ${id}`,
      age: id % 2 == 0 ? null : id * 11,
      _deleted: false,
      _modified: '2023-' + id
    }
  }

  afterEach(async () => {
    supabaseMock.verifyNoMoreQueriesExpected()
    await db.remove()
  })  
})
