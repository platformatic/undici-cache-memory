/*
Copyright Platformatic. All rights reserved.
Copyright (c) Matteo Collina and Undici contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
*/

'use strict'

const { describe, test, after } = require('node:test')
const { strictEqual } = require('node:assert')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { Client, interceptors } = require('undici')
const MemoryCacheStore = require('../index.js')

describe('Cache Interceptor', () => {
  test('caches request successfully', async () => {
    let requestsToOrigin = 0

    const server = createServer((_, res) => {
      requestsToOrigin++
      res.setHeader('cache-control', 'public, s-maxage=10')
      res.end('asd')
    }).listen(0)

    const client = new Client(`http://localhost:${server.address().port}`)
      .compose(interceptors.cache({
        store: new MemoryCacheStore()
      }))

    after(async () => {
      server.close()
      await client.close()
    })

    await once(server, 'listening')

    strictEqual(requestsToOrigin, 0)

    // Send initial request. This should reach the origin
    let response = await client.request({
      origin: 'localhost',
      method: 'GET',
      path: '/'
    })
    strictEqual(requestsToOrigin, 1)
    strictEqual(await response.body.text(), 'asd')

    // Send second request that should be handled by cache
    response = await client.request({
      origin: 'localhost',
      method: 'GET',
      path: '/'
    })
    strictEqual(requestsToOrigin, 1)
    strictEqual(await response.body.text(), 'asd')
    strictEqual(response.headers.age, '0')
  })

  test('invalidates response by cache tag', async () => {
    let requestsToOrigin = 0

    const cacheTag = 'test-cache-tag-value-42'
    const server = createServer((_, res) => {
      requestsToOrigin++
      res.setHeader('cache-control', 'public, s-maxage=10')
      res.setHeader('cache-tag', cacheTag)
      res.end('asd')
    }).listen(0)

    after(() => server.close())
    await once(server, 'listening')

    const cacheStore = new MemoryCacheStore({
      cacheTagHeader: 'cache-tag'
    })
  
    const client = new Client(`http://localhost:${server.address().port}`)
      .compose(interceptors.cache({ store: cacheStore }))

    strictEqual(requestsToOrigin, 0)

    // Send initial request. This should reach the origin
    let response = await client.request({
      origin: 'localhost',
      method: 'GET',
      path: '/'
    })
    strictEqual(requestsToOrigin, 1)
    strictEqual(await response.body.text(), 'asd')

    // Send second request that should be handled by cache
    response = await client.request({
      origin: 'localhost',
      method: 'GET',
      path: '/'
    })
    strictEqual(requestsToOrigin, 1)
    strictEqual(await response.body.text(), 'asd')
    strictEqual(response.headers.age, '0')

    await cacheStore.deleteByCacheTags('localhost', [cacheTag])

    // Send third request that should reach the origin again
    response = await client.request({
      origin: 'localhost',
      method: 'GET',
      path: '/'
    })
    strictEqual(requestsToOrigin, 2)
    strictEqual(await response.body.text(), 'asd')
  })
})
