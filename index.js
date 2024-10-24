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

const { Writable, Readable } = require('node:stream')

class MemoryCacheStore {
  #maxEntries = Infinity
  #maxEntrySize = Infinity
  #errorCallback = undefined
  #cacheTagsHeader = undefined
  #entryCount = 0
  #data = new Map()
  #tags = new Map()

  constructor (opts) {
    if (opts) {
      if (typeof opts !== 'object') {
        throw new TypeError('MemoryCacheStore options must be an object')
      }

      if (opts.maxEntries !== undefined) {
        if (
          typeof opts.maxEntries !== 'number' ||
          !Number.isInteger(opts.maxEntries) ||
          opts.maxEntries < 0
        ) {
          throw new TypeError('MemoryCacheStore options.maxEntries must be a non-negative integer')
        }
        this.#maxEntries = opts.maxEntries
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

      if (opts.errorCallback !== undefined) {
        if (typeof opts.errorCallback !== 'function') {
          throw new TypeError('MemoryCacheStore options.errorCallback must be a function')
        }
        this.#errorCallback = opts.errorCallback
      }

      if (typeof opts.cacheTagsHeader === 'string') {
        this.#cacheTagsHeader = opts.cacheTagsHeader.toLowerCase()
      }
    }
  }

  get isFull () {
    return this.#entryCount >= this.#maxEntries
  }

  getRoutes () {
    const cachedRoutes = []

    for (const origin of this.#data.keys()) {
      const originPaths = this.#data.get(origin)
      if (!originPaths) continue
  
      for (const cachedValue of originPaths.keys()) {
        const [path, method] = cachedValue.split(':')
        const url = new URL(path, origin).href
        cachedRoutes.push({ method, url })
      }
    }

    return cachedRoutes
  }

  createReadStream (req) {
    if (typeof req !== 'object') {
      throw new TypeError(`expected req to be object, got ${typeof req}`)
    }

    const values = this.#getValuesForRequest(req, false)
    if (!values) {
      return undefined
    }

    const value = this.#findValue(req, values)

    if (!value || value.readLock) {
      return undefined
    }

    return new MemoryStoreReadableStream(value)
  }

  createWriteStream (req, opts) {
    if (typeof req !== 'object') {
      throw new TypeError(`expected req to be object, got ${typeof req}`)
    }
    if (typeof opts !== 'object') {
      throw new TypeError(`expected value to be object, got ${typeof opts}`)
    }

    if (this.isFull) {
      return undefined
    }

    const cacheTags = this.#parseCacheTags(opts.rawHeaders)
    this.#saveCacheTags(req, cacheTags)

    opts.cacheTags = cacheTags

    const values = this.#getValuesForRequest(req, true)

    let value = this.#findValue(req, values)
    if (!value) {
      // The value doesn't already exist, meaning we haven't cached this
      //  response before. Let's assign it a value and insert it into our data
      //  property.

      if (this.isFull) {
        // Or not, we don't have space to add another response
        return undefined
      }

      this.#entryCount++

      value = {
        readers: 0,
        readLock: false,
        writeLock: false,
        opts,
        body: []
      }

      // We want to sort our responses in decending order by their deleteAt
      //  timestamps so that deleting expired responses is faster
      if (
        values.length === 0 ||
        opts.deleteAt < values[values.length - 1].deleteAt
      ) {
        // Our value is either the only response for this path or our deleteAt
        //  time is sooner than all the other responses
        values.push(value)
      } else if (opts.deleteAt >= values[0].deleteAt) {
        // Our deleteAt is later than everyone elses
        values.unshift(value)
      } else {
        // We're neither in the front or the end, let's just binary search to
        //  find our stop we need to be in
        let startIndex = 0
        let endIndex = values.length
        while (true) {
          if (startIndex === endIndex) {
            values.splice(startIndex, 0, value)
            break
          }

          const middleIndex = Math.floor((startIndex + endIndex) / 2)
          const middleValue = values[middleIndex]
          if (opts.deleteAt === middleIndex) {
            values.splice(middleIndex, 0, value)
            break
          } else if (opts.deleteAt > middleValue.opts.deleteAt) {
            endIndex = middleIndex
            continue
          } else {
            startIndex = middleIndex
            continue
          }
        }
      }
    } else {
      // Check if there's already another request writing to the value or
      //  a request reading from it
      if (value.writeLock || value.readLock) {
        return undefined
      }

      // Empty it so we can overwrite it
      value.body = []
    }

    const writable = new MemoryStoreWritableStream(
      value,
      this.#maxEntrySize
    )

    // Remove the value if there was some error
    writable.on('error', (err) => {
      values.filter(current => value !== current)
      if (this.#errorCallback) {
        this.#errorCallback(err)
      }
    })

    writable.on('bodyOversized', () => {
      values.filter(current => value !== current)
    })

    return writable
  }

  deleteByOrigin (origin) {
    this.#data.delete(origin)
    this.#tags.delete(origin)
  }

  deleteRoutes (origin, routes) {
    const originRoutes = this.#data.get(origin)
    if (!originRoutes) return

    for (const { method, path } of routes) {
      const cacheKey = `${path}:${method}`
      const cacheValues = originRoutes.get(cacheKey)
      if (!cacheValues || cacheValues.length === 0) continue

      for (const cacheValue of cacheValues) {
        const cacheTags = cacheValue.opts.cacheTags
        if (cacheTags && cacheTags.length > 0) {
          this.#unlinkRouteFromCacheTag(origin, cacheTags, cacheKey)
        }
      }

      originRoutes.delete(cacheKey)
    }
  }

  deleteByCacheTags (origin, cacheTags) {
    const originTags = this.#tags.get(origin)
    if (!originTags) return

    const originRoutes = this.#data.get(origin)
    if (!originRoutes) return

    for (const cacheTag of cacheTags) {
      const cacheKeys = originTags.get(cacheTag)
      if (!cacheKeys) continue

      for (const cacheKey of cacheKeys) {
        originRoutes.delete(cacheKey)
      }

      originTags.delete(cacheTag)
    }
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

  #unlinkRouteFromCacheTag (origin, cacheTags, cacheKey) {
    const originTags = this.#tags.get(origin)
    if (!originTags) return

    for (const cacheTag of cacheTags) {
      const cacheKeys = originTags.get(cacheTag)
      if (!cacheKeys) continue

      cacheKeys.delete(cacheKey)

      if (cacheKeys.size === 0) {
        originTags.delete(cacheTag)
      }
    }
  }

  #getValuesForRequest (req, makeIfDoesntExist) {
    // https://www.rfc-editor.org/rfc/rfc9111.html#section-2-3
    let cachedPaths = this.#data.get(req.origin)
    if (!cachedPaths) {
      if (!makeIfDoesntExist) {
        return undefined
      }

      cachedPaths = new Map()
      this.#data.set(req.origin, cachedPaths)
    }

    let values = cachedPaths.get(`${req.path}:${req.method}`)
    if (!values && makeIfDoesntExist) {
      values = []
      cachedPaths.set(`${req.path}:${req.method}`, values)
    }

    return values
  }

  #saveCacheTags (req, cacheTags) {
    if (cacheTags.length === 0) return

    let originTags = this.#tags.get(req.origin)
    if (!originTags) {
      originTags = new Map()
      this.#tags.set(req.origin, originTags)
    }

    for (const cacheTag of cacheTags) {
      let tagPaths = originTags.get(cacheTag)
      if (!tagPaths) {
        tagPaths = new Set()
        originTags.set(cacheTag, tagPaths)
      }
      tagPaths.add(`${req.path}:${req.method}`)
    }
  }

  #findValue (req, values) {
    /**
     * @type {MemoryStoreValue}
     */
    let value
    const now = Date.now()
    for (let i = values.length - 1; i >= 0; i--) {
      const current = values[i]
      const currentCacheValue = current.opts
      if (now >= currentCacheValue.deleteAt) {
        const cacheTags = currentCacheValue.cacheTags
        if (cacheTags) {
          const cacheKey = `${req.path}:${req.method}`
          this.#unlinkRouteFromCacheTag(req.origin, cacheTags, cacheKey)
        }

        // We've reached expired values, let's delete them
        this.#entryCount -= values.length - i
        values.length = i
        break
      }

      let matches = true

      if (currentCacheValue.vary) {
        if (!req.headers) {
          matches = false
          break
        }

        for (const key in currentCacheValue.vary) {
          if (currentCacheValue.vary[key] !== req.headers[key]) {
            matches = false
            break
          }
        }
      }

      if (matches) {
        value = current
        break
      }
    }

    return value
  }
}

class MemoryStoreReadableStream extends Readable {
  #value
  #chunksToSend = []

  constructor (value) {
    super()

    if (value.readLock) {
      throw new Error('can\'t read a locked value')
    }

    this.#value = value
    this.#chunksToSend = value?.body ? [...value.body, null] : [null]

    this.#value.readers++
    this.#value.writeLock = true

    this.on('close', () => {
      this.#value.readers--

      if (this.#value.readers === 0) {
        this.#value.writeLock = false
      }
    })
  }

  get value () {
    return this.#value.opts
  }

  _read (size) {
    if (this.#chunksToSend.length === 0) {
      throw new Error('no chunks left to read, stream should have closed')
    }

    if (size > this.#chunksToSend.length) {
      size = this.#chunksToSend.length
    }

    for (let i = 0; i < size; i++) {
      this.push(this.#chunksToSend.shift())
    }
  }
}

class MemoryStoreWritableStream extends Writable {
  #value
  #currentSize = 0
  #maxEntrySize = 0
  #body = []

  constructor (value, maxEntrySize) {
    super()
    this.#value = value
    this.#value.readLock = true
    this.#maxEntrySize = maxEntrySize ?? Infinity
  }

  get rawTrailers () {
    return this.#value.opts.rawTrailers
  }

  set rawTrailers (trailers) {
    this.#value.opts.rawTrailers = trailers
  }

  _write (chunk, encoding, callback) {
    if (typeof chunk === 'string') {
      chunk = Buffer.from(chunk, encoding)
    }

    this.#currentSize += chunk.byteLength
    if (this.#currentSize < this.#maxEntrySize) {
      this.#body.push(chunk)
    } else {
      this.#body = null // release memory as early as possible
      this.emit('bodyOversized')
    }

    callback()
  }

  _final (callback) {
    if (this.#currentSize < this.#maxEntrySize) {
      this.#value.readLock = false
      this.#value.body = this.#body
    }

    callback()
  }
}

module.exports = MemoryCacheStore
