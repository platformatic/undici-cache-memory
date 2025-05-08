'use strict'

const { describe, test } = require('node:test')
const { deepStrictEqual, notEqual, equal } = require('node:assert')
const { Readable } = require('node:stream')
const { once } = require('node:events')
const MemoryCacheStore = require('../index.js')
const { cacheStoreTests } = require('./cache-store-test-utils.js')

cacheStoreTests(MemoryCacheStore)
