import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const canonicalVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-rc\.(?:0|[1-9][0-9]*))?$/

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const packageDescriptors = Object.freeze([
  Object.freeze({ directory: '.', expectedName: 'dsp-nebula-control' }),
  Object.freeze({ directory: 'apps/api', expectedName: '@dyson-control/api' }),
  Object.freeze({ directory: 'apps/web', expectedName: '@dyson-control/web' })
])
const bridgeProjectRelativePath = 'integrations/dyson-control-bridge/DysonControlBridge.csproj'
const bridgePluginRelativePath = 'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs'

export async function validateVersionConsistency(options = {}) {
  const root = options.repositoryRoot === undefined
    ? repositoryRoot
    : path.resolve(options.repositoryRoot)
  const expectedVersion = optionalCanonicalVersion(options.expectedVersion, '--expected-version')
  const tagVersion = options.tag === undefined || options.tag === null
    ? null
    : versionFromTag(options.tag)
  if (expectedVersion !== null && tagVersion !== null && expectedVersion !== tagVersion) {
    fail('--expected-version does not exactly match the version derived from --tag')
  }

  const records = []
  for (const descriptor of packageDescriptors) {
    const displayDirectory = descriptor.directory === '.' ? 'root' : descriptor.directory
    const directory = path.resolve(root, descriptor.directory)
    const manifest = await readJsonObject(path.join(directory, 'package.json'), `${displayDirectory}/package.json`)
    const lock = await readJsonObject(path.join(directory, 'package-lock.json'), `${displayDirectory}/package-lock.json`)

    requireExact(manifest.name, descriptor.expectedName, `${displayDirectory}/package.json name`)
    requireCanonicalVersion(manifest.version, `${displayDirectory}/package.json version`)
    requireExact(lock.name, manifest.name, `${displayDirectory}/package-lock.json top-level name`)
    requireExact(lock.version, manifest.version, `${displayDirectory}/package-lock.json top-level version`)

    const rootPackage = isObject(lock.packages) && isObject(lock.packages[''])
      ? lock.packages['']
      : null
    if (rootPackage === null) fail(`${displayDirectory}/package-lock.json packages[''] is missing or invalid`)
    requireExact(rootPackage.name, manifest.name, `${displayDirectory}/package-lock.json packages[''] name`)
    requireExact(rootPackage.version, manifest.version, `${displayDirectory}/package-lock.json packages[''] version`)
    records.push({ directory: descriptor.directory, name: manifest.name, version: manifest.version })
  }

  const version = records[0].version
  for (const record of records.slice(1)) {
    requireExact(record.version, version, `${record.directory}/package.json version`)
  }

  const bridgeProjectSource = await readText(
    path.join(root, bridgeProjectRelativePath),
    bridgeProjectRelativePath
  )
  const bridgePluginSource = await readText(
    path.join(root, bridgePluginRelativePath),
    bridgePluginRelativePath
  )
  const bridgeProjectVersion = readBridgeProjectVersion(bridgeProjectSource)
  const bridgePluginVersion = readBridgePluginVersion(bridgePluginSource)
  requireExact(bridgeProjectVersion, version, `${bridgeProjectRelativePath} Version`)
  requireExact(bridgePluginVersion, version, `${bridgePluginRelativePath} PluginVersion`)

  if (expectedVersion !== null) requireExact(version, expectedVersion, 'repository version')
  if (tagVersion !== null) requireExact(version, tagVersion, 'repository version derived from tag')

  return Object.freeze({
    version,
    packages: Object.freeze(records.map((record) => Object.freeze({ ...record }))),
    bridge: Object.freeze({
      projectFile: bridgeProjectRelativePath,
      projectVersion: bridgeProjectVersion,
      pluginFile: bridgePluginRelativePath,
      pluginVersion: bridgePluginVersion
    })
  })
}

export function parseVersionArguments(argv) {
  let expectedVersion = null
  let tag = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== '--expected-version' && argument !== '--tag') fail(`unknown argument: ${argument}`)
    const value = argv[index + 1]
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      fail(`${argument} requires one value`)
    }
    if (argument === '--expected-version') {
      if (expectedVersion !== null) fail('--expected-version may be supplied only once')
      expectedVersion = value
    } else {
      if (tag !== null) fail('--tag may be supplied only once')
      tag = value
    }
    index += 1
  }
  return { expectedVersion, tag }
}

function optionalCanonicalVersion(value, label) {
  if (value === undefined || value === null) return null
  requireCanonicalVersion(value, label)
  return value
}

function versionFromTag(value) {
  if (typeof value !== 'string' || !value.startsWith('v')) fail('--tag is not canonical')
  const version = value.slice(1)
  requireCanonicalVersion(version, '--tag version')
  if (value !== `v${version}`) fail('--tag is not canonical')
  return version
}

async function readJsonObject(filePath, label) {
  let source
  try {
    source = await readFile(filePath, 'utf8')
  } catch {
    fail(`${label} is unavailable`)
  }
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    fail(`${label} is not valid JSON`)
  }
  if (!isObject(parsed)) fail(`${label} must contain a JSON object`)
  return parsed
}

async function readText(filePath, label) {
  let source
  try {
    source = await readFile(filePath, 'utf8')
  } catch {
    fail(`${label} is unavailable`)
  }
  if (source.length === 0 || Buffer.byteLength(source, 'utf8') > 1024 * 1024) {
    fail(`${label} is empty or too large`)
  }
  return source
}

function readBridgeProjectVersion(source) {
  const label = bridgeProjectRelativePath
  const withoutComments = removeXmlComments(source, label)
  const trimmed = withoutComments.trim()
  const projectOpenings = trimmed.match(/<Project(?:\s|>)/g) ?? []
  const projectClosings = trimmed.match(/<\/Project\s*>/g) ?? []
  if (projectOpenings.length !== 1 || projectClosings.length !== 1 ||
      !/^<Project(?:\s[^<>]*)?>[\s\S]*<\/Project>$/.test(trimmed)) {
    fail(`${label} must contain one complete Project root`)
  }
  const openings = withoutComments.match(/<Version(?:\s|>)/g) ?? []
  const closings = withoutComments.match(/<\/Version\s*>/g) ?? []
  if (openings.length !== 1 || closings.length !== 1) {
    fail(`${label} must contain exactly one Version element`)
  }

  const exact = /<Version>([^<>\r\n]+)<\/Version>/.exec(withoutComments)
  if (exact === null) fail(`${label} Version must use one exact <Version>value</Version> element`)
  const propertyGroups = [...withoutComments.matchAll(/<PropertyGroup([^<>]*)>([\s\S]*?)<\/PropertyGroup\s*>/g)]
  const containingGroups = propertyGroups.filter((match) => match[2].includes(exact[0]))
  if (containingGroups.length !== 1) {
    fail(`${label} Version must be inside one PropertyGroup`)
  }
  if (/(?:^|\s)condition\s*=/i.test(containingGroups[0][1])) {
    fail(`${label} Version PropertyGroup must be unconditional`)
  }
  requireCanonicalVersion(exact[1], `${label} Version`)
  return exact[1]
}

function readBridgePluginVersion(source) {
  const label = bridgePluginRelativePath
  const withoutComments = removeCSharpComments(source, label)
  const declarations = withoutComments.match(/\bconst\s+string\s+PluginVersion\b/g) ?? []
  if (declarations.length !== 1) {
    fail(`${label} must contain exactly one const string PluginVersion declaration`)
  }

  const exact = /^[\t ]*public[\t ]+const[\t ]+string[\t ]+PluginVersion[\t ]*=[\t ]*"([^"\\\r\n]+)"[\t ]*;[\t ]*$/m.exec(withoutComments)
  if (exact === null) {
    fail(`${label} PluginVersion must use one public const string declaration with a literal value`)
  }
  if (isInsideCSharpConditional(withoutComments, exact.index, label)) {
    fail(`${label} PluginVersion cannot be conditionally compiled`)
  }
  const pluginAttributes = withoutComments.match(/\bBepInPlugin\s*\([^)]*\)/g) ?? []
  const exactBindings = withoutComments.match(
    /\bBepInPlugin\s*\(\s*PluginGuid\s*,\s*PluginName\s*,\s*PluginVersion\s*\)/g
  ) ?? []
  if (pluginAttributes.length !== 1 || exactBindings.length !== 1) {
    fail(`${label} must bind exactly one BepInPlugin attribute to PluginVersion`)
  }
  requireCanonicalVersion(exact[1], `${label} PluginVersion`)
  return exact[1]
}

function isInsideCSharpConditional(source, declarationIndex, label) {
  let depth = 0
  let declarationDepth = null
  let offset = 0
  for (const line of source.split(/(?<=\n)/)) {
    const directive = /^[\t ]*#[\t ]*(if|elif|else|endif)\b/.exec(line)
    if (directive?.[1] === 'if') {
      depth += 1
    } else if (directive?.[1] === 'elif' || directive?.[1] === 'else') {
      if (depth === 0) fail(`${label} contains an unmatched conditional directive`)
    } else if (directive?.[1] === 'endif') {
      if (depth === 0) fail(`${label} contains an unmatched conditional directive`)
      depth -= 1
    }
    if (declarationIndex >= offset && declarationIndex < offset + line.length) {
      declarationDepth = depth
    }
    offset += line.length
  }
  if (depth !== 0) fail(`${label} contains an unmatched conditional directive`)
  return declarationDepth !== 0
}

function removeXmlComments(source, label) {
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, '')
  if (withoutComments.includes('<!--') || withoutComments.includes('-->')) {
    fail(`${label} contains an unterminated XML comment`)
  }
  return withoutComments
}

function removeCSharpComments(source, label) {
  let result = ''
  let state = 'code'
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]
    if (state === 'line-comment') {
      if (current === '\n') {
        result += current
        state = 'code'
      } else if (current === '\r') {
        result += current
      } else {
        result += ' '
      }
      continue
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        result += '  '
        index += 1
        state = 'code'
      } else {
        result += current === '\r' || current === '\n' ? current : ' '
      }
      continue
    }
    if (state === 'string') {
      result += current
      if (current === '\\' && next !== undefined) {
        result += next
        index += 1
      } else if (current === '"') {
        state = 'code'
      }
      continue
    }
    if (state === 'verbatim-string') {
      result += current
      if (current === '"' && next === '"') {
        result += next
        index += 1
      } else if (current === '"') {
        state = 'code'
      }
      continue
    }
    if (state === 'character') {
      result += current
      if (current === '\\' && next !== undefined) {
        result += next
        index += 1
      } else if (current === "'") {
        state = 'code'
      }
      continue
    }
    if (current === '/' && next === '/') {
      result += '  '
      index += 1
      state = 'line-comment'
    } else if (current === '/' && next === '*') {
      result += '  '
      index += 1
      state = 'block-comment'
    } else if (current === '@' && next === '"') {
      result += '@"'
      index += 1
      state = 'verbatim-string'
    } else if (current === '"') {
      result += current
      state = 'string'
    } else if (current === "'") {
      result += current
      state = 'character'
    } else {
      result += current
    }
  }
  if (state === 'block-comment' || state === 'string' || state === 'verbatim-string' || state === 'character') {
    fail(`${label} contains an unterminated comment or literal`)
  }
  return result
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireCanonicalVersion(value, label) {
  if (typeof value !== 'string' || !canonicalVersionPattern.test(value)) {
    fail(`${label} must be canonical x.y.z or x.y.z-rc.N`)
  }
}

function requireExact(actual, expected, label) {
  if (typeof actual !== 'string' || actual !== expected) fail(`${label} does not exactly match ${expected}`)
}

function fail(message) {
  throw new Error(message)
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedUrl === import.meta.url) {
  try {
    const options = parseVersionArguments(process.argv.slice(2))
    const result = await validateVersionConsistency(options)
    process.stdout.write(`Version consistency verified: ${result.version} across 3 manifests, 3 lockfiles, and 2 Bridge declarations.\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown validation failure'
    process.stderr.write(`Version consistency check failed: ${message}\n`)
    process.exitCode = 1
  }
}
