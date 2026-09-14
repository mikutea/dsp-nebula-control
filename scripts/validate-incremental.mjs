import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const baseline = 'f7c1d6186460a8586d8532978ec339a9d62686bb'
// Advance a component only after its relevant checks actually pass. A failed
// unrelated group must not erase completed evidence for an unchanged component.
export const componentBaselines = Object.fromEntries(
  ['status', 'recovery', 'bootstrap', 'lifecycle', 'deployment'].map(group => [group, {
    commit: baseline,
    evidence: 'https://github.com/mikutea/dsp-nebula-control/actions/runs/34459007627'
  }])
)
componentBaselines.lifecycle = {
  commit: baseline,
  evidence: 'https://github.com/mikutea/dsp-nebula-control/actions/runs/34459007627'
}
const versionFiles = new Set([
  '.env.example', 'README.md', 'package.json', 'package-lock.json',
  'apps/api/package.json', 'apps/api/package-lock.json',
  'apps/web/package.json', 'apps/web/package-lock.json',
  'apps/api/src/app.test.ts', 'apps/api/src/config.test.ts', 'apps/api/src/config.ts',
  'apps/api/src/providers/windows-lifecycle.integration.test.ts',
  'apps/api/src/providers/windows-lifecycle.test.ts', 'apps/api/src/providers/windows-lifecycle.ts',
  'integrations/dyson-control-bridge/DysonControlBridge.csproj',
  'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs'
])
const reviewedPaths = new Set([
  '.github/workflows/ci.yml', '.github/workflows/release.yml', 'global.json',
  'scripts/windows/release/release-workflow.test.mjs',
  'scripts/windows/Get-DysonStatus.ps1',
  'scripts/windows/data-recovery/DysonDataRootRecovery.Common.ps1',
  'scripts/windows/data-recovery/SelfTest-DysonDataRootRecovery.ps1',
  'scripts/windows/lifecycle-broker/Install-DysonLifecycleBrokerTask.ps1',
  'scripts/windows/lifecycle-broker/Invoke-DysonLifecycleBrokerWorker.ps1',
  'scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1',
  'scripts/windows/deployment/Install-DysonControl.ps1',
  'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1',
  'scripts/windows/bootstrap/DysonGameLifecycleBootstrap.Common.ps1',
  'scripts/windows/bootstrap/SelfTest-DysonGameBootstrapPointer.ps1',
  'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1',
  'apps/api/src/providers/windows-status-script.test.ts',
  'apps/api/src/providers/powershell-runner.ts', 'apps/api/src/providers/powershell-runner.test.ts',
  'apps/api/src/config.test.ts', 'apps/api/src/providers/windows-lifecycle.test.ts',
  'apps/api/src/services/lifecycle-service.test.ts',
  'scripts/validate-incremental.mjs', 'scripts/validate-incremental.test.mjs',
  'docs/incremental-validation.md', 'AGENTS.md'
])
const normalize = text => text.replaceAll('\r\n', '\n')
const controlExitBefore = "    if ($process.ExitCode -ne 0) { throw 'The managed DSP process exited with a non-zero result.' }"
const controlExitAfter = [
  '    # Windows reports a delivered console interrupt as STATUS_CONTROL_C_EXIT.',
  '    # The stable bootstrap still requires its durable completed stop intent;',
  '    # unrelated non-zero exits remain failures.',
  '    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne -1073741510) {',
  "        throw 'The managed DSP process exited with a non-zero result.'",
  '    }'
].join('\n')

// Exact normalized source identities: any additional runtime edit falls back to
// the regular bootstrap impact plan instead of inheriting this narrow check.
const aclSourceHash = source => createHash('sha256').update(normalize(source).trimEnd() + '\n').digest('hex')
const aclBeforeHash = 'b8ff1c53b36ceb1cb8c4f104621c967108c6c2b0c6f667410e3522453e51a1c9'
const aclAfterHash = '693e50ca6767358d9e0409987c994c804bc1e6d19be9c9b0f533cf2399a2b253'

// Only this reviewed startup patch receives the focused plan. Version labels
// are checked independently; any other runtime edit requires another plan.
const startupSourceHash = source => createHash('sha256').update(
  normalize(source).replace(/0\.1\.0-rc\.[0-9]+/gu, '0.1.0-rc.17').trimEnd() + '\n').digest('hex')
const startupSources = new Map([
  ['.env.example', {before:['dc9ffe019ee75ebc78a5eaa66791eaefce83d997acd5fe89a87bcc9c034e1188'],after:'212c2da8da402295fcc8c6069b0638deba7c0d271c1a9939c3b5902f4ec597c5'}],
  ['apps/api/src/app.ts', {before:['81ec044b1c43fa4f889336358caeaace096cb660c35376080fb5b306ab90c90c'],after:'6d9f409fd31f203b321b3608fed10044d32e115e4723e70b569f25d60e522b35'}],
  ['apps/api/src/config.ts', {before:['57e07a049b2e2a689353019cb3269b90e74d1a50e908a805a6e7d4051acc0c0d'],after:'d6ef2a5190fa2185ac289474d3547454e9669ae2924004fe1aee73ab24c405ba'}],
  ['apps/api/src/providers/windows-lifecycle.ts', {before:['9cd75b88447c8a4d558b35d00a0dccb1c32716843101a1ffc86cffb4a3e95380'],after:'e4b3f5620efd0f4411c167296d63d9a75befacd2cecd0bb838dc7e290c09ad8c'}],
  ['apps/api/src/services/lifecycle-service.ts', {before:['2bc2acada832a4383cb37fa44521f9120a8af145bba5f6496521970cc533a3f0'],after:'7a314149dadf2403b4d586af1dbe4de2690226eb57beb6588815a9a6ec81b625'}],
  ['scripts/windows/lifecycle-broker/Invoke-DysonLifecycleBrokerWorker.ps1', {before:['bf7725ecd25c309c7f7e4c6e2050902e5919a920cc45896931a320634f6ff425','4c55d309e150b3f8cc5f52afb6f45affc8edef44974365f6e09ec92deede3a70'],after:'620e27b382b67509aad17facac91854d4442de7699302e8784735d7065a6fa4a'}]
])

// Immutable RC23 source bytes verified by local integration and target-host
// recovery checks. See docs/incremental-validation.md; edits never inherit reuse.
const rc23VerifiedSources = new Map([
  [".env.example", "ce7625087de978204de8c36bf777f6c1ee47d4865bf9d8ae20e027cab81dd382"],
  ["apps/api/package-lock.json", "b0fc9173b227c9cb87b06db4fabbc5ee164a4fcb9e68e151bbbd1170d1f22bd4"],
  ["apps/api/package.json", "f9cdb3c4b3130c5a2f2a7ff279d72740768f7f693608ad7180e7014db5c056f4"],
  ["apps/api/src/app.test.ts", "da90f1aef0cf8eea18cc942a26b12f5865bebda17f6d825354b33a491eca5cd8"],
  ["apps/api/src/app.ts", "6c1b83159f24f8911834fb0aca8d6fffa11e3ac850de13bd27351620510b5847"],
  ["apps/api/src/config.test.ts", "8ca04559be3eba3876c06508dcc80a041a6ab6d5fe9790546f6ae9fc35271cf2"],
  ["apps/api/src/config.ts", "f56375e7515c10bf029658043330d89fe369fc935667e8667c40f41c966dd234"],
  ["apps/api/src/configuration-apply-coordination.test.ts", "0a00855eaed2d0bed43f6805cc52f8f13abb90d4adf7481122720f36903bdcbb"],
  ["apps/api/src/configuration-reconcile-coordination.test.ts", "2d3d8ca2a48f59a051c1306d9474566858334084adbd82cfdf3d9e74f2c4ee5e"],
  ["apps/api/src/game-config/history-hard-exit.test.ts", "0e279fee028151e889f9f5a5965ebd8cc7c7f4739e4a7860c9f00f46d54afac4"],
  ["apps/api/src/game-config/history.test.ts", "873f9143c22a79883c6d6a3b4baa65cb75a97f3ad1ff88e12745d2a83314a026"],
  ["apps/api/src/game-config/history.ts", "f8fd17dcdcf28410f911d9de9aceebbda825bc0bce7a8183ec4bf1326f1714c8"],
  ["apps/api/src/game-config/transaction.test.ts", "4561b74316ab9dd5ca61ed40b6451ccf090b467d28558b7508a979f33b38fd46"],
  ["apps/api/src/game-config/transaction.ts", "f3365914bffc0c73d0cee84771e7d3c8c1f466b5734cb90f767e984f515bca29"],
  ["apps/api/src/host-mutation/residual-file-lock.test.ts", "0d5e75cb2724be3ab868ca9789de2ad5b201de75fc16dd1baf708c3bcba25282"],
  ["apps/api/src/host-mutation/residual-file-lock.ts", "421f5c2f52be614fc1fccd3b6b9c5018a3f3a911aebbf7022de606924814dbab"],
  ["apps/api/src/providers/powershell-output.test.ts", "6b17addafb342a10be5face0fa1cabfd00cb7abfd34b0185817250a353e915c2"],
  ["apps/api/src/providers/powershell-runner.ts", "0ecda7cd829daf472d311d6c41270ae6c5ccf60a891c16f5eedb4425e36b72b8"],
  ["apps/api/src/providers/windows-lifecycle.integration.test.ts", "f5a39c275aa6f0aacf9f652181295bcaa9590a93eb5ab2a94721b0dc71e7dcce"],
  ["apps/api/src/providers/windows-lifecycle.test.ts", "08b9fff9c0e6b8fa6961896bbc1e9557038fea162deac7bf789d0dc1d5d0bac8"],
  ["apps/api/src/providers/windows-lifecycle.ts", "5e32d9364c444d1a606215b11f01c5a330bfef5550a889a7670ed03b32c99163"],
  ["apps/api/src/providers/windows.ts", "f7c89a69e84221931113389fafc3922e0bd64395e994cff4fbc98e2aa57432b3"],
  ["apps/api/src/saves/restore-hard-exit.test.ts", "b297ff909beb47a97d5df3f482fdcec2ce71b173122b429d340c04ed5c4bc788"],
  ["apps/api/src/saves/transactions.ts", "b58b494950ecf972db60eda47847bfe2fe9196a59b95c00f51b5b68cbb22a5c8"],
  ["apps/api/src/services/save-job-service.test.ts", "8b64858f59634b4ea1d9fedd856eeae4edd395cdbb2d9558b8018bd0fc101284"],
  ["apps/api/src/services/save-job-service.ts", "9a20100f61bcb9dc4393e127dd36982a0ace838345c9a1659d6ac5940b413879"],
  ["apps/api/src/update-pipeline/acquisition.test.ts", "9e4b79656faff0ac040f625aadfb8bc6e855b3f18cca37626ffafb10eb481482"],
  ["apps/api/src/update-pipeline/acquisition.ts", "51233221385fadadda8eee75f2d44ceb3f22d67910fb443838f09557f457553d"],
  ["apps/api/src/update-pipeline/cache-mutex.test.ts", "d5af1b16c05a5716f48605965bff07a8e767dd29e4cb3a8bbc9ca67e90a0898a"],
  ["apps/api/src/update-pipeline/cache-mutex.ts", "677b91ceb8639722a5966a25db3decb5e0f5d286723ffa8fcec516c7efc7063a"],
  ["apps/api/src/update-pipeline/candidate-preparation.ts", "01738356f8454de8a6429280544632579e449a3940405f87bd823ee8cb8fb8cf"],
  ["apps/api/src/update-pipeline/staging.test.ts", "3e7a15f380895e48817a4688e0c3349a75cf383b7ac60eb8788cc3e1d2f98452"],
  ["apps/api/src/update-pipeline/staging.ts", "8279dc02d36e4373ac0bc5188b0dc59271469a1645bcce07ce1c9b8bd1eb1b3c"],
  ["apps/api/src/update-pipeline/steam-manual-handoff.test.ts", "1c60ce99efd38f0a8d63ffe440bf5aecb5421c96d279f600c5f5c065f6c52c87"],
  ["apps/api/src/update-pipeline/steam-manual-handoff.ts", "718100e77137a9b8d42638eec7d522fe2b9797c3cc79cdeba89baad4df0250d2"],
  ["apps/api/src/workspace-routes.test.ts", "c51dea7c13c771d8c55f87f06326aa0c2572b8935f8f70f1b8987dd864e313b4"],
  ["apps/web/package-lock.json", "27b062ecf2ed2ac88d38a30cd432132e9e38af1f683f73d0dc557fad54b76f2b"],
  ["apps/web/package.json", "a2e7c3f1d45457185867acdb76636316ea2f542d0b9eaa56b3da416265044c51"],
  ["apps/web/src/App.tsx", "3c8e1d5d7dad5a68ed6b3ba51e7a8a0fb86b4272e9af3d30a20d330d9c8613d4"],
  ["apps/web/src/api.ts", "8da161c4213d57c5aa010dbb731badd59d93c52fed2cc95bb9ccb0ab19a4e1e8"],
  ["apps/web/src/configuration-workspace.test.tsx", "f8d0db0349ecdf2cd648e7c70c34c55e9f0cbe118d7a1957c33b46f7de89c997"],
  ["apps/web/src/model.ts", "76efc918cb5ada5ed30726d69b692b833c71a757ce82591fb57518ccd516841e"],
  ["apps/web/src/styles.css", "db054a3c03f8489d240eb3a703dd6a9b67778461048c2f3b61cbe5cc65e06a26"],
  ["integrations/dyson-control-bridge/DysonControlBridge.csproj", "751afe5332e2d05f2c03d555abfd350b7d1fa8dd9368207f14f8f24d4c108b79"],
  ["integrations/dyson-control-bridge/DysonControlBridgePlugin.cs", "8419c3114da427e5bfad5231cfe7fd26a001b5b7d6150b234f4d5c4c6a8e58a4"],
  ["package-lock.json", "b96775591b9aa67e96616dee8db733ec486f74f3bbb612b92b8e53a574ecd094"],
  ["package.json", "d8edd1c6d3e9fd5a55d1411680c0860a4a1888ee893ae74db344f7daf463fb80"],
  ["scripts/windows/configuration/dyson-control.environment-contract.json", "8ae71deb1f48f4b32b415b8fa6071b2ca3718e02a439d7bd5bd4fcdffb9c31e0"]
])

// Reuse the existing configuration gate without migrating the persisted contract.
const configurationGateSources = new Map([
  [".env.example", "6ea35413832696eb4fb1dd5d2ee4247df56d7173b37ac65821f8a6088ad2ee76"],
  ["apps/api/src/config.ts", "a4f154beec0605fa66b67b6fc7e340ec9e26158c494f99d134829190d788b9ca"],
  ["apps/api/src/config.test.ts", "a80d70a009148924def94a384ae49acb1518c427b9b1e758557bd86723cb8d99"],
  ["scripts/windows/configuration/dyson-control.environment-contract.json", "5386f42df066b3d5ce4fa26f3346baf4311b0ec8efb1eb4d83bdf488c14786dc"],
  ["apps/api/src/configuration-apply-coordination.test.ts", "050b0628880f50a8708468840c2f27ea21f1210a6a44645ad9b600e40c6329f8"],
  ["apps/api/src/configuration-reconcile-coordination.test.ts", "d805c6526e1b91b7596979f74115af7518c65da85d4542079c424d6547cfd81c"]
])

// Exact source bindings select affected tests; they do not reuse unexecuted evidence.
// Exact source evidence: CI 34553851609, commit 79fe8ce5854d4a8fa071c647d524706b4bf3423b.
const reviewedRc24ApplicationSources = new Map([
  [
    "apps/api/src/app.ts",
    "cf5ddb604e912f19839652ae7827bc63e6f806776cfbf76ab84a9a56cc132ec8"
  ],
  [
    "apps/api/src/mods/thunderstore-import.ts",
    "e534d3b049b4f4b8e984368b1fc062a2467caf13625775c5d65bf60034bb7311"
  ],
  [
    "apps/api/src/mods/thunderstore-import.test.ts",
    "a9667ec105455f6592042f9c93aacaf48291eaee9c9b7a7e03e98a99a1df8323"
  ],
  [
    "apps/api/src/update-acquisition-routes.test.ts",
    "b0063cd955bd7583daac1486bd3774d9204e030a439e59176e5ce8da4dac0e1e"
  ],
  [
    "apps/api/src/update-pipeline/acquisition-http.ts",
    "e8e9e404b9917ebd2a7a84ac9822ac82b9cf969ba4259c64a4fb9c9d81a26ec8"
  ],
  [
    "apps/api/src/update-pipeline/acquisition.ts",
    "a00634ca8ba2679ffdae114b4d71bc021c38e6fb1cefdf1884f9d553d36910d1"
  ],
  [
    "apps/api/src/update-pipeline/acquisition.test.ts",
    "4b9a9f6cc50da0eccc374b64d628f3c35117c2fa47f54113d8286490b73c11de"
  ],
  [
    "apps/api/src/update-pipeline/bepinex-discovery.ts",
    "9e71b7e3f7b6468b810abe2e1aedbede8ffd1cd50e647e2ee588607076d53799"
  ],
  [
    "apps/api/src/update-pipeline/bepinex-discovery.test.ts",
    "48ad7ab06688eb63beb27ca048dab295401a0d05db4bbd8a1ede607aaf76ff7b"
  ],
  [
    "apps/api/src/update-pipeline/discovery.ts",
    "614f8d7ed2f454052eef6a5d13316ee4daf5fd2839852f54fe08250e623fe482"
  ],
  [
    "apps/api/src/update-pipeline/discovery.test.ts",
    "2a845ab08982382dd6bdc5a6fd8d5e1aa929fb59551870b9f5a2fa1724750796"
  ],
  [
    "apps/api/src/update-pipeline/trusted-compatibility.ts",
    "25ad2afae7ba554f21b7d8802392992c8ebd5c786f72aba6eb33cbb561fd185c"
  ],
  [
    "apps/api/src/update-pipeline/trusted-mod-artifacts.ts",
    "b65afdd57290073f250207c4e77afaee6ac755356224ea3ed228d1adfdfe1b29"
  ],
  [
    "apps/api/src/update-pipeline/trusted-mod-artifacts.test.ts",
    "943cc66731b7ea6aaf23a647d2a6a6562d68ccff0bf4baf1fa44f429531b7f81"
  ],
  [
    "apps/web/src/model.ts",
    "4b2b7ff1e0e14c206a81828c09ad6fb69492124c1fb6c427f0092b5f4100b276"
  ],
  [
    "apps/web/src/ModSupplyWorkspace.tsx",
    "bae0c90442ccca255bafeb54be6ceb7f3a1bf1cd10530f5a1f4693bb2490c712"
  ],
  [
    "apps/web/src/mod-supply-workspace.test.tsx",
    "05a6c01a1bd8d13b0fbb121c3237ca4d646498cf38710f97e26da4a9adf05e86"
  ],
  [
    "apps/api/src/providers/windows.ts",
    "de8a4f11f3ffed76390daae1b27b8851928d6b936f7b098fb3038d30eafe0f13"
  ],
  [
    "apps/api/src/providers/windows-lifecycle-broker.ts",
    "fe99ca01d49c01608cb84207420a197d04b6224472582a40b7f92af25dece027"
  ],
  [
    "apps/api/src/providers/windows-lifecycle-broker.test.ts",
    "1d74082b7b2c2b58e311f50435c8d12538cfb4dfd1b6a7888c023c4d1ba207f3"
  ]
]);

const reviewedEntryCacheSources = new Map([
  [
    "apps/api/src/app.ts",
    "e3fedae925e1e34a0ef03fc2bd7e25b2891708d16b37065999feab4905332dcb"
  ],
  [
    "apps/api/src/web-assets.ts",
    "eae463e526d91fb35676743755d7c10b8be861076694bae0a360544fe4ff6ca8"
  ],
  [
    "apps/api/src/web-assets.test.ts",
    "5849cae43e2a47fde7911858c5fdabbbbb4b236ec435c0788fe6d7e636e907ac"
  ]
]);

const reviewedPredecessorSources = new Map([
  [
    "apps/api/src/app.ts",
    "430248ca4ab3d3d316a32c8d91fc92c9cad3c21cec4d4a1bb419a911c38b2318"
  ],
  [
    "apps/api/src/update-pipeline/activation-types.ts",
    "d38235f815b9b992e71a33539eab38d8b01c8f9202179ee08712c76c501307ac"
  ],
  [
    "apps/api/src/update-pipeline/activation.ts",
    "c63ccb54a930b95c99dfe0e70257c9e8cbf09bc39888114a77983155c9076918"
  ],
  [
    "apps/api/src/update-pipeline/activation.test.ts",
    "667775c7da3bb6ffcb5bc11953a4ed3554711706399a2033d4385fa54b339fce"
  ],
  [
    "apps/api/src/update-pipeline/activation-http.ts",
    "5f3af8317b4dc06ad157bd576fba04419f4f8b7d962f67ca6a7cb08a153fd1dc"
  ],
  [
    "apps/api/src/providers/windows-update-activation.ts",
    "27353c39ccb8524af5e4f759ab83283d27d34efe68f18ea4d7d3b5ce41d2daa6"
  ],
  [
    "apps/api/src/providers/windows-update-activation.test.ts",
    "396ccbfe413d55aca4b214a8b3440ea26980e096f13dd48443d8208d1296e97f"
  ],
  [
    "apps/api/src/providers/windows-update-transaction-provider.ts",
    "e739b2a8b9704ab6ef72712bc5efccf91a995cd3dc39c9466803a71b5a40ecc7"
  ],
  [
    "apps/api/src/providers/windows-update-transaction-provider.test.ts",
    "d0010a85e189ce869a7c72c7a6b58fcfbe74200f1bfa6266d0963c46b47a3a11"
  ],
  [
    "apps/api/src/update-activation-app-wiring.test.ts",
    "5bae00ecb08b9aead6d25c7275e01e4b050a12df4617c631fc331651640f68e6"
  ],
  [
    "apps/api/src/windows-update-production-assembly.test.ts",
    "68963e13fc6fcf838acb982e6b20b1dfc088e2f62ac6693e10fa883ea37a624c"
  ]
]);

const reviewedOperatorBatchSources = new Map([
  ["scripts/windows/deployment/SelfTest-DysonDeploymentConfigurationIntegration.ps1", "a76a62b482ced1838d724e0621711069f2de8951ace95cb3e47b835029d98b5f"],
  ["scripts/windows/deployment/DysonDeployment.Common.ps1", "a5c30216907649e1e72780bbf3047394273423208c348f378bdc9f3468f00d69"],
  ["apps/api/src/update-pipeline/steam-manual-handoff.test.ts", "1169cda955e9146239491183bde46179fc1991dd3a3aa354d645f82e303af30e"],
  ["apps/web/src/recoverable-cleanup-panel.test.tsx", "0e63eec7996a82ee63164c43899c0dc6b16d3df5681328e43962e7cb75f2a69a"],
  ["apps/web/src/RecoverableCleanupPanel.tsx", "d1cb2ab6bed980200aef9397148f1079a314f2db48a8404dcac1ad6507ec7dd2"],
  ["apps/web/src/recoverable-cleanup-api.test.ts", "6edecef10d5d9f72a24f8f8615fa518adcc4b40e7cb1195fb5bc6a722570ece5"],
  ["apps/web/src/recoverable-cleanup-api.ts", "3f3e49a4488720d8fe4323e3532260344ca2c4b55c79a8845f57750652e5034f"],
  [".env.example", "c2691fd8bbe92565144af301611e99d48a42db1d17b9dd182fd05a6945fb9c3a"],
  ["scripts/windows/configuration/dyson-control.environment-contract.json", "ceb58c8a4c19dc8092641d9a9897cb8e50a0f0c82f789618c2d612c6bdddd17c"],
  ["apps/api/src/config.test.ts", "683610009f11bf3915da3db97d23361c8a45dc0703a3f263ed811c28c33762f7"],
  ["apps/api/src/config.ts", "9e4cc7507bfa10f643fbcd737c8143effc1dc674fa926cac86f244b101aceb68"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-http.test.ts", "78069bbfb7d4558e6caca3f768d845a77542bb0c5505eb80fdb2e112ce47f7c5"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-http.ts", "9cfe0784758d785b642c6914fab86ca5e468df7f0e5f4487a2d9ed196bf26f33"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-coordinator.test.ts", "e402bac0b9e05bd7e42ec24063806a0233c304eb918a6b751ebf99d5108de617"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-coordinator.ts", "5ab64a97f2867705c778ab104f38d118d11f1fab5138bba1b19507023ca1c329"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-execution.test.ts", "23de652dc53cc338ad17a610edcfb9fa403fe28c3434c1565b8496933c7a0500"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-execution.ts", "eb58ceebff8a04a171173e0700511f72e5faf475db83fe22ad7e41f9dbe8fef7"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-records.test.ts", "a10111e8e1da42a365d9ac1864c5f107631587dc23d5bf85c2aa2fc1e9a757e3"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-records.ts", "70c47ecf201c62cd2a7be50d28c44267f1ce2896d84a6746de8d59cbc46ecc22"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-files.test.ts", "d92cbcb8288f8dc0416236a0cc543460885014adb10536d248483c09d9a1525b"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-files.ts", "b0f854635757653107da2f27b26b7a318db19c4b9d92f603999cbd97700c1189"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-inventory.test.ts", "aeff61a99c5339229594ef8ff65234114702eac7f8cfe65c6fa7c143e390d963"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-inventory.ts", "6f7df8653f5fa8feb036d99deba4013a4cd61170882e28b270c4cce0771725e6"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-move.test.ts", "a8fbca240d4d2adb1f0bf8d69218bb0c64f172210b0a4857eefdef7c512b3f14"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-move.ts", "3f64867d39610c09e7fe0aa9b503a51e5106ade8c3234d51d8ee9992ac7056b5"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-plan.test.ts", "957ad8537ca622a13ce96f3d9bbe7c72ec71f50a9e3d7699682de7a4fcd8a507"],
  ["apps/api/src/update-pipeline/recoverable-cleanup-plan.ts", "527d131fb591a872a962c2e1eb9194ea4468540ab4d0dac3283b0c1e780c6a42"],
  ["apps/api/src/storage/database.test.ts", "0e2ce6f9f0a6fc769d0197354d3ea9582d39f755e207f2c985af26e8d6be0bfe"],
  ["apps/api/src/storage/database.ts", "bfb67d031aedf8cb1968b7099dc261cb2e31453528b356a7a1e88dbb9f1ffd72"],
  ["apps/web/src/TasksAuditWorkspace.tsx", "2dc3e69cb5ab8c2c90b6bbccc04831fdd2b43659e2dbdc1a20649443e2e21c53"],
  ["apps/web/src/model.ts", "86b7b41a9d138ce101bbd90acfc56faec41a9a17c8092f9afeeca6795ca9beaa"],
  ["apps/api/src/domain.ts", "d09dbcd0ae4590826950db3be8bc9936cc9e4ceb3e7482bd4ca62ded5e462f4e"],
  ["apps/web/src/App.tsx", "24b26e1fbcb10278712a7d5894ce93e436c4a6e965a7a3a4a1cc43bfecf650fd"],
  [
    "apps/api/src/app.ts",
    "c816035010e9dfc146478b85090d4510307ca9fc883355d72af9801540a0190e"
  ],
  [
    "apps/api/src/lifecycle/game-runtime-receipts.test.ts",
    "df9f7532030878b54e14bae5a62b9ab6fa89851e0b451f0d5067fbcac074e66b"
  ],
  [
    "apps/api/src/lifecycle/game-runtime-receipts.ts",
    "34bf0f205b8aecea38c01d194035546e94340b0f62c5dac188ebce0c9bbf508a"
  ],
  [
    "apps/api/src/providers/windows-lifecycle.test.ts",
    "42bfd6e1bbfa49e82b085ca49eb83ea55c9bbaea2d1922eb4055379ae19f45a7"
  ],
  [
    "apps/api/src/providers/windows-lifecycle.ts",
    "eb4ee98c8a98c54d2bfd202acbd726cf9e9d86edcaa9d56654656180f5c7f9af"
  ],
  [
    "apps/api/src/providers/windows-runtime-compatibility.test.ts",
    "18b85372ae9b0f390ff5069382e05998784a2ea73aaebf0369ffaed12a3326f1"
  ],
  [
    "apps/api/src/providers/windows-runtime-compatibility.ts",
    "d258edf5a9e49c4e2e6c0efe2c48811e0852058796bfcf8a1bb969b4f170d4fd"
  ],
  [
    "apps/api/src/providers/windows-update-activation.test.ts",
    "360981495cf844bc2a0b12b91c6da5e67772aaa69d9de51bade005703fa68183"
  ],
  [
    "apps/api/src/providers/windows-update-activation.ts",
    "a60afcab83c6bc0813eb265b7dc793333a7e640dd384237c1e2584ae2ca929a3"
  ],
  [
    "apps/api/src/providers/windows-update-lifecycle-composition.test.ts",
    "5243bffc8333e2f7a639c4023f76d2172ef02ba627a0faaf5e67f7ee10808aef"
  ],
  [
    "apps/api/src/providers/windows-update-runtime-evidence.test.ts",
    "9aeecd5dc99eee306ff53e36d5f1f7ea3b84389ae5b811ab97c9f3a6c4870504"
  ],
  [
    "apps/api/src/providers/windows-update-runtime-evidence.ts",
    "351a25e6625593fa6ed5cfff032ec8cb836fb8cd4d27fcad747685be302ae8c7"
  ],
  [
    "apps/api/src/providers/windows-update-transaction-provider.test.ts",
    "c21d664ff3a8f31de2fb6c5b69a7817d648a9ad7adb3f76bdba23c922c536f3c"
  ],
  [
    "apps/api/src/providers/windows-update-transaction-provider.ts",
    "1d06a838c29bf7dae107b2de1ca0f96e49c463e06608735f31a27a72a0ee5fc9"
  ],
  [
    "apps/api/src/update-activation-routes.test.ts",
    "1c035c5c39a8e3047752a2e014d0a8e6aabd653041bdea90a769d3627588d5e0"
  ],
  [
    "apps/api/src/update-pipeline/activation-http.test.ts",
    "11435ca03b64ac6e7037b7ea99e915449ad880c6ccb90a0ab75d6c32dec0c430"
  ],
  [
    "apps/api/src/update-pipeline/activation-http.ts",
    "479fbea361b841b4fe3546da60ebf54ce16faa75819ba58c9b45e61ef5128058"
  ],
  [
    "apps/api/src/update-pipeline/activation-live.test.ts",
    "6ae65b53f330875f5ca49c382e9bc7f274ac197a9fd83aad325266d45617cfe8"
  ],
  [
    "apps/api/src/update-pipeline/activation-live.ts",
    "b78f3cca6497475ab8ce3629bbc130b71b29ec2d55441dd0d0df4a89aeaba118"
  ],
  [
    "apps/api/src/update-pipeline/activation-types.ts",
    "c102958b661cdd5c586890a921da2a565e2260119fd4a1b6f35153ed2c336ade"
  ],
  [
    "apps/api/src/update-pipeline/activation.test.ts",
    "aae448e4b34d6c02e3afcf8b7258de5cf41aec81ec053a31bac2ac97eb496026"
  ],
  [
    "apps/api/src/update-pipeline/activation.ts",
    "f2b33ffc1b283c81bbffd9c4eb8c9df94879f15bc4cf4b0cf4ea6130ffd8a6e5"
  ],
  [
    "apps/api/src/update-pipeline/operator-rollback-http.test.ts",
    "d352250d287a766a88c199830dd455cb4b52e722592aa078930a0a327bb47dfa"
  ],
  [
    "apps/api/src/update-pipeline/operator-rollback-http.ts",
    "2f7df01992bf9f7e624fc0c2de7e41eedd52836b69c9638f15765547546336d7"
  ],
  [
    "apps/api/src/update-pipeline/operator-rollback-records.test.ts",
    "c6cc289cd38ef5df33081436b3c0810be79889b43bf4da17e34a56fbcd72594d"
  ],
  [
    "apps/api/src/update-pipeline/operator-rollback-records.ts",
    "d17099355dd6eeb3db875c67608b4a644d68e46b78ecae874e5539cbad93ab11"
  ],
  [
    "apps/api/src/update-pipeline/operator-rollback-store.test.ts",
    "5bfada82a987910fdfeabe8cfead12ef8d69e61d6a54a626a67ced77223bfff8"
  ],
  [
    "apps/api/src/update-pipeline/operator-rollback-store.ts",
    "a58dbe5fcf13790905f7585e181a06d528453a7face4b47ca48827823b1e7841"
  ],
  [
    "apps/api/src/update-pipeline/operator-rollback.test.ts",
    "295f2f72a35bdab6424a8062477460c708b4b92d0af38c24a722f4ce5c9c98d7"
  ],
  [
    "apps/api/src/update-pipeline/operator-rollback.ts",
    "beadffde372be2eaad2c96e0271222e9c07d80db0a215eaa29de15d54b994b45"
  ],
  [
    "apps/api/src/update-pipeline/rollback-health-policy.test.ts",
    "d3ba67a4e4157345dfc9b980203de15f7f24456ee4dd2a00c2d362b47e323f7c"
  ],
  [
    "apps/api/src/update-pipeline/rollback-health-policy.ts",
    "0b56be2b7538efe84aca92c1eb0764a77346dee2145c726f4745ae7b90d86c72"
  ],
  [
    "apps/api/src/update-pipeline/trusted-compatibility.test.ts",
    "e32eb1e5ca165fec1721ba74544612c72de4abc6518921e607b496c4ab27d07c"
  ],
  [
    "apps/api/src/update-pipeline/trusted-compatibility.ts",
    "ec0a4fa601f4a5622478892b2a907a454be8c38dbe607b91b7a917d420df6727"
  ],
  [
    "apps/web/src/OperatorRollbackPanel.css",
    "462af27ce696812ac11c295a82ee3c1603c09e8b4e951aec0b58faf16069a99d"
  ],
  [
    "apps/web/src/OperatorRollbackPanel.tsx",
    "3cb4a3f9b3e63723bbee69ca5ef11d12cb32da4e35aeb958abbefe84fed327f8"
  ],
  [
    "apps/web/src/VersionUpdateWorkspace.tsx",
    "e52dcf4849c5dd54ab2a8a59df055f011d58d6ceacc37fa36f8ff77361b9003b"
  ],
  [
    "apps/web/src/operator-rollback-api.test.ts",
    "ef84585014e242c13b42c70c3653c23cae2eec8521b083ea4fb74fbf3d1a9116"
  ],
  [
    "apps/web/src/operator-rollback-api.ts",
    "f62e354ec71c043a7feef3d0fd90ebd32650ca1166c01e3f6740e16abf78c4b8"
  ],
  [
    "apps/web/src/operator-rollback-panel.test.tsx",
    "1fc2f632d5cc0fe9901724234e60cd813285699cbe7269ad78beb43c30b415b6"
  ],
  [
    "apps/web/src/update-activation-workspace.test.tsx",
    "2d4e946e3ab7c3ee59c5435b58b6734a5cf7f9483d71f346e266c495ecf79c56"
  ],
  [
    "scripts/windows/bootstrap/DysonGameLifecycleBootstrap.Common.ps1",
    "d81d5fbc5bd23b1814c5e249e0b0e175f0f54786a5f05aacb10936cbb624fb9a"
  ],
  [
    "scripts/windows/bootstrap/DysonStoppedSaveCapture.ps1",
    "961952612e6d2efff0c0462eb6792d21cbc310a511cd8d800cacecec55998303"
  ],
  [
    "scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1",
    "101986c99a58c276409df1a68de3837d12e9ef6f48815611062bda4c72eb9249"
  ],
  [
    "scripts/windows/bootstrap/Start-DysonServer.ps1",
    "d0b76dbaa9eebcd3331e354476538261f9f8dd7d7d7a82500451af04e7aca65a"
  ],
  [
    "scripts/windows/deployment/Install-DysonControl.ps1",
    "8e0f26e262c657aa735e16be7f531a5ab06ff3c454a9ee27962095fcec48dd40"
  ],
  [
    "scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1",
    "8c970281e9e5643842cb618292348ab083451b90eeaa7e37030cd2f764079f87"
  ],
  [
    "scripts/windows/release/DysonReleasePackaging.Common.ps1",
    "c95affd318d91ca36dabf961aa36950db609585bc12433815bb4a53416ec5637"
  ]
]);
const operatorBatchApiTests = ["src/config.test.ts","src/update-pipeline/recoverable-cleanup-http.test.ts","src/update-pipeline/recoverable-cleanup-coordinator.test.ts","src/update-pipeline/recoverable-cleanup-execution.test.ts","src/update-pipeline/recoverable-cleanup-records.test.ts","src/update-pipeline/recoverable-cleanup-files.test.ts","src/update-pipeline/recoverable-cleanup-inventory.test.ts","src/update-pipeline/recoverable-cleanup-move.test.ts","src/update-pipeline/recoverable-cleanup-plan.test.ts","src/storage/database.test.ts","src/jobs/audit.test.ts","src/app.test.ts","src/game-runtime-receipt-routes.test.ts","src/lifecycle/game-runtime-receipts.test.ts","src/providers/windows-lifecycle.test.ts","src/providers/windows-runtime-compatibility.test.ts","src/providers/windows-update-activation.test.ts","src/providers/windows-update-lifecycle-composition.test.ts","src/providers/windows-update-runtime-evidence.test.ts","src/providers/windows-update-transaction-provider.test.ts","src/steam-manual-handoff-routes.test.ts","src/update-activation-app-wiring.test.ts","src/update-activation-routes.test.ts","src/update-pipeline/activation-http.test.ts","src/update-pipeline/activation-live.test.ts","src/update-pipeline/activation.test.ts","src/update-pipeline/operator-rollback-http.test.ts","src/update-pipeline/operator-rollback-records.test.ts","src/update-pipeline/operator-rollback-store.test.ts","src/update-pipeline/operator-rollback.test.ts","src/update-pipeline/rollback-health-policy.test.ts","src/update-pipeline/steam-manual-handoff-http.test.ts","src/update-pipeline/steam-manual-handoff.test.ts","src/update-pipeline/trusted-compatibility.test.ts","src/windows-update-production-assembly.test.ts"];
const operatorBatchWebTests = ["src/recoverable-cleanup-panel.test.tsx","src/recoverable-cleanup-api.test.ts","src/tasks-audit-workspace.test.tsx","src/operator-rollback-api.test.ts","src/operator-rollback-panel.test.tsx","src/update-activation-workspace.test.tsx"];

const reviewedRuntimeLayoutSources = new Map([
  [
    "apps/api/src/lifecycle/game-runtime-receipts.test.ts",
    "b82d20638f8ae6930eae275fd4ceca4915577d4f74881481d9ef581d08ae0239"
  ],
  [
    "apps/api/src/app.ts",
    "0fdc0d67b838c7c085812be3cad2d6649356c5ee0e14f262d55f2a455c964f81"
  ],
  [
    "apps/api/src/runtime-receipt-location.test.ts",
    "f66df92035fb0dfcdbe536cda4a8ac7f7de4d66ce9beb5854efa68204a8465e7"
  ]
]);

const reviewedContractMigrationSources = new Map([
  [
    "scripts/windows/configuration/DysonConfiguration.Common.ps1",
    "58caa53bd90c5c48287526f280f096a40fd39dcd92600066999904ca6d454006"
  ],
  [
    "scripts/windows/configuration/New-DysonControlConfigurationSnapshot.ps1",
    "5d28019782ceb80b26969b1d41e670cd5cad78d59925cac64c6265dbdfd06bb1"
  ],
  [
    "scripts/windows/configuration/Restore-DysonControlConfiguration.ps1",
    "935d6fe2de75951468d4c719f9f39d4429ceed20c53a3e3b107610a68e6bc81d"
  ],
  [
    "scripts/windows/configuration/SelfTest-DysonControlConfiguration.ps1",
    "8c5b2cb0b4491d5177b12e2e2a1033cd027dee8682a2594186c5f95be8690a32"
  ],
  [
    "scripts/windows/configuration/Test-DysonControlConfiguration.ps1",
    "b5d6357320f676552d8240fd2c08896caa5ff0430110c33244a7ccb56b7aa470"
  ],
  [
    "scripts/windows/configuration/dyson-control.environment-contract.json",
    "7ed366d43a3ba906417d1ec114624df465e4cbe12e74d454da140ba3afc86394"
  ],
  [
    "scripts/windows/configuration/dyson-control.environment-contract.rc26.json",
    "5386f42df066b3d5ce4fa26f3346baf4311b0ec8efb1eb4d83bdf488c14786dc"
  ],
  [
    "scripts/windows/deployment/Install-DysonControl.ps1",
    "f984e6b42ef06ac7faf4168a942d70de117fea933c260569b366a06f64689868"
  ],
  [
    "scripts/windows/release/DysonReleasePackaging.Common.ps1",
    "4e87f472ec1797c3f23fdb39d945bc68c2f008650423051def249496460b3e52"
  ]
]);

const reviewedManagerRemovalSources = new Map([
  [
    ".env.example",
    "3c8bcdd9cceb31b7fb6cf5b3e6bebd9cc91055871593996d132337ab89e31e8e"
  ],
  [
    "acceptance/manifest.json",
    "7d7a3b65752bbcc68a702ea3aa3d633ee4c965e5234602908fdd66450f6216ca"
  ],
  [
    "apps/api/package.json",
    "0f3f9754e748a6f64ef7fafb8343f6c76a7b722e5eda7e8e921d03e7e7d933c7"
  ],
  [
    "apps/api/src/app.test.ts",
    "d8c406e963b09aa4e413682750ee88699032c158c3c2e9070a61b6a4174f6fd8"
  ],
  [
    "apps/api/src/app.ts",
    "0921d9ac7da8d62a055a01631a0735e8f0f2eafb4a016942ce3529a34567f294"
  ],
  [
    "apps/api/src/config.test.ts",
    "2f74da2ddd380fbc08b5d5343417c7295c3629f653f6974b22b52864a0d64461"
  ],
  [
    "apps/api/src/config.ts",
    "c5100170ac121e82e485e3b30444cd97b9d04bcb238d5539f7d1088c6b039598"
  ],
  [
    "apps/api/src/providers/powershell-runner.test.ts",
    "6935536e61ad03db04b287a79393350f0bc0b890b70533a4e4ae7106f2aced6d"
  ],
  [
    "apps/api/src/providers/powershell-runner.ts",
    "d301dd866de7d7aa8f2de88d973ac78daf59d70f00ba2a4f035b0614e54c374e"
  ],
  [
    "apps/api/src/security/authorization.test.ts",
    "c69b172c4465cf36d0943a0f731667543940347e0512eab3457e00d0a9e64f2f"
  ],
  [
    "apps/api/src/security/authorization.ts",
    "0d4252490afd69162dcd1991afd01048cbf29b4d83fc7c7d3f97366450484c48"
  ],
  [
    "apps/web/src/api.ts",
    "0c3ef83093b139a8d91bb62477a2701c9af88be9208604e1ae951ab888adf295"
  ],
  [
    "apps/web/src/App.tsx",
    "df04d8c4689c5c592abfcf20bf2b31a690e40124ab3a4a607d540d18261e84f5"
  ],
  [
    "apps/web/src/model.ts",
    "db95559ba7a8fd08f2e91d60731dd8dfb15c9957b6b80e5771e077543f5cdc09"
  ],
  [
    "apps/web/src/styles.css",
    "5792d63014226398e7392878815130ed4d75a8e75ef12d9e0f7b15d702ca10d6"
  ],
  [
    "docs/ACCEPTANCE.md",
    "9f59496c73d9e418917f9c2a87cb7c6373a56506c9d2c2d2001c34e26853ccf6"
  ],
  [
    "docs/DATAROOT-RECOVERY.md",
    "b585867694e759da76ea923f8fdf135c58cddd18d9304d1d9a7446f8878771a7"
  ],
  [
    "docs/incremental-validation.md",
    "7adc1c465084f05542aba75669227a224b8225a48eeb3fd6346171280a226dcc"
  ],
  [
    "docs/LIFECYCLE.md",
    "81d9ef2c68899952116cc8b8ae3a5477e3ba8e1b80ce1deca254ee7a290a5b67"
  ],
  [
    "docs/NETWORK-CONNECTIVITY.md",
    "de9ba758b3094a9a1e927a6e63ac139c8720a50e6477b1e4b10ef032b7035658"
  ],
  [
    "docs/PRODUCTION-QUALIFICATION.md",
    "eceac31d2bb1071c6d3530fd0c7963f9d37e4d812de6be4a9dfbf03c633cca5e"
  ],
  [
    "docs/SECURITY.md",
    "88a0bfbd5ff63e516cc7c3e07ac1a504d910655fc1de6754004cd892be9b174c"
  ],
  [
    "docs/update-integration-audit.md",
    "48b530defbfa8f4cb55aa13e0cd16d28a29b552bbad9ccd691fa316fbb129947"
  ],
  [
    "docs/WINDOWS-DEPLOYMENT-DRAFT.md",
    "e144e4c776c85519b929393a55f591b89dd73802809fbb8bfc5999a0b21f5748"
  ],
  [
    "integrations/dyson-control-bridge/README.md",
    "a8cd0f3502e6ad2adedae01d23b49e4c272b31cd9e988c729755b8acc2c7f071"
  ],
  [
    "package.json",
    "3710caff4057c2bd2900d156d83673ee5110343b05eb2a08879d1f220edeae8e"
  ],
  [
    "README.md",
    "8ce340c2f5182c1fe54170fa3c1651892503686474d0a54a33d3c5f179031c29"
  ],
  [
    "scripts/clean-api-dist.mjs",
    "31d094224f34ebada7cf875f33b50c8cda845fa20b05c4418287a4f685b64632"
  ],
  [
    "scripts/validate-acceptance.mjs",
    "a404f044a710b56ea869cdcc9c5b60cd4b79b1cfe63355b6cb51cf80af1ae5bb"
  ],
  [
    "scripts/validate-acceptance.test.mjs",
    "98bee6eccd51173a8fefe655fa4a4fe653ecf704a90a22b134ca027f1e6c130b"
  ],
  [
    "scripts/validate-incremental.test.mjs",
    "bce68cb96934ee692837fdb9c67d0759985da8006d75d630d6fb258c5d606882"
  ],
  [
    "scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1",
    "2a64b45888b64fc8e85770c9e7368b14802fa4483153a638d3b7767681e5dce2"
  ],
  [
    "scripts/windows/data-recovery/DysonDataRootRecovery.Common.ps1",
    "8ed3ed2bc8ee34858ae1e91ccf2cec537a8e982ae9eb4e3ff3302573cf1194fd"
  ],
  [
    "scripts/windows/data-recovery/SelfTest-DysonDataRootRecovery.ps1",
    "9503bca4570ba2d23b35bdf0cd2c865f0137d299f6ec5f263504172233976363"
  ],
  [
    "scripts/windows/deployment/DysonDeployment.Common.ps1",
    "7b24d773eb973fce24f9816e20aa68f51bcefead117e162ecb8c530d1c65f384"
  ],
  [
    "scripts/windows/deployment/DysonRebootAcceptance.Common.ps1",
    "be1338ac6a41acce5394c0a7a44e0c8f335bd9a1edc0d11e5a5c75c9785a0cd2"
  ],
  [
    "scripts/windows/deployment/Invoke-DysonControlDeployment.ps1",
    "2f8dba10aaaa07cca2876a333bb72d2dfe4b0b94aaa2564c08b2f435e884b765"
  ],
  [
    "scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1",
    "93d3dc7f9162d5b8ac77129e7c72f571e4297714d32e1ee00204bd0f0a2ab17f"
  ],
  [
    "scripts/windows/deployment/SelfTest-DysonRebootAcceptance.ps1",
    "add0dd069b0967ad653efaf73f2e052318bab49769083528cb47182504203ab5"
  ],
  [
    "scripts/windows/deployment/Uninstall-DysonControl.ps1",
    "e5067465e0231b6d6cd01a384865a22d61e7c7b2c1a04af8d94edad87da8d006"
  ],
  [
    "scripts/windows/evidence/DysonPrivateEvidence.Common.ps1",
    "20e5ab3b7580a6c5c19fb9b7fb24a071df40f8c3a290a0454014dc10edc0859e"
  ],
  [
    "scripts/windows/lifecycle-broker/DysonLifecycleBroker.Common.ps1",
    "b10ac0be2ecc110e3bed414ad3f80c279e573c977477ffdeff52f5b658d48023"
  ],
  [
    "scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1",
    "a2d5fa1a96ea951d135d2564de932042019a976c57cad15194841fe32ae93784"
  ],
  [
    "scripts/windows/qualification/fixtures/adapter-contract.v1.json",
    "b9f74a231b8640f8dc3ac6e84b3b8bc625448c2420af12990b25e76e01a1ef74"
  ],
  [
    "scripts/windows/qualification/fixtures/adapter-contract.v2.json",
    "4aeae34ff12986505a277f7d357bb5996cc0f8d23f23631555af6abe9f52142d"
  ],
  [
    "scripts/windows/qualification/fixtures/orchestration-adapter-contract.v2.json",
    "49b7b288de3d5542ca1a2a4e30315e99be534e9907ff4df4b6356ef7167fd6cd"
  ],
  [
    "scripts/windows/qualification/Invoke-QualificationOrchestrationV2SelfTest.ps1",
    "27cf8a0dc9867b9fe1754e308acd0882ce43f1b82c89bbba0d8c843bad4c528d"
  ],
  [
    "scripts/windows/qualification/Invoke-QualificationSelfTest.ps1",
    "339ed66ee8a323f2953ec24f8024fd0849407eabe6c6c3859efd5d1a07ebf22b"
  ],
  [
    "scripts/windows/qualification/qualification-controlled-evidence.v2.schema.json",
    "59d43d5ba448ab03a6ccc473355be912ab5ae16f57675ce227eed3c18bafb551"
  ],
  [
    "scripts/windows/qualification/qualification-orchestration-profile.v2.schema.json",
    "7b02901814615fb8817f6d3cefb6684573d674e1bff3a16337cf6c0b4b494087"
  ],
  [
    "scripts/windows/qualification/qualification-orchestration-request.v2.schema.json",
    "170ca94e389a735486a45a5866104be48df1ce266cc65aa643fc58516b2e67c0"
  ],
  [
    "scripts/windows/qualification/qualification-plan.v1.json",
    "9434af735004064f634339befeb78aa136cc4b898e6dc620fdef5c7ada39cab9"
  ],
  [
    "scripts/windows/qualification/Qualification.Executor.ps1",
    "19dce7beb8c503c3df324da32d8294771b9ea01fd678b87efaada96f254aabdf"
  ],
  [
    "scripts/windows/qualification/Qualification.OrchestrationV2.ps1",
    "3bf43686e50ac83b3ac51dee181ccebe65f9184ac80bfe33f29f5fb903e0b96a"
  ],
  [
    "scripts/windows/qualification/Qualification.Plan.ps1",
    "6e021159cb5f2d6554d83ac10021413cddc89aa00b1b17a317b3727b8b8c4fca"
  ],
  [
    "scripts/windows/qualification/Qualification.Protocol.ps1",
    "b812e785d40fd5fa25e7544177290dde7ab127c7e8230436652f62d54ff95c0d"
  ],
  [
    "scripts/windows/qualification/Qualification.Shadow.ps1",
    "59bfdecc36a4cbdcb6c5f7143471f3e661b24cdc3132a913f260732e1d22a1cf"
  ],
  [
    "scripts/windows/qualification/README.production-v2.md",
    "b79b60040d33e6a3af33e39b9bf60c886d2941fd70b51111dbdc54cac4cfd42a"
  ],
  [
    "scripts/windows/qualification/README.protocol.md",
    "16de73bd25903e0f723c68b7406eea0ecc2501db91afd1dbdbb8d5db15326337"
  ],
  [
    "scripts/windows/qualification/README.shadow.md",
    "130d8d49882fae56b45fdee16fb28a7491ad7d57d40c0105093895d44684c6bd"
  ],
  [
    "scripts/windows/release/New-DysonControlReleaseArtifact.ps1",
    "a80a26216a5d4bec48cfd6a3973162b02b5b646a2cf4f9d756f2e3a8167c2c13"
  ],
  [
    "scripts/windows/release/SelfTest-DysonControlReleaseArtifact.ps1",
    "d4be2e210f541a61413de020d68a662cafd7b577eeb53133b3afe9bde18e6b09"
  ],
  [
    "scripts/windows/release/SelfTest-DysonControlReleasePackage.ps1",
    "de1fd71fcaf1e15f90ff361da907ba6bf8732197c1670a34595f72e69eb51950"
  ],
  [
    "scripts/windows/SelfTest-DysonRuntimeTasks.ps1",
    "8dd0fe5757ac58c2266008c7599b716fd8e5d66614c0483b1ab1d58aa0c659b7"
  ]
]);
const reviewedManagerRemovalDeletions = new Map([
  [
    "apps/api/src/cutover-app-routes.test.ts",
    [
      "b2ab72cd26ecabcfa9a779623f922df4fa247fec0ba0ab93334b0a8407f46e78"
    ]
  ],
  [
    "apps/api/src/cutover-production-app-wiring.test.ts",
    [
      "93efec90cd896b529167c99447edec858da2d18eaef63c051a1471302d55222f"
    ]
  ],
  [
    "apps/api/src/cutover/audit.test.ts",
    [
      "98ca1e461e2d3004868708e58141035ea050786a00563a67ddb96ef555458696"
    ]
  ],
  [
    "apps/api/src/cutover/audit.ts",
    [
      "18a120f00f66e98b0fcfdb7af22030619ddcace5a948052bc2051d040af9c553"
    ]
  ],
  [
    "apps/api/src/cutover/broker-profile.test.ts",
    [
      "2d50e29219f8cb45bd783f4f30006ade9b7e9ed7112f75d5625eebca59993948"
    ]
  ],
  [
    "apps/api/src/cutover/broker-profile.ts",
    [
      "f00b8db79e5ed4f4301805d2f4ae2469b5768b955a2531d4a7197054afc93782"
    ]
  ],
  [
    "apps/api/src/cutover/http.test.ts",
    [
      "6d80f5b56132e2a65fcd5c61bd430b769577efea8354630d5359e2afd42758f7"
    ]
  ],
  [
    "apps/api/src/cutover/http.ts",
    [
      "ac4837e5f51044df088674f443f534d5dba90acb01979d066474dc722ee5a2d5"
    ]
  ],
  [
    "apps/api/src/cutover/profile.test.ts",
    [
      "da23cf428e840fc0334be46b952c163acffa1f8d60064f1c75c1d806a298ffcb"
    ]
  ],
  [
    "apps/api/src/cutover/profile.ts",
    [
      "ebd94d1e3c7fb72932cd1fcc8e3819cc16ae3bee91235b30df233db2c0ba0980"
    ]
  ],
  [
    "apps/api/src/cutover/routes.test.ts",
    [
      "21a24466b9b17506198458d0d9d9acc9c3ced2fc2c1a6ba3f19ac58083fff39e"
    ]
  ],
  [
    "apps/api/src/cutover/routes.ts",
    [
      "a4cf2c9915430b308e1a02a52f5c8f3f6e561cd3cb6040004b708a5964d471f6"
    ]
  ],
  [
    "apps/api/src/cutover/service.test.ts",
    [
      "6502822fe34d86ddf6b5b01beeb7d8baf68d989a039bf555d543ffaf8a9e5944"
    ]
  ],
  [
    "apps/api/src/cutover/service.ts",
    [
      "06b9791554fbea30eb1b63e0c7a786542a70af940987d3762853d1fd82f3a05c"
    ]
  ],
  [
    "apps/api/src/cutover/sqlite-store.test.ts",
    [
      "d5e22eebdf083b2c7e9f8cc82c5ed6a5f1e89e6d33b4d83739df75862cb48ff1"
    ]
  ],
  [
    "apps/api/src/cutover/sqlite-store.ts",
    [
      "9a98be9a2c45f16a11d2668447d858601fc302b189a1884a6f6805897ca8ffc2"
    ]
  ],
  [
    "apps/api/src/cutover/types.ts",
    [
      "11ad125bbb0f00a5aa4d7e6a0d764730d662325c859b156846a3045a91306656"
    ]
  ],
  [
    "apps/api/src/providers/windows-cutover-host.test.ts",
    [
      "293362727bbae515c132512121f21b53c2a60f9736245b64b7b54de9f541933a"
    ]
  ],
  [
    "apps/api/src/providers/windows-cutover-host.ts",
    [
      "854e188aca2a89c162ef86d8e379fa974ce327a181af4c452b28b3186a1878ec"
    ]
  ],
  [
    "apps/api/src/providers/windows-cutover.test.ts",
    [
      "c51f5c834e9fb5a6cc61dab27200fca666f9f40296678b188f4b575ec235cfa6"
    ]
  ],
  [
    "apps/api/src/providers/windows-cutover.ts",
    [
      "589c8ad9e067d09985c77b6aac3dbdf44b32d09607be59f0d643be9f45946b43"
    ]
  ],
  [
    "apps/web/src/cutover-api.test.ts",
    [
      "2397a342774f8ab0e5eebb27c5bc6e059b5364c8e11e4dd63cf56a12cd6d769d"
    ]
  ],
  [
    "apps/web/src/cutover-workspace.test.tsx",
    [
      "3dd2e9f6c25c119053c09c4913cefe5c1a6dab1c7f46be41e83594eda7893db3"
    ]
  ],
  [
    "apps/web/src/CutoverWorkspace.tsx",
    [
      "572c87c77e30ba166a5f1086ad7ee8289ca9dbaaa112ea322a2fc3dc147c6c8c"
    ]
  ],
  [
    "docs/GSM-EVALUATION.md",
    [
      "af900a43ba6439cfbe75635eee413f01b4685f655e8dae6bec042dbd2c31e1e6"
    ]
  ],
  [
    "docs/MIGRATION-GSMANAGER.md",
    [
      "6ab3268f0c2e068ca56541de7404bc911deb118d1f2bfe457aad0f61abd4f2b6"
    ]
  ],
  [
    "scripts/windows/cutover-broker/DysonCutoverBroker.Common.ps1",
    [
      "dd2b3be169b1aee593f5ab6fbe6c74737e0a6ceb0457c13f05ed0c7029ee441b"
    ]
  ],
  [
    "scripts/windows/cutover-broker/DysonCutoverBroker.TaskAcl.ps1",
    [
      "6ae91e5c2ed08ebef3dd87c94b463ba3d386de1b33702a8e7c4ee64a447a2d83"
    ]
  ],
  [
    "scripts/windows/cutover-broker/Install-DysonCutoverBrokerTask.ps1",
    [
      "419b124c2bd5faaccf32d290126ff21b238e2225f2609a5994280af54fddf620"
    ]
  ],
  [
    "scripts/windows/cutover-broker/Invoke-DysonCutoverBrokerWorker.ps1",
    [
      "c6cf81be86c1193a88f3aa348ed54217078b14a008eb11b137eb9864552320d0"
    ]
  ],
  [
    "scripts/windows/cutover-broker/SelfTest-DysonCutoverBroker.ps1",
    [
      "44d709110a8791ef49d88f8a329acbe02b1344d61fff68b6cf6b7d6fa79dd828"
    ]
  ],
  [
    "scripts/windows/cutover-broker/Submit-DysonCutoverBrokerRequest.ps1",
    [
      "0af50a7d205a7a9e708548952238f95b063ebb144076a59732040f6141c3eb30"
    ]
  ],
  [
    "scripts/windows/cutover/DysonCutoverHost.Common.ps1",
    [
      "e271bf1de24f33c5641ee6db9293228320a489f3a1dff8b2d95139560ba9f449"
    ]
  ],
  [
    "scripts/windows/cutover/DysonGsManagerAuthority.Common.ps1",
    [
      "e7f94735f11c98b4cec231734940ae22d3751a18ac45364a4a40f33ad5daafe3"
    ]
  ],
  [
    "scripts/windows/cutover/Get-DysonCutoverEvidence.ps1",
    [
      "56f885d7ddee9408e12a0b3ddb0eaa4f1790afe196a2a4b24d010e2ffa63b951"
    ]
  ],
  [
    "scripts/windows/cutover/Initialize-DysonGsManagerAuthority.ps1",
    [
      "6e24bdd9fe5275cac9543bb884c08c7a8acf0eb794f47a7d03303bda22954312"
    ]
  ],
  [
    "scripts/windows/cutover/Invoke-DysonCutoverAction.ps1",
    [
      "b2755a05e268bf8ea6764fce08f249426d738ec3049f8317231e73d23c76ca06"
    ]
  ],
  [
    "scripts/windows/cutover/SelfTest-DysonCutoverHost.ps1",
    [
      "519b9efe050409172aa753484b7ec4ed600163ddf6cbc55ba1b88bd5cbbd918c"
    ]
  ],
  [
    "scripts/windows/cutover/SelfTest-DysonGsManagerAuthority.ps1",
    [
      "7bfb588113ad1982bfa426214fa5562ff39f238dad64f94ee582a7db51b3e631"
    ]
  ],
  [
    "scripts/windows/migration/DysonGsManagerMigration.Common.ps1",
    [
      "7eedb403a566353096b7e3d6901482ce30ec7d9ac161c9e3e081d929617960d9"
    ]
  ],
  [
    "scripts/windows/migration/DysonGsManagerRemoval.Common.ps1",
    [
      "8f8070a806595a5d637f63c9c114f5ce591d08a9516a87830015aaa1a73484c2"
    ]
  ],
  [
    "scripts/windows/migration/Get-DysonGsManagerMigration.ps1",
    [
      "d810ef24fb9354682c1612c8fdd1565835e12926abd3cd40477ee51c296eda64"
    ]
  ],
  [
    "scripts/windows/migration/New-DysonGsManagerSnapshot.ps1",
    [
      "b5a3020356168f8ed3d46da96cdbe49a34726e629b564bdfeb699ef481c1b1d4"
    ]
  ],
  [
    "scripts/windows/migration/Remove-DysonGsManagerInstallation.ps1",
    [
      "a11680a3d1999e45fd6edb0b3e1c233e0db04759876eda50da7f2473fab5cf4d"
    ]
  ],
  [
    "scripts/windows/migration/Restore-DysonGsManagerRemoval.ps1",
    [
      "84135825135cc96213fc8e9a90567d05f4607578f72bac89c4eeef7efcfd5470"
    ]
  ],
  [
    "scripts/windows/migration/Restore-DysonGsManagerSnapshot.ps1",
    [
      "5e01801d1e071b12972d2bc68c55907e0f6071cf7c1db31d09fc744dce41306f"
    ]
  ],
  [
    "scripts/windows/migration/SelfTest-DysonGsManagerMigration.ps1",
    [
      "870f30512c7483d9035bdd21138c0352938087aff6e14ebb7c169e9dab9f7d3d"
    ]
  ],
  [
    "scripts/windows/migration/SelfTest-DysonGsManagerRemoval.ps1",
    [
      "ec7fcd415ccf1c3f2262269d3e9a2186327e17a892ec00a2677936ddfcffb377"
    ]
  ],
  [
    "scripts/windows/migration/Test-DysonGsManagerRemoval.ps1",
    [
      "2455b664caf12f6e003748806480258eabe8bb1ff737b1bd14512440756ad559"
    ]
  ],
  [
    "scripts/windows/migration/Test-DysonGsManagerSnapshot.ps1",
    [
      "698bac0e5090bd436df90d6579b5a52928ac58a60e91c3b0618087990f8b3dd9"
    ]
  ],
  [
    "scripts/windows/qualification/dyson-post-gsmanager-removal-observation-v2.schema.json",
    [
      "e7a4262f725f707837347b2c74815f4a212cf7fec9a3efefeea3cda78e077631"
    ]
  ],
  [
    "scripts/windows/qualification/New-DysonPostGsManagerRemovalObservationV2.ps1",
    [
      "41858213a7224cd815b17782625025174b62776b3952cd60147fe4a3dd1f1fb1"
    ]
  ],
  [
    "scripts/windows/qualification/New-DysonQualificationReversibleCutoverObservationV2.ps1",
    [
      "ff4b8877bebcd47f3b3a0b3a13517a200cbc8230589391923426026f07497ea2"
    ]
  ],
  [
    "scripts/windows/qualification/New-DysonSideBySideObservationV2.ps1",
    [
      "a83aca58bf3f6a763f28b89b6370117356a8a6187b65e4e402d7a63d5fabc991"
    ]
  ],
  [
    "scripts/windows/qualification/PostGsManagerRemovalObservationV2.Common.ps1",
    [
      "c72ea4996780b9fdcbbf92741dcad4542c7c22e10a7d50c94eca258d9562c68f"
    ]
  ],
  [
    "scripts/windows/qualification/Qualification.ReversibleCutover.ps1",
    [
      "f2362570af2358a6b6ddd0f79066a6123407b677535119a46c8b9fd87ac6089b"
    ]
  ],
  [
    "scripts/windows/qualification/Qualification.SideBySideV2.ps1",
    [
      "9ab3c10eb56cbe3d83d7aa50861b8aee5ab4c746331e300060778c5c88190520"
    ]
  ],
  [
    "scripts/windows/qualification/README-ReversibleCutover.md",
    [
      "bc7a93af564ec8e943b4e53d86db031d2026149c07c8b034538ef27ca2c83647"
    ]
  ],
  [
    "scripts/windows/qualification/README.PostGsManagerRemovalObservationV2.md",
    [
      "dc13e008fb660c762f4c0954d5cea2cb0eb1afa1254fc8945c3148a539f3fdcb"
    ]
  ],
  [
    "scripts/windows/qualification/README.SideBySideV2.md",
    [
      "1623f5edfa95bb6e3dcb900f56fd46d7934d73ff4b5e32f56369bf83454b3a46"
    ]
  ],
  [
    "scripts/windows/qualification/reversible-cutover-observation.v2.schema.json",
    [
      "8bcebee1b040102d18049cfe71991628a89e01e02bc2f07d5053571cf10bb82b"
    ]
  ],
  [
    "scripts/windows/qualification/SelfTest-DysonPostGsManagerRemovalObservationV2.ps1",
    [
      "cc6e2cfb9e3ace743009b963ea3e4314b07149839014f1a45b096d3f78c0caad"
    ]
  ],
  [
    "scripts/windows/qualification/SelfTest-DysonQualificationReversibleCutoverObservationV2.ps1",
    [
      "ef1d86399ec736f8a74cc51372898fcd65ade0a642874d048f8f33124e4a6e19"
    ]
  ],
  [
    "scripts/windows/qualification/SelfTest-DysonSideBySideObservationV2.ps1",
    [
      "eb663bef4ed776436720769dbb1f130cc3f94f876820a41d118aedbc5530df22"
    ]
  ],
  [
    "scripts/windows/qualification/Test-DysonPostGsManagerRemovalObservationV2.ps1",
    [
      "3fb68d7824f0575cf52295bc2a2a450e17f0e8ca90018f2d818b4cc8fb2d5459"
    ]
  ],
  [
    "scripts/windows/qualification/Test-DysonQualificationReversibleCutoverObservationV2.ps1",
    [
      "411dc3e8e35905cbf1172f4aee47530cbea48c19fd4cb946ff01a672956e83e4"
    ]
  ],
  [
    "scripts/windows/qualification/Test-DysonSideBySideObservationV2.ps1",
    [
      "885cfafcf9da775a5fab3f94f30f5ce6fbfa870e38c68eeffd454bf5ea256f53"
    ]
  ]
]);

export function classifyChange(file, before, after) {
  if (after !== null && reviewedManagerRemovalSources.get(file) === aclSourceHash(after)) return 'reviewed-manager-removal'
  if (after === null && before !== null &&
      (reviewedManagerRemovalDeletions.get(file) ?? []).includes(aclSourceHash(before))) return 'reviewed-manager-removal'
  if (after !== null && reviewedContractMigrationSources.get(file) === aclSourceHash(after)) return 'reviewed-contract-migration'
  if (after !== null && reviewedOperatorBatchSources.get(file) === aclSourceHash(after)) return "reviewed-operator-batch"
  if (after !== null && reviewedEntryCacheSources.get(file) === aclSourceHash(after)) return 'reviewed-entry-cache'
  if (after !== null && reviewedPredecessorSources.get(file) === aclSourceHash(after)) return 'reviewed-predecessor-binding'
  if (after !== null && reviewedRuntimeLayoutSources.get(file) === aclSourceHash(after)) return 'reviewed-runtime-layout'
  if (after === null) throw new Error(`Deletion requires an updated validation plan: ${file}`)
  if (file === 'scripts/public-release/scanner.test.mjs' && aclSourceHash(after) === '1fa443147c15695a1f91934ced3dfe2251b284bd0837680e885e53b792f3ad24') return 'reviewed-hygiene-policy'
  if (file === 'scripts/public-release/policy.mjs' &&
      aclSourceHash(after) === 'c2835a4d765ae9810016e19b1dd1d3109317b16d1f0349069a50e4ad67c36bd5') return 'reviewed-hygiene-policy'
  if (file === 'scripts/windows/deployment/Test-DysonControlDeployment.ps1' &&
      aclSourceHash(after) === 'a6c1dcaf59954eaaa4620b65cff612e856ed5280ce63e1a7e1520a52277f390d') return 'verified-native-status'
  for (const releaseVersion of ['0.1.0-rc.24', '0.1.0-rc.25', '0.1.0-rc.26', '0.1.0-rc.27']) {
    const priorReleaseSource = after.replaceAll(releaseVersion, '0.1.0-rc.23')
    if (priorReleaseSource !== after && priorReleaseSource.replaceAll('0.1.0-rc.23', releaseVersion) === after) {
      if (rc23VerifiedSources.get(file) === aclSourceHash(priorReleaseSource)) return 'version-only'
      if (configurationGateSources.get(file) === aclSourceHash(priorReleaseSource)) return 'configuration-gate'
    }
  }
  if (reviewedRc24ApplicationSources.get(file) === aclSourceHash(after)) return 'verified-rc24-source'
  if (rc23VerifiedSources.get(file) === aclSourceHash(after)) return 'verified-rc23-source'
  if (configurationGateSources.get(file) === aclSourceHash(after)) return 'configuration-gate'
  const startup = startupSources.get(file)
  if (startup && before !== null && startup.before.includes(startupSourceHash(before)) &&
      startup.after === startupSourceHash(after)) return 'startup-policy'
  if (file === 'scripts/windows/lifecycle-broker/Invoke-DysonLifecycleBrokerWorker.ps1' && before !== null &&
      aclSourceHash(before) === 'bf7725ecd25c309c7f7e4c6e2050902e5919a920cc45896931a320634f6ff425' &&
      aclSourceHash(after) === '4c55d309e150b3f8cc5f52afb6f45affc8edef44974365f6e09ec92deede3a70') return 'verify-blocker-array'
  if (file === 'scripts/windows/bootstrap/DysonGameLifecycleBootstrap.Common.ps1' && before !== null &&
      aclSourceHash(before) === aclBeforeHash && aclSourceHash(after) === aclAfterHash) return 'expected-exit-acl'
  if (file === 'scripts/windows/Start-DysonServer.ps1' && before !== null && normalize(before).includes(controlExitBefore) &&
      normalize(before).replace(controlExitBefore, controlExitAfter) === normalize(after)) return 'control-exit-policy'
  if (file === 'scripts/windows/deployment/DysonRebootAcceptance.Common.ps1') return 'test-only'
  if (file.endsWith('.md')) return 'documentation'
  if (reviewedPaths.has(file) && /\/SelfTest-[^/]+\.ps1$/.test(file)) return 'test-only'
  if (file === 'scripts/windows/release/DysonReleasePackaging.Common.ps1' && before !== null &&
      normalize(before).replace("    'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1',",
        "    'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1',\n    'scripts/windows/bootstrap/SelfTest-DysonGameBootstrapPointer.ps1',") === normalize(after)) return 'release-test-allowlist'
  if (versionFiles.has(file) && before !== null) {
    if (file.endsWith('package.json') || file.endsWith('package-lock.json')) {
      try {
        const previous = JSON.parse(before), current = JSON.parse(after)
        if (current.version === '0.1.0-rc.23') {
          previous.version = current.version
          if (file.endsWith('package-lock.json')) {
            if (current.packages[''].version !== current.version) throw new Error('root version mismatch')
            previous.packages[''].version = current.packages[''].version
          }
          if (JSON.stringify(previous) === JSON.stringify(current)) return 'version-only'
        }
      } catch { /* A dependency or structural change requires a reviewed plan. */ }
    } else {
      const priorVersions = new Set(normalize(before).match(/0\.1\.0-rc\.[0-9]+/gu) ?? [])
      if ([...priorVersions].some(version => version !== '0.1.0-rc.23' &&
          normalize(before).replaceAll(version, '0.1.0-rc.23') === normalize(after))) return 'version-only'
    }
  }
  if (reviewedPaths.has(file)) return 'affected'
  throw new Error(`No reviewed affected-test mapping for ${file}; update the plan, never auto-run the full suite.`)
}

export function selectCommands(changes, { componentChanges } = {}) {
  const changed = group => new Set((componentChanges?.[group] ?? changes)
    .filter(change => change.kind === 'affected').map(change => change.file))
  const commands = [
    ['node', ['scripts/validate-version-consistency.mjs']],
    ['node', ['--test', 'scripts/validate-incremental.test.mjs', 'scripts/windows/release/release-workflow.test.mjs']]
  ]
  if (['apps/api/src/providers/powershell-runner.ts', 'apps/api/src/providers/powershell-runner.test.ts']
      .some(file => changed('lifecycle').has(file))) {
    commands.push(['node', ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=4',
      'src/providers/powershell-runner.test.ts', 'src/providers/windows-lifecycle-broker.test.ts']])
  }
  if (changed('status').has('scripts/windows/Get-DysonStatus.ps1') ||
      changed('status').has('apps/api/src/providers/windows-status-script.test.ts')) {
    commands.push(['node', ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=4',
      'src/providers/windows-status-script.test.ts', 'src/providers/windows.test.ts',
      'src/observability/server-status.test.ts', 'src/observability/snapshot.test.ts']])
  }
  if ([...changed('recovery')].some(file => file.startsWith('scripts/windows/data-recovery/'))) {
    commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'scripts/windows/data-recovery/SelfTest-DysonDataRootRecovery.ps1']])
  }
  if ([...changed('bootstrap')].some(file => file.startsWith('scripts/windows/bootstrap/'))) {
    for (const script of ['SelfTest-DysonGameBootstrapPointer.ps1', 'SelfTest-DysonGameLifecycleBootstrap.ps1']) {
      commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', `scripts/windows/bootstrap/${script}`]])
    }
  }
  if ([...changed('lifecycle')].some(file => file.startsWith('scripts/windows/lifecycle-broker/'))) {
    commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1']])
  }
  if (changed('deployment').has('scripts/windows/deployment/Install-DysonControl.ps1')) {
    commands.push(['node', ['apps/api/node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.json']])
    commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1']])
  }
  return commands
}

const deploymentCommand = ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', 'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1']]
const apiBuildCommand = ['npm', ['--prefix', 'apps/api', 'run', 'build']]
const isDeploymentCommand = ([, args]) => args.includes('apps/api/tsconfig.json') ||
  args.includes('scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1')
const commandGroup = command => {
  if (isDeploymentCommand(command)) return 'deployment'
  const args = command[1].join(' ')
  if (args.includes('/bootstrap/')) return 'bootstrap'
  if (args.includes('/lifecycle-broker/') || args.includes('powershell-runner.test.ts')) return 'lifecycle'
  if (args.includes('/data-recovery/')) return 'recovery'
  if (args.includes('windows-status-script.test.ts')) return 'status'
  return null
}

export function planExecution(changes, { componentChanges, hostChecks = false, fullDeployment = false } = {}) {
  const startupChanged = changes.some(change => change.kind === 'startup-policy')
  const verifyBlockersChanged = changes.some(change => change.kind === 'verify-blocker-array')
  const aclChanged = changes.some(change => change.kind === 'expected-exit-acl')
  const controlExitChanged = changes.some(change => change.kind === 'control-exit-policy')
  const requested = rows => rows.map(change => hostChecks && change.kind === 'test-only' &&
    !((controlExitChanged || aclChanged) && change.file === 'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1') &&
    !((verifyBlockersChanged || startupChanged) && change.file === 'scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1')
    ? { ...change, kind: 'affected' } : change)
  const selected = selectCommands(requested(changes), { componentChanges: componentChanges &&
    Object.fromEntries(Object.entries(componentChanges).map(([group, rows]) => [group, requested(rows)])) })
  const isRunnerCheck = ([, args]) => args.includes('src/providers/powershell-runner.test.ts')
  const hostCommands = selected.slice(2).filter(command => !isRunnerCheck(command))
  const commands = [...selected.slice(0, 2), ...selected.slice(2).filter(isRunnerCheck)]
  if (changes.some(change => change.kind === 'reviewed-operator-batch')) {
    commands.push(apiBuildCommand);
    commands.push(['node', ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=4', '--testTimeout=30000', '--hookTimeout=30000', ...operatorBatchApiTests]]);
    commands.push(['node', ['apps/web/node_modules/typescript/bin/tsc', '-b', 'apps/web/tsconfig.json']]);
    commands.push(['node', ['apps/web/node_modules/vite/bin/vite.js', 'build', 'apps/web']]);
    commands.push(['node', ['apps/web/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/web', '--maxWorkers=2', ...operatorBatchWebTests]]);
    for (const script of ['bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1', 'deployment/SelfTest-DysonDeploymentConfigurationIntegration.ps1', 'release/SelfTest-DysonControlReleasePackage.ps1']) {
      hostCommands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/windows/' + script]]);
    }
    hostCommands.push(deploymentCommand);
  }
  if (changes.some(change => change.kind === 'reviewed-manager-removal')) {
    commands.push(apiBuildCommand);
    commands.push(['node', ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=2', 'src/app.test.ts', 'src/config.test.ts', 'src/security/authorization.test.ts', 'src/providers/powershell-runner.test.ts']]);
    commands.push(['node', ['apps/web/node_modules/typescript/bin/tsc', '-b', 'apps/web/tsconfig.json']]);
    commands.push(['node', ['apps/web/node_modules/vite/bin/vite.js', 'build', 'apps/web']]);
    commands.push(['node', ['apps/web/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/web', '--maxWorkers=2',
      'src/App.test.tsx', 'src/nebula-plugin-transaction-api.test.ts', 'src/nebula-plugin-transaction-workspace.test.tsx']]);
    commands.push(['node', ['--test', 'scripts/validate-acceptance.test.mjs', 'scripts/public-release/scanner.test.mjs']]);
    commands.push(['node', ['scripts/validate-acceptance.mjs']]);
    for (const script of [
      'SelfTest-DysonRuntimeTasks.ps1',
      'bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1',
      'data-recovery/SelfTest-DysonDataRootRecovery.ps1',
      'deployment/SelfTest-DysonDeploymentConfigurationIntegration.ps1',
      'deployment/SelfTest-DysonControlDeploymentStatus.ps1',
      'deployment/SelfTest-DysonRebootAcceptance.ps1',
      'lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1',
      'qualification/Invoke-QualificationSelfTest.ps1',
      'qualification/Invoke-QualificationOrchestrationV2SelfTest.ps1',
      'release/SelfTest-DysonControlReleasePackage.ps1',
      'release/SelfTest-DysonControlReleaseArtifact.ps1'
    ]) {
      hostCommands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/windows/' + script]]);
    }
    hostCommands.push(deploymentCommand);
  }
  if (changes.some(change => change.kind === 'reviewed-contract-migration')) {
    commands.push(['node', ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=2', 'src/config.test.ts', 'src/configuration-apply-coordination.test.ts', 'src/configuration-reconcile-coordination.test.ts']]);
    for (const script of ['configuration/SelfTest-DysonControlConfiguration.ps1', 'deployment/SelfTest-DysonDeploymentConfigurationIntegration.ps1', 'release/SelfTest-DysonControlReleasePackage.ps1']) {
      hostCommands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/windows/' + script]]);
    }
    hostCommands.push(deploymentCommand);
  }
  if (changes.some(change => change.kind === 'reviewed-runtime-layout')) {
    commands.push(['node', ['apps/api/node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.json', '--noEmit']])
    commands.push(['node', ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=4',
      '--testTimeout=30000', '--hookTimeout=30000', 'src/runtime-receipt-location.test.ts',
      'src/lifecycle/game-runtime-receipts.test.ts', 'src/app.test.ts',
      'src/update-activation-app-wiring.test.ts', 'src/windows-update-production-assembly.test.ts']])
  }
  if (changes.some(change => ['reviewed-entry-cache', 'reviewed-predecessor-binding'].includes(change.kind))) {
    commands.push(['node', ['apps/api/node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.json', '--noEmit']])
  }
  if (changes.some(change => change.kind === 'reviewed-entry-cache')) {
    commands.push(['node', ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=2',
      'src/web-assets.test.ts', 'src/app.test.ts']])
  }
  if (changes.some(change => change.kind === 'reviewed-predecessor-binding')) {
    commands.push(['node', ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=4',
      '--testTimeout=30000', '--hookTimeout=30000',
      'src/update-pipeline/activation.test.ts', 'src/update-pipeline/activation-http.test.ts',
      'src/providers/windows-update-activation.test.ts', 'src/providers/windows-update-transaction-provider.test.ts',
      'src/update-activation-app-wiring.test.ts', 'src/windows-update-production-assembly.test.ts']])
  }
  if (changes.some(change => change.kind === 'reviewed-hygiene-policy')) {
    commands.push(['node', ['--test', 'scripts/public-release/scanner.test.mjs']])
  }
  if (changes.some(change => change.kind === 'configuration-gate')) commands.push(['node',
    ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=2',
      'src/config.test.ts', 'src/configuration-apply-coordination.test.ts', 'src/configuration-reconcile-coordination.test.ts']])
  if (controlExitChanged) commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1', '-ExitPolicyOnly']])
  if (aclChanged) commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1', '-ExpectedExitAclOnly']])
  if (verifyBlockersChanged) commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', 'scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1', '-VerifyEvidenceOnly']])
  if (startupChanged || changes.some(change => ['apps/api/src/config.test.ts',
      'apps/api/src/providers/windows-lifecycle.test.ts', 'apps/api/src/services/lifecycle-service.test.ts']
      .includes(change.file) && change.kind === 'affected')) {
    commands.push(['node', ['apps/api/node_modules/vitest/vitest.mjs', 'run', '--root', 'apps/api', '--maxWorkers=4',
      'src/app.test.ts', 'src/config.test.ts', 'src/providers/windows-lifecycle.test.ts', 'src/services/lifecycle-service.test.ts']])
  }
  if (changes.some(change => change.kind === 'startup-policy' && change.file.endsWith('Invoke-DysonLifecycleBrokerWorker.ps1'))) {
    commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', 'scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1', '-DispatchStateOnly']])
  }
  const syntaxFiles = changes.filter(change => change.kind === 'test-only').map(change => change.file)
  if (syntaxFiles.length) {
    const literals = syntaxFiles.map(file => `'${file.replaceAll("'", "''")}'`).join(',')
    const script = `$ErrorActionPreference='Stop';foreach($file in @(${literals})){$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) $file),[ref]$tokens,[ref]$errors);if($errors.Count){throw ('PowerShell syntax failed: '+$file)}}`
    commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]])
  }
  if (hostChecks) commands.push(...hostCommands.filter(command => !isDeploymentCommand(command)))
  if (fullDeployment && hostCommands.some(isDeploymentCommand)) commands.push(apiBuildCommand, deploymentCommand)
  const pendingHostCommands = hostCommands.filter(command =>
    isDeploymentCommand(command) ? !fullDeployment : !hostChecks)
  const required = new Set(hostCommands.map(commandGroup))
  const running = new Set(commands.map(commandGroup))
  return { commands, pendingHostCommands, syntaxFiles,
    mode: fullDeployment ? 'explicit-deployment-suite' : hostChecks ? 'target-host' : 'fast',
    components: Object.keys(componentBaselines).map(group => ({ group,
      decision: running.has(group) ? 'run' : required.has(group) ? 'host-validation-required' : 'reuse',
      reason: running.has(group) ? group === 'deployment' ? 'explicit full-deployment request' : 'selected focused or host check' :
        required.has(group) ? 'changed runtime inputs or explicitly requested changed tests' :
          'no affected runtime inputs changed',
      verifiedCommit: componentBaselines[group].commit,
      evidence: componentBaselines[group].evidence })),
    reasons: changes.map(({ file, kind }) => ({ file, kind,
      decision: kind === 'reviewed-operator-batch' ? 'reviewed runtime changes: run mapped integration, UI and native acceptance gates; release is not yet qualified' :
        kind.startsWith('reviewed-') ? 'run the checks mapped to this exact reviewed source; retain independent native release gates' :
        kind === 'configuration-gate' ? 'run focused shared configuration gate checks' :
        kind === 'verified-native-status' ? 'reuse exact native read-only deployment status evidence; HTTP readiness remains separate' :
        kind === 'verified-rc24-source' ? 'reuse exact RC24 CI source evidence; new changes and native qualification remain separate' :
        kind === 'verified-rc23-source' ? 'reuse exact RC23 source evidence; production qualification remains separate' :
        kind === 'control-exit-policy' ? 'reviewed runtime change: execute the focused exit-policy check' :
        kind === 'affected' ? 'run matching checks or reuse the verified component baseline' : 'no production behavior change' })) }
}

export function runValidation(root, planOnly = false, options = {}) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  git(['merge-base', '--is-ancestor', baseline, 'HEAD'])
  const references = [...new Set([baseline, ...Object.values(componentBaselines).map(value => value.commit)])]
  for (const reference of references) {
    if (!/^[0-9a-f]{40}$/.test(reference)) throw new Error('Validation evidence requires an immutable commit')
    git(['merge-base', '--is-ancestor', baseline, reference])
    git(['merge-base', '--is-ancestor', reference, 'HEAD'])
  }
  const files = [...new Set([
    ...references.flatMap(reference => git(['diff', '--name-only', '-z', reference, '--']).split('\0')),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')
  ].filter(Boolean))].sort()
  const changes = files.map(file => {
    const before = git(['ls-tree', baseline, '--', file]).trim()
      ? git(['show', `${baseline}:${file}`]) : null
    let after = null
    try { after = readFileSync(path.join(root, file), 'utf8') } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return { file, kind: classifyChange(file, before, after) }
  })
  const componentChanges = {}
  const changedByReference = new Map()
  const classifiedByReference = new Map([[baseline, changes]])
  for (const [group, verified] of Object.entries(componentBaselines)) {
    git(['merge-base', '--is-ancestor', baseline, verified.commit])
    git(['merge-base', '--is-ancestor', verified.commit, 'HEAD'])
    if (!changedByReference.has(verified.commit)) {
      changedByReference.set(verified.commit, new Set([
        ...git(['diff', '--name-only', '-z', verified.commit, '--']).split('\0'),
        ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')
      ]))
    }
    if (!classifiedByReference.has(verified.commit)) {
      classifiedByReference.set(verified.commit, changes
        .filter(change => changedByReference.get(verified.commit).has(change.file)).map(change => {
        const before = git(['ls-tree', verified.commit, '--', change.file]).trim()
          ? git(['show', `${verified.commit}:${change.file}`]) : null
        let after = null
        try { after = readFileSync(path.join(root, change.file), 'utf8') } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        return { file: change.file, kind: classifyChange(change.file, before, after) }
        }))
    }
    componentChanges[group] = classifiedByReference.get(verified.commit)
      .filter(change => changedByReference.get(verified.commit).has(change.file))
  }
  const execution = planExecution(changes, { ...options, componentChanges })
  const { commands } = execution
  const report = { baseline, subject: git(['rev-parse', 'HEAD']).trim(), changes,
    componentBaselines, ...execution,
    fullSuiteRerun: false, releaseQualified: false, state: 'planned' }
  if (planOnly) return report
  if (options.hostChecks || options.fullDeployment) {
    const sdk = execFileSync('dotnet', ['--version'], { cwd: root, encoding: 'utf8' }).trim()
    if (sdk !== '8.0.424') throw new Error('Expected repository-selected .NET SDK 8.0.424')
  }
  for (const [executable, args] of commands) {
    execFileSync(executable === 'node' ? process.execPath : executable, args, { cwd: root, stdio: 'inherit' })
  }
  return { ...report, state: execution.pendingHostCommands.length ? 'host-validation-required' : 'passed' }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const flag of process.argv.slice(2)) {
    if (!['--plan', '--host-checks', '--full-deployment'].includes(flag)) throw new Error(`Unknown validation option: ${flag}`)
  }
  const root = path.resolve(import.meta.dirname, '..')
  const report = runValidation(root, process.argv.includes('--plan'), {
    hostChecks: process.argv.includes('--host-checks'),
    fullDeployment: process.argv.includes('--full-deployment')
  })
  if (report.state === 'host-validation-required') process.exitCode = 2
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Validation: ${report.state} (${report.mode})\n\nBaseline: ${baseline}\n\nChanged files: ${report.changes.length}. Pending host commands: ${report.pendingHostCommands.length}. Full project suite rerun: false. Production release qualification: not asserted.\n`, { flag: 'a' })
  }
  console.log(JSON.stringify(report, null, 2))
}
