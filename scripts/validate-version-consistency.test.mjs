import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  parseVersionArguments,
  validateVersionConsistency
} from './validate-version-consistency.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const validatorPath = path.join(import.meta.dirname, 'validate-version-consistency.mjs')
const temporaryRoots = []

test.afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test('accepts the repository and exact stable or rc expectations derived from tags', async () => {
  const current = await validateVersionConsistency({ repositoryRoot })
  const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))
  assert.equal(current.version, rootManifest.version)
  assert.deepEqual(current.packages.map(({ name }) => name), [
    'dsp-nebula-control', '@dyson-control/api', '@dyson-control/web'
  ])
  assert.deepEqual(current.bridge, {
    projectFile: 'integrations/dyson-control-bridge/DysonControlBridge.csproj',
    projectVersion: current.version,
    assemblyVersion: `${versionCore(current.version)}.0`,
    fileVersion: `${versionCore(current.version)}.0`,
    informationalVersion: current.version,
    includeSourceRevisionInInformationalVersion: 'false',
    pluginFile: 'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
    releaseVersion: current.version,
    pluginVersion: versionCore(current.version)
  })
  assert.deepEqual(current.ciToolchain, {
    workflowFile: '.github/workflows/ci.yml',
    nodeVersion: '24.20.0',
    dotnetSdkVersion: '8.0.424',
    setupDotnetCommit: '26b0ec14cb23fa6904739307f278c14f94c95bf1'
  })
  assert.deepEqual(current.bindings, {
    apiBridgeDefault: { file: 'apps/api/src/config.ts', version: current.version },
    lifecycleBridgeFallback: { file: 'apps/api/src/providers/windows-lifecycle.ts', version: current.version },
    environmentDeploymentDefault: { file: '.env.example', version: current.version },
    environmentBridgeDefault: { file: '.env.example', version: current.version },
    repositoryStatus: { file: 'README.md', version: current.version }
  })
  assert.deepEqual(current.protocols, {
    hostnameWssQualification: {
      protocol: 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1',
      schemaVersion: 1,
      schemaFile: 'scripts/windows/network/dyson-nebula-hostname-wss-qualification-v1.schema.json',
      powershellFile: 'scripts/windows/network/DysonHostnameWssQualification.Common.ps1',
      clientFile: 'apps/api/src/client-profile/qualification-v2.ts'
    },
    networkAssessmentV2: {
      protocol: 'DYSON_NEBULA_NETWORK_ASSESSMENT_V2',
      schemaVersion: 2,
      schemaFile: 'scripts/windows/network/dyson-nebula-network-assessment-v2.schema.json',
      powershellFile: 'scripts/windows/network/DysonNetworkV2.Common.ps1'
    },
    qualifiedClientManifest: {
      protocol: 'DYSON_QUALIFIED_CLIENT_MANIFEST_V1',
      schemaVersion: 1,
      powershellFile: 'scripts/windows/network/DysonHostnameWssQualification.Common.ps1',
      clientFile: 'apps/api/src/client-profile/qualification-v2.ts'
    }
  })
  await validateVersionConsistency({
    repositoryRoot,
    expectedVersion: current.version,
    tag: `v${current.version}`
  })

  for (const version of [
    '0.0.0', '1.2.3', '10.20.30-rc.0', '10.20.30-rc.12',
    '65534.65534.65534', '65534.0.1-rc.999999'
  ]) {
    const fixture = await createFixture(version)
    await validateVersionConsistency({ repositoryRoot: fixture, expectedVersion: version, tag: `v${version}` })
  }
})

test('rejects floating, missing, duplicate, or assertion-drifted CI runtime pins', async () => {
  for (const [expected, replacement, diagnostic] of [
    ['node-version: 24.20.0', 'node-version: 24.20.1', /node-version does not exactly match 24\.20\.0/],
    ['dotnet-version: 8.0.424', 'dotnet-version: 8.0.423', /dotnet-version does not exactly match 8\.0\.424/],
    [
      'actions/setup-dotnet@26b0ec14cb23fa6904739307f278c14f94c95bf1',
      'actions/setup-dotnet@v5',
      /actions\/setup-dotnet reference does not exactly match/
    ],
    ["$nodeVersion -cne '24.20.0'", "$nodeVersion -cne '24.20.1'", /Node runtime assertion/],
    ["$dotnetVersion -cne '8.0.424'", "$dotnetVersion -cne '8.0.423'", /\.NET SDK assertion/]
  ]) {
    const fixture = await createFixture('1.2.3')
    await replaceText(path.join(fixture, '.github/workflows/ci.yml'), expected, replacement)
    await assert.rejects(validateVersionConsistency({ repositoryRoot: fixture }), diagnostic)
  }

  const missingSetup = await createFixture('1.2.3')
  await replaceText(
    path.join(missingSetup, '.github/workflows/ci.yml'),
    '      - uses: actions/setup-dotnet@26b0ec14cb23fa6904739307f278c14f94c95bf1\n',
    ''
  )
  await assert.rejects(
    validateVersionConsistency({ repositoryRoot: missingSetup }),
    /actions\/setup-dotnet reference must contain exactly one literal binding/
  )

  const duplicateNodePin = await createFixture('1.2.3')
  await replaceText(
    path.join(duplicateNodePin, '.github/workflows/ci.yml'),
    '          node-version: 24.20.0\n',
    '          node-version: 24.20.0\n          node-version: 24.20.0\n'
  )
  await assert.rejects(
    validateVersionConsistency({ repositoryRoot: duplicateNodePin }),
    /node-version must contain exactly one literal binding/
  )
})

test('rejects every non-canonical manifest, expected version, and tag form', async () => {
  for (const version of [
    'v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2', '1.2.3.4',
    '1.2.3-alpha.1', '1.2.3+build.1', '1.2.3-rc.01', '1.2.3-RC.1',
    '65535.0.0', '1.65535.0', '1.2.65535', '1.2.3-rc.1000000'
  ]) {
    const fixture = await createFixture('1.2.3')
    await mutateJson(path.join(fixture, 'package.json'), (json) => { json.version = version })
    await assert.rejects(validateVersionConsistency({ repositoryRoot: fixture }), /must be canonical/)
  }

  const fixture = await createFixture('1.2.3-rc.2')
  await assert.rejects(
    validateVersionConsistency({ repositoryRoot: fixture, expectedVersion: 'v1.2.3-rc.2' }),
    /must be canonical/
  )
  await assert.rejects(validateVersionConsistency({ repositoryRoot: fixture, tag: '1.2.3-rc.2' }), /tag/)
  await assert.rejects(validateVersionConsistency({ repositoryRoot: fixture, tag: 'v1.2.3-rc.02' }), /canonical/)
})

test('accepts the repository-declared CRLF checkout form of PowerShell protocol bindings', async () => {
  const fixture = await createFixture('1.2.3')
  for (const relative of [
    'scripts/windows/network/DysonHostnameWssQualification.Common.ps1',
    'scripts/windows/network/DysonNetworkV2.Common.ps1'
  ]) {
    const filePath = path.join(fixture, relative)
    const source = await readFile(filePath, 'utf8')
    await writeFile(filePath, source.replace(/\n/g, '\r\n'))
  }
  const result = await validateVersionConsistency({ repositoryRoot: fixture })
  assert.equal(result.protocols.hostnameWssQualification.schemaVersion, 1)
  assert.equal(result.protocols.networkAssessmentV2.schemaVersion, 2)
})

test('rejects package identity and cross-package version drift', async () => {
  const renamed = await createFixture('1.2.3')
  await mutateJson(path.join(renamed, 'apps/api/package.json'), (json) => { json.name = '@dyson-control/renamed' })
  await assert.rejects(validateVersionConsistency({ repositoryRoot: renamed }), /package\.json name/)

  const drifted = await createFixture('1.2.3')
  await setPackageVersion(drifted, 'apps/web', '1.2.4')
  await assert.rejects(validateVersionConsistency({ repositoryRoot: drifted }), /does not exactly match 1\.2\.3/)

  const expectedMismatch = await createFixture('1.2.3')
  await assert.rejects(
    validateVersionConsistency({ repositoryRoot: expectedMismatch, expectedVersion: '1.2.4' }),
    /repository version/
  )
  await assert.rejects(
    validateVersionConsistency({ repositoryRoot: expectedMismatch, expectedVersion: '1.2.3', tag: 'v1.2.4' }),
    /does not exactly match the version derived/
  )
})

test('rejects Bridge project, release, or numeric BepInEx version drift and non-canonical values', async () => {
  const projectDrift = await createFixture('1.2.3')
  await replaceText(
    path.join(projectDrift, 'integrations/dyson-control-bridge/DysonControlBridge.csproj'),
    '<Version>1.2.3</Version>',
    '<Version>1.2.4</Version>'
  )
  await assert.rejects(
    validateVersionConsistency({ repositoryRoot: projectDrift }),
    /DysonControlBridge\.csproj Version does not exactly match 1\.2\.3/
  )

  const pluginDrift = await createFixture('1.2.3')
  await replaceText(
    path.join(pluginDrift, 'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs'),
    'PluginVersion = "1.2.3"',
    'PluginVersion = "1.2.4"'
  )
  await assert.rejects(
    validateVersionConsistency({ repositoryRoot: pluginDrift }),
    /numeric PluginVersion does not exactly match 1\.2\.3/
  )

  const releaseDrift = await createFixture('1.2.3-rc.2')
  await replaceText(
    path.join(releaseDrift, 'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs'),
    'ReleaseVersion = "1.2.3-rc.2"',
    'ReleaseVersion = "1.2.3-rc.3"'
  )
  await assert.rejects(
    validateVersionConsistency({ repositoryRoot: releaseDrift }),
    /ReleaseVersion does not exactly match 1\.2\.3-rc\.2/
  )

  for (const [property, expected, replacement] of [
    ['AssemblyVersion', '1.2.3.0', '1.2.4.0'],
    ['FileVersion', '1.2.3.0', '1.2.4.0'],
    ['InformationalVersion', '1.2.3-rc.2', '1.2.3-rc.3'],
    ['IncludeSourceRevisionInInformationalVersion', 'false', 'true']
  ]) {
    const identityDrift = await createFixture('1.2.3-rc.2')
    await replaceText(
      path.join(identityDrift, 'integrations/dyson-control-bridge/DysonControlBridge.csproj'),
      `<${property}>${expected}</${property}>`,
      `<${property}>${replacement}</${property}>`
    )
    await assert.rejects(
      validateVersionConsistency({ repositoryRoot: identityDrift }),
      new RegExp(`${property} does not exactly match`)
    )
  }

  const nonCanonical = await createFixture('1.2.3')
  await replaceText(
    path.join(nonCanonical, 'integrations/dyson-control-bridge/DysonControlBridge.csproj'),
    '<Version>1.2.3</Version>',
    '<Version>v1.2.3</Version>'
  )
  await assert.rejects(
    validateVersionConsistency({ repositoryRoot: nonCanonical }),
    /DysonControlBridge\.csproj Version must be canonical/
  )
})

test('rejects missing, duplicate, or structurally ambiguous Bridge version declarations', async () => {
  for (const [file, source, expected] of [
    [
      'integrations/dyson-control-bridge/DysonControlBridge.csproj',
      '<Project><PropertyGroup></PropertyGroup></Project>\n',
      /exactly one Version element/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridge.csproj',
      '<Project><PropertyGroup><Version>1.2.3</Version><Version>1.2.3</Version></PropertyGroup></Project>\n',
      /exactly one Version element/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridge.csproj',
      '<Project><PropertyGroup><Version Condition="true">1.2.3</Version></PropertyGroup></Project>\n',
      /must use one exact <Version>value<\/Version> element/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridge.csproj',
      '<Project><Version>1.2.3</Version></Project>\n',
      /must be inside one PropertyGroup/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridge.csproj',
      '<Project><PropertyGroup Condition="true"><Version>1.2.3</Version></PropertyGroup></Project>\n',
      /Version PropertyGroup must be unconditional/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridge.csproj',
      '<Project><PropertyGroup><Version>1.2.3</Version></PropertyGroup>\n',
      /must contain one complete Project root/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
      'public sealed class Plugin {}\n',
      /exactly one PluginVersion and one ReleaseVersion declaration/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
      'public sealed class Plugin { public const string PluginVersion = "1.2.3"; public const string PluginVersion = "1.2.3"; public const string ReleaseVersion = "1.2.3"; }\n',
      /exactly one PluginVersion and one ReleaseVersion declaration/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
      '[BepInPlugin(PluginGuid, PluginName, PluginVersion)]\ninternal const string PluginVersion = "1.2.3";\npublic const string ReleaseVersion = "1.2.3";\n',
      /must use one public const string declaration/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
      '[BepInPlugin(PluginGuid, PluginName, PluginVersion)]\n#if RELEASE\npublic const string PluginVersion = "1.2.3";\n#endif\npublic const string ReleaseVersion = "1.2.3";\n',
      /cannot be conditionally compiled/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
      '[BepInPlugin(PluginGuid, PluginName, "1.2.3")]\npublic const string PluginVersion = "1.2.3";\npublic const string ReleaseVersion = "1.2.3";\n',
      /must bind exactly one BepInPlugin attribute to PluginVersion/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
      '[BepInPlugin(PluginGuid, PluginName, PluginVersion)]\npublic const string PluginVersion = "1.2.3-rc.1";\npublic const string ReleaseVersion = "1.2.3";\n',
      /PluginVersion must be canonical numeric x\.y\.z for BepInEx/
    ]
  ]) {
    const fixture = await createFixture('1.2.3')
    await writeFile(path.join(fixture, file), source)
    await assert.rejects(validateVersionConsistency({ repositoryRoot: fixture }), expected)
  }
})

test('rejects top-level and packages-empty lock identity drift or missing roots', async () => {
  for (const [field, value, expected] of [
    ['name', '@dyson-control/wrong', /top-level name/],
    ['version', '1.2.4', /top-level version/],
    ['rootName', '@dyson-control/wrong', /packages\[''\] name/],
    ['rootVersion', '1.2.4', /packages\[''\] version/]
  ]) {
    const fixture = await createFixture('1.2.3')
    await mutateJson(path.join(fixture, 'apps/api/package-lock.json'), (json) => {
      if (field === 'rootName') json.packages[''].name = value
      else if (field === 'rootVersion') json.packages[''].version = value
      else json[field] = value
    })
    await assert.rejects(validateVersionConsistency({ repositoryRoot: fixture }), expected)
  }

  const missing = await createFixture('1.2.3')
  await mutateJson(path.join(missing, 'apps/web/package-lock.json'), (json) => { delete json.packages[''] })
  await assert.rejects(validateVersionConsistency({ repositoryRoot: missing }), /packages\[''\] is missing/)
})

test('rejects runtime defaults, environment examples, or README status version drift', async () => {
  for (const [file, expected, replacement, diagnostic] of [
    ['apps/api/src/config.ts', ".default('1.2.3-rc.2')", ".default('1.2.4')", /apiBridgeDefault version/],
    ['apps/api/src/providers/windows-lifecycle.ts', "?? '1.2.3-rc.2'", "?? '1.2.4'", /lifecycleBridgeFallback version/],
    ['.env.example', 'DYSON_DEPLOYMENT_VERSION=1.2.3-rc.2', 'DYSON_DEPLOYMENT_VERSION=1.2.4', /environmentDeploymentDefault version/],
    ['.env.example', 'DYSON_BRIDGE_PLUGIN_VERSION=1.2.3-rc.2', 'DYSON_BRIDGE_PLUGIN_VERSION=1.2.4', /environmentBridgeDefault version/],
    ['README.md', '`1.2.3-rc.2` implementation foundation', '`1.2.4` implementation foundation', /repositoryStatus version/]
  ]) {
    const fixture = await createFixture('1.2.3-rc.2')
    await replaceText(path.join(fixture, file), expected, replacement)
    await assert.rejects(validateVersionConsistency({ repositoryRoot: fixture }), diagnostic)
  }
})

test('rejects missing or duplicate literal runtime/example bindings', async () => {
  const missing = await createFixture('1.2.3')
  await replaceText(
    path.join(missing, '.env.example'),
    '# DYSON_DEPLOYMENT_VERSION=1.2.3\n',
    ''
  )
  await assert.rejects(
    validateVersionConsistency({ repositoryRoot: missing }),
    /DYSON_DEPLOYMENT_VERSION example must contain exactly one literal version binding/
  )

  const duplicate = await createFixture('1.2.3')
  await replaceText(
    path.join(duplicate, 'apps/api/src/config.ts'),
    "  DYSON_BRIDGE_PLUGIN_VERSION: z.string().regex(/^fixture$/).default('1.2.3'),\n",
    "  DYSON_BRIDGE_PLUGIN_VERSION: z.string().regex(/^fixture$/).default('1.2.3'),\n  DYSON_BRIDGE_PLUGIN_VERSION: z.string().regex(/^fixture$/).default('1.2.3'),\n"
  )
  await assert.rejects(
    validateVersionConsistency({ repositoryRoot: duplicate }),
    /DYSON_BRIDGE_PLUGIN_VERSION default must contain exactly one literal version binding/
  )
})

test('rejects hostname-WSS, network V2, or qualified-client cross-runtime protocol drift', async () => {
  const scenarios = [
    {
      file: 'scripts/windows/network/dyson-nebula-hostname-wss-qualification-v1.schema.json',
      from: 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1',
      to: 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V2',
      expected: /hostname-wss-qualification-v1\.schema\.json protocol does not exactly match/
    },
    {
      file: 'scripts/windows/network/DysonHostnameWssQualification.Common.ps1',
      from: "$script:DysonHostnameWssSchemaVersion = 1",
      to: "$script:DysonHostnameWssSchemaVersion = 2",
      expected: /DysonHostnameWssQualification\.Common\.ps1 schemaVersion does not exactly match 1/
    },
    {
      file: 'apps/api/src/client-profile/qualification-v2.ts',
      from: "export const HOSTNAME_WSS_QUALIFICATION_PROTOCOL = 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1' as const",
      to: "export const HOSTNAME_WSS_QUALIFICATION_PROTOCOL = 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V2' as const",
      expected: /qualification-v2\.ts hostname-WSS protocol does not exactly match/
    },
    {
      file: 'scripts/windows/network/dyson-nebula-network-assessment-v2.schema.json',
      from: 'DYSON_NEBULA_NETWORK_ASSESSMENT_V2',
      to: 'DYSON_NEBULA_NETWORK_ASSESSMENT_V3',
      expected: /network-assessment-v2\.schema\.json protocol does not exactly match/
    },
    {
      file: 'scripts/windows/network/DysonNetworkV2.Common.ps1',
      from: '$script:DysonNetworkV2SchemaVersion = 2',
      to: '$script:DysonNetworkV2SchemaVersion = 3',
      expected: /DysonNetworkV2\.Common\.ps1 schemaVersion does not exactly match 2/
    },
    {
      file: 'scripts/windows/network/DysonHostnameWssQualification.Common.ps1',
      from: "[string]$Manifest.protocol -cne 'DYSON_QUALIFIED_CLIENT_MANIFEST_V1'",
      to: "[string]$Manifest.protocol -cne 'DYSON_QUALIFIED_CLIENT_MANIFEST_V2'",
      expected: /qualified client manifest protocol does not exactly match/
    },
    {
      file: 'apps/api/src/client-profile/qualification-v2.ts',
      from: [
        'export const qualifiedClientManifestSchema = z.strictObject({',
        '  protocol: z.literal(QUALIFIED_CLIENT_MANIFEST_PROTOCOL),',
        '  schemaVersion: z.literal(1),'
      ].join('\n'),
      to: [
        'export const qualifiedClientManifestSchema = z.strictObject({',
        '  protocol: z.literal(QUALIFIED_CLIENT_MANIFEST_PROTOCOL),',
        '  schemaVersion: z.literal(2),'
      ].join('\n'),
      expected: /qualified client manifest schemaVersion does not exactly match 1/
    }
  ]

  for (const scenario of scenarios) {
    const fixture = await createFixture('1.2.3')
    await replaceText(path.join(fixture, scenario.file), scenario.from, scenario.to)
    await assert.rejects(validateVersionConsistency({ repositoryRoot: fixture }), scenario.expected)
  }
})

test('parses only bounded optional expected-version and tag arguments', () => {
  assert.deepEqual(parseVersionArguments([]), { expectedVersion: null, tag: null })
  assert.deepEqual(
    parseVersionArguments(['--expected-version', '1.2.3-rc.4', '--tag', 'v1.2.3-rc.4']),
    { expectedVersion: '1.2.3-rc.4', tag: 'v1.2.3-rc.4' }
  )
  assert.throws(() => parseVersionArguments(['--unknown']), /unknown argument/)
  assert.throws(() => parseVersionArguments(['--tag']), /requires one value/)
  assert.throws(() => parseVersionArguments(['--tag', 'v1.2.3', '--tag', 'v1.2.3']), /only once/)
})

test('CLI exits nonzero with a bounded diagnostic on an expected-version mismatch', () => {
  const result = spawnSync(process.execPath, [
    validatorPath, '--expected-version', '9.9.9', '--tag', 'v9.9.9'
  ], { cwd: repositoryRoot, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^Version consistency check failed: repository version does not exactly match 9\.9\.9\r?\n$/)
  assert.equal(result.stdout, '')
})

test('root check runs both version gates before build', async () => {
  const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))
  const check = rootPackage.scripts?.check
  assert.equal(typeof check, 'string')
  const consistency = check.indexOf('npm run version:check')
  const selftest = check.indexOf('npm run version:selftest')
  const build = check.indexOf('npm run build')
  assert.ok(consistency >= 0 && consistency < selftest, 'version consistency must run before its self-test')
  assert.ok(selftest < build, 'both version gates must run before build')
})

async function createFixture(version) {
  const root = await mkdtemp(path.join(tmpdir(), 'dyson-version-consistency-'))
  temporaryRoots.push(root)
  const packages = [
    ['.', 'dsp-nebula-control'],
    ['apps/api', '@dyson-control/api'],
    ['apps/web', '@dyson-control/web']
  ]
  for (const [directory, name] of packages) {
    const target = path.resolve(root, directory)
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'package.json'), `${JSON.stringify({ name, version }, null, 2)}\n`)
    await writeFile(path.join(target, 'package-lock.json'), `${JSON.stringify({
      name,
      version,
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name, version } }
    }, null, 2)}\n`)
  }
  const bridgeDirectory = path.join(root, 'integrations', 'dyson-control-bridge')
  await mkdir(bridgeDirectory, { recursive: true })
  await writeFile(path.join(bridgeDirectory, 'DysonControlBridge.csproj'), [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    `    <Version>${version}</Version>`,
    `    <AssemblyVersion>${versionCore(version)}.0</AssemblyVersion>`,
    `    <FileVersion>${versionCore(version)}.0</FileVersion>`,
    `    <InformationalVersion>${version}</InformationalVersion>`,
    '    <IncludeSourceRevisionInInformationalVersion>false</IncludeSourceRevisionInInformationalVersion>',
    '  </PropertyGroup>',
    '</Project>',
    ''
  ].join('\n'))
  await writeFile(path.join(bridgeDirectory, 'DysonControlBridgePlugin.cs'), [
    'namespace DysonControl.Bridge',
    '{',
    '    [BepInPlugin(PluginGuid, PluginName, PluginVersion)]',
    '    public sealed class DysonControlBridgePlugin',
    '    {',
    `        public const string PluginVersion = "${versionCore(version)}";`,
    `        public const string ReleaseVersion = "${version}";`,
    '    }',
    '}',
    ''
  ].join('\n'))
  const apiSourceDirectory = path.join(root, 'apps', 'api', 'src')
  await mkdir(path.join(apiSourceDirectory, 'providers'), { recursive: true })
  await writeFile(
    path.join(apiSourceDirectory, 'config.ts'),
    `  DYSON_BRIDGE_PLUGIN_VERSION: z.string().regex(/^fixture$/).default('${version}'),\n`
  )
  await writeFile(
    path.join(apiSourceDirectory, 'providers', 'windows-lifecycle.ts'),
    `      bridgePluginVersion: options.bridgePluginVersion ?? '${version}',\n`
  )
  const networkDirectory = path.join(root, 'scripts', 'windows', 'network')
  await mkdir(networkDirectory, { recursive: true })
  await writeFile(
    path.join(networkDirectory, 'dyson-nebula-hostname-wss-qualification-v1.schema.json'),
    `${JSON.stringify({
      type: 'object',
      properties: {
        protocol: { const: 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1' },
        schemaVersion: { const: 1 }
      }
    }, null, 2)}\n`
  )
  await writeFile(
    path.join(networkDirectory, 'dyson-nebula-network-assessment-v2.schema.json'),
    `${JSON.stringify({
      type: 'object',
      properties: {
        protocol: { const: 'DYSON_NEBULA_NETWORK_ASSESSMENT_V2' },
        schemaVersion: { const: 2 }
      }
    }, null, 2)}\n`
  )
  await writeFile(path.join(networkDirectory, 'DysonHostnameWssQualification.Common.ps1'), [
    "$script:DysonHostnameWssProtocol = 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1'",
    '$script:DysonHostnameWssSchemaVersion = 1',
    'function Test-FixtureQualifiedClientManifest {',
    "    if ([string]$Manifest.protocol -cne 'DYSON_QUALIFIED_CLIENT_MANIFEST_V1' -or",
    '        -not (Test-DysonHostnameWssJsonInteger -Value $Manifest.schemaVersion -Minimum 1 -Maximum 1) -or',
    '        $false) { throw }',
    '}',
    ''
  ].join('\n'))
  await writeFile(path.join(networkDirectory, 'DysonNetworkV2.Common.ps1'), [
    "$script:DysonNetworkV2Protocol = 'DYSON_NEBULA_NETWORK_ASSESSMENT_V2'",
    '$script:DysonNetworkV2SchemaVersion = 2',
    ''
  ].join('\n'))
  const clientProfileDirectory = path.join(apiSourceDirectory, 'client-profile')
  await mkdir(clientProfileDirectory, { recursive: true })
  await writeFile(path.join(clientProfileDirectory, 'qualification-v2.ts'), [
    "export const HOSTNAME_WSS_QUALIFICATION_PROTOCOL = 'DYSON_NEBULA_HOSTNAME_WSS_QUALIFICATION_V1' as const",
    "export const QUALIFIED_CLIENT_MANIFEST_PROTOCOL = 'DYSON_QUALIFIED_CLIENT_MANIFEST_V1' as const",
    '',
    'export const hostnameWssQualificationDocumentSchema = z.strictObject({',
    '  protocol: z.literal(HOSTNAME_WSS_QUALIFICATION_PROTOCOL),',
    '  schemaVersion: z.literal(1),',
    '})',
    '',
    'export const qualifiedClientManifestSchema = z.strictObject({',
    '  protocol: z.literal(QUALIFIED_CLIENT_MANIFEST_PROTOCOL),',
    '  schemaVersion: z.literal(1),',
    '})',
    ''
  ].join('\n'))
  await writeFile(path.join(root, '.env.example'), [
    `# DYSON_DEPLOYMENT_VERSION=${version}`,
    `# DYSON_BRIDGE_PLUGIN_VERSION=${version}`,
    ''
  ].join('\n'))
  await writeFile(path.join(root, 'README.md'), `> Project status: \`${version}\` implementation foundation.\n`)
  const workflowDirectory = path.join(root, '.github', 'workflows')
  await mkdir(workflowDirectory, { recursive: true })
  await writeFile(path.join(workflowDirectory, 'ci.yml'), [
    'name: CI fixture',
    'jobs:',
    '  check:',
    '    steps:',
    '      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
    '        with:',
    '          node-version: 24.20.0',
    '      - uses: actions/setup-dotnet@26b0ec14cb23fa6904739307f278c14f94c95bf1',
    '        with:',
    '          dotnet-version: 8.0.424',
    '      - shell: pwsh',
    '        run: |',
    "          if ($LASTEXITCODE -ne 0 -or $nodeVersion -cne '24.20.0') {",
    "          if ($LASTEXITCODE -ne 0 -or $dotnetVersion -cne '8.0.424') {",
    ''
  ].join('\n'))
  return root
}

async function setPackageVersion(root, directory, version) {
  for (const file of ['package.json', 'package-lock.json']) {
    await mutateJson(path.join(root, directory, file), (json) => {
      json.version = version
      if (file === 'package-lock.json') json.packages[''].version = version
    })
  }
}

async function mutateJson(filePath, mutate) {
  const json = JSON.parse(await readFile(filePath, 'utf8'))
  mutate(json)
  await writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`)
}

async function replaceText(filePath, expected, replacement) {
  const source = await readFile(filePath, 'utf8')
  assert.ok(source.includes(expected), `fixture text is missing: ${expected}`)
  await writeFile(filePath, source.replace(expected, replacement))
}

function versionCore(version) {
  return version.split('-rc.', 1)[0]
}
