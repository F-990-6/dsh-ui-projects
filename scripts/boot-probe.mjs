/**
 * Boot the client bundle once, with a deadline, and report where it stops.
 *
 * The suite runs dozens of boots and prints as it goes; when it stalls before the first line
 * there is nothing to read. This runs ONE boot with a wall-clock deadline and says which step
 * did not return, which is the only way to tell a hang from a slow assertion.
 *
 * Usage: node scripts/boot-probe.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

const deadline = (label, ms = 5000) =>
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`timed out: ${label}`)), ms))

const source = await readFile(join(packageRoot, 'lib', 'client.js'), 'utf8')
const react = (await import('react')).default

/** The bundle registers itself through this facade, exactly as the shell's loader does. */
let factory
const sandbox = {
  window: {},
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  getComputedStyle: () => ({
    display: 'block',
    gridTemplateColumns: 'none',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    backdropFilter: 'none',
    position: 'static',
    getPropertyValue: () => '',
  }),
  __ModuleLoader__: {
    load(record) {
      factory = record.factory
    },
  },
}
sandbox.window.__ModuleLoader__ = sandbox.__ModuleLoader__
sandbox.globalThis = sandbox

const context = vm.createContext(sandbox)
process.stdout.write('1. evaluating the bundle…\n')
vm.runInContext(source, context, { filename: 'client.js' })
process.stdout.write(`   factory: ${typeof factory}\n`)

process.stdout.write('2. materialising the entry…\n')
const entry = factory((spec) => {
  if (spec === 'react') return react
  throw new Error(`module-table miss: ${spec}`)
})
process.stdout.write(`   entry: ${typeof entry}\napply: ${typeof entry?.apply}\n`)

process.stdout.write('3. calling apply()…\n')
const effects = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  get: () => undefined,
  inject: (deps, callback) => {
    callback({ settings: { register: () => () => {} } })
  },
  effect: (callback) => {
    const dispose = callback()
    effects.push(typeof dispose === 'function' ? dispose : () => {})
    return () => {}
  },
  slots: {
    inject: (name, callback) => {
      callback()
    },
    register: () => () => {},
  },
  on: () => () => {},
}
try {
  await Promise.race([Promise.resolve(entry.apply(ctx)), deadline('apply()')])
  process.stdout.write('   apply returned\n')
} catch (err) {
  process.stdout.write(`   apply FAILED: ${err.message}\n`)
  process.exitCode = 1
}

process.stdout.write(`4. published services: ${Object.keys(entry).join(', ')}\n`)
if (entry.ready !== undefined) {
  try {
    await Promise.race([entry.ready(), deadline('ready()')])
    process.stdout.write('   ready() settled\n')
  } catch (err) {
    process.stdout.write(`   ready() FAILED: ${err.message}\n`)
    process.exitCode = 1
  }
}

for (const dispose of effects) {
  try {
    dispose()
  } catch (err) {
    process.stdout.write(`   a disposer threw: ${err.message}\n`)
  }
}
process.stdout.write('5. disposed\n')
void pathToFileURL
