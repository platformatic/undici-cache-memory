# @platformatic/undici-cache-memory

Memory cache store implementation for the undici cache interceptor, providing efficient in-memory caching of HTTP responses.

[![npm version](https://img.shields.io/npm/v/@platformatic/undici-cache-memory)](https://www.npmjs.com/package/@platformatic/undici-cache-memory)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## Installation

```bash
npm install @platformatic/undici-cache-memory
```

## Usage

```js
const { Client, interceptors } = require('undici')
const MemoryCacheStore = require('@platformatic/undici-cache-memory')

// Create a client with the cache interceptor
const client = new Client('https://example.com')
  .compose(interceptors.cache({
    store: new MemoryCacheStore()
  }))

// Make a request - first request will hit the origin
const response1 = await client.request({
  method: 'GET',
  path: '/'
})

// Second request to the same URL will be served from cache if cacheable
const response2 = await client.request({
  method: 'GET',
  path: '/'
})
```

## Configuration

The `MemoryCacheStore` constructor accepts an options object with the following properties:

```js
const store = new MemoryCacheStore({
  // Maximum number of entries to store (default: 1024)
  maxCount: 1000,
  
  // Maximum total size in bytes (default: 100MB)
  maxSize: 1024 * 1024 * 10, // 10MB
  
  // Maximum size of a single entry in bytes (default: 5MB)
  maxEntrySize: 1024 * 1024, // 1MB
  
  // Header name to parse for cache tags (default: undefined)
  cacheTagsHeader: 'cache-tag'
})
```

## Cache Invalidation

### By Cache Tag

```js
// Create the store with a header to parse for cache tags
const store = new MemoryCacheStore({
  cacheTagsHeader: 'cache-tag'
})

// Add the store to the client
const client = new Client('https://example.com')
  .compose(interceptors.cache({ store }))

// Later, invalidate all cached responses with specific tags
store.deleteTags(['product-123', 'category-456'])
```

### By Request Key

```js
// Invalidate specific paths
store.deleteKeys([
  { origin: 'example.com', path: '/products/123', method: 'GET' },
  { origin: 'example.com', path: '/categories', method: 'GET' }
])

// Or delete a specific entry
store.delete({ origin: 'example.com', path: '/products/123', method: 'GET' })
```

## Advanced Features

This implementation supports:

- Caching based on standard HTTP cache semantics
- Respect for `Vary` headers for content negotiation
- Support for `stale-while-revalidate` and `stale-if-error` directives
- Memory management with configurable limits
- Cache tag-based invalidation for efficient cache purging

## License

Licensed under [Apache-2.0](./LICENSE).