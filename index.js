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

  getRoutes () {
    const cachedRoutes = []

    for (const [origin, originValues] of this.#entries) {
      for (const [path, pathValues] of originValues) {
        for (const [method] of pathValues) {
          const url = new URL(path, origin).href
          cachedRoutes.push({ method, url })
        }
      }
    }

    return cachedRoutes
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
          rawHeaders: entry.rawHeaders,
          body: entry.body,
          etag: entry.etag,
          cacheTags: entry.cacheTags,
          cachedAt: entry.cachedAt,
          staleAt: entry.staleAt,
          deleteAt: entry.deleteAt
        }
  }

  createWriteStream (key, val) {
    if (typeof key !== 'object') {
      throw new TypeError(`expected key to be object, got ${typeof key}`)
    }
    if (typeof val !== 'object') {
      throw new TypeError(`expected value to be object, got ${typeof val}`)
    }

    const cacheTags = this.#parseCacheTags(val.rawHeaders)
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

    const originValues = this.#entries.get(key.origin)
    if (!originValues) return

    const pathValues = originValues.get(key.path)
    if (!pathValues) return

    for (const entries of pathValues.values()) {
      for (const entry of entries) {
        this.#deleteEntry(key, entry)
      }
    }

    originValues.delete(key.path)
  }

  deleteRoutes (routes) {
    for (const { method, url } of routes) {
      const { origin, pathname, search, hash } = new URL(url)
      const path = `${pathname}${search}${hash}`
      this.#deleteByKey({ origin, path, method })
    }
  }

  deleteByCacheTags (origin, cacheTags) {
    const originTags = this.#tags.get(origin)
    if (!originTags) return

    const originValues = this.#entries.get(origin)
    if (!originValues) return

    for (const cacheTag of cacheTags) {
      const cacheKeys = originTags.get(cacheTag)
      if (!cacheKeys) continue

      for (const cacheKey of cacheKeys) {
        const [path, method] = cacheKey.split(':')
        this.#deleteByKey({ origin, path, method })
      }

      originTags.delete(cacheTag)
    }
  }

  #saveEntry (key, entry) {
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

  #parseCacheTags (rawHeaders) {
    if (!this.#cacheTagsHeader) {
      return []
    }

    for (let i = 0; i < rawHeaders.length; i += 2) {
      const headerName = rawHeaders[i].toString().toLowerCase()
      if (headerName !== this.#cacheTagsHeader) continue

      const headerValue = rawHeaders[i + 1].toString()
      return headerValue.split(',')
    }

    return []
  }

  #saveCacheTags (key, cacheTags) {
    if (cacheTags.length === 0) return

    let originTags = this.#tags.get(key.origin)
    if (!originTags) {
      originTags = new Map()
      this.#tags.set(key.origin, originTags)
    }

    for (const cacheTag of cacheTags) {
      let tagPaths = originTags.get(cacheTag)
      if (!tagPaths) {
        tagPaths = new Set()
        originTags.set(cacheTag, tagPaths)
      }
      tagPaths.add(`${key.path}:${key.method}`)
    }
  }

  #deleteHalf () {
    for (const [origin, originValues] of this.#entries) {
      for (const [path, pathValues] of originValues) {
        for (const [method, entries] of pathValues) {
          for (const entry of entries.splice(0, entries.length / 2)) {
            this.#deleteEntry({ origin, path, method }, entry)
          }
          if (entries.length === 0) {
            entries.delete(key)
          }
        }
        if (pathValues.length === 0) {
          pathValues.delete(key)
        }
      }
      if (originValues.length === 0) {
        originValues.delete(key)
      }
    }
  }

  #deleteByKey (key) {
    const originValues = this.#entries.get(key.origin)
    if (!originValues) return

    const pathValues = originValues.get(key.path)
    if (!pathValues) return

    const entries = pathValues.get(key.method)
    if (!entries) return

    for (const entry of entries) {
      this.#deleteEntry(key, entry)
    }

    pathValues.delete(key.method)

    if (pathValues.size === 0) {
      originValues.delete(key.path)
    }
  }

  #deleteEntry (key, entry) {
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
