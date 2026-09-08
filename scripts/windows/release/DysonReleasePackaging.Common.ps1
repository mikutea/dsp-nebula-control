Set-StrictMode -Version 2.0

$script:DysonArtifactProtocol = 'DYSON_CONTROL_RELEASE_ARTIFACT_V1'
$script:DysonArtifactManifestName = 'artifact-manifest.json'
$script:DysonArtifactEntryPoint = 'apps/api/dist/index.js'
$script:DysonArtifactRequiredApiLifecycleFiles = @(
    'apps/api/dist/lifecycle/game-runtime-receipts.js'
)
$script:DysonArtifactRequiredApiHostnameWssRuntimeFiles = @(
    'apps/api/dist/client-profile/canonical.js',
    'apps/api/dist/client-profile/index.js',
    'apps/api/dist/client-profile/issued-profile-store.js',
    'apps/api/dist/client-profile/qualification-store.js',
    'apps/api/dist/client-profile/qualification-v2.js',
    'apps/api/dist/client-profile/qualified-generator.js',
    'apps/api/dist/providers/windows-hostname-wss-qualification.js',
    'apps/api/dist/services/qualified-client-profile-service.js'
)
if ($script:DysonArtifactRequiredApiHostnameWssRuntimeFiles.Count -ne 8 -or
    @($script:DysonArtifactRequiredApiHostnameWssRuntimeFiles | Select-Object -Unique).Count -ne 8) {
    throw 'The exact compiled hostname-WSS client qualification API package is inconsistent.'
}
$script:DysonArtifactRequiredApiUpdateCoreRuntimeFiles = @(
    'apps/api/dist/providers/windows-update-runtime-evidence.js',
    'apps/api/dist/providers/windows-update-transaction-provider.js',
    'apps/api/dist/providers/windows-runtime-compatibility.js'
)
$script:DysonArtifactRequiredApiObservabilityRuntimeFiles = @(
    'apps/api/dist/observability/alerts.js',
    'apps/api/dist/observability/errors.js',
    'apps/api/dist/observability/health.js',
    'apps/api/dist/observability/history.js',
    'apps/api/dist/observability/index.js',
    'apps/api/dist/observability/latency.js',
    'apps/api/dist/observability/long-window.js',
    'apps/api/dist/observability/persistent-alerts.js',
    'apps/api/dist/observability/persistent-history.js',
    'apps/api/dist/observability/qualification.js',
    'apps/api/dist/observability/server-status.js',
    'apps/api/dist/observability/snapshot.js',
    'apps/api/dist/observability/types.js',
    'apps/api/dist/observability/windows-bridge.js'
)
if ($script:DysonArtifactRequiredApiObservabilityRuntimeFiles.Count -ne 14 -or
    @($script:DysonArtifactRequiredApiObservabilityRuntimeFiles | Select-Object -Unique).Count -ne 14) {
    throw 'The exact compiled observability runtime package is inconsistent.'
}
$script:DysonArtifactRequiredApiObservabilitySourceFiles = @(
    $script:DysonArtifactRequiredApiObservabilityRuntimeFiles | ForEach-Object {
        $_.Replace('apps/api/dist/', 'apps/api/src/').Replace('.js', '.ts')
    }
)
if ($script:DysonArtifactRequiredApiObservabilitySourceFiles.Count -ne 14 -or
    @($script:DysonArtifactRequiredApiObservabilitySourceFiles | Select-Object -Unique).Count -ne 14) {
    throw 'The exact observability source package is inconsistent.'
}
$script:DysonArtifactRequiredApiNebulaPluginTransactionFiles = @(
    'apps/api/dist/nebula-plugin-transaction-routes.js',
    'apps/api/dist/providers/powershell-runner.js',
    'apps/api/dist/providers/windows-nebula-plugin-transaction.js'
)
# New-DysonControlReleaseArtifact consumes this aggregate for its existing
# required compiled-API selection.  The verifier below keeps the update and
# Nebula contracts separate so either package fails with a precise reason.
$script:DysonArtifactRequiredApiUpdateRuntimeFiles = @(
    $script:DysonArtifactRequiredApiUpdateCoreRuntimeFiles +
    $script:DysonArtifactRequiredApiNebulaPluginTransactionFiles
)
if ($script:DysonArtifactRequiredApiUpdateCoreRuntimeFiles.Count -ne 3 -or
    $script:DysonArtifactRequiredApiNebulaPluginTransactionFiles.Count -ne 3 -or
    $script:DysonArtifactRequiredApiUpdateRuntimeFiles.Count -ne 6 -or
    @($script:DysonArtifactRequiredApiUpdateRuntimeFiles |
        Select-Object -Unique).Count -ne 6) {
    throw 'The exact compiled Windows runtime API package is inconsistent.'
}
$script:DysonArtifactRequiredTopLevelWindowsScripts = @(
    'scripts/windows/Get-DysonLifecyclePreflight.ps1',
    'scripts/windows/Get-DysonManagedPluginVersion.ps1',
    'scripts/windows/Get-DysonStatus.ps1',
    'scripts/windows/Install-DysonRuntimeTasks.ps1',
    'scripts/windows/Invoke-DysonScheduledTask.ps1',
    'scripts/windows/New-DysonSaveProtectionPoint.ps1',
    'scripts/windows/SelfTest-DysonRuntimeTasks.ps1',
    'scripts/windows/Start-DysonServer.ps1',
    'scripts/windows/Stop-DysonServer.ps1',
    'scripts/windows/Test-DysonRuntimeState.ps1'
)
$script:DysonArtifactRequiredReleaseScripts = @(
    'scripts/windows/release/DysonReleasePackaging.Common.ps1',
    'scripts/windows/release/Test-DysonControlReleaseArtifact.ps1'
)
$script:DysonArtifactRequiredDeploymentScripts = @(
    'scripts/windows/deployment/DysonDeployment.Common.ps1',
    'scripts/windows/deployment/DysonDeployment.Configuration.ps1',
    'scripts/windows/deployment/DysonNodeRuntime.Transaction.ps1',
    'scripts/windows/deployment/DysonRebootAcceptance.Common.ps1',
    'scripts/windows/deployment/Install-DysonControl.ps1',
    'scripts/windows/deployment/Install-DysonControlTask.ps1',
    'scripts/windows/deployment/Install-DysonNodeRuntime.ps1',
    'scripts/windows/deployment/Set-DysonGameBootstrapAccess.ps1',
    'scripts/windows/deployment/Invoke-DysonControlDeployment.ps1',
    'scripts/windows/deployment/New-DysonRebootAcceptanceCheckpoint.ps1',
    'scripts/windows/deployment/Repair-DysonNodeRuntime.ps1',
    'scripts/windows/deployment/Start-DysonControl.ps1',
    'scripts/windows/deployment/Test-DysonControlDeployment.ps1',
    'scripts/windows/deployment/Test-DysonRebootAcceptanceResume.ps1',
    'scripts/windows/deployment/Uninstall-DysonControl.ps1'
)
$script:DysonArtifactRequiredConfigurationFiles = @(
    'scripts/windows/configuration/DysonConfiguration.Common.ps1',
    'scripts/windows/configuration/Install-DysonControlConfiguration.ps1',
    'scripts/windows/configuration/New-DysonControlConfigurationSnapshot.ps1',
    'scripts/windows/configuration/Restore-DysonControlConfiguration.ps1',
    'scripts/windows/configuration/Test-DysonControlConfiguration.ps1',
    'scripts/windows/configuration/SelfTest-DysonControlConfiguration.ps1',
    'scripts/windows/configuration/dyson-control.environment-contract.json',
    'scripts/windows/configuration/README.md'
)
$script:DysonArtifactRequiredSessionScripts = @(
    'scripts/windows/session/Configure-DysonInteractiveSession.ps1',
    'scripts/windows/session/Disable-DysonInteractiveSession.ps1',
    'scripts/windows/session/DysonSession.Common.ps1',
    'scripts/windows/session/Test-DysonInteractiveSession.ps1'
)
$script:DysonArtifactMaximumFiles = 50000
$script:DysonArtifactMaximumBytes = [int64](2GB)
$script:DysonArtifactRequiredBridgeSources = @(
    'integrations/dyson-control-bridge/BridgeFileStore.cs',
    'integrations/dyson-control-bridge/BridgeProtocol.cs',
    'integrations/dyson-control-bridge/DysonControlBridge.csproj',
    'integrations/dyson-control-bridge/DysonControlBridgePlugin.cs',
    'integrations/dyson-control-bridge/GameSaveAdapter.cs',
    'integrations/dyson-control-bridge/LoadedSaveEvidencePublisher.cs',
    'integrations/dyson-control-bridge/NebulaNoticeRuntimeCompatibility.cs',
    'integrations/dyson-control-bridge/PlayerNoticeProtocol.cs',
    'integrations/dyson-control-bridge/PlayerRosterPublisher.cs',
    'integrations/dyson-control-bridge/SimulationTelemetrySampler.cs',
    'integrations/dyson-control-bridge/README.md',
    'integrations/dyson-control-bridge/dyson-control-bridge.cfg.example'
)
$script:DysonArtifactRequiredBridgeScripts = @(
    'scripts/windows/bridge/Build-DysonControlBridgeCandidate.ps1',
    'scripts/windows/bridge/DysonBridge.Common.ps1',
    'scripts/windows/bridge/DysonBridge.Telemetry.ps1',
    'scripts/windows/bridge/Get-DysonBridgeSimulationTelemetry.ps1',
    'scripts/windows/bridge/Install-DysonControlBridge.ps1',
    'scripts/windows/bridge/Test-DysonControlBridgeCandidate.ps1',
    'scripts/windows/bridge/Test-DysonControlBridgeInstallation.ps1',
    'scripts/windows/bridge/Uninstall-DysonControlBridge.ps1'
)
$script:DysonArtifactRequiredBridgeSimulationTelemetryFiles = @(
    'integrations/dyson-control-bridge/SimulationTelemetrySampler.cs',
    'scripts/windows/bridge/DysonBridge.Telemetry.ps1',
    'scripts/windows/bridge/Get-DysonBridgeSimulationTelemetry.ps1'
)
if ($script:DysonArtifactRequiredBridgeSimulationTelemetryFiles.Count -ne 3 -or
    @($script:DysonArtifactRequiredBridgeSimulationTelemetryFiles | Where-Object {
        $_ -cnotin @($script:DysonArtifactRequiredBridgeSources + $script:DysonArtifactRequiredBridgeScripts)
    }).Count -ne 0) {
    throw 'The exact Bridge simulation telemetry package is inconsistent with the Bridge release allowlists.'
}
$script:DysonArtifactRequiredBridgeReferenceSpecifications = @(
    [ordered]@{ name = 'BepInEx.dll'; relativePath = 'BepInEx\core\BepInEx.dll' },
    [ordered]@{ name = '0Harmony.dll'; relativePath = 'BepInEx\core\0Harmony.dll' },
    [ordered]@{ name = 'UnityEngine.dll'; relativePath = 'DSPGAME_Data\Managed\UnityEngine.dll' },
    [ordered]@{ name = 'UnityEngine.CoreModule.dll'; relativePath = 'DSPGAME_Data\Managed\UnityEngine.CoreModule.dll' },
    [ordered]@{ name = 'netstandard.dll'; relativePath = 'DSPGAME_Data\Managed\netstandard.dll' },
    [ordered]@{ name = 'Assembly-CSharp.dll'; relativePath = 'DSPGAME_Data\Managed\Assembly-CSharp.dll' },
    [ordered]@{ name = 'NebulaAPI.dll'; relativePath = 'BepInEx\plugins\nebula-NebulaMultiplayerModApi\NebulaAPI.dll' },
    [ordered]@{ name = 'NebulaModel.dll'; relativePath = 'BepInEx\plugins\nebula-NebulaMultiplayerMod\NebulaModel.dll' }
)
if ($script:DysonArtifactRequiredBridgeReferenceSpecifications.Count -ne 8 -or
    @($script:DysonArtifactRequiredBridgeReferenceSpecifications.name | Select-Object -Unique).Count -ne 8 -or
    @($script:DysonArtifactRequiredBridgeReferenceSpecifications.relativePath | Select-Object -Unique).Count -ne 8) {
    throw 'The exact Bridge fixed reference package is inconsistent.'
}
$script:DysonArtifactRequiredMigrationScripts = @(
    'scripts/windows/migration/DysonGsManagerMigration.Common.ps1',
    'scripts/windows/migration/Get-DysonGsManagerMigration.ps1',
    'scripts/windows/migration/New-DysonGsManagerSnapshot.ps1',
    'scripts/windows/migration/Restore-DysonGsManagerSnapshot.ps1',
    'scripts/windows/migration/SelfTest-DysonGsManagerMigration.ps1',
    'scripts/windows/migration/Test-DysonGsManagerSnapshot.ps1'
)
$script:DysonArtifactRequiredGsManagerRemovalScripts = @(
    'scripts/windows/migration/DysonGsManagerRemoval.Common.ps1',
    'scripts/windows/migration/Remove-DysonGsManagerInstallation.ps1',
    'scripts/windows/migration/Restore-DysonGsManagerRemoval.ps1',
    'scripts/windows/migration/SelfTest-DysonGsManagerRemoval.ps1',
    'scripts/windows/migration/Test-DysonGsManagerRemoval.ps1'
)
$script:DysonArtifactRequiredEvidenceScripts = @(
    'scripts/windows/evidence/DysonPrivateEvidence.Common.ps1',
    'scripts/windows/evidence/New-DysonAcceptanceEvidenceIndex.ps1',
    'scripts/windows/evidence/New-DysonPrivateEvidenceBundle.ps1',
    'scripts/windows/evidence/SelfTest-DysonPrivateEvidenceBundle.ps1',
    'scripts/windows/evidence/Test-DysonPrivateEvidenceBundle.ps1'
)
$script:DysonArtifactRequiredHostMutationLeaseScripts = @(
    'scripts/windows/DysonHostMutationLease.Common.ps1',
    'scripts/windows/Invoke-DysonHostMutationLeaseBroker.ps1',
    'scripts/windows/SelfTest-DysonHostMutationLease.ps1'
)
$script:DysonArtifactRequiredNebulaPluginTransactionRunnerFiles = @(
    'scripts/windows/nebula-private-build/New-NebulaPluginCutoverPlan.ps1',
    'scripts/windows/nebula-private-build/Invoke-NebulaPluginCutover.ps1',
    'scripts/windows/nebula-private-build/Restore-NebulaPluginCutover.ps1',
    'scripts/windows/nebula-private-build/Test-NebulaPluginCutover.ps1',
    'scripts/windows/nebula-private-build/Test-NebulaPluginRollback.ps1'
)
$script:DysonArtifactRequiredNebulaPluginTransactionFiles = @(
    $script:DysonArtifactRequiredNebulaPluginTransactionRunnerFiles +
    'scripts/windows/nebula-private-build/NebulaPluginTransaction.Common.ps1',
    'scripts/windows/nebula-private-build/NebulaPrivateBuild.Common.ps1',
    'scripts/windows/nebula-private-build/private-build-contract.v1.json'
)
# The artifact builder already copies repository-relative host-mutation inputs;
# use that bounded selection channel for the V3 transaction runtime without
# permitting the rest of the private-build source tree into the public release.
$script:DysonArtifactRequiredHostMutationScripts = @(
    $script:DysonArtifactRequiredHostMutationLeaseScripts +
    $script:DysonArtifactRequiredNebulaPluginTransactionFiles
)
if ($script:DysonArtifactRequiredNebulaPluginTransactionRunnerFiles.Count -ne 5 -or
    $script:DysonArtifactRequiredNebulaPluginTransactionFiles.Count -ne 8 -or
    @($script:DysonArtifactRequiredNebulaPluginTransactionFiles |
        Select-Object -Unique).Count -ne 8 -or
    @($script:DysonArtifactRequiredNebulaPluginTransactionRunnerFiles | Where-Object {
        $_ -cnotin $script:DysonArtifactRequiredNebulaPluginTransactionFiles
    }).Count -ne 0) {
    throw 'The exact Nebula V3 whole-plugin-tree runtime package is inconsistent.'
}
if ($script:DysonArtifactRequiredHostMutationLeaseScripts.Count -ne 3 -or
    $script:DysonArtifactRequiredHostMutationScripts.Count -ne 11 -or
    @($script:DysonArtifactRequiredHostMutationScripts |
        Select-Object -Unique).Count -ne 11) {
    throw 'The bounded host-mutation runtime selection package is inconsistent.'
}
$script:DysonArtifactRequiredGameBootstrapScripts = @(
    'scripts/windows/bootstrap/DysonGameLifecycleBootstrap.Common.ps1',
    'scripts/windows/bootstrap/Resolve-DysonGameLifecycleRelease.ps1',
    'scripts/windows/bootstrap/SelfTest-DysonGameLifecycleBootstrap.ps1',
    'scripts/windows/bootstrap/Start-DysonServer.ps1',
    'scripts/windows/bootstrap/Stop-DysonServer.ps1'
)
$script:DysonArtifactRequiredCutoverScripts = @(
    'scripts/windows/cutover/DysonCutoverHost.Common.ps1',
    'scripts/windows/cutover/DysonGsManagerAuthority.Common.ps1',
    'scripts/windows/cutover/Get-DysonCutoverEvidence.ps1',
    'scripts/windows/cutover/Initialize-DysonGsManagerAuthority.ps1',
    'scripts/windows/cutover/Invoke-DysonCutoverAction.ps1',
    'scripts/windows/cutover/SelfTest-DysonCutoverHost.ps1',
    'scripts/windows/cutover/SelfTest-DysonGsManagerAuthority.ps1'
)
$script:DysonArtifactRequiredCutoverBrokerScripts = @(
    'scripts/windows/cutover-broker/DysonCutoverBroker.Common.ps1',
    'scripts/windows/cutover-broker/DysonCutoverBroker.TaskAcl.ps1',
    'scripts/windows/cutover-broker/Install-DysonCutoverBrokerTask.ps1',
    'scripts/windows/cutover-broker/Invoke-DysonCutoverBrokerWorker.ps1',
    'scripts/windows/cutover-broker/SelfTest-DysonCutoverBroker.ps1',
    'scripts/windows/cutover-broker/Submit-DysonCutoverBrokerRequest.ps1'
)
$script:DysonArtifactRequiredLifecycleBrokerScripts = @(
    'scripts/windows/lifecycle-broker/DysonLifecycleBroker.Common.ps1',
    'scripts/windows/lifecycle-broker/DysonLifecycleBroker.TaskAcl.ps1',
    'scripts/windows/lifecycle-broker/Install-DysonLifecycleBrokerTask.ps1',
    'scripts/windows/lifecycle-broker/Invoke-DysonLifecycleBrokerWorker.ps1',
    'scripts/windows/lifecycle-broker/SelfTest-DysonLifecycleBroker.ps1',
    'scripts/windows/lifecycle-broker/Submit-DysonLifecycleBrokerRequest.ps1'
)
$script:DysonArtifactRequiredDataRecoveryScripts = @(
    'scripts/windows/data-recovery/DysonDataRootRecovery.Common.ps1',
    'scripts/windows/data-recovery/New-DysonDataRootRecoveryBundle.ps1',
    'scripts/windows/data-recovery/Restore-DysonDataRootRecoveryBundle.ps1',
    'scripts/windows/data-recovery/SelfTest-DysonDataRootRecovery.ps1',
    'scripts/windows/data-recovery/Test-DysonDataRootRecoveryBundle.ps1'
)
$script:DysonArtifactRequiredNetworkFiles = @(
    'scripts/windows/network/dyson-nebula-hostname-wss-qualification-v1.schema.json',
    'scripts/windows/network/dyson-nebula-network-assessment-v1.schema.json',
    'scripts/windows/network/dyson-nebula-network-assessment-v2.schema.json',
    'scripts/windows/network/DysonHostnameWssQualification.Common.ps1',
    'scripts/windows/network/DysonNetwork.Common.ps1',
    'scripts/windows/network/DysonNetworkV2.Common.ps1',
    'scripts/windows/network/fixtures/shadow-ready-direct-ws.json',
    'scripts/windows/network/fixtures/shadow-websocket-classification.json',
    'scripts/windows/network/fixtures/shadow-wss-hostname-boundary.json',
    'scripts/windows/network/fixtures/hostname-wss-canonical-v1.fixture.json',
    'scripts/windows/network/fixtures/hostname-wss-mod-manifest-digests-v1.fixture.json',
    'scripts/windows/network/SelfTest-DysonHostnameWssQualification.ps1',
    'scripts/windows/network/SelfTest-DysonNebulaNetwork.ps1',
    'scripts/windows/network/SelfTest-DysonNebulaNetworkV2.ps1',
    'scripts/windows/network/Test-DysonHostnameWssQualification.ps1',
    'scripts/windows/network/Test-DysonNebulaNetwork.ps1',
    'scripts/windows/network/Test-DysonNebulaNetworkV2.ps1'
)
if ($script:DysonArtifactRequiredNetworkFiles.Count -ne 17 -or
    @($script:DysonArtifactRequiredNetworkFiles | Select-Object -Unique).Count -ne 17) {
    throw 'The exact Nebula network and hostname-WSS qualification runtime package is inconsistent.'
}
$script:DysonArtifactRequiredHostnameWssQualificationFiles = @(
    'scripts/windows/qualification/Qualification.Protocol.ps1',
    'scripts/windows/qualification/Qualification.ProtocolV2.ps1'
)
if ($script:DysonArtifactRequiredHostnameWssQualificationFiles.Count -ne 2 -or
    @($script:DysonArtifactRequiredHostnameWssQualificationFiles | Select-Object -Unique).Count -ne 2) {
    throw 'The exact hostname-WSS qualification protocol package is inconsistent.'
}
$script:DysonArtifactRequiredQualificationOrchestrationV2Files = @(
    'scripts/windows/qualification/Qualification.OrchestrationV2.ps1',
    'scripts/windows/qualification/Invoke-QualificationOrchestrationV2.ps1',
    'scripts/windows/qualification/Invoke-QualificationOrchestrationV2SelfTest.ps1',
    'scripts/windows/qualification/qualification-orchestration-profile.v2.schema.json',
    'scripts/windows/qualification/qualification-orchestration-request.v2.schema.json',
    'scripts/windows/qualification/qualification-controlled-evidence.v2.schema.json',
    'scripts/windows/qualification/fixtures/orchestration-adapter-contract.v2.json',
    'scripts/windows/qualification/README.production-v2.md'
)
if ($script:DysonArtifactRequiredQualificationOrchestrationV2Files.Count -ne 8 -or
    @($script:DysonArtifactRequiredQualificationOrchestrationV2Files | Select-Object -Unique).Count -ne 8) {
    throw 'The exact qualification orchestration V2 runtime package is inconsistent.'
}
$script:DysonArtifactRequiredQualificationFrameworkFiles = @(
    'scripts/windows/qualification/Qualification.Plan.ps1',
    'scripts/windows/qualification/Qualification.Executor.ps1',
    'scripts/windows/qualification/Qualification.Shadow.ps1',
    'scripts/windows/qualification/Invoke-QualificationSelfTest.ps1',
    'scripts/windows/qualification/qualification-plan.v1.json',
    'scripts/windows/qualification/fixtures/adapter-contract.v1.json',
    'scripts/windows/qualification/fixtures/shadow-scenarios.v1.json',
    'scripts/windows/qualification/README.protocol.md',
    'scripts/windows/qualification/README.shadow.md',
    'scripts/windows/qualification/Qualification.ExecutorV2.ps1',
    'scripts/windows/qualification/Qualification.ProductionAdaptersV2.ps1',
    'scripts/windows/qualification/Qualification.FakeV2.ps1',
    'scripts/windows/qualification/Invoke-QualificationV2SelfTest.ps1',
    'scripts/windows/qualification/qualification-production-profile.v2.schema.json',
    'scripts/windows/qualification/qualification-action-request.v2.schema.json',
    'scripts/windows/qualification/fixtures/adapter-contract.v2.json'
)
if ($script:DysonArtifactRequiredQualificationFrameworkFiles.Count -ne 16 -or
    @($script:DysonArtifactRequiredQualificationFrameworkFiles | Select-Object -Unique).Count -ne 16) {
    throw 'The exact qualification V1/V2 framework package is inconsistent.'
}
$script:DysonArtifactRequiredStrictQualificationV2Files = @(
    'scripts/windows/qualification/Qualification.SideBySideV2.ps1',
    'scripts/windows/qualification/New-DysonSideBySideObservationV2.ps1',
    'scripts/windows/qualification/Test-DysonSideBySideObservationV2.ps1',
    'scripts/windows/qualification/SelfTest-DysonSideBySideObservationV2.ps1',
    'scripts/windows/qualification/README.SideBySideV2.md',
    'scripts/windows/qualification/Qualification.PairedSaveLoad.ps1',
    'scripts/windows/qualification/New-DysonQualificationPairedSaveLoadObservationV2.ps1',
    'scripts/windows/qualification/Test-DysonQualificationPairedSaveLoadObservationV2.ps1',
    'scripts/windows/qualification/SelfTest-DysonQualificationPairedSaveLoadObservationV2.ps1',
    'scripts/windows/qualification/SelfTest-DysonQualificationPairedSaveLoadRecordV2.ps1',
    'scripts/windows/qualification/PanelObservationV2.Common.ps1',
    'scripts/windows/qualification/New-DysonControlPanelObservationV2.ps1',
    'scripts/windows/qualification/Test-DysonControlPanelObservationV2.ps1',
    'scripts/windows/qualification/SelfTest-DysonControlPanelObservationV2.ps1',
    'scripts/windows/qualification/dyson-control-panel-observation-v2.schema.json',
    'scripts/windows/qualification/ExternalJoinObservationV2.Common.ps1',
    'scripts/windows/qualification/New-DysonExternalJoinObservationV2.ps1',
    'scripts/windows/qualification/Test-DysonExternalJoinObservationV2.ps1',
    'scripts/windows/qualification/SelfTest-DysonExternalJoinObservationV2.ps1',
    'scripts/windows/qualification/dyson-external-join-observation-v2.schema.json',
    'scripts/windows/qualification/README.ExternalJoinObservationV2.md',
    'scripts/windows/qualification/Qualification.ReversibleCutover.ps1',
    'scripts/windows/qualification/New-DysonQualificationReversibleCutoverObservationV2.ps1',
    'scripts/windows/qualification/Test-DysonQualificationReversibleCutoverObservationV2.ps1',
    'scripts/windows/qualification/SelfTest-DysonQualificationReversibleCutoverObservationV2.ps1',
    'scripts/windows/qualification/reversible-cutover-observation.v2.schema.json',
    'scripts/windows/qualification/README-ReversibleCutover.md',
    'scripts/windows/qualification/PostGsManagerRemovalObservationV2.Common.ps1',
    'scripts/windows/qualification/New-DysonPostGsManagerRemovalObservationV2.ps1',
    'scripts/windows/qualification/Test-DysonPostGsManagerRemovalObservationV2.ps1',
    'scripts/windows/qualification/SelfTest-DysonPostGsManagerRemovalObservationV2.ps1',
    'scripts/windows/qualification/dyson-post-gsmanager-removal-observation-v2.schema.json',
    'scripts/windows/qualification/README.PostGsManagerRemovalObservationV2.md',
    'scripts/windows/qualification/SoakObservationV2.Common.ps1',
    'scripts/windows/qualification/New-DysonSoakObservationV2.ps1',
    'scripts/windows/qualification/Test-DysonSoakObservationV2.ps1',
    'scripts/windows/qualification/SelfTest-DysonSoakObservationV2.ps1',
    'scripts/windows/qualification/dyson-soak-observation-v2.schema.json',
    'scripts/windows/qualification/README.SoakObservationV2.md'
)
if ($script:DysonArtifactRequiredStrictQualificationV2Files.Count -ne 39 -or
    @($script:DysonArtifactRequiredStrictQualificationV2Files | Select-Object -Unique).Count -ne 39) {
    throw 'The exact strict qualification V2 protocol package is inconsistent.'
}
$script:DysonArtifactRequiredQualificationRuntimeFiles = @(
    $script:DysonArtifactRequiredHostnameWssQualificationFiles +
    $script:DysonArtifactRequiredQualificationOrchestrationV2Files +
    $script:DysonArtifactRequiredQualificationFrameworkFiles +
    $script:DysonArtifactRequiredStrictQualificationV2Files
)
if ($script:DysonArtifactRequiredQualificationRuntimeFiles.Count -ne 65 -or
    @($script:DysonArtifactRequiredQualificationRuntimeFiles | Select-Object -Unique).Count -ne 65) {
    throw 'The aggregate qualification runtime package is inconsistent.'
}
$script:DysonArtifactRequiredNebulaHostnameWssSources = @(
    'integrations/nebula-hostname-wss/contract.json',
    'integrations/nebula-hostname-wss/patches/nebula-v0.9.22-hostname-wss.patch'
)
if ($script:DysonArtifactRequiredNebulaHostnameWssSources.Count -ne 2 -or
    @($script:DysonArtifactRequiredNebulaHostnameWssSources | Select-Object -Unique).Count -ne 2) {
    throw 'The exact public hostname-WSS source contract package is inconsistent.'
}
$script:DysonArtifactRequiredMigrationDocs = @(
    'docs/GSM-EVALUATION.md',
    'docs/WINDOWS-DEPLOYMENT-DRAFT.md'
)
$script:DysonArtifactRequiredGsManagerRemovalDocs = @(
    'docs/MIGRATION-GSMANAGER.md'
)
$script:DysonArtifactRequiredRecoveryDocs = @(
    'docs/DATAROOT-RECOVERY.md'
)
$script:DysonArtifactRequiredNetworkDocs = @(
    'docs/NETWORK-CONNECTIVITY.md'
)
$script:DysonArtifactRequiredQualificationDocs = @(
    'docs/PRODUCTION-QUALIFICATION.md'
)
if ($script:DysonArtifactRequiredQualificationDocs.Count -ne 1) {
    throw 'The exact production qualification documentation package is inconsistent.'
}
$script:DysonArtifactRepositoryOnlyPaths = @(
    'apps/api/dist/mods/deployment-hard-exit.fixture.js',
    'apps/api/dist/update-pipeline/bepinex-discovery.fixtures.js',
    'integrations/nebula-hostname-wss/README.md',
    'integrations/dyson-control-bridge/protocol-tests/DysonControlBridge.ProtocolTests.csproj',
    'integrations/dyson-control-bridge/protocol-tests/Program.cs',
    'scripts/windows/bridge/SelfTest-DysonBridgeSimulationTelemetry.ps1',
    'scripts/windows/bridge/SelfTest-DysonControlBridge.ps1',
    'scripts/windows/deployment/SelfTest-DysonControlDeployment.ps1',
    'scripts/windows/deployment/SelfTest-DysonDeploymentConfigurationIntegration.ps1',
    'scripts/windows/deployment/SelfTest-DysonControlDeploymentStatus.ps1',
    'scripts/windows/deployment/SelfTest-DysonNodeRuntimeProtection.ps1',
    'scripts/windows/deployment/SelfTest-DysonRebootAcceptance.ps1',
    'scripts/windows/release/DysonReleaseArchive.Common.ps1',
    'scripts/windows/release/New-DysonControlReleaseArtifact.ps1',
    'scripts/windows/release/New-DysonControlReleasePackage.ps1',
    'scripts/windows/release/release-workflow.test.mjs',
    'scripts/windows/release/SelfTest-DysonControlReleaseArtifact.ps1',
    'scripts/windows/release/SelfTest-DysonControlReleasePackage.ps1',
    'scripts/windows/release/Test-DysonControlReleasePackage.ps1',
    'scripts/windows/session/SelfTest-DysonInteractiveSession.ps1'
)
$script:DysonArtifactRepositoryOnlyPathPrefixes = @(
    'apps/api/dist/cli/',
    'apps/api/dist/unused/',
    'integrations/dyson-control-bridge/protocol-tests/',
    'scripts/windows/qualification/'
)
$script:DysonArtifactRepositoryOnlyApiJavaScriptSuffixes = @(
    '.test.js',
    '.spec.js',
    '.fixture.js',
    '.fixtures.js'
)
& {
    $requiredRuntimePaths = @(
        $script:DysonArtifactRequiredApiLifecycleFiles +
        $script:DysonArtifactRequiredApiHostnameWssRuntimeFiles +
        $script:DysonArtifactRequiredApiUpdateRuntimeFiles +
        $script:DysonArtifactRequiredApiObservabilityRuntimeFiles +
        $script:DysonArtifactRequiredTopLevelWindowsScripts +
        $script:DysonArtifactRequiredReleaseScripts +
        $script:DysonArtifactRequiredDeploymentScripts +
        $script:DysonArtifactRequiredConfigurationFiles +
        $script:DysonArtifactRequiredSessionScripts +
        $script:DysonArtifactRequiredBridgeSources +
        $script:DysonArtifactRequiredBridgeScripts +
        $script:DysonArtifactRequiredMigrationScripts +
        $script:DysonArtifactRequiredGsManagerRemovalScripts +
        $script:DysonArtifactRequiredEvidenceScripts +
        $script:DysonArtifactRequiredHostMutationScripts +
        $script:DysonArtifactRequiredGameBootstrapScripts +
        $script:DysonArtifactRequiredCutoverScripts +
        $script:DysonArtifactRequiredCutoverBrokerScripts +
        $script:DysonArtifactRequiredLifecycleBrokerScripts +
        $script:DysonArtifactRequiredDataRecoveryScripts +
        $script:DysonArtifactRequiredNetworkFiles +
        $script:DysonArtifactRequiredQualificationRuntimeFiles +
        $script:DysonArtifactRequiredNebulaHostnameWssSources +
        $script:DysonArtifactRequiredMigrationDocs +
        $script:DysonArtifactRequiredGsManagerRemovalDocs +
        $script:DysonArtifactRequiredRecoveryDocs +
        $script:DysonArtifactRequiredNetworkDocs +
        $script:DysonArtifactRequiredQualificationDocs
    )
    if (@($script:DysonArtifactRepositoryOnlyPaths | Where-Object { $_ -cin $requiredRuntimePaths }).Count -ne 0) {
        throw 'A repository-only release path overlaps the required runtime allowlist.'
    }
}

function ConvertTo-DysonArtifactJsonLine {
    [CmdletBinding()]
    param([Parameter(Mandatory, ValueFromPipeline)]$Value)

    process { return $Value | ConvertTo-Json -Depth 12 -Compress }
}

function Get-DysonArtifactFullPath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'An artifact path cannot be empty.' }
    if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $Path))
}

function Assert-DysonArtifactVersion {
    param([Parameter(Mandatory)][string]$Version)

    if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$') {
        throw 'The artifact version must contain only letters, numbers, dot, underscore, plus, or hyphen.'
    }
}

function Assert-DysonArtifactSafeRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name
    )

    $full = Get-DysonArtifactFullPath -Path $Path
    $root = [System.IO.Path]::GetPathRoot($full)
    if ([string]::Equals($full.TrimEnd('\', '/'), $root.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name cannot be a filesystem root."
    }
    return $full
}

function Test-DysonArtifactPathWithin {
    param(
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Parent,
        [switch]$AllowEqual
    )

    $candidateFull = (Get-DysonArtifactFullPath -Path $Candidate).TrimEnd('\', '/')
    $parentFull = (Get-DysonArtifactFullPath -Path $Parent).TrimEnd('\', '/')
    if ($AllowEqual -and [string]::Equals($candidateFull, $parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $candidateFull.StartsWith(
        $parentFull + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-DysonArtifactPlainDirectory {
    param([Parameter(Mandatory)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Artifact directory is unavailable or redirected: $Path"
    }
    return $item.FullName
}

function New-DysonArtifactDirectory {
    param([Parameter(Mandatory)][string]$Path)

    [System.IO.Directory]::CreateDirectory($Path) | Out-Null
    return Assert-DysonArtifactPlainDirectory -Path $Path
}

function Assert-DysonArtifactRelativePath {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or [System.IO.Path]::IsPathRooted($Path) -or
        $Path -match '(^|[\/])\.\.([\/]|$)' -or $Path.IndexOf([char]0) -ge 0 -or $Path -match '["\r\n]') {
        throw 'Artifact inventory paths must be bounded and relative.'
    }
}

function Test-DysonArtifactRepositoryOnlyPath {
    param([Parameter(Mandatory)][string]$RelativePath)

    Assert-DysonArtifactRelativePath -Path $RelativePath
    $normalized = $RelativePath.Replace('\', '/')
    $lower = $normalized.ToLowerInvariant()
    $repositoryOnlyPaths = @($script:DysonArtifactRepositoryOnlyPaths | ForEach-Object {
        $_.ToLowerInvariant()
    })
    if ($lower -in $repositoryOnlyPaths) { return $true }
    $qualificationRuntimePaths = @($script:DysonArtifactRequiredQualificationRuntimeFiles |
        ForEach-Object { $_.ToLowerInvariant() })
    if ($lower -in $qualificationRuntimePaths) { return $false }

    foreach ($prefix in $script:DysonArtifactRepositoryOnlyPathPrefixes) {
        if ($lower.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }

    if ($lower.StartsWith('apps/api/dist/', [System.StringComparison]::Ordinal)) {
        $name = [System.IO.Path]::GetFileName($lower)
        foreach ($suffix in $script:DysonArtifactRepositoryOnlyApiJavaScriptSuffixes) {
            if ($name.EndsWith($suffix, [System.StringComparison]::Ordinal)) { return $true }
        }
    }
    return $false
}

function Get-DysonArtifactRelativePath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$File
    )

    $rootFull = (Get-DysonArtifactFullPath -Path $Root).TrimEnd('\', '/')
    $fileFull = Get-DysonArtifactFullPath -Path $File
    if (-not (Test-DysonArtifactPathWithin -Candidate $fileFull -Parent $rootFull)) {
        throw 'An artifact file escaped its expected root.'
    }
    $relative = $fileFull.Substring($rootFull.Length).TrimStart('\', '/').Replace('\', '/')
    Assert-DysonArtifactRelativePath -Path $relative
    return $relative
}

function Get-DysonArtifactPlainFiles {
    param([Parameter(Mandatory)][string]$Root)

    $rootFull = Assert-DysonArtifactPlainDirectory -Path $Root
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $files = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]'
    $pending.Push($rootFull)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "Release artifacts cannot contain reparse points: $($item.Name)"
            }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
            elseif ($item -is [System.IO.FileInfo]) { $files.Add($item) }
            else { throw "Unsupported artifact filesystem entry: $($item.Name)" }
        }
    }
    return @($files)
}

function Get-DysonArtifactFileSha256 {
    param([Parameter(Mandatory)][string]$Path)

    $stream = [System.IO.File]::Open(
        (Get-DysonArtifactFullPath -Path $Path),
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

function Assert-DysonArtifactAllowedFile {
    param(
        [Parameter(Mandatory)][string]$RelativePath,
        [Parameter(Mandatory)][string]$FullPath
    )

    Assert-DysonArtifactRelativePath -Path $RelativePath
    $normalized = $RelativePath.Replace('\', '/')
    $lower = $normalized.ToLowerInvariant()
    $segments = @($lower.Split('/'))
    $name = $segments[$segments.Count - 1]
    $extension = [System.IO.Path]::GetExtension($name).ToLowerInvariant()

    if ($name -eq '.env' -or $name.StartsWith('.env.') -or
        $name -in @('credentials.json', 'id_rsa', 'id_ed25519') -or
        $extension -in @('.log', '.dsv', '.server', '.bak', '.backup', '.zip')) {
        throw "A forbidden secret, log, save, or archive file entered the artifact: $RelativePath"
    }
    if ($segments[0] -in @('.git', 'data', 'logs', 'userdata', 'server', 'steam', 'steamapps', 'coverage', 'screenshots')) {
        throw "A forbidden mutable top-level directory entered the artifact: $RelativePath"
    }
    $nodeModuleIndexes = for ($index = 0; $index -lt $segments.Count; $index++) {
        if ($segments[$index] -eq 'node_modules') { $index }
    }
    if (@($nodeModuleIndexes).Count -gt 0 -and
        -not ($segments.Count -ge 4 -and $segments[0] -eq 'apps' -and $segments[1] -eq 'api' -and $segments[2] -eq 'node_modules')) {
        throw "node_modules is allowed only for API production dependencies: $RelativePath"
    }
    if ($lower -eq $script:DysonArtifactManifestName -or $lower -eq 'release-manifest.json') {
        throw 'Input payloads cannot provide packaging or deployment manifests.'
    }
    if (Test-DysonArtifactRepositoryOnlyPath -RelativePath $normalized) {
        if ($lower.StartsWith('scripts/windows/qualification/')) {
            throw "The repository-only production qualification harness cannot enter a runtime artifact: $RelativePath"
        }
        throw "A repository-only path entered the runtime artifact: $RelativePath"
    }

    $allowedBridgeSources = @($script:DysonArtifactRequiredBridgeSources | ForEach-Object { $_.ToLowerInvariant() })
    $allowedApiObservabilityRuntimeFiles = @(
        $script:DysonArtifactRequiredApiObservabilityRuntimeFiles | ForEach-Object { $_.ToLowerInvariant() }
    )
    $allowedBridgeScripts = @($script:DysonArtifactRequiredBridgeScripts | ForEach-Object { $_.ToLowerInvariant() })
    $allowedTopLevelWindowsScripts = @($script:DysonArtifactRequiredTopLevelWindowsScripts | ForEach-Object { $_.ToLowerInvariant() })
    $allowedReleaseScripts = @($script:DysonArtifactRequiredReleaseScripts | ForEach-Object { $_.ToLowerInvariant() })
    $allowedDeploymentScripts = @($script:DysonArtifactRequiredDeploymentScripts | ForEach-Object { $_.ToLowerInvariant() })
    $allowedConfigurationFiles = @($script:DysonArtifactRequiredConfigurationFiles | ForEach-Object { $_.ToLowerInvariant() })
    $allowedSessionScripts = @($script:DysonArtifactRequiredSessionScripts | ForEach-Object { $_.ToLowerInvariant() })
    $allowedMigrationScripts = @(($script:DysonArtifactRequiredMigrationScripts +
        $script:DysonArtifactRequiredGsManagerRemovalScripts) | ForEach-Object { $_.ToLowerInvariant() })
    $allowedEvidenceScripts = @($script:DysonArtifactRequiredEvidenceScripts | ForEach-Object { $_.ToLowerInvariant() })
    $allowedHostMutationScripts = @($script:DysonArtifactRequiredHostMutationScripts | ForEach-Object { $_.ToLowerInvariant() })
    $allowedNebulaPluginTransactionFiles = @(
        $script:DysonArtifactRequiredNebulaPluginTransactionFiles |
            ForEach-Object { $_.ToLowerInvariant() }
    )
    $allowedGameBootstrapScripts = @($script:DysonArtifactRequiredGameBootstrapScripts | ForEach-Object { $_.ToLowerInvariant() })
    $allowedCutoverScripts = @($script:DysonArtifactRequiredCutoverScripts | ForEach-Object { $_.ToLowerInvariant() })
    $allowedCutoverBrokerScripts = @($script:DysonArtifactRequiredCutoverBrokerScripts | ForEach-Object { $_.ToLowerInvariant() })
    $allowedLifecycleBrokerScripts = @($script:DysonArtifactRequiredLifecycleBrokerScripts | ForEach-Object { $_.ToLowerInvariant() })
    $allowedDataRecoveryScripts = @($script:DysonArtifactRequiredDataRecoveryScripts | ForEach-Object { $_.ToLowerInvariant() })
    $allowedNetworkFiles = @($script:DysonArtifactRequiredNetworkFiles | ForEach-Object { $_.ToLowerInvariant() })
    $allowedQualificationRuntimeFiles = @(
        $script:DysonArtifactRequiredQualificationRuntimeFiles | ForEach-Object { $_.ToLowerInvariant() }
    )
    $allowedNebulaHostnameWssSources = @(
        $script:DysonArtifactRequiredNebulaHostnameWssSources | ForEach-Object { $_.ToLowerInvariant() }
    )
    $allowedMigrationDocs = @($script:DysonArtifactRequiredMigrationDocs | ForEach-Object { $_.ToLowerInvariant() })
    $allowedGsManagerRemovalDocs = @($script:DysonArtifactRequiredGsManagerRemovalDocs | ForEach-Object { $_.ToLowerInvariant() })
    $allowedRecoveryDocs = @($script:DysonArtifactRequiredRecoveryDocs | ForEach-Object { $_.ToLowerInvariant() })
    $allowedNetworkDocs = @($script:DysonArtifactRequiredNetworkDocs | ForEach-Object { $_.ToLowerInvariant() })
    $allowedQualificationDocs = @(
        $script:DysonArtifactRequiredQualificationDocs | ForEach-Object { $_.ToLowerInvariant() }
    )
    $allowedWindowsScripts = @(
        $allowedTopLevelWindowsScripts + $allowedReleaseScripts + $allowedDeploymentScripts +
        $allowedSessionScripts + $allowedBridgeScripts + $allowedMigrationScripts +
        $allowedEvidenceScripts + $allowedHostMutationScripts + $allowedGameBootstrapScripts +
        $allowedCutoverScripts + $allowedCutoverBrokerScripts + $allowedLifecycleBrokerScripts +
        $allowedDataRecoveryScripts + $allowedNetworkFiles + $allowedQualificationRuntimeFiles +
        $allowedConfigurationFiles
    )
    if ($normalized.StartsWith('apps/api/dist/observability/', [System.StringComparison]::OrdinalIgnoreCase) -and
        $normalized -cnotin $script:DysonArtifactRequiredApiObservabilityRuntimeFiles) {
        throw "The observability runtime contains a path outside its exact allowlist: $RelativePath"
    }
    if ($normalized.StartsWith('integrations/dyson-control-bridge/', [System.StringComparison]::OrdinalIgnoreCase) -and
        $normalized -cnotin $script:DysonArtifactRequiredBridgeSources) {
        throw "The public Bridge source package contains a path outside its exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('integrations/nebula-hostname-wss/') -and
        $lower -notin $allowedNebulaHostnameWssSources) {
        throw "The hostname-WSS source contract contains a path outside its exact allowlist: $RelativePath"
    }
    if ($normalized.StartsWith('scripts/windows/bridge/', [System.StringComparison]::OrdinalIgnoreCase) -and
        $normalized -cnotin $script:DysonArtifactRequiredBridgeScripts) {
        throw "The Bridge delivery tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/release/') -and $lower -notin $allowedReleaseScripts) {
        throw "The release verification tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/deployment/') -and $lower -notin $allowedDeploymentScripts) {
        throw "The deployment tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/configuration/') -and $lower -notin $allowedConfigurationFiles) {
        throw "The protected configuration tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/session/') -and $lower -notin $allowedSessionScripts) {
        throw "The interactive-session tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/migration/') -and $lower -notin $allowedMigrationScripts) {
        throw "The GSManager migration tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/evidence/') -and $lower -notin $allowedEvidenceScripts) {
        throw "The private acceptance evidence tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/nebula-private-build/') -and
        $lower -notin $allowedNebulaPluginTransactionFiles) {
        throw "The Nebula V3 whole-plugin-tree runtime contains a path outside its exact allowlist: $RelativePath"
    }
    if ($segments.Count -eq 3 -and $segments[0] -eq 'scripts' -and $segments[1] -eq 'windows' -and
        $name.Contains('dysonhostmutationlease') -and $lower -notin $allowedHostMutationScripts) {
        throw "The host-mutation lease tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/bootstrap/') -and $lower -notin $allowedGameBootstrapScripts) {
        throw "The stable game bootstrap contains a path outside its exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/cutover/') -and $lower -notin $allowedCutoverScripts) {
        throw "The cutover host tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/cutover-broker/') -and $lower -notin $allowedCutoverBrokerScripts) {
        throw "The cutover broker tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/lifecycle-broker/') -and $lower -notin $allowedLifecycleBrokerScripts) {
        throw "The lifecycle broker tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/data-recovery/') -and $lower -notin $allowedDataRecoveryScripts) {
        throw "The DataRoot recovery tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/network/') -and $lower -notin $allowedNetworkFiles) {
        throw "The Nebula network assessment tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($normalized.StartsWith('scripts/windows/qualification/', [System.StringComparison]::OrdinalIgnoreCase) -and
        $normalized -cnotin $script:DysonArtifactRequiredQualificationRuntimeFiles) {
        throw "The qualification runtime contains a path outside its exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('scripts/windows/') -and $lower -notin $allowedWindowsScripts) {
        throw "The Windows runtime tools contain a path outside their exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('docs/') -and $lower -notin @(
            $allowedMigrationDocs + $allowedGsManagerRemovalDocs + $allowedRecoveryDocs +
                $allowedNetworkDocs + $allowedQualificationDocs
        )) {
        throw "The release documentation contains a path outside its exact allowlist: $RelativePath"
    }
    if ($lower.StartsWith('integrations/dyson-control-bridge/') -and $extension -in @('.dll', '.pdb', '.exe')) {
        throw "A compiled or proprietary assembly entered the public Bridge source package: $RelativePath"
    }

    $allowed = $lower -eq 'license' -or $lower.StartsWith('license.') -or
        $lower -eq 'notice' -or $lower.StartsWith('notice.') -or
        $lower -eq 'apps/api/package.json' -or $lower -eq 'apps/api/package-lock.json' -or
        $lower.StartsWith('apps/api/dist/') -or $lower.StartsWith('apps/api/node_modules/') -or
        $lower.StartsWith('apps/web/dist/') -or $lower.StartsWith('scripts/windows/') -or
        $lower -in $allowedBridgeSources -or
        $lower -in $allowedNebulaHostnameWssSources -or
        $lower -in @($allowedMigrationDocs + $allowedGsManagerRemovalDocs + $allowedRecoveryDocs +
            $allowedNetworkDocs + $allowedQualificationDocs)
    if (-not $allowed) { throw "The artifact contains a path outside the release allowlist: $RelativePath" }

    $textExtensions = @('.js', '.json', '.ps1', '.patch', '.cs', '.csproj', '.cfg', '.example', '.html', '.css', '.txt', '.md', '.xml', '.yml', '.yaml', '.pem', '.key')
    $fileInfo = Get-Item -LiteralPath $FullPath -Force -ErrorAction Stop
    if ($textExtensions -contains $extension -and $fileInfo.Length -le 2MB) {
        $content = [System.IO.File]::ReadAllText($fileInfo.FullName, [System.Text.Encoding]::UTF8)
        if ($content -match '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----' -or
            $content -match '(?m)^\s*DYSON_(?:SESSION_SECRET|ADMIN_PASSWORD_HASH)\s*=') {
            throw "Secret material entered the release artifact: $RelativePath"
        }
    }
}

function Get-DysonArtifactInventory {
    param([Parameter(Mandatory)][string]$Root)

    $rootFull = Assert-DysonArtifactPlainDirectory -Path $Root
    $byPath = @{}
    $totalBytes = [int64]0
    foreach ($file in @(Get-DysonArtifactPlainFiles -Root $rootFull)) {
        $relative = Get-DysonArtifactRelativePath -Root $rootFull -File $file.FullName
        if ([string]::Equals($relative, $script:DysonArtifactManifestName, [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        Assert-DysonArtifactAllowedFile -RelativePath $relative -FullPath $file.FullName
        if ($byPath.ContainsKey($relative)) { throw "Duplicate artifact path: $relative" }
        $totalBytes += [int64]$file.Length
        if ($totalBytes -gt $script:DysonArtifactMaximumBytes) { throw 'The release artifact exceeds its size limit.' }
        $byPath[$relative] = [ordered]@{
            path = $relative
            length = [int64]$file.Length
            sha256 = Get-DysonArtifactFileSha256 -Path $file.FullName
        }
    }
    if ($byPath.Count -eq 0) { throw 'The release artifact is empty.' }
    if ($byPath.Count -gt $script:DysonArtifactMaximumFiles) { throw 'The release artifact contains too many files.' }
    $paths = [string[]]@($byPath.Keys)
    [System.Array]::Sort($paths, [System.StringComparer]::Ordinal)
    $files = @($paths | ForEach-Object { $byPath[$_] })
    $canonical = [string]::Join("`n", @($files | ForEach-Object { '{0}|{1}|{2}' -f $_.path, $_.length, $_.sha256 }))
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($canonical)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $payloadSha256 = ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    return [ordered]@{
        files = $files
        fileCount = [int]$files.Count
        totalBytes = $totalBytes
        payloadSha256 = $payloadSha256
    }
}

function Write-DysonArtifactManifest {
    param(
        [Parameter(Mandatory)][string]$ArtifactRoot,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$DevDependenciesExcluded
    )

    Assert-DysonArtifactVersion -Version $Version
    $inventory = Get-DysonArtifactInventory -Root $ArtifactRoot
    $devDependencies = [string[]]@($DevDependenciesExcluded)
    [System.Array]::Sort($devDependencies, [System.StringComparer]::Ordinal)
    $manifest = [ordered]@{
        protocol = $script:DysonArtifactProtocol
        version = $Version
        entryPoint = $script:DysonArtifactEntryPoint
        nodeMinimumMajor = 24
        dependencyInstall = 'npm-ci-omit-dev-ignore-scripts'
        dependencyPruning = 'non-runtime-package-content-v1'
        devDependenciesExcluded = $devDependencies
        payloadSha256 = $inventory.payloadSha256
        fileCount = $inventory.fileCount
        totalBytes = $inventory.totalBytes
        files = $inventory.files
    }
    $manifestPath = Join-Path $ArtifactRoot $script:DysonArtifactManifestName
    $json = $manifest | ConvertTo-Json -Depth 12 -Compress
    [System.IO.File]::WriteAllText($manifestPath, $json, [System.Text.UTF8Encoding]::new($false))
    return $manifest
}

function Read-DysonArtifactManifest {
    param([Parameter(Mandatory)][string]$ArtifactRoot)

    $manifestPath = Join-Path $ArtifactRoot $script:DysonArtifactManifestName
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'The artifact manifest is missing.' }
    $item = Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 32MB) {
        throw 'The artifact manifest is redirected or too large.'
    }
    try { return [System.IO.File]::ReadAllText($item.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { throw 'The artifact manifest is invalid JSON.' }
}

function Read-DysonArtifactBoundedJsonFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name,
        [ValidateRange(2, 33554432)][int64]$MaximumBytes = 16777216,
        [switch]$PreserveEmptyPropertyNames
    )

    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 2 -or $item.Length -gt $MaximumBytes) {
            throw 'invalid JSON file'
        }
        $json = [System.IO.File]::ReadAllText($item.FullName, [System.Text.Encoding]::UTF8)
        if ($PreserveEmptyPropertyNames) {
            [void][System.Reflection.Assembly]::Load(
                'System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35'
            )
            $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
            $serializer.MaxJsonLength = [int]$MaximumBytes
            $serializer.RecursionLimit = 64
            return $serializer.DeserializeObject($json)
        }
        return $json | ConvertFrom-Json -ErrorAction Stop
    }
    catch { throw "$Name is unavailable, redirected, oversized, or invalid JSON." }
}

function Get-DysonArtifactJsonPropertyValue {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Name
    )

    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) {
        if ($Value.ContainsKey($Name)) { return $Value[$Name] }
        return $null
    }
    $property = $Value.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Test-DysonArtifactPackageVersionBinding {
    param(
        [Parameter(Mandatory)][string]$ArtifactRoot,
        [Parameter(Mandatory)][string]$ExpectedVersion
    )

    Assert-DysonArtifactVersion -Version $ExpectedVersion
    $root = Assert-DysonArtifactPlainDirectory -Path $ArtifactRoot
    $packagePath = Get-DysonArtifactFullPath -Path (Join-Path $root 'apps\api\package.json')
    $lockPath = Get-DysonArtifactFullPath -Path (Join-Path $root 'apps\api\package-lock.json')
    foreach ($candidate in @($packagePath, $lockPath)) {
        if (-not (Test-DysonArtifactPathWithin -Candidate $candidate -Parent $root)) {
            throw 'The API package metadata escaped the artifact root.'
        }
    }
    $package = Read-DysonArtifactBoundedJsonFile -Path $packagePath -Name 'apps/api/package.json'
    $lock = Read-DysonArtifactBoundedJsonFile -Path $lockPath -Name 'apps/api/package-lock.json' `
        -PreserveEmptyPropertyNames
    $packages = Get-DysonArtifactJsonPropertyValue -Value $lock -Name 'packages'
    $rootPackage = if ($null -ne $packages) {
        Get-DysonArtifactJsonPropertyValue -Value $packages -Name ''
    }
    else { $null }
    if ($null -eq $rootPackage) { throw 'The API lockfile is missing its root package binding.' }
    $packageName = [string](Get-DysonArtifactJsonPropertyValue -Value $package -Name 'name')
    $packageVersion = [string](Get-DysonArtifactJsonPropertyValue -Value $package -Name 'version')
    $packagePrivate = Get-DysonArtifactJsonPropertyValue -Value $package -Name 'private'
    $packageType = [string](Get-DysonArtifactJsonPropertyValue -Value $package -Name 'type')
    $packageMain = [string](Get-DysonArtifactJsonPropertyValue -Value $package -Name 'main')
    $lockName = [string](Get-DysonArtifactJsonPropertyValue -Value $lock -Name 'name')
    $lockVersion = [string](Get-DysonArtifactJsonPropertyValue -Value $lock -Name 'version')
    $lockfileVersion = Get-DysonArtifactJsonPropertyValue -Value $lock -Name 'lockfileVersion'
    $rootPackageName = [string](Get-DysonArtifactJsonPropertyValue -Value $rootPackage -Name 'name')
    $rootPackageVersion = [string](Get-DysonArtifactJsonPropertyValue -Value $rootPackage -Name 'version')
    if ([string]::IsNullOrWhiteSpace($packageName) -or $packageName.Length -gt 214 -or
        -not ($packagePrivate -is [bool]) -or -not [bool]$packagePrivate -or
        $packageType -cne 'module' -or $packageMain -cne 'dist/index.js' -or
        $lockName -cne $packageName -or $rootPackageName -cne $packageName -or
        $lockfileVersion -isnot [int] -or [int]$lockfileVersion -ne 3 -or
        $packageVersion -cne $ExpectedVersion -or $lockVersion -cne $ExpectedVersion -or
        $rootPackageVersion -cne $ExpectedVersion) {
        throw 'The API package, lockfile, and requested release version are not exactly bound.'
    }
    Assert-DysonArtifactVersion -Version $packageVersion
    return [ordered]@{
        name = $packageName
        version = $packageVersion
        lockfileVersion = 3
    }
}

function Assert-DysonArtifactExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Name
    )

    $actual = [string[]]@($Value.PSObject.Properties.Name)
    [System.Array]::Sort($actual, [System.StringComparer]::Ordinal)
    $expectedSorted = [string[]]@($Expected)
    [System.Array]::Sort($expectedSorted, [System.StringComparer]::Ordinal)
    if ([string]::Join("`n", $actual) -ne [string]::Join("`n", $expectedSorted)) {
        throw "$Name contains missing or unknown fields."
    }
}

function Assert-DysonArtifactBridgeFixedReferenceContract {
    param(
        [Parameter(Mandatory)][string]$ProjectPath,
        [Parameter(Mandatory)][string]$CommonScriptPath
    )

    foreach ($candidate in @($ProjectPath, $CommonScriptPath)) {
        $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $item.Length -lt 1 -or $item.Length -gt 2MB) {
            throw 'The Bridge fixed reference contract input is unavailable, redirected, or oversized.'
        }
    }

    $settings = New-Object System.Xml.XmlReaderSettings
    $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = $null
    try {
        $reader = [System.Xml.XmlReader]::Create((Get-DysonArtifactFullPath -Path $ProjectPath), $settings)
        $project = New-Object System.Xml.XmlDocument
        $project.XmlResolver = $null
        $project.Load($reader)
    }
    catch { throw 'The Bridge project fixed reference contract is invalid XML.' }
    finally { if ($null -ne $reader) { $reader.Dispose() } }

    $projectRoot = $project.DocumentElement
    if ($null -eq $projectRoot -or $projectRoot.LocalName -cne 'Project' -or
        $projectRoot.HasAttribute('Condition')) {
        throw 'The Bridge project fixed reference contract is not active at the project root.'
    }
    $referenceElements = @($project.SelectNodes("//*[local-name()='Reference']"))
    if ($referenceElements.Count -ne $script:DysonArtifactRequiredBridgeReferenceSpecifications.Count) {
        throw 'The Bridge project fixed reference set is incomplete or contains extra entries.'
    }
    for ($index = 0; $index -lt $referenceElements.Count; $index++) {
        $reference = $referenceElements[$index]
        $itemGroup = $reference.ParentNode
        $expected = $script:DysonArtifactRequiredBridgeReferenceSpecifications[$index]
        $expectedInclude = [System.IO.Path]::GetFileNameWithoutExtension([string]$expected.name)
        $expectedHint = '$(DysonServerRoot)\' + [string]$expected.relativePath
        $children = @($reference.ChildNodes | Where-Object {
            $_.NodeType -eq [System.Xml.XmlNodeType]::Element
        })
        if ($null -eq $itemGroup -or $itemGroup.LocalName -cne 'ItemGroup' -or
            -not [object]::ReferenceEquals($itemGroup.ParentNode, $projectRoot) -or
            $itemGroup.Attributes.Count -ne 0 -or
            $reference.Attributes.Count -ne 1 -or
            $reference.GetAttribute('Include') -cne $expectedInclude -or
            $children.Count -ne 2 -or
            $children[0].LocalName -cne 'HintPath' -or $children[0].Attributes.Count -ne 0 -or
            $children[0].InnerText -cne $expectedHint -or
            $children[1].LocalName -cne 'Private' -or $children[1].Attributes.Count -ne 0 -or
            $children[1].InnerText -cne 'false') {
            throw 'The Bridge project fixed reference set is conditional, reordered, or inconsistent.'
        }
    }

    $tokens = $null
    $parseErrors = $null
    $commonAst = [System.Management.Automation.Language.Parser]::ParseFile(
        (Get-DysonArtifactFullPath -Path $CommonScriptPath),
        [ref]$tokens,
        [ref]$parseErrors
    )
    if (@($parseErrors).Count -ne 0) {
        throw 'The Bridge common script fixed reference contract is not valid PowerShell.'
    }
    $functions = @($commonAst.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -ceq 'Get-DysonBridgeReferenceSpecifications'
    }, $true))
    if ($functions.Count -ne 1) {
        throw 'The Bridge common script must define exactly one fixed reference function.'
    }
    $function = $functions[0]
    $statements = @($function.Body.EndBlock.Statements)
    if ($null -ne $function.Body.ParamBlock -or $null -ne $function.Body.BeginBlock -or
        $null -ne $function.Body.ProcessBlock -or $null -ne $function.Body.DynamicParamBlock -or
        $statements.Count -ne 1 -or
        $statements[0] -isnot [System.Management.Automation.Language.ReturnStatementAst]) {
        throw 'The Bridge fixed reference function is not a single static return expression.'
    }
    $returnPipeline = $statements[0].Pipeline
    if ($returnPipeline -isnot [System.Management.Automation.Language.PipelineAst] -or
        $returnPipeline.PipelineElements.Count -ne 1 -or
        $returnPipeline.PipelineElements[0] -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
        $returnPipeline.PipelineElements[0].Redirections.Count -ne 0 -or
        $returnPipeline.PipelineElements[0].Expression -isnot [System.Management.Automation.Language.ArrayExpressionAst]) {
        throw 'The Bridge fixed reference function is not a single static array.'
    }
    $arrayStatements = @($returnPipeline.PipelineElements[0].Expression.SubExpression.Statements)
    if ($arrayStatements.Count -ne 1 -or
        $arrayStatements[0] -isnot [System.Management.Automation.Language.PipelineAst] -or
        $arrayStatements[0].PipelineElements.Count -ne 1 -or
        $arrayStatements[0].PipelineElements[0] -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
        $arrayStatements[0].PipelineElements[0].Redirections.Count -ne 0 -or
        $arrayStatements[0].PipelineElements[0].Expression -isnot [System.Management.Automation.Language.ArrayLiteralAst]) {
        throw 'The Bridge fixed reference function array is not a static literal.'
    }
    $elements = @($arrayStatements[0].PipelineElements[0].Expression.Elements)
    if ($elements.Count -ne $script:DysonArtifactRequiredBridgeReferenceSpecifications.Count) {
        throw 'The Bridge common script fixed reference set is incomplete or contains extra entries.'
    }
    for ($index = 0; $index -lt $elements.Count; $index++) {
        $element = $elements[$index]
        $expected = $script:DysonArtifactRequiredBridgeReferenceSpecifications[$index]
        if ($element -isnot [System.Management.Automation.Language.ConvertExpressionAst] -or
            $element.Type.TypeName.FullName -cne 'ordered' -or
            $element.Child -isnot [System.Management.Automation.Language.HashtableAst]) {
            throw 'The Bridge common script fixed reference set is not an ordered literal.'
        }
        $pairs = @($element.Child.KeyValuePairs)
        if ($pairs.Count -ne 2) {
            throw 'A Bridge fixed reference specification has missing or unknown fields.'
        }
        $actual = [ordered]@{}
        for ($pairIndex = 0; $pairIndex -lt $pairs.Count; $pairIndex++) {
            $keyAst = $pairs[$pairIndex].Item1
            $valuePipeline = $pairs[$pairIndex].Item2
            if ($keyAst -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
                $valuePipeline -isnot [System.Management.Automation.Language.PipelineAst] -or
                $valuePipeline.PipelineElements.Count -ne 1 -or
                $valuePipeline.PipelineElements[0] -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
                $valuePipeline.PipelineElements[0].Redirections.Count -ne 0 -or
                $valuePipeline.PipelineElements[0].Expression -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) {
                throw 'A Bridge fixed reference specification is not made of constant strings.'
            }
            $key = [string]$keyAst.Value
            if ($pairIndex -eq 0 -and $key -cne 'name') {
                throw 'A Bridge fixed reference specification reordered its fields.'
            }
            if ($pairIndex -eq 1 -and $key -cne 'relativePath') {
                throw 'A Bridge fixed reference specification reordered its fields.'
            }
            $actual[$key] = [string]$valuePipeline.PipelineElements[0].Expression.Value
        }
        if ([string]$actual.name -cne [string]$expected.name -or
            [string]$actual.relativePath -cne [string]$expected.relativePath) {
            throw 'The Bridge common script fixed reference set is inconsistent.'
        }
    }
    return $true
}

function Test-DysonControlReleaseArtifactCore {
    param(
        [Parameter(Mandatory)][string]$ArtifactRoot,
        [string]$ExpectedVersion
    )

    $root = Assert-DysonArtifactPlainDirectory -Path $ArtifactRoot
    $manifest = Read-DysonArtifactManifest -ArtifactRoot $root
    Assert-DysonArtifactExactProperties -Value $manifest -Expected @(
        'protocol', 'version', 'entryPoint', 'nodeMinimumMajor', 'dependencyInstall',
        'dependencyPruning', 'devDependenciesExcluded', 'payloadSha256', 'fileCount', 'totalBytes', 'files'
    ) -Name 'Artifact manifest'
    if (-not [string]::Equals([string]$manifest.protocol, $script:DysonArtifactProtocol, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$manifest.entryPoint, $script:DysonArtifactEntryPoint, [System.StringComparison]::Ordinal) -or
        [int]$manifest.nodeMinimumMajor -ne 24 -or
        -not [string]::Equals([string]$manifest.dependencyInstall, 'npm-ci-omit-dev-ignore-scripts', [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$manifest.dependencyPruning, 'non-runtime-package-content-v1', [System.StringComparison]::Ordinal)) {
        throw 'The artifact manifest contract is unsupported.'
    }
    Assert-DysonArtifactVersion -Version ([string]$manifest.version)
    if ($ExpectedVersion -and -not [string]::Equals([string]$manifest.version, $ExpectedVersion, [System.StringComparison]::Ordinal)) {
        throw 'The artifact version does not match the expected version.'
    }
    [void](Test-DysonArtifactPackageVersionBinding -ArtifactRoot $root -ExpectedVersion ([string]$manifest.version))
    if ([string]$manifest.payloadSha256 -notmatch '^[0-9a-f]{64}$' -or
        [int64]$manifest.fileCount -lt 1 -or [int64]$manifest.fileCount -gt $script:DysonArtifactMaximumFiles -or
        [int64]$manifest.totalBytes -lt 1 -or [int64]$manifest.totalBytes -gt $script:DysonArtifactMaximumBytes) {
        throw 'The artifact manifest summary is invalid.'
    }

    $entryPoint = Get-DysonArtifactFullPath -Path (Join-Path $root $script:DysonArtifactEntryPoint)
    if (-not (Test-DysonArtifactPathWithin -Candidate $entryPoint -Parent $root) -or
        -not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
        throw 'The packaged API entry point is missing.'
    }
    foreach ($requiredApiPath in $script:DysonArtifactRequiredApiLifecycleFiles) {
        $requiredApiFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredApiPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredApiFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredApiFile -PathType Leaf)) {
            throw 'The game-runtime receipt API delivery package is incomplete.'
        }
    }
    foreach ($requiredApiPath in $script:DysonArtifactRequiredApiHostnameWssRuntimeFiles) {
        $requiredApiFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredApiPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredApiFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredApiFile -PathType Leaf)) {
            throw 'The hostname-WSS client qualification API delivery package is incomplete.'
        }
    }
    foreach ($requiredApiPath in $script:DysonArtifactRequiredApiObservabilityRuntimeFiles) {
        $requiredApiFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredApiPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredApiFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredApiFile -PathType Leaf)) {
            throw 'The observability runtime API delivery package is incomplete.'
        }
    }
    foreach ($requiredApiPath in $script:DysonArtifactRequiredApiUpdateCoreRuntimeFiles) {
        $requiredApiFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredApiPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredApiFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredApiFile -PathType Leaf)) {
            throw 'The Windows update runtime API delivery package is incomplete.'
        }
    }
    foreach ($requiredApiPath in $script:DysonArtifactRequiredApiNebulaPluginTransactionFiles) {
        $requiredApiFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredApiPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredApiFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredApiFile -PathType Leaf)) {
            throw 'The Nebula V3 whole-plugin-tree API delivery package is incomplete.'
        }
    }
    foreach ($requiredCorePath in @(
        $script:DysonArtifactRequiredTopLevelWindowsScripts +
        $script:DysonArtifactRequiredReleaseScripts +
        $script:DysonArtifactRequiredDeploymentScripts +
        $script:DysonArtifactRequiredConfigurationFiles +
        $script:DysonArtifactRequiredSessionScripts
    )) {
        $requiredCoreFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredCorePath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredCoreFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredCoreFile -PathType Leaf)) {
            throw 'The core Windows runtime delivery package is incomplete.'
        }
    }
    foreach ($requiredBridgePath in @($script:DysonArtifactRequiredBridgeSources + $script:DysonArtifactRequiredBridgeScripts)) {
        $requiredBridgeFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredBridgePath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredBridgeFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredBridgeFile -PathType Leaf)) {
            throw 'The public Bridge source/build delivery package is incomplete.'
        }
    }
    [void](Assert-DysonArtifactBridgeFixedReferenceContract `
        -ProjectPath (Join-Path $root 'integrations\dyson-control-bridge\DysonControlBridge.csproj') `
        -CommonScriptPath (Join-Path $root 'scripts\windows\bridge\DysonBridge.Common.ps1'))
    foreach ($requiredMigrationPath in @($script:DysonArtifactRequiredMigrationScripts + $script:DysonArtifactRequiredMigrationDocs)) {
        $requiredMigrationFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredMigrationPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredMigrationFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredMigrationFile -PathType Leaf)) {
            throw 'The GSManager parallel-migration delivery package is incomplete.'
        }
    }
    foreach ($requiredRemovalPath in @($script:DysonArtifactRequiredGsManagerRemovalScripts +
        $script:DysonArtifactRequiredGsManagerRemovalDocs)) {
        $requiredRemovalFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredRemovalPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredRemovalFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredRemovalFile -PathType Leaf)) {
            throw 'The GSManager recoverable-removal delivery package is incomplete.'
        }
    }
    foreach ($requiredEvidencePath in $script:DysonArtifactRequiredEvidenceScripts) {
        $requiredEvidenceFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredEvidencePath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredEvidenceFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredEvidenceFile -PathType Leaf)) {
            throw 'The private acceptance evidence delivery package is incomplete.'
        }
    }
    foreach ($requiredHostMutationPath in $script:DysonArtifactRequiredHostMutationLeaseScripts) {
        $requiredHostMutationFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredHostMutationPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredHostMutationFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredHostMutationFile -PathType Leaf)) {
            throw 'The host-mutation lease delivery package is incomplete.'
        }
    }
    foreach ($requiredNebulaPath in $script:DysonArtifactRequiredNebulaPluginTransactionFiles) {
        $requiredNebulaFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredNebulaPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredNebulaFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredNebulaFile -PathType Leaf)) {
            throw 'The Nebula V3 whole-plugin-tree runtime delivery package is incomplete.'
        }
    }
    foreach ($requiredBootstrapPath in $script:DysonArtifactRequiredGameBootstrapScripts) {
        $requiredBootstrapFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredBootstrapPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredBootstrapFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredBootstrapFile -PathType Leaf)) {
            throw 'The stable game bootstrap delivery package is incomplete.'
        }
    }
    foreach ($requiredCutoverPath in $script:DysonArtifactRequiredCutoverScripts) {
        $requiredCutoverFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredCutoverPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredCutoverFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredCutoverFile -PathType Leaf)) {
            throw 'The cutover host delivery package is incomplete.'
        }
    }
    foreach ($requiredBrokerPath in $script:DysonArtifactRequiredCutoverBrokerScripts) {
        $requiredBrokerFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredBrokerPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredBrokerFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredBrokerFile -PathType Leaf)) {
            throw 'The cutover broker delivery package is incomplete.'
        }
    }
    foreach ($requiredBrokerPath in $script:DysonArtifactRequiredLifecycleBrokerScripts) {
        $requiredBrokerFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredBrokerPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredBrokerFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredBrokerFile -PathType Leaf)) {
            throw 'The lifecycle broker delivery package is incomplete.'
        }
    }
    foreach ($requiredRecoveryPath in @($script:DysonArtifactRequiredDataRecoveryScripts + $script:DysonArtifactRequiredRecoveryDocs)) {
        $requiredRecoveryFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredRecoveryPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredRecoveryFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredRecoveryFile -PathType Leaf)) {
            throw 'The DataRoot recovery delivery package is incomplete.'
        }
    }
    foreach ($requiredNetworkPath in @($script:DysonArtifactRequiredNetworkFiles + $script:DysonArtifactRequiredNetworkDocs)) {
        $requiredNetworkFile = Get-DysonArtifactFullPath -Path (Join-Path $root $requiredNetworkPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredNetworkFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredNetworkFile -PathType Leaf)) {
            throw 'The Nebula network assessment delivery package is incomplete.'
        }
    }
    foreach ($requiredQualificationPath in @(
        $script:DysonArtifactRequiredQualificationRuntimeFiles +
        $script:DysonArtifactRequiredNebulaHostnameWssSources +
        $script:DysonArtifactRequiredQualificationDocs
    )) {
        $requiredQualificationFile = Get-DysonArtifactFullPath -Path `
            (Join-Path $root $requiredQualificationPath.Replace('/', '\'))
        if (-not (Test-DysonArtifactPathWithin -Candidate $requiredQualificationFile -Parent $root) -or
            -not (Test-Path -LiteralPath $requiredQualificationFile -PathType Leaf)) {
            throw 'The qualification runtime or hostname-WSS source-contract delivery package is incomplete.'
        }
    }
    $inventory = Get-DysonArtifactInventory -Root $root
    if ($inventory.payloadSha256 -ne [string]$manifest.payloadSha256 -or
        $inventory.fileCount -ne [int]$manifest.fileCount -or
        $inventory.totalBytes -ne [int64]$manifest.totalBytes) {
        throw 'The artifact inventory no longer matches its manifest.'
    }
    $manifestFiles = @($manifest.files)
    if ($manifestFiles.Count -ne $inventory.fileCount) { throw 'The artifact manifest file count is inconsistent.' }
    for ($index = 0; $index -lt $manifestFiles.Count; $index++) {
        $expectedFile = $manifestFiles[$index]
        Assert-DysonArtifactExactProperties -Value $expectedFile -Expected @('path', 'length', 'sha256') -Name 'Artifact file entry'
        $actualFile = $inventory.files[$index]
        if ([string]$expectedFile.path -cne [string]$actualFile.path -or
            [int64]$expectedFile.length -ne $actualFile.length -or
            [string]$expectedFile.sha256 -cne [string]$actualFile.sha256) {
            throw 'The artifact file inventory is inconsistent.'
        }
    }
    $excludedDependencies = [string[]]@($manifest.devDependenciesExcluded)
    if ($excludedDependencies.Count -gt 256) { throw 'The excluded development dependency list is too large.' }
    $excludedSet = @{}
    for ($dependencyIndex = 0; $dependencyIndex -lt $excludedDependencies.Count; $dependencyIndex++) {
        $dependency = $excludedDependencies[$dependencyIndex]
        if ([string]$dependency -notmatch '^(?:@[a-z0-9_.-]+/)?[a-z0-9_.-]+$') {
            throw 'The excluded development dependency list is invalid.'
        }
        if ($excludedSet.ContainsKey($dependency) -or
            ($dependencyIndex -gt 0 -and [System.StringComparer]::Ordinal.Compare($excludedDependencies[$dependencyIndex - 1], $dependency) -ge 0)) {
            throw 'The excluded development dependency list is duplicated or unsorted.'
        }
        $excludedSet[$dependency] = $true
        $dependencyPath = Join-Path (Join-Path $root 'apps\api\node_modules') ([string]$dependency).Replace('/', '\')
        if (Test-Path -LiteralPath $dependencyPath) { throw "A development dependency entered the runtime artifact: $dependency" }
    }
    return [ordered]@{
        protocol = $script:DysonArtifactProtocol
        ready = $true
        version = [string]$manifest.version
        entryPoint = $script:DysonArtifactEntryPoint
        nodeMinimumMajor = [int]$manifest.nodeMinimumMajor
        payloadSha256 = $inventory.payloadSha256
        fileCount = $inventory.fileCount
        totalBytes = $inventory.totalBytes
        productionOnlyNodeModules = $true
        deploymentSourceCompatible = $true
        packageLockManifestVersionBound = $true
        coreWindowsRuntimeAllowlistVerified = $true
        publicBridgeSourcePackaged = $true
        bridgeSimulationTelemetryPackaged = $true
        bridgeFixedReferenceContractPackaged = $true
        privateBridgeBinariesPackaged = $false
        gameRuntimeReceiptApiPackaged = $true
        hostnameWssClientQualificationApiPackaged = $true
        observabilityRuntimeApiPackaged = $true
        windowsUpdateRuntimeApiPackaged = $true
        nebulaPluginTransactionApiPackaged = $true
        gsManagerParallelMigrationPackaged = $true
        migrationDocumentationPackaged = $true
        gsManagerRecoverableRemovalPackaged = $true
        gsManagerRemovalDocumentationPackaged = $true
        privateAcceptanceEvidenceToolingPackaged = $true
        hostMutationLeaseToolingPackaged = $true
        nebulaPluginTransactionRuntimePackaged = $true
        nebulaPluginTransactionRunnerMappingsRequired = `
            $script:DysonArtifactRequiredNebulaPluginTransactionRunnerFiles.Count
        privateNebulaCandidateBinariesPackaged = $false
        stableGameBootstrapPackaged = $true
        cutoverHostToolingPackaged = $true
        cutoverBrokerToolingPackaged = $true
        lifecycleBrokerToolingPackaged = $true
        dataRootRecoveryToolingPackaged = $true
        dataRootRecoveryDocumentationPackaged = $true
        nebulaNetworkAssessmentPackaged = $true
        hostnameWssQualificationRuntimePackaged = $true
        qualificationOrchestrationV2Packaged = $true
        qualificationFrameworkPackaged = $true
        strictQualificationV2Packaged = $true
        productionQualificationDocumentationPackaged = $true
        networkConnectivityDocumentationPackaged = $true
    }
}
