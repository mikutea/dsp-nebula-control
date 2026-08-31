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
  assert.equal(current.version, '0.1.0')
  assert.deepEqual(current.packages.map(({ name }) => name), [
    'dsp-nebula-control', '@dyson-control/api', '@dyson-control/web'
  ])
  assert.deepEqual(current.bridge, {
    projectFile: 'integrations/dyson-control-bridge/DysonControlBridge.csproj',
    projectVersion: '0.1.0',
    pluginFile: 'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
    pluginVersion: '0.1.0'
  })
  await validateVersionConsistency({
    repositoryRoot,
    expectedVersion: current.version,
    tag: `v${current.version}`
  })

  for (const version of ['0.0.0', '1.2.3', '10.20.30-rc.0', '10.20.30-rc.12']) {
    const fixture = await createFixture(version)
    await validateVersionConsistency({ repositoryRoot: fixture, expectedVersion: version, tag: `v${version}` })
  }
})

test('rejects every non-canonical manifest, expected version, and tag form', async () => {
  for (const version of [
    'v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2', '1.2.3.4',
    '1.2.3-alpha.1', '1.2.3+build.1', '1.2.3-rc.01', '1.2.3-RC.1'
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

test('rejects Bridge project or plugin version drift and non-canonical values', async () => {
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
    /DysonControlBridgePlugin\.cs PluginVersion does not exactly match 1\.2\.3/
  )

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
      /exactly one const string PluginVersion declaration/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
      'public sealed class Plugin { public const string PluginVersion = "1.2.3"; public const string PluginVersion = "1.2.3"; }\n',
      /exactly one const string PluginVersion declaration/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
      'public sealed class Plugin { internal const string PluginVersion = "1.2.3"; }\n',
      /must use one public const string declaration/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
      '#if RELEASE\npublic const string PluginVersion = "1.2.3";\n#endif\n',
      /PluginVersion cannot be conditionally compiled/
    ],
    [
      'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
      '[BepInPlugin(PluginGuid, PluginName, "1.2.3")]\npublic const string PluginVersion = "1.2.3";\n',
      /must bind exactly one BepInPlugin attribute to PluginVersion/
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
    `        public const string PluginVersion = "${version}";`,
    '    }',
    '}',
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
