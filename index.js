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

const { Writable } = require('node:stream')

class MemoryCacheStore {
  #maxCount = Infinity
  #maxSize = Infinity
  #maxEntrySize = Infinity
  #cacheTagsHeader = undefined

  #size = 0
  #count = 0
  #entries = new Map()
  #tags = new Map()

  constructor (opts) {
    if (opts) {
      if (typeof opts !== 'object') {
        throw new TypeError('MemoryCacheStore options must be an object')
      }

      if (opts.maxCount !== undefined) {
        if (
          typeof opts.maxCount !== 'number' ||
          !Number.isInteger(opts.maxCount) ||
          opts.maxCount < 0
        ) {
          throw new TypeError('MemoryCacheStore options.maxCount must be a non-negative integer')
        }
        this.#maxCount = opts.maxCount
      }

      if (opts.maxSize !== undefined) {
        if (
          typeof opts.maxSize !== 'number' ||
          !Number.isInteger(opts.maxSize) ||
          opts.maxSize < 0
        ) {
          throw new TypeError('MemoryCacheStore options.maxSize must be a non-negative integer')
        }
        this.#maxSize = opts.maxSize
      }

      if (opts.maxEntrySize !== undefined) {
        if (
          typeof opts.maxEntrySize !== 'number' ||
          !Number.isInteger(opts.maxEntrySize) ||
          opts.maxEntrySize < 0
        ) {
          throw new TypeError('MemoryCacheStore options.maxEntrySize must be a non-negative integer')
        }
        this.#maxEntrySize = opts.maxEntrySize
      }

      if (typeof opts.cacheTagsHeader === 'string') {
        this.#cacheTagsHeader = opts.cacheTagsHeader.toLowerCase()
      }
    }
  }

  get (key) {
    if (typeof key !== 'object') {
      throw new TypeError(`expected key to be object, got ${typeof key}`)
    }

    const entries = this.#getEntries(key)
    if (!entries) return undefined

    const now = Date.now()
    const entry = entries.find((entry) => (
      entry.deleteAt > now &&
      (entry.vary == null || Object.keys(entry.vary).every(headerName => entry.vary[headerName] === key.headers?.[headerName]))
    ))

    return entry == null
      ? undefined
      : {
        statusMessage: entry.statusMessage,
        statusCode: entry.statusCode,
        headers: entry.headers,
        body: entry.body,
        etag: entry.etag,
        cacheTags: entry.cacheTags,
        cachedAt: entry.cachedAt,
        staleAt: entry.staleAt,
        deleteAt: entry.deleteAt,
        cacheControlDirectives: entry.cacheControlDirectives
      }
  }

  createWriteStream (key, val) {
    if (typeof key !== 'object') {
      throw new TypeError(`expected key to be object, got ${typeof key}`)
    }
    if (typeof val !== 'object') {
      throw new TypeError(`expected value to be object, got ${typeof val}`)
    }

    const cacheTags = this.#parseCacheTags(val.headers)
    this.#saveCacheTags(key, cacheTags)

    const store = this
    const entry = { ...key, ...val, cacheTags, body: [], size: 0 }

    return new Writable({
      write (chunk, encoding, callback) {
        if (typeof chunk === 'string') {
          chunk = Buffer.from(chunk, encoding)
        }

        entry.size += chunk.byteLength

        if (entry.size >= store.#maxEntrySize) {
          this.destroy()
        } else {
          entry.body.push(chunk)
        }

        callback(null)
      },
      final (callback) {
        store.#saveEntry(key, entry)
        callback(null)
      }
    })
  }

  delete (key) {
    if (typeof key !== 'object') {
      throw new TypeError(`expected key to be object, got ${typeof key}`)
    }
    this.#deleteByKey(key, { deleteAllMethods: true })
  }

  deleteKeys (keys) {
    for (const key of keys) {
      if (key.origin === undefined) {
        throw new TypeError('key.origin must be defined')
      }
      if (key.path === undefined) {
        throw new TypeError('key.path must be defined')
      }
      this.#deleteByKey(key)
    }
  }

  deleteTags (tags) {
    for (const tag of tags) {
      this.#deleteByTag(tag)
    }
  }

  #saveEntry (key, entry) {
    const existingEntry = this.get(key)
    if (existingEntry) {
      this.#deleteEntry(key, existingEntry)
    }

    let originValues = this.#entries.get(key.origin)
    if (!originValues) {
      originValues = new Map()
      this.#entries.set(key.origin, originValues)
    }

    let pathValues = originValues.get(key.path)
    if (!pathValues) {
      pathValues = new Map()
      originValues.set(key.path, pathValues)
    }

    let entries = pathValues.get(key.method)
    if (!entries) {
      entries = []
      pathValues.set(key.method, entries)
    }

    entries.push(entry)

    this.#size += entry.size
    this.#count += 1

    if (this.#size > this.#maxSize || this.#count > this.#maxCount) {
      this.#deleteHalf()
    }
  }

  #getEntries (key) {
    const originValues = this.#entries.get(key.origin)
    if (!originValues) return undefined

    const pathValues = originValues.get(key.path)
    if (!pathValues) return undefined

    return pathValues.get(key.method)
  }

  #parseCacheTags (headers) {
    if (!this.#cacheTagsHeader) {
      return []
    }

    for (const [header, headerValue] of Object.entries(headers)) {
      const headerName = header.toLowerCase()
      if (headerName !== this.#cacheTagsHeader) continue

      return headerValue.toString().split(',')
    }

    return []
  }

  #saveCacheTags (key, cacheTags) {
    if (cacheTags.length === 0) return

    for (const cacheTag of cacheTags) {
      let tagPaths = this.#tags.get(cacheTag)
      if (!tagPaths) {
        tagPaths = new Set()
        this.#tags.set(cacheTag, tagPaths)
      }
      tagPaths.add(
        `${encodeURIComponent(key.origin)}:` +
        `${encodeURIComponent(key.path)}:` +
        `${encodeURIComponent(key.method)}`
      )
    }
  }

  #deleteByTag (cacheTag) {
    const cacheKeys = this.#tags.get(cacheTag)
    if (!cacheKeys) return

    for (const cacheKey of cacheKeys) {
      const [origin, path, method] = cacheKey.split(':')
        .map(decodeURIComponent)
      this.#deleteByKey({ origin, path, method })
    }

    this.#tags.delete(cacheTag)
  }

  #deleteHalf () {
    for (const [origin, originValues] of this.#entries) {
      for (const [path, pathValues] of originValues) {
        for (const [method, entries] of pathValues) {
          for (let i = 0; i < entries.length / 2; i++) {
            this.#deleteEntry({ origin, path, method }, entries[i])
          }
        }
      }
    }
  }

  #deleteByKey (key, opts = {}) {
    const deleteAllMethods = opts.deleteAllMethods ?? false

    const originValues = this.#entries.get(key.origin)
    if (!originValues) return

    const pathValues = originValues.get(key.path)
    if (!pathValues) return

    let entries = []
    if (deleteAllMethods || key.method === undefined) {
      for (const methodEntries of pathValues.values()) {
        entries.push(...methodEntries)
      }
    } else {
      entries = pathValues.get(key.method)
    }

    if (!entries || entries.length === 0) return

    for (const entry of entries) {
      this.#deleteEntry(key, entry)
      if (entry.cacheTags) {
        this.deleteTags(entry.cacheTags)
      }
    }
  }

  #deleteEntry (key, entry) {
    const originValues = this.#entries.get(key.origin)
    if (!originValues) return

    const pathValues = originValues.get(key.path)
    if (!pathValues) return

    const entries = pathValues.get(key.method)
    if (!entries) return

    const index = entries.indexOf(entry)
    if (index === -1) return

    entries.splice(index, 1)

    this.#size -= entry.size
    this.#count -= 1

    this.#unlinkRouteFromCacheTag(key, entry.cacheTags)
  }

  #unlinkRouteFromCacheTag (key, cacheTags) {
    const originTags = this.#tags.get(key.origin)
    if (!originTags) return

    const cacheKey = `${key.path}:${key.method}`

    for (const cacheTag of cacheTags) {
      const cacheKeys = originTags.get(cacheTag)
      if (!cacheKeys) continue

      cacheKeys.delete(cacheKey)

      if (cacheKeys.size === 0) {
        originTags.delete(cacheTag)
      }
    }
  }
}

module.exports = MemoryCacheStore
