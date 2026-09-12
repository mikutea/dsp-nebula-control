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

export function classifyChange(file, before, after) {
  if (after !== null && reviewedOperatorBatchSources.get(file) === aclSourceHash(after)) return "reviewed-operator-batch"
  if (after !== null && reviewedEntryCacheSources.get(file) === aclSourceHash(after)) return 'reviewed-entry-cache'
  if (after !== null && reviewedPredecessorSources.get(file) === aclSourceHash(after)) return 'reviewed-predecessor-binding'
  if (after !== null && reviewedRuntimeLayoutSources.get(file) === aclSourceHash(after)) return 'reviewed-runtime-layout'
  if (after === null) throw new Error(`Deletion requires an updated validation plan: ${file}`)
  if (file === 'scripts/public-release/scanner.test.mjs' && aclSourceHash(after) === 'e04dc3b368859772a29127de141af4c618d93850efb2c84f968e7fb731a1d581') return 'reviewed-hygiene-policy'
  if (file === 'scripts/public-release/policy.mjs' &&
      aclSourceHash(after) === '1d74d8afc77f704db94403540a893a8758657ad778c450dcdd5398d0c9097546') return 'reviewed-hygiene-policy'
  if (file === 'scripts/windows/deployment/Test-DysonControlDeployment.ps1' &&
      aclSourceHash(after) === '248758ae47a5edf9678f0c515eb564c31e3cb127538347556319ba10ae44766a') return 'verified-native-status'
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
const apiBuildCommand = ['node', ['apps/api/node_modules/typescript/bin/tsc', '-p', 'apps/api/tsconfig.json']]
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
