'use strict'

const { describe, test } = require('node:test')
const { deepStrictEqual, notEqual, equal } = require('node:assert')
const { Readable } = require('node:stream')
const { once } = require('node:events')
const MemoryCacheStore = require('../index.js')
const { cacheStoreTests } = require('./cache-store-test-utils.js')

cacheStoreTests(MemoryCacheStore)

describe('MemoryCacheStore defaults', () => {
  test('respects default maxCount limit of 1024', async () => {
    const store = new MemoryCacheStore()
    
    // Add more than 1024 entries using different paths to create distinct entries
    for (let i = 0; i < 1030; i++) {
      const key = { origin: 'example.com', path: `/test-${i}`, method: 'GET', headers: {} }
      const value = {
        statusCode: 200,
        statusMessage: 'OK',
        rawHeaders: [],
        cacheControlDirectives: { 'max-age': 3600 },
        cachedAt: Date.now(),
        staleAt: Date.now() + 3600000,
        deleteAt: Date.now() + 7200000
      }
      
      const result = store.createWriteStream(key, value)
      result.write('test-data')
      result.end()
      await once(result, 'close')
    }
    
    // The store should have cleaned up to stay within limits
    let count = 0
    for (let i = 0; i < 1030; i++) {
      const key = { origin: 'example.com', path: `/test-${i}`, method: 'GET', headers: {} }
      const result = store.get(key)
      if (result) count++
    }
    
    // Should be less than 1024 due to cleanup mechanism
    equal(count <= 1024, true)
  })

  test('respects default maxEntrySize limit of 5MB', async () => {
    const store = new MemoryCacheStore()
    
    const key = { origin: 'example.com', path: '/large', method: 'GET', headers: {} }
    const value = {
      statusCode: 200,
      statusMessage: 'OK',
      rawHeaders: [],
      cacheControlDirectives: { 'max-age': 3600 },
      cachedAt: Date.now(),
      staleAt: Date.now() + 3600000,
      deleteAt: Date.now() + 7200000
    }
    
    const result = store.createWriteStream(key, value)
    
    // Write chunks that will exceed 5MB total
    const chunkSize = 1024 * 1024 // 1MB chunks
    const chunk = 'x'.repeat(chunkSize)
    
    // Write 6 chunks to exceed the 5MB limit
    for (let i = 0; i < 6; i++) {
      result.write(chunk)
    }
    
    result.end()
    await once(result, 'close')
    
    // Entry should not be stored at all due to size limit
    const retrieved = store.get(key)
    equal(retrieved, undefined)
  })
})
