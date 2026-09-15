import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const clrVersionSegmentSource = '(?:0|[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-4])'
const rcSequenceSource = '(?:0|[1-9][0-9]{0,5})'
export const canonicalVersionPattern = new RegExp(
  `^${clrVersionSegmentSource}\\.${clrVersionSegmentSource}\\.${clrVersionSegmentSource}(?:-rc\\.${rcSequenceSource})?$`
)
const canonicalVersionCapturePattern = new RegExp(
  `^(${clrVersionSegmentSource})\\.(${clrVersionSegmentSource})\\.(${clrVersionSegmentSource})(?:-rc\\.(${rcSequenceSource}))?$`
)

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const packageDescriptors = Object.freeze([
  Object.freeze({ directory: '.', expectedName: 'dsp-nebula-control' }),
  Object.freeze({ directory: 'apps/api', expectedName: '@dyson-control/api' }),
  Object.freeze({ directory: 'apps/web', expectedName: '@dyson-control/web' })
])
const bridgeProjectRelativePath = 'integrations/dyson-control-bridge/DysonControlBridge.csproj'
const bridgePluginRelativePath = 'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs'
const apiConfigRelativePath = 'apps/api/src/config.ts'
const windowsLifecycleRelativePath = 'apps/api/src/providers/windows-lifecycle.ts'
const environmentExampleRelativePath = '.env.example'
const repositoryReadmeRelativePath = 'README.md'
const ciWorkflowRelativePath = '.github/workflows/ci.yml'
const ciNodeVersion = '24.20.0'
const ciDotnetSdkVersion = '8.0.424'
const ciSetupDotnetCommit = '26b0ec14cb23fa6904739307f278c14f94c95bf1'
const hostnameWssSchemaRelativePath =
  'scripts/windows/network/dyson-nebula-hostname-wss-qualification-v1.schema.json'
const hostnameWssPowerShellRelativePath =
  'scripts/windows/network/DysonHostnameWssQualification.Common.ps1'
const networkV2SchemaRelativePath =
  'scripts/windows/network/dyson-nebula-network-assessment-v2.schema.json'
const networkV2PowerShellRelativePath = 'scripts/windows/network/DysonNetworkV2.Common.ps1'
const clientQualificationV2RelativePath = 'apps/api/src/client-profile/qualification-v2.ts'

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
  const bridgeProjectIdentity = readBridgeProjectIdentity(bridgeProjectSource)
  const bridgePluginIdentity = readBridgePluginIdentity(bridgePluginSource)
  requireExact(bridgeProjectIdentity.version, version, `${bridgeProjectRelativePath} Version`)
  requireExact(
    bridgeProjectIdentity.assemblyVersion,
    `${versionCore(version)}.0`,
    `${bridgeProjectRelativePath} AssemblyVersion`
  )
  requireExact(
    bridgeProjectIdentity.fileVersion,
    `${versionCore(version)}.0`,
    `${bridgeProjectRelativePath} FileVersion`
  )
  requireExact(
    bridgeProjectIdentity.informationalVersion,
    version,
    `${bridgeProjectRelativePath} InformationalVersion`
  )
  requireExact(
    bridgeProjectIdentity.includeSourceRevisionInInformationalVersion,
    'false',
    `${bridgeProjectRelativePath} IncludeSourceRevisionInInformationalVersion`
  )
  requireExact(bridgePluginIdentity.releaseVersion, version, `${bridgePluginRelativePath} ReleaseVersion`)
  requireExact(
    bridgePluginIdentity.pluginVersion,
    versionCore(version),
    `${bridgePluginRelativePath} numeric PluginVersion`
  )

  const apiConfigSource = await readText(path.join(root, apiConfigRelativePath), apiConfigRelativePath)
  const windowsLifecycleSource = await readText(
    path.join(root, windowsLifecycleRelativePath),
    windowsLifecycleRelativePath
  )
  const environmentExampleSource = await readText(
    path.join(root, environmentExampleRelativePath),
    environmentExampleRelativePath
  )
  const repositoryReadmeSource = await readText(
    path.join(root, repositoryReadmeRelativePath),
    repositoryReadmeRelativePath
  )
  const ciWorkflowSource = await readText(
    path.join(root, ciWorkflowRelativePath),
    ciWorkflowRelativePath
  )
  const ciToolchain = readCiToolchainBinding(ciWorkflowSource)
  const bindings = Object.freeze({
    apiBridgeDefault: Object.freeze({
      file: apiConfigRelativePath,
      version: readSingleVersionBinding(
        apiConfigSource,
        /^[\t ]*DYSON_BRIDGE_PLUGIN_VERSION:[\t ]*z\.string\(\)\.regex\([^\r\n]+\)\.default\('([^'\\\r\n]+)'\),[\t ]*$/gm,
        `${apiConfigRelativePath} DYSON_BRIDGE_PLUGIN_VERSION default`
      )
    }),
    lifecycleBridgeFallback: Object.freeze({
      file: windowsLifecycleRelativePath,
      version: readSingleVersionBinding(
        windowsLifecycleSource,
        /^[\t ]*bridgePluginVersion:[\t ]*options\.bridgePluginVersion[\t ]*\?\?[\t ]*'([^'\\\r\n]+)',?[\t ]*$/gm,
        `${windowsLifecycleRelativePath} bridgePluginVersion fallback`
      )
    }),
    environmentDeploymentDefault: Object.freeze({
      file: environmentExampleRelativePath,
      version: readSingleVersionBinding(
        environmentExampleSource,
        /^[\t ]*#[\t ]+DYSON_DEPLOYMENT_VERSION=([^\s#\r\n]+)[\t ]*$/gm,
        `${environmentExampleRelativePath} DYSON_DEPLOYMENT_VERSION example`
      )
    }),
    environmentBridgeDefault: Object.freeze({
      file: environmentExampleRelativePath,
      version: readSingleVersionBinding(
        environmentExampleSource,
        /^[\t ]*#[\t ]+DYSON_BRIDGE_PLUGIN_VERSION=([^\s#\r\n]+)[\t ]*$/gm,
        `${environmentExampleRelativePath} DYSON_BRIDGE_PLUGIN_VERSION example`
      )
    }),
    repositoryStatus: Object.freeze({
      file: repositoryReadmeRelativePath,
      version: readSingleVersionBinding(
        repositoryReadmeSource,
        /^> Project status: `([^`\\\r\n]+)` implementation foundation\./gm,
        `${repositoryReadmeRelativePath} project status`
      )
    })
  })
  for (const [name, binding] of Object.entries(bindings)) {
    requireExact(binding.version, version, `${name} version`)
  }

  const hostnameWssSchema = await readJsonObject(
    path.join(root, hostnameWssSchemaRelativePath),
    hostnameWssSchemaRelativePath
  )
  const networkV2Schema = await readJsonObject(
    path.join(root, networkV2SchemaRelativePath),
    networkV2SchemaRelativePath
  )
  const hostnameWssPowerShellSource = await readText(
    path.join(root, hostnameWssPowerShellRelativePath),
    hostnameWssPowerShellRelativePath
  )
  const networkV2PowerShellSource = await readText(
    path.join(root, networkV2PowerShellRelativePath),
    networkV2PowerShellRelativePath
  )
  const clientQualificationV2Source = await readText(
    path.join(root, clientQualificationV2RelativePath),
    clientQualificationV2RelativePath
  )
  const hostnameWssClientSchemaSource = readSingleSourceBlock(
    clientQualificationV2Source,
    /^export const hostnameWssQualificationDocumentSchema = z\.strictObject\(\{[\s\S]*?^\}\)[\t ]*\r?$/gm,
    `${clientQualificationV2RelativePath} hostnameWssQualificationDocumentSchema`
  )
  const qualifiedClientManifestSchemaSource = readSingleSourceBlock(
    clientQualificationV2Source,
    /^export const qualifiedClientManifestSchema = z\.strictObject\(\{[\s\S]*?^\}\)[\t ]*\r?$/gm,
    `${clientQualificationV2RelativePath} qualifiedClientManifestSchema`
  )
  const hostnameWssProtocol = readJsonSchemaConst(
    hostnameWssSchema,
    'protocol',
    hostnameWssSchemaRelativePath
  )
  const hostnameWssSchemaVersion = readJsonSchemaConst(
    hostnameWssSchema,
    'schemaVersion',
    hostnameWssSchemaRelativePath
  )
  const networkV2Protocol = readJsonSchemaConst(
    networkV2Schema,
    'protocol',
    networkV2SchemaRelativePath
  )
  const networkV2SchemaVersion = readJsonSchemaConst(
    networkV2Schema,
    'schemaVersion',
    networkV2SchemaRelativePath
  )
  requireExact(hostnameWssProtocol, 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1',
    `${hostnameWssSchemaRelativePath} protocol`)
  requireExactNumber(hostnameWssSchemaVersion, 1, `${hostnameWssSchemaRelativePath} schemaVersion`)
  requireExact(networkV2Protocol, 'DYSON_NEBULA_NETWORK_ASSESSMENT_V2',
    `${networkV2SchemaRelativePath} protocol`)
  requireExactNumber(networkV2SchemaVersion, 2, `${networkV2SchemaRelativePath} schemaVersion`)

  const hostnameWssPowerShellProtocol = readSingleLiteralBinding(
    hostnameWssPowerShellSource,
    /^\$script:DysonHostnameWssProtocol[\t ]*=[\t ]*'([^'\\\r\n]+)'[\t ]*\r?$/gm,
    `${hostnameWssPowerShellRelativePath} DysonHostnameWssProtocol`
  )
  const hostnameWssPowerShellSchemaVersion = readSingleIntegerBinding(
    hostnameWssPowerShellSource,
    /^\$script:DysonHostnameWssSchemaVersion[\t ]*=[\t ]*([0-9]+)[\t ]*\r?$/gm,
    `${hostnameWssPowerShellRelativePath} DysonHostnameWssSchemaVersion`
  )
  const networkV2PowerShellProtocol = readSingleLiteralBinding(
    networkV2PowerShellSource,
    /^\$script:DysonNetworkV2Protocol[\t ]*=[\t ]*'([^'\\\r\n]+)'[\t ]*\r?$/gm,
    `${networkV2PowerShellRelativePath} DysonNetworkV2Protocol`
  )
  const networkV2PowerShellSchemaVersion = readSingleIntegerBinding(
    networkV2PowerShellSource,
    /^\$script:DysonNetworkV2SchemaVersion[\t ]*=[\t ]*([0-9]+)[\t ]*\r?$/gm,
    `${networkV2PowerShellRelativePath} DysonNetworkV2SchemaVersion`
  )
  const hostnameWssClientProtocol = readSingleLiteralBinding(
    clientQualificationV2Source,
    /^export const HOSTNAME_WSS_QUALIFICATION_PROTOCOL[\t ]*=[\t ]*'([^'\\\r\n]+)'[\t ]+as const[\t ]*\r?$/gm,
    `${clientQualificationV2RelativePath} HOSTNAME_WSS_QUALIFICATION_PROTOCOL`
  )
  const qualifiedClientManifestProtocol = readSingleLiteralBinding(
    clientQualificationV2Source,
    /^export const QUALIFIED_CLIENT_MANIFEST_PROTOCOL[\t ]*=[\t ]*'([^'\\\r\n]+)'[\t ]+as const[\t ]*\r?$/gm,
    `${clientQualificationV2RelativePath} QUALIFIED_CLIENT_MANIFEST_PROTOCOL`
  )
  const qualifiedClientPowerShellBinding = readQualifiedClientPowerShellBinding(
    hostnameWssPowerShellSource
  )
  const hostnameWssClientSchemaVersion = readZodSchemaVersion(
    hostnameWssClientSchemaSource,
    `${clientQualificationV2RelativePath} hostnameWssQualificationDocumentSchema`
  )
  const qualifiedClientManifestSchemaVersion = readZodSchemaVersion(
    qualifiedClientManifestSchemaSource,
    `${clientQualificationV2RelativePath} qualifiedClientManifestSchema`
  )
  requireExact(hostnameWssPowerShellProtocol, hostnameWssProtocol,
    `${hostnameWssPowerShellRelativePath} protocol`)
  requireExactNumber(hostnameWssPowerShellSchemaVersion, hostnameWssSchemaVersion,
    `${hostnameWssPowerShellRelativePath} schemaVersion`)
  requireExact(hostnameWssClientProtocol, hostnameWssProtocol,
    `${clientQualificationV2RelativePath} hostname-WSS protocol`)
  requireExactNumber(hostnameWssClientSchemaVersion, hostnameWssSchemaVersion,
    `${clientQualificationV2RelativePath} hostname-WSS schemaVersion`)
  requireExact(networkV2PowerShellProtocol, networkV2Protocol,
    `${networkV2PowerShellRelativePath} protocol`)
  requireExactNumber(networkV2PowerShellSchemaVersion, networkV2SchemaVersion,
    `${networkV2PowerShellRelativePath} schemaVersion`)
  requireExact(qualifiedClientManifestProtocol, 'DYSON_QUALIFIED_CLIENT_MANIFEST_V1',
    `${clientQualificationV2RelativePath} qualified client manifest protocol`)
  requireExact(qualifiedClientPowerShellBinding.protocol, qualifiedClientManifestProtocol,
    `${hostnameWssPowerShellRelativePath} qualified client manifest protocol`)
  requireExactNumber(qualifiedClientPowerShellBinding.schemaVersion, 1,
    `${hostnameWssPowerShellRelativePath} qualified client manifest schemaVersion`)
  requireExactNumber(qualifiedClientManifestSchemaVersion, qualifiedClientPowerShellBinding.schemaVersion,
    `${clientQualificationV2RelativePath} qualified client manifest schemaVersion`)

  const protocols = Object.freeze({
    hostnameWssQualification: Object.freeze({
      protocol: hostnameWssProtocol,
      schemaVersion: hostnameWssSchemaVersion,
      schemaFile: hostnameWssSchemaRelativePath,
      powershellFile: hostnameWssPowerShellRelativePath,
      clientFile: clientQualificationV2RelativePath
    }),
    networkAssessmentV2: Object.freeze({
      protocol: networkV2Protocol,
      schemaVersion: networkV2SchemaVersion,
      schemaFile: networkV2SchemaRelativePath,
      powershellFile: networkV2PowerShellRelativePath
    }),
    qualifiedClientManifest: Object.freeze({
      protocol: qualifiedClientManifestProtocol,
      schemaVersion: qualifiedClientManifestSchemaVersion,
      powershellFile: hostnameWssPowerShellRelativePath,
      clientFile: clientQualificationV2RelativePath
    })
  })

  if (expectedVersion !== null) requireExact(version, expectedVersion, 'repository version')
  if (tagVersion !== null) requireExact(version, tagVersion, 'repository version derived from tag')

  return Object.freeze({
    version,
    packages: Object.freeze(records.map((record) => Object.freeze({ ...record }))),
    bridge: Object.freeze({
      projectFile: bridgeProjectRelativePath,
      projectVersion: bridgeProjectIdentity.version,
      assemblyVersion: bridgeProjectIdentity.assemblyVersion,
      fileVersion: bridgeProjectIdentity.fileVersion,
      informationalVersion: bridgeProjectIdentity.informationalVersion,
      includeSourceRevisionInInformationalVersion:
        bridgeProjectIdentity.includeSourceRevisionInInformationalVersion,
      pluginFile: bridgePluginRelativePath,
      releaseVersion: bridgePluginIdentity.releaseVersion,
      pluginVersion: bridgePluginIdentity.pluginVersion
    }),
    ciToolchain,
    bindings,
    protocols
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

function readBridgeProjectIdentity(source) {
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
  const assemblyVersion = readBridgeProjectSiblingProperty(withoutComments, containingGroups[0][2], 'AssemblyVersion')
  const fileVersion = readBridgeProjectSiblingProperty(withoutComments, containingGroups[0][2], 'FileVersion')
  const informationalVersion = readBridgeProjectSiblingProperty(
    withoutComments,
    containingGroups[0][2],
    'InformationalVersion'
  )
  const includeSourceRevisionInInformationalVersion = readBridgeProjectSiblingProperty(
    withoutComments,
    containingGroups[0][2],
    'IncludeSourceRevisionInInformationalVersion'
  )
  return Object.freeze({
    version: exact[1],
    assemblyVersion,
    fileVersion,
    informationalVersion,
    includeSourceRevisionInInformationalVersion
  })
}

function readBridgeProjectSiblingProperty(source, versionGroup, propertyName) {
  const label = bridgeProjectRelativePath
  const openings = source.match(new RegExp(`<${propertyName}(?:\\s|>)`, 'g')) ?? []
  const closings = source.match(new RegExp(`</${propertyName}\\s*>`, 'g')) ?? []
  if (openings.length !== 1 || closings.length !== 1) {
    fail(`${label} must contain exactly one ${propertyName} element`)
  }
  const exact = new RegExp(`<${propertyName}>([^<>\\r\\n]+)</${propertyName}>`).exec(source)
  if (exact === null || !versionGroup.includes(exact[0])) {
    fail(`${label} ${propertyName} must be an exact literal in the Version PropertyGroup`)
  }
  return exact[1]
}

function readBridgePluginIdentity(source) {
  const label = bridgePluginRelativePath
  const withoutComments = removeCSharpComments(source, label)
  const pluginDeclarations = withoutComments.match(/\bconst\s+string\s+PluginVersion\b/g) ?? []
  const releaseDeclarations = withoutComments.match(/\bconst\s+string\s+ReleaseVersion\b/g) ?? []
  if (pluginDeclarations.length !== 1 || releaseDeclarations.length !== 1) {
    fail(`${label} must contain exactly one PluginVersion and one ReleaseVersion declaration`)
  }

  const exactPlugin = /^[\t ]*public[\t ]+const[\t ]+string[\t ]+PluginVersion[\t ]*=[\t ]*"([^"\\\r\n]+)"[\t ]*;[\t ]*$/m.exec(withoutComments)
  const exactRelease = /^[\t ]*public[\t ]+const[\t ]+string[\t ]+ReleaseVersion[\t ]*=[\t ]*"([^"\\\r\n]+)"[\t ]*;[\t ]*$/m.exec(withoutComments)
  if (exactPlugin === null || exactRelease === null) {
    fail(`${label} PluginVersion must use one public const string declaration with a literal value`)
  }
  if (isInsideCSharpConditional(withoutComments, exactPlugin.index, label) ||
      isInsideCSharpConditional(withoutComments, exactRelease.index, label)) {
    fail(`${label} PluginVersion and ReleaseVersion cannot be conditionally compiled`)
  }
  const pluginAttributes = withoutComments.match(/\bBepInPlugin\s*\([^)]*\)/g) ?? []
  const exactBindings = withoutComments.match(
    /\bBepInPlugin\s*\(\s*PluginGuid\s*,\s*PluginName\s*,\s*PluginVersion\s*\)/g
  ) ?? []
  if (pluginAttributes.length !== 1 || exactBindings.length !== 1) {
    fail(`${label} must bind exactly one BepInPlugin attribute to PluginVersion`)
  }
  requireCanonicalVersion(exactRelease[1], `${label} ReleaseVersion`)
  if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(exactPlugin[1])) {
    fail(`${label} PluginVersion must be canonical numeric x.y.z for BepInEx`)
  }
  return Object.freeze({ pluginVersion: exactPlugin[1], releaseVersion: exactRelease[1] })
}

function readSingleVersionBinding(source, pattern, label) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1) fail(`${label} must contain exactly one literal version binding`)
  requireCanonicalVersion(matches[0][1], label)
  return matches[0][1]
}

function readSingleLiteralBinding(source, pattern, label) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1) fail(`${label} must contain exactly one literal binding`)
  return matches[0][1]
}

function readSingleIntegerBinding(source, pattern, label) {
  const value = readSingleLiteralBinding(source, pattern, label)
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    fail(`${label} must contain one canonical nonnegative integer binding`)
  }
  return Number(value)
}

function readCiToolchainBinding(source) {
  const nodeVersion = readSingleLiteralBinding(
    source,
    /^[\t ]+node-version:[\t ]*([^'"\s#]+)[\t ]*(?:#[^\r\n]*)?\r?$/gm,
    `${ciWorkflowRelativePath} node-version`
  )
  const dotnetSdkVersion = readSingleLiteralBinding(
    source,
    /^[\t ]+dotnet-version:[\t ]*([^'"\s#]+)[\t ]*(?:#[^\r\n]*)?\r?$/gm,
    `${ciWorkflowRelativePath} dotnet-version`
  )
  const setupDotnetCommit = readSingleLiteralBinding(
    source,
    /^[\t ]*-[\t ]+uses:[\t ]+actions\/setup-dotnet@([^\s#]+)[\t ]*(?:#[^\r\n]*)?\r?$/gm,
    `${ciWorkflowRelativePath} actions/setup-dotnet reference`
  )
  const verifiedNodeVersion = readSingleLiteralBinding(
    source,
    /^[\t ]*if[\t ]*\(\$LASTEXITCODE[\t ]+-ne[\t ]+0[\t ]+-or[\t ]+\$nodeVersion[\t ]+-cne[\t ]+'([^'\\\r\n]+)'\)[\t ]*\{[\t ]*\r?$/gm,
    `${ciWorkflowRelativePath} Node runtime assertion`
  )
  const verifiedDotnetSdkVersion = readSingleLiteralBinding(
    source,
    /^[\t ]*if[\t ]*\(\$LASTEXITCODE[\t ]+-ne[\t ]+0[\t ]+-or[\t ]+\$dotnetVersion[\t ]+-cne[\t ]+'([^'\\\r\n]+)'\)[\t ]*\{[\t ]*\r?$/gm,
    `${ciWorkflowRelativePath} .NET SDK assertion`
  )
  requireExact(nodeVersion, ciNodeVersion, `${ciWorkflowRelativePath} node-version`)
  requireExact(verifiedNodeVersion, ciNodeVersion, `${ciWorkflowRelativePath} Node runtime assertion`)
  requireExact(dotnetSdkVersion, ciDotnetSdkVersion, `${ciWorkflowRelativePath} dotnet-version`)
  requireExact(verifiedDotnetSdkVersion, ciDotnetSdkVersion,
    `${ciWorkflowRelativePath} .NET SDK assertion`)
  requireExact(setupDotnetCommit, ciSetupDotnetCommit,
    `${ciWorkflowRelativePath} actions/setup-dotnet reference`)
  return Object.freeze({
    workflowFile: ciWorkflowRelativePath,
    nodeVersion,
    dotnetSdkVersion,
    setupDotnetCommit
  })
}

function readSingleSourceBlock(source, pattern, label) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1) fail(`${label} must contain exactly one literal schema block`)
  return matches[0][0]
}

function readJsonSchemaConst(schema, propertyName, label) {
  if (!isObject(schema.properties) || !isObject(schema.properties[propertyName]) ||
      !Object.hasOwn(schema.properties[propertyName], 'const')) {
    fail(`${label} ${propertyName} must contain one top-level JSON Schema const`)
  }
  return schema.properties[propertyName].const
}

function readZodSchemaVersion(source, label) {
  return readSingleIntegerBinding(
    source,
    /^[\t ]*schemaVersion:[\t ]*z\.literal\(([0-9]+)\),[\t ]*\r?$/gm,
    `${label} schemaVersion`
  )
}

function readQualifiedClientPowerShellBinding(source) {
  const label = `${hostnameWssPowerShellRelativePath} qualified client manifest`
  const protocol = readSingleLiteralBinding(
    source,
    /^[\t ]*if \(\[string\]\$Manifest\.protocol -cne '([^'\\\r\n]+)' -or[\t ]*\r?$/gm,
    `${label} protocol`
  )
  const rangeMatches = [...source.matchAll(
    /^[\t ]*-not \(Test-DysonHostnameWssJsonInteger -Value \$Manifest\.schemaVersion -Minimum ([0-9]+) -Maximum ([0-9]+)\) -or[\t ]*\r?$/gm
  )]
  if (rangeMatches.length !== 1 || rangeMatches[0][1] !== rangeMatches[0][2]) {
    fail(`${label} schemaVersion must contain one exact single-version integer gate`)
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(rangeMatches[0][1]) ||
      !Number.isSafeInteger(Number(rangeMatches[0][1]))) {
    fail(`${label} schemaVersion must contain one canonical nonnegative integer gate`)
  }
  return Object.freeze({ protocol, schemaVersion: Number(rangeMatches[0][1]) })
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
  const match = typeof value === 'string' ? canonicalVersionCapturePattern.exec(value) : null
  if (match === null || match.slice(1, 4).some((segment) => Number(segment) > 65_534) ||
      (match[4] !== undefined && Number(match[4]) > 999_999)) {
    fail(`${label} must be canonical x.y.z or x.y.z-rc.N with CLR segments 0..65534 and RC number 0..999999`)
  }
}

function requireExact(actual, expected, label) {
  if (typeof actual !== 'string' || actual !== expected) fail(`${label} does not exactly match ${expected}`)
}

function requireExactNumber(actual, expected, label) {
  if (!Number.isSafeInteger(actual) || actual !== expected) fail(`${label} does not exactly match ${expected}`)
}

function versionCore(version) {
  return version.split('-rc.', 1)[0]
}

function fail(message) {
  throw new Error(message)
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedUrl === import.meta.url) {
  try {
    const options = parseVersionArguments(process.argv.slice(2))
    const result = await validateVersionConsistency(options)
    process.stdout.write(`Version consistency verified: ${result.version} across 3 manifests, 3 lockfiles, 7 Bridge version bindings, 5 runtime/example bindings, the exact CI Node/.NET toolchain, and 3 cross-runtime protocol contracts.\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown validation failure'
    process.stderr.write(`Version consistency check failed: ${message}\n`)
    process.exitCode = 1
  }
}
