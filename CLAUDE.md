# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository contains `@platformatic/undici-cache-memory`, a memory cache store implementation for the undici cache interceptor. It provides an in-memory caching mechanism for HTTP requests made with undici.

## Commands

### Testing

To run all tests:
```
npm test
```

To run a specific test file:
```
npx borp test/memory-cache-store.test.js
```

The project uses [borp](https://github.com/mcollina/borp) for testing, which is a minimal test runner for Node.js that uses Node.js's built-in test runner.

## Architecture

The main component of this library is the `MemoryCacheStore` class in `index.js`. It implements the cache store interface required by undici's cache interceptor.

### Key Components

1. **MemoryCacheStore**: The main class that provides memory-based caching functionality:
   - Stores responses in memory based on request key (origin, path, method, headers)
   - Supports cache invalidation by key or by cache tags
   - Handles cache entry expiration through `staleAt` and `deleteAt` timestamps
   - Respects cache control directives and vary headers
   - Configurable with max sizes, counts, and entry size limits

2. **Cache Tags**: The store supports invalidating cached entries by tags, which are extracted from a configurable response header.

3. **Memory Management**: The store automatically manages memory usage by:
   - Limiting total entries with `maxCount` (default: 1024)
   - Limiting total size with `maxSize` (default: 100MB)
   - Limiting individual entry size with `maxEntrySize` (default: 5MB)
   - Implementing automatic cleanup by deleting half of entries when limits are exceeded

## Testing

The test suite includes:
- Unit tests for the MemoryCacheStore implementation (`memory-cache-store.test.js`)
- Integration tests with undici's cache interceptor (`interceptor.test.js`)
- Tests for cache invalidation mechanisms
- Tests for stale-while-revalidate and stale-if-error behavior (`stale.test.js`)

### Test Structure

- `cache-store-test-utils.js`: Contains reusable test utilities and shared test cases that validate cache store interface compliance
- Tests use Node.js built-in test runner via borp
- Common pattern: tests import and run `cacheStoreTests()` from test utils to ensure interface compliance

## Key Features

- In-memory HTTP response caching
- Support for cache tags to allow targeted cache invalidation
- Respects HTTP caching semantics (vary headers, ETag, etc.)
- Supports stale-while-revalidate and stale-if-error cache control extensions
- Automatic memory management to prevent unbounded growth