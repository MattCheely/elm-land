const compiler = require('node-elm-compiler')
const { relative } = require('path')
const { acquireLock } = require('./mutex')
const { default: ElmErrorJson } = require('./elm-error-json.js')
const terser = require('terser')
const path = require('path')
const fs = require('fs')

const trimDebugMessage = (code) => code.replace(/(console\.warn\('Compiled in DEBUG mode)/, '// $1')
const viteProjectPath = (dependency) => `/${relative(process.cwd(), dependency)}`

// Here's where we'll expect to find the Elm binary installed
const elmPaths = {
  // When locally installed with `npm install -D elm-land`
  // ✅ Tested with npm install -D, yarn, pnpm i
  local: path.join(__dirname, '..', '..', '..', '..', '@lydell', 'elm', 'bin', 'elm'),
  // When globally installed with `npm install -g elm-land`
  // ✅ Tested with npm install -g, yarn, pnpm
  global: path.join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'elm'),
}

const pathToElm =
  fs.existsSync(elmPaths.global)
    ? elmPaths.global
    : elmPaths.local

const parseImportId = (id) => {
  const parsedId = new URL(id, 'file://')
  const pathname = parsedId.pathname
  const valid = pathname.endsWith('.elm')
  const withParams = parsedId.searchParams.getAll('with')

  return {
    valid,
    pathname,
    withParams,
  }
}

const colorOverrides = {
  GREEN: 'mediumseagreen',
  RED: 'indianred',
  BLUE: 'dodgerblue',
}

const plugin = (opts) => {
  const compilableFiles = new Map()
  const debug = opts ? opts.debug : undefined
  const optimize = opts ? opts.optimize : undefined

  let lastErrorSent = undefined
  let server = undefined

  return {
    name: 'vite-plugin-elm',
    enforce: 'pre',
    handleHotUpdate({ file, server, modules }) {
      const { valid } = parseImportId(file)
      if (!valid) return

      const modulesToCompile = []
      compilableFiles.forEach((dependencies, compilableFile) => {
        if (dependencies.has(file)) {
          const module = server.moduleGraph.getModuleById(compilableFile)
          if (module) modulesToCompile.push(module)
        }
      })

      if (modulesToCompile.length > 0) {
        server.ws.send({
          type: 'custom',
          event: 'hot-update-dependents',
          data: modulesToCompile.map(({ url }) => url),
        })
        return modulesToCompile
      } else {
        return modules
      }
    },
    configureServer(server_) {
      server = server_

      server.ws.on('elm:client-ready', () => {
        if (lastErrorSent) {
          server.ws.send('elm:error', {
            error: ElmErrorJson.toColoredHtmlOutput(lastErrorSent, colorOverrides)
          })
        }
      })
    },
    async load(id) {
      const { valid, pathname, withParams } = parseImportId(id)
      if (!valid) return

      const accompanies = await (() => {
        if (withParams.length > 0) {
          const importTree = this.getModuleIds()
          let importer = ''
          for (const moduleId of importTree) {
            if (moduleId === id) break
            importer = moduleId
          }
          const resolveAcoompany = async (accompany) => {
            let thing = await this.resolve(accompany, importer)
            return thing && thing.id ? thing.id : ''
          }
          return Promise.all(withParams.map(resolveAcoompany))
        } else {
          return Promise.resolve([])
        }
      })()

      const targets = [pathname, ...accompanies].filter((target) => target !== '')

      compilableFiles.delete(id)
      const dependencies = (
        await Promise.all(targets.map((target) => compiler.findAllDependencies(target)))
      ).flat()
      compilableFiles.set(id, new Set([...accompanies, ...dependencies]))

      const releaseLock = await acquireLock()
      const isBuild = process.env.NODE_ENV === 'production'
      try {
        const compiled = await compiler.compileToString(targets, {
          pathToElm,
          output: '.js',
          optimize: typeof optimize === 'boolean' ? optimize : !debug && isBuild,
          verbose: false,
          debug: typeof debug === 'boolean' ? debug : !isBuild,
          report: 'json'
        })

        // Taken from https://www.npmjs.com/package/elm-esm/v/1.1.4
        // 
        // It is just a single function, so having an NPM dependency feels silly, but
        // I want to still give source credit to https://github.com/ChristophP/elm-esm
        const toESModule = (js) => {
          const elmExports = js.match(
            /^\s*_Platform_export\(([^]*)\);\n?}\(this\)\);/m
          )[1]
          return js
            .replace(/\(function\s*\(scope\)\s*\{$/m, "// -- $&")
            .replace(/['"]use strict['"];$/m, "// -- $&")
            .replace(/function _Platform_export([^]*?)\}\n/g, "/*\n$&\n*/")
            .replace(/function _Platform_mergeExports([^]*?)\}\n\s*}/g, "/*\n$&\n*/")
            .replace(/^\s*_Platform_export\(([^]*)\);\n?}\(this\)\);/m, "/*\n$&\n*/")
            .concat(`\nexport const Elm = ${elmExports};\n`)
        }

        const esm = toESModule(compiled)

        // Apparently `addWatchFile` may not exist: https://github.com/hmsk/vite-plugin-elm/pull/36
        if (this.addWatchFile) {
          dependencies.forEach(this.addWatchFile.bind(this))
        }

        lastErrorSent = null
        if (server) {
          server.ws.send('elm:success', { msg: 'Success!' })
        }

        let minify = async (unminifiedJs) => {
          // --compress 'pure_funcs="F2,F3,F4,F5,F6,F7,F8,F9,A2,A3,A4,A5,A6,A7,A8,A9",pure_getters,keep_fargs=false,unsafe_comps,unsafe' })
          const { code: step1 } = await terser.minify(unminifiedJs, { compress: { pure_funcs: 'F2,F3,F4,F5,F6,F7,F8,F9,A2,A3,A4,A5,A6,A7,A8,A9'.split(','), pure_getters: true, keep_fargs: false, unsafe_comps: true, unsafe: true } })
          // --mangle
          const { code: step2 } = await terser.minify(step1, { mangle: true })
          return step2
        }

        if (isBuild) {
          let code = await minify(esm)
          return {
            code,
            map: null
          }
        } else {
          return {
            code: trimDebugMessage(esm, dependencies.map(viteProjectPath)),
            map: null,
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('-- NO MAIN')) {
          const message = `${viteProjectPath(
            pathname,
          )
            }: NO MAIN.elm file is requested to transform by vite.Probably, this file is just a depending module`
          throw message
        } else {
          if (isBuild) {
            try {
              let output = ElmErrorJson.parse(e.message)
              console.error(`❗️ Elm Land build failed: `)
              console.error('')
              console.error(ElmErrorJson.toColoredTerminalOutput(output))
              console.error('')
              return process.exit(1)
            } catch (e) {
              throw e
            }
          } else {
            let elmError = ElmErrorJson.parse(e.message)
            lastErrorSent = elmError
            server.ws.send('elm:error', {
              error: ElmErrorJson.toColoredHtmlOutput(elmError, colorOverrides)
            })

            return {
              code: `export const Elm = new Proxy({}, () => ({ init: () => { } }))`,
              map: null
            }
          }
        }
      } finally {
        releaseLock()
      }
    },
  }
}

module.exports = {
  plugin
}
