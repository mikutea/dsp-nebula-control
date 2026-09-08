[CmdletBinding()]
param()

$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'NebulaPluginTransaction.Common.ps1')

$script:passed=0; $script:failed=0
$script:results=New-Object Collections.Generic.List[object]
function Add-Result([string]$Name,[bool]$Passed,[string]$Detail){
    if($Passed){$script:passed++}else{$script:failed++}
    $script:results.Add([pscustomobject][ordered]@{name=$Name;passed=$Passed;detail=$Detail})
}
function Test-Case([string]$Name,[scriptblock]$Body){
    try{& $Body;Add-Result $Name $true 'ok'}catch{Add-Result $Name $false $_.Exception.Message}
}
function Assert-True([bool]$Condition,[string]$Message='assertion-failed'){if(-not $Condition){throw $Message}}
function Remove-NebulaTransactionSelfTestFixture([string]$Path){
    $full=[IO.Path]::GetFullPath($Path).TrimEnd('\')
    $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if(-not $full.StartsWith($temp+'\',[StringComparison]::OrdinalIgnoreCase)-or
        -not [IO.Path]::GetFileName($full).StartsWith('dyson-nebula-transaction-selftest-',[StringComparison]::Ordinal)){
        throw 'selftest-cleanup-scope-invalid'
    }
    $lastFailure=$null
    for($attempt=1;$attempt-le 3-and[IO.Directory]::Exists($full);$attempt++){
        try{
            [IO.Directory]::Delete(('\\?\'+$full),$true)
            $lastFailure=$null
        }
        catch{
            $lastFailure=$_.Exception
            if([IO.Directory]::Exists($full)-and$attempt-lt 3){Start-Sleep -Milliseconds 50}
        }
    }
    if([IO.Directory]::Exists($full)){
        if($null-ne $lastFailure){throw $lastFailure}
        throw 'selftest-cleanup-incomplete'
    }
}
function Write-Json([string]$Path,$Value){
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))|Out-Null
    [IO.File]::WriteAllText($Path,(ConvertTo-NebulaPrivateCanonicalJson $Value)+"`n",[Text.UTF8Encoding]::new($false))
}
function Write-Bytes([string]$Path,[byte[]]$Bytes){
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))|Out-Null
    [IO.File]::WriteAllBytes($Path,$Bytes)
}
function Copy-TreeWithAcl([string]$Source,[string]$Destination){
    [IO.Directory]::CreateDirectory($Destination)|Out-Null
    [IO.Directory]::SetAccessControl($Destination,[IO.Directory]::GetAccessControl($Source))
    foreach($directory in @(Get-ChildItem -LiteralPath $Source -Recurse -Force -Directory|Sort-Object FullName)){
        $relative=$directory.FullName.Substring($Source.Length).TrimStart('\')
        $target=Join-Path $Destination $relative;[IO.Directory]::CreateDirectory($target)|Out-Null
        [IO.Directory]::SetAccessControl($target,[IO.Directory]::GetAccessControl($directory.FullName))
    }
    foreach($file in @(Get-ChildItem -LiteralPath $Source -Recurse -Force -File)){
        $relative=$file.FullName.Substring($Source.Length).TrimStart('\');$target=Join-Path $Destination $relative
        [IO.File]::Copy($file.FullName,$target,$false)
        [IO.File]::SetAccessControl($target,[IO.File]::GetAccessControl($file.FullName))
    }
}
function Invoke-Child([string]$Script,[string[]]$Arguments){
    $exe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $all=@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$Script)+$Arguments
    $savedPreference=$ErrorActionPreference;$ErrorActionPreference='Continue'
    try{$output=@(& $exe @all 2>&1 | ForEach-Object { [string]$_ })}finally{$ErrorActionPreference=$savedPreference}
    return [pscustomobject]@{exitCode=[int]$LASTEXITCODE;output=$output;text=($output -join "`n")}
}
function Assert-Success($Result){if($Result.exitCode -ne 0){throw ('unexpected-failure:'+($Result.text -replace '[\r\n]+',' '))}}
function Assert-Failure($Result,[string]$Code){
    if($Result.exitCode -eq 0 -or $Result.text -notmatch [regex]::Escape($Code)){throw ('wrong-failure:'+($Result.text -replace '[\r\n]+',' '))}
}
function New-ShadowEvidence([string]$Path,[string]$GameRoot,[string]$Role,[bool]$Stopped=$true,
    [string]$GameVersion,[string]$GameLibVersion,[string]$Mvid){
    if([string]::IsNullOrWhiteSpace($GameVersion)){$GameVersion=[string]$script:NebulaPrivateContract.game.gameVersion}
    if([string]::IsNullOrWhiteSpace($GameLibVersion)){$GameLibVersion=[string]$script:NebulaPrivateContract.game.gameLibVersion}
    if([string]::IsNullOrWhiteSpace($Mvid)){$Mvid=[string]$script:NebulaPrivateContract.game.assemblyCSharpMvid}
    $now=[datetimeoffset]::UtcNow
    [int[]]$processIds=@();if(-not $Stopped){$processIds=@(4242)}
    $core=[ordered]@{
        protocol=$script:NebulaPluginShadowEvidenceProtocol;schemaVersion=1;targetRole=$Role
        gamePathIdentity=Get-NebulaPluginPathIdentity $GameRoot;observedUtc=$now.ToString('o')
        validUntilUtc=$now.AddMinutes(10).ToString('o');gameVersion=$GameVersion;gameLibVersion=$GameLibVersion
        assemblyCSharpMvid=$Mvid;processEnumerationComplete=$true;processesStopped=$Stopped
        matchingProcessIds=$processIds
    }
    $value=[ordered]@{};foreach($key in $core.Keys){$value[$key]=$core[$key]}
    $value.evidenceDigest=Get-NebulaPrivateObjectSha256 $core
    Write-Json $Path $value
}
function New-Candidate([string]$JobRoot){
    $candidateRoot=Join-Path $JobRoot 'candidate'
    foreach($relative in $script:NebulaPrivateExpectedFiles){
        Write-Bytes (Join-Path $candidateRoot $relative.Replace('/','\')) `
            ([Text.UTF8Encoding]::new($false).GetBytes(('qualified-candidate:'+ $relative)))
    }
    $records=@(Get-NebulaPrivatePlainFiles $candidateRoot)
    $tree=Get-NebulaPrivateTreeDigest $records
    $core=[ordered]@{
        protocol=$script:NebulaPrivateCandidateProtocol;schemaVersion=1
        source=[ordered]@{upstreamCommit=[string]$script:NebulaPrivateContract.upstream.commit
            websocketSubmoduleCommit=[string]$script:NebulaPrivateContract.upstream.websocketSubmoduleCommit
            sourceContractSha256=[string]$script:NebulaPrivateContract.sourcePatch.contractSha256
            patchSha256=[string]$script:NebulaPrivateContract.sourcePatch.patchSha256}
        game=[ordered]@{gameVersion=[string]$script:NebulaPrivateContract.game.gameVersion
            gameLibVersion=[string]$script:NebulaPrivateContract.game.gameLibVersion
            assemblyCSharpMvid=[string]$script:NebulaPrivateContract.game.assemblyCSharpMvid}
        baseline=[ordered]@{mainArchiveSha256=[string]$script:NebulaPrivateContract.candidate.officialMainArchiveSha256
            apiArchiveSha256=[string]$script:NebulaPrivateContract.candidate.officialApiArchiveSha256
            sourceManifestSha256=[string]$script:NebulaPrivateContract.candidate.officialTreeManifestSha256
            treeSha256=[string]$script:NebulaPrivateContract.candidate.officialTreeDigestSha256
            treeDigestAlgorithm=[string]$script:NebulaPrivateContract.candidate.treeDigestAlgorithm}
        candidate=[ordered]@{treeSha256=$tree;totalFiles=44;stockFilesExact=40;customFiles=4}
        deterministicBuildEvidence=[ordered]@{buildPlanDigest=('d'*64)
            inputFingerprintSha256=Get-NebulaPrivateExpectedBuildInputFingerprint
            metadataASha256=('b'*64);metadataBSha256=('c'*64);matched=$true}
        files=@($records|ForEach-Object{[pscustomobject][ordered]@{path=[string]$_.path;size=[int64]$_.size
            sha256=[string]$_.sha256;origin=if([string]$_.path -cin $script:NebulaPrivateCustomFiles){'private-build'}else{'official-stock'}}})
    }
    $manifest=[ordered]@{};foreach($key in $core.Keys){$manifest[$key]=$core[$key]}
    $manifest.manifestDigest=Get-NebulaPrivateObjectSha256 $core
    $path=Join-Path $JobRoot 'evidence\candidate-manifest.json';Write-Json $path $manifest
    return [pscustomobject]@{root=$candidateRoot;manifestPath=$path;manifest=$manifest;tree=$tree}
}
function Protect-ScenarioBepInEx([string]$Path){
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor `
        [Security.AccessControl.AccessControlSections]::Owner -bor `
        [Security.AccessControl.AccessControlSections]::Group
    $acl=[IO.Directory]::GetAccessControl($Path,$sections)
    # Build a deterministic protected parent boundary instead of copying the
    # host/temporary-root ACL.  In particular, no unrelated inherited
    # principal may retain DeleteChild over the operation-owned plugin trees.
    $acl.SetAccessRuleProtection($true,$false)
    foreach($existing in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){
        [void]$acl.RemoveAccessRuleSpecific($existing)
    }
    $inheritance=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $trusted=@(
        [Security.Principal.WindowsIdentity]::GetCurrent().User,
        (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),
        (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544'))
    )|Sort-Object Value -Unique
    foreach($sid in $trusted){
        $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,
            [Security.AccessControl.FileSystemRights]::FullControl,$inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)
        [void]$acl.AddAccessRule($rule)
    }
    [IO.Directory]::SetAccessControl($Path,$acl)
    [void](Assert-NebulaPluginParentBoundarySafe (Get-NebulaPluginParentBoundary $Path))
}
function Stop-ScenarioLease($S,[string]$State='released'){
    if($null-ne $S.leaseScope -and $null-ne $S.leaseScope.lease -and $S.leaseScope.lease.Active){
        [void](Exit-DysonHostMutationLease -Lease $S.leaseScope.lease -State $State)
    }
}
function Use-ScenarioLease($S,[ValidateSet('mutation','recovery')][string]$Kind='mutation'){
    if($null-ne $S.leaseScope.lease -and $S.leaseScope.lease.Active -and
        [string]$S.leaseScope.lease.Record.leaseKind -ceq $Kind){return $S.leaseScope.lease}
    if($null-ne $S.leaseScope.lease -and $S.leaseScope.lease.Active){
        if([string]$S.leaseScope.lease.Record.leaseKind -ceq 'mutation' -and $Kind -ceq 'recovery'){
            Stop-ScenarioLease $S 'abandoned'
        }else{Stop-ScenarioLease $S 'released'}
    }
    if($Kind-ceq'mutation'){
        $lease=Enter-DysonHostMutationLease -DataRoot $S.leaseScope.root -Owner 'nebula-selftest' `
            -Operation 'nebula-plugin-transaction' -RequestId $S.leaseScope.requestId -OwnerPid $PID `
            -TimeoutMilliseconds 0
    }else{
        $candidate=Get-DysonHostMutationLeaseRecoveryCandidate -DataRoot $S.leaseScope.root -TimeoutMilliseconds 0
        $lease=Enter-DysonHostMutationLease -DataRoot $S.leaseScope.root -Owner 'nebula-selftest' `
            -Operation ([string]$candidate.priorOperation) -RequestId ([string]$candidate.priorRequestId) `
            -OwnerPid $PID -TimeoutMilliseconds 0 -RecoveryPriorInstanceId ([string]$candidate.priorInstanceId) `
            -RecoveryPriorRecordDigest ([string]$candidate.priorRecordDigest)
    }
    $S.leaseScope.lease=$lease
    return $lease
}
function Get-ScenarioLeaseArgs($S,[ValidateSet('mutation','recovery')][string]$Kind='mutation'){
    $lease=Use-ScenarioLease $S $Kind
    return @('-HostMutationDataRoot',$S.leaseScope.root,'-HostMutationLeaseInstanceId',[string]$lease.InstanceId,
        '-HostMutationLeaseToken',[string]$lease.Token)
}
$script:scenarioIndex=0
$script:scenarios=New-Object Collections.Generic.List[object]
function New-Scenario([string]$Name,[string]$Role='Server'){
    $script:scenarioIndex++
    $leaf=('s{0:d2}' -f $script:scenarioIndex)
    $request=[guid]::NewGuid().ToString('D').ToLowerInvariant()
    $base=Join-Path $fixtureRoot ('j\'+$leaf);[IO.Directory]::CreateDirectory($base)|Out-Null
    $job=Join-Path $base $request;[IO.Directory]::CreateDirectory($job)|Out-Null
    $candidate=New-Candidate $job
    $game=Join-Path $fixtureRoot ('g\'+$leaf+'\Dyson Sphere Program')
    $plugins=Join-Path $game 'BepInEx\plugins';[IO.Directory]::CreateDirectory($plugins)|Out-Null
    Protect-ScenarioBepInEx (Join-Path $game 'BepInEx')
    Write-Bytes (Join-Path $plugins 'legacy\old-plugin.dll') ([byte[]](1,3,3,7))
    Write-Bytes (Join-Path $plugins 'legacy\settings.cfg') ([Text.UTF8Encoding]::new($false).GetBytes('old=true'))
    $evidence=Join-Path $job 'evidence\shadow-evidence.json';New-ShadowEvidence $evidence $game $Role
    $binding=Get-NebulaPluginTargetBinding $game $Role
    $preimage=Get-NebulaPluginTreeInventory $plugins $binding.digest
    $preimageIdentity=Get-NebulaPluginDirectoryIdentity $plugins
    $start=[datetimeoffset]::UtcNow.AddMinutes(-2);$end=$start.AddHours(2)
    $leaseRoot=Join-Path $fixtureRoot ('l\'+$leaf);[IO.Directory]::CreateDirectory($leaseRoot)|Out-Null
    $scope=[pscustomobject]@{root=$leaseRoot;requestId=$request;lease=$null}
    $scenario=[pscustomobject]@{name=$Name;role=$Role;request=$request;jobBase=$base;job=$job;game=$game
        plugins=$plugins;evidence=$evidence;candidate=$candidate;preimage=$preimage;preimageIdentity=$preimageIdentity;start=$start;end=$end
        planPath=(Join-Path $job 'evidence\plugin-cutover-plan.json');leaseScope=$scope}
    $script:scenarios.Add($scenario)
    return $scenario
}
function New-ScenarioOnGame([string]$Name,[string]$Game,[string]$Role,$LeaseScope){
    $script:scenarioIndex++
    $leaf=('s{0:d2}' -f $script:scenarioIndex)
    $request=[guid]::NewGuid().ToString('D').ToLowerInvariant()
    $base=Join-Path $fixtureRoot ('j\'+$leaf);[IO.Directory]::CreateDirectory($base)|Out-Null
    $job=Join-Path $base $request;[IO.Directory]::CreateDirectory($job)|Out-Null
    $candidate=New-Candidate $job
    $plugins=Join-Path $Game 'BepInEx\plugins'
    $evidence=Join-Path $job 'evidence\shadow-evidence.json';New-ShadowEvidence $evidence $Game $Role
    $binding=Get-NebulaPluginTargetBinding $Game $Role
    $preimage=Get-NebulaPluginTreeInventory $plugins $binding.digest
    $preimageIdentity=Get-NebulaPluginDirectoryIdentity $plugins
    $start=[datetimeoffset]::UtcNow.AddMinutes(-2);$end=$start.AddHours(2)
    $scenario=[pscustomobject]@{name=$Name;role=$Role;request=$request;jobBase=$base;job=$job;game=$Game
        plugins=$plugins;evidence=$evidence;candidate=$candidate;preimage=$preimage;preimageIdentity=$preimageIdentity;start=$start;end=$end
        planPath=(Join-Path $job 'evidence\plugin-cutover-plan.json');leaseScope=$LeaseScope}
    $script:scenarios.Add($scenario)
    return $scenario
}
function Get-PlanArgs($S){return @('-RequestId',$S.request,'-JobBase',$S.jobBase,'-GameRoot',$S.game,
    '-TargetRole',$S.role,'-CurrentPluginsTreeSha256',$S.preimage.contentTreeSha256,
    '-CandidateManifestPath',$S.candidate.manifestPath,'-MaintenanceWindowStartUtc',$S.start.ToString('o'),
    '-MaintenanceWindowEndUtc',$S.end.ToString('o'),'-Backend','Shadow','-ShadowEvidencePath',$S.evidence)}
function New-Plan($S){$r=Invoke-Child (Join-Path $PSScriptRoot 'New-NebulaPluginCutoverPlan.ps1') (Get-PlanArgs $S);Assert-Success $r;return $r}
function Get-ApplyArgs($S,[bool]$IncludeConfirmation=$false,[string]$LeaseKind='mutation'){
    $args=@('-RequestId',$S.request,'-JobBase',$S.jobBase,'-GameRoot',$S.game,'-TargetRole',$S.role,
        '-PlanPath',$S.planPath,'-CandidateManifestPath',$S.candidate.manifestPath,'-Backend','Shadow',
        '-ShadowEvidencePath',$S.evidence)
    if($IncludeConfirmation){$plan=Read-NebulaPluginJson $S.planPath;$args+=@('-Apply','-ConfirmationPhrase',[string]$plan.confirmation.exactPhrase)
        $args+=Get-ScenarioLeaseArgs $S $LeaseKind}
    return $args
}
function Rewrite-PlanDigest($Plan,[string]$RequestId,[string]$Path){
    $core=[ordered]@{}
    foreach($property in $Plan.PSObject.Properties){
        if([string]$property.Name-cne'planDigest'-and[string]$property.Name-cne'confirmation'){
            $core[[string]$property.Name]=$property.Value
        }
    }
    $Plan.planDigest=Get-NebulaPrivateObjectSha256 $core
    $Plan.confirmation.exactPhrase='CONFIRM NEBULA PLUGIN CUTOVER '+$RequestId+' '+[string]$Plan.planDigest
    $Plan.confirmation.granted=$false
    Write-Json $Path $Plan
}

$fixtureRoot=$null
try{
    $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $fixtureRoot=Join-Path $temp ('dyson-nebula-transaction-selftest-'+[guid]::NewGuid().ToString('N').Substring(0,8))
    [IO.Directory]::CreateDirectory($fixtureRoot)|Out-Null

    Test-Case 'default-invoke-is-read-only-dry-run' {
        $s=New-Scenario 'dry-run';[void](New-Plan $s)
        $before=Get-NebulaPluginTreeInventory $s.plugins (Get-NebulaPluginTargetBinding $s.game $s.role).digest
        $r=Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') (Get-ApplyArgs $s)
        Assert-Success $r
        $after=Get-NebulaPluginTreeInventory $s.plugins (Get-NebulaPluginTargetBinding $s.game $s.role).digest
        Assert-True ([string]$before.inventoryDigest -ceq [string]$after.inventoryDigest)
        Assert-True (-not(Test-Path (Join-Path $s.game 'BepInEx\.dyson-private-cutover')))
        $text=Get-Content $s.planPath -Raw
        Assert-True ($text.IndexOf((Join-Path $s.job 'candidate'),[StringComparison]::OrdinalIgnoreCase)-lt 0)
        Assert-True ($text.IndexOf($s.game,[StringComparison]::OrdinalIgnoreCase)-lt 0)
    }
    Test-Case 'apply-requires-exact-confirmation' {
        $s=New-Scenario 'confirmation';[void](New-Plan $s)
        $args=Get-ApplyArgs $s;$args+=@('-Apply')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') $args) `
            'NEBULA_PLUGIN_CONFIRMATION_REQUIRED'
        Assert-True (-not(Test-Path (Join-Path $s.game 'BepInEx\.dyson-private-cutover')))
    }
    Test-Case 'preimage-mismatch-and-extra-file-fail-before-mutation' {
        $s=New-Scenario 'preimage-mismatch';[void](New-Plan $s)
        Write-Bytes (Join-Path $s.plugins 'unexpected.bin') ([byte[]](9,9))
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') (Get-ApplyArgs $s)) `
            'NEBULA_PLUGIN_PREIMAGE_CHANGED'
    }
    Test-Case 'candidate-byte-mismatch-and-extra-file-are-rejected' {
        $s=New-Scenario 'candidate-mismatch';[void](New-Plan $s)
        [IO.File]::AppendAllText((Join-Path $s.candidate.root 'nebula-NebulaMultiplayerMod\README.md'),'tamper')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') (Get-ApplyArgs $s)) `
            'NEBULA_PRIVATE_CANDIDATE_MANIFEST_INVALID'
        $s2=New-Scenario 'candidate-extra';[void](New-Plan $s2)
        Write-Bytes (Join-Path $s2.candidate.root 'extra.bin') ([byte[]](1))
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') (Get-ApplyArgs $s2)) `
            'NEBULA_PRIVATE_CANDIDATE_FILE_SET_INVALID'
    }
    Test-Case 'candidate-reparse-point-is-rejected' {
        $s=New-Scenario 'candidate-reparse';[void](New-Plan $s)
        $target=Join-Path $fixtureRoot 'junction-target';[IO.Directory]::CreateDirectory($target)|Out-Null
        New-Item -ItemType Junction -Path (Join-Path $s.candidate.root 'junction') -Target $target|Out-Null
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') (Get-ApplyArgs $s)) `
            'NEBULA_PRIVATE_REPARSE_POINT_REJECTED'
    }
    Test-Case 'process-stop-proof-and-version-gates-fail-closed' {
        $s=New-Scenario 'process-running';New-ShadowEvidence $s.evidence $s.game $s.role $false
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'New-NebulaPluginCutoverPlan.ps1') (Get-PlanArgs $s)) `
            'NEBULA_PLUGIN_PROCESS_STOP_PROOF_FAILED'
        $s2=New-Scenario 'wrong-version';New-ShadowEvidence $s2.evidence $s2.game $s2.role $true '9.9.9.9'
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'New-NebulaPluginCutoverPlan.ps1') (Get-PlanArgs $s2)) `
            'NEBULA_PLUGIN_COMPATIBILITY_PREFLIGHT_FAILED'
    }
    Test-Case 'locked-target-is-rejected-before-stage-or-intent' {
        $s=New-Scenario 'locked';[void](New-Plan $s)
        $locked=Join-Path $s.plugins 'legacy\old-plugin.dll'
        $handle=[IO.File]::Open($locked,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
        try{$r=Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') (Get-ApplyArgs $s $true)}finally{$handle.Dispose()}
        Assert-Failure $r 'NEBULA_PLUGIN_TARGET_TREE_LOCKED'
        Assert-True (-not(Test-Path (Join-Path $s.game ('BepInEx\.plugins.dyson-stage.'+$s.request))))
    }
    Test-Case 'successful-apply-and-terminal-verifier-bind-content-acl-and-role' {
        $s=New-Scenario 'apply-success';[void](New-Plan $s)
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') (Get-ApplyArgs $s $true))
        $verify=@('-RequestId',$s.request,'-JobBase',$s.jobBase,'-GameRoot',$s.game,'-TargetRole',$s.role,
            '-PlanPath',$s.planPath,'-Backend','Shadow')
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Test-NebulaPluginCutover.ps1') $verify)
        $wrong=@('-RequestId',$s.request,'-JobBase',$s.jobBase,'-GameRoot',$s.game,'-TargetRole','Client',
            '-PlanPath',$s.planPath,'-Backend','Shadow')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Test-NebulaPluginCutover.ps1') $wrong) `
            'NEBULA_PLUGIN_PLAN_INVALID'
        $persisted=(Get-Content (Join-Path $s.game ('BepInEx\.dyson-private-cutover\requests\'+$s.request+'.intent.json')) -Raw)+
            (Get-Content (Join-Path $s.game ('BepInEx\.dyson-private-cutover\receipts\'+$s.request+'.receipt.json')) -Raw)
        Assert-True ($persisted.IndexOf((Join-Path $s.job 'candidate'),[StringComparison]::OrdinalIgnoreCase)-lt 0)
    }
    Test-Case 'mid-transaction-failure-compensates-and-retains-candidate-stage' {
        $s=New-Scenario 'failure-rollback';[void](New-Plan $s)
        $args=Get-ApplyArgs $s $true;$args+=@('-TestFailurePoint','AfterActivateMove')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') $args) `
            'NEBULA_PLUGIN_APPLY_FAILED_ROLLED_BACK'
        $verify=@('-RequestId',$s.request,'-JobBase',$s.jobBase,'-GameRoot',$s.game,'-TargetRole',$s.role,
            '-PlanPath',$s.planPath,'-Backend','Shadow')
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Test-NebulaPluginCutover.ps1') $verify)
    }
    Test-Case 'crash-after-first-rename-recovers-preimage-fail-closed' {
        $s=New-Scenario 'crash-recovery';[void](New-Plan $s)
        $args=Get-ApplyArgs $s $true;$args+=@('-TestCrashPoint','AfterQuarantineMove')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') $args) `
            'NEBULA_PLUGIN_SIMULATED_CRASH'
        Assert-True (-not(Test-Path $s.plugins))
        $wrongRecover=Get-ApplyArgs $s $true 'mutation';$wrongRecover+=@('-Recover')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') $wrongRecover) `
            'NEBULA_PLUGIN_HOST_MUTATION_LEASE_KIND_INVALID'
        $recover=Get-ApplyArgs $s $true 'recovery';$recover+=@('-Recover')
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') $recover)
        $verify=@('-RequestId',$s.request,'-JobBase',$s.jobBase,'-GameRoot',$s.game,'-TargetRole',$s.role,
            '-PlanPath',$s.planPath,'-Backend','Shadow')
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Test-NebulaPluginCutover.ps1') $verify)
    }
    Test-Case 'manual-rollback-has-preview-confirmation-receipt-and-verifier' {
        $s=New-Scenario 'manual-rollback';[void](New-Plan $s)
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') (Get-ApplyArgs $s $true))
        $originalReceipt=Read-NebulaPluginJson (Join-Path $s.game ('BepInEx\.dyson-private-cutover\receipts\'+$s.request+'.receipt.json'))
        $rollback=[guid]::NewGuid().ToString('D').ToLowerInvariant()
        $base=@('-OriginalRequestId',$s.request,'-RollbackRequestId',$rollback,'-JobBase',$s.jobBase,
            '-GameRoot',$s.game,'-TargetRole',$s.role,'-OriginalPlanPath',$s.planPath,
            '-OriginalReceiptSha256',[string]$originalReceipt.receiptDigest,
            '-MaintenanceWindowStartUtc',$s.start.ToString('o'),'-MaintenanceWindowEndUtc',$s.end.ToString('o'),
            '-Backend','Shadow','-ShadowEvidencePath',$s.evidence)
        $preview=Invoke-Child (Join-Path $PSScriptRoot 'Restore-NebulaPluginCutover.ps1') $base;Assert-Success $preview
        $previewJson=($preview.output|Where-Object{$_.StartsWith('{')}|Select-Object -Last 1)|ConvertFrom-Json
        $apply=$base+@('-Apply','-ConfirmationPhrase',[string]$previewJson.exactConfirmationPhrase)+
            (Get-ScenarioLeaseArgs $s 'mutation')
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Restore-NebulaPluginCutover.ps1') $apply)
        $verify=@('-OriginalRequestId',$s.request,'-RollbackRequestId',$rollback,'-JobBase',$s.jobBase,
            '-GameRoot',$s.game,'-TargetRole',$s.role,'-OriginalPlanPath',$s.planPath,'-Backend','Shadow')
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Test-NebulaPluginRollback.ps1') $verify)
    }
    Test-Case 'rollback-crash-recovery-requires-recovery-lease-and-current-head' {
        $s=New-Scenario 'rollback-recovery';[void](New-Plan $s)
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') (Get-ApplyArgs $s $true))
        $originalReceipt=Read-NebulaPluginJson (Join-Path $s.game ('BepInEx\.dyson-private-cutover\receipts\'+$s.request+'.receipt.json'))
        $rollback=[guid]::NewGuid().ToString('D').ToLowerInvariant()
        $base=@('-OriginalRequestId',$s.request,'-RollbackRequestId',$rollback,'-JobBase',$s.jobBase,
            '-GameRoot',$s.game,'-TargetRole',$s.role,'-OriginalPlanPath',$s.planPath,
            '-OriginalReceiptSha256',[string]$originalReceipt.receiptDigest,
            '-MaintenanceWindowStartUtc',$s.start.ToString('o'),'-MaintenanceWindowEndUtc',$s.end.ToString('o'),
            '-Backend','Shadow','-ShadowEvidencePath',$s.evidence)
        $preview=Invoke-Child (Join-Path $PSScriptRoot 'Restore-NebulaPluginCutover.ps1') $base;Assert-Success $preview
        $previewJson=($preview.output|Where-Object{$_.StartsWith('{')}|Select-Object -Last 1)|ConvertFrom-Json
        $crash=$base+@('-Apply','-ConfirmationPhrase',[string]$previewJson.exactConfirmationPhrase,
            '-TestCrashPoint','AfterCandidateMoved')+(Get-ScenarioLeaseArgs $s 'mutation')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Restore-NebulaPluginCutover.ps1') $crash) `
            'NEBULA_PLUGIN_SIMULATED_CRASH'
        $wrong=$base+@('-Apply','-Recover','-ConfirmationPhrase',[string]$previewJson.exactConfirmationPhrase)+
            (Get-ScenarioLeaseArgs $s 'mutation')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Restore-NebulaPluginCutover.ps1') $wrong) `
            'NEBULA_PLUGIN_HOST_MUTATION_LEASE_KIND_INVALID'
        $recover=$base+@('-Apply','-Recover','-ConfirmationPhrase',[string]$previewJson.exactConfirmationPhrase)+
            (Get-ScenarioLeaseArgs $s 'recovery')
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Restore-NebulaPluginCutover.ps1') $recover)
        $verify=@('-OriginalRequestId',$s.request,'-RollbackRequestId',$rollback,'-JobBase',$s.jobBase,
            '-GameRoot',$s.game,'-TargetRole',$s.role,'-OriginalPlanPath',$s.planPath,'-Backend','Shadow')
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Test-NebulaPluginRollback.ps1') $verify)
    }
    Test-Case 'terminal-verifier-rejects-extra-file-and-acl-drift' {
        $s=New-Scenario 'verify-extra';[void](New-Plan $s)
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') (Get-ApplyArgs $s $true))
        Write-Bytes (Join-Path $s.plugins 'unexpected.bin') ([byte[]](7))
        $verify=@('-RequestId',$s.request,'-JobBase',$s.jobBase,'-GameRoot',$s.game,'-TargetRole',$s.role,
            '-PlanPath',$s.planPath,'-Backend','Shadow')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Test-NebulaPluginCutover.ps1') $verify) `
            'NEBULA_PLUGIN_ACTIVE_VERIFY_FAILED'
        $s2=New-Scenario 'verify-acl';[void](New-Plan $s2)
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') (Get-ApplyArgs $s2 $true))
        $file=Join-Path $s2.plugins 'nebula-NebulaMultiplayerMod\README.md'
        $sections=[Security.AccessControl.AccessControlSections]::Access -bor `
            [Security.AccessControl.AccessControlSections]::Owner -bor `
            [Security.AccessControl.AccessControlSections]::Group
        $acl=[IO.File]::GetAccessControl($file,$sections)
        $acl.SetAccessRuleProtection($true,$true);[IO.File]::SetAccessControl($file,$acl)
        $verify2=@('-RequestId',$s2.request,'-JobBase',$s2.jobBase,'-GameRoot',$s2.game,'-TargetRole',$s2.role,
            '-PlanPath',$s2.planPath,'-Backend','Shadow')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Test-NebulaPluginCutover.ps1') $verify2) `
            'NEBULA_PLUGIN_ACTIVE_VERIFY_FAILED'
    }
    Test-Case 'plan-nested-schema-is-exact-even-after-attacker-rehash' {
        $s=New-Scenario 'nested-schema';[void](New-Plan $s)
        $plan=Read-NebulaPluginJson $s.planPath
        $plan.transaction|Add-Member -NotePropertyName attackerControlled -NotePropertyValue $true
        Rewrite-PlanDigest $plan $s.request $s.planPath
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') (Get-ApplyArgs $s)) `
            'NEBULA_PLUGIN_PLAN_INVALID'
    }
    Test-Case 'protected-parent-rejects-untrusted-delete-child' {
        $s=New-Scenario 'parent-delete-child'
        $parent=Join-Path $s.game 'BepInEx'
        $acl=[IO.Directory]::GetAccessControl($parent)
        $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
        $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,
            [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
            [Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule);[IO.Directory]::SetAccessControl($parent,$acl)
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'New-NebulaPluginCutoverPlan.ps1') (Get-PlanArgs $s)) `
            'NEBULA_PLUGIN_PARENT_DELETE_CHILD_UNSAFE'
    }
    Test-Case 'physical-root-pending-intent-gate-crosses-role-bindings' {
        $a=New-Scenario 'cross-role-a' 'Server';[void](New-Plan $a)
        $crash=Get-ApplyArgs $a $true 'mutation';$crash+=@('-TestCrashPoint','AfterIntent')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') $crash) `
            'NEBULA_PLUGIN_SIMULATED_CRASH'
        $b=New-ScenarioOnGame 'cross-role-b' $a.game 'Client' $a.leaseScope
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'New-NebulaPluginCutoverPlan.ps1') (Get-PlanArgs $b)) `
            'NEBULA_PLUGIN_PENDING_RECOVERY_REQUIRED'
        Assert-True (Test-NebulaPluginBoundTree $a.plugins $a.preimage $a.preimageIdentity `
            (Get-NebulaPluginTargetBinding $a.game $a.role).digest)
    }
    Test-Case 'stale-a-recovery-and-receipt-replay-cannot-overwrite-b-winner' {
        $a=New-Scenario 'stale-a' 'Server';[void](New-Plan $a)
        $crash=Get-ApplyArgs $a $true 'mutation';$crash+=@('-TestCrashPoint','AfterQuarantineMove')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') $crash) `
            'NEBULA_PLUGIN_SIMULATED_CRASH'
        $recover=Get-ApplyArgs $a $true 'recovery';$recover+=@('-Recover')
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') $recover)
        $b=New-ScenarioOnGame 'winner-b' $a.game 'Client' $a.leaseScope;[void](New-Plan $b)
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') (Get-ApplyArgs $b $true 'mutation'))
        $bindingB=(Get-NebulaPluginTargetBinding $b.game $b.role).digest
        $winnerInventory=Get-NebulaPluginTreeInventory $b.plugins $bindingB
        $winnerIdentity=Get-NebulaPluginDirectoryIdentity $b.plugins
        $stale=Get-ApplyArgs $a $true 'recovery';$stale+=@('-Recover')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') $stale) `
            'NEBULA_PLUGIN_RECEIPT_NOT_CURRENT_HEAD'
        $replayVerify=@('-RequestId',$a.request,'-JobBase',$a.jobBase,'-GameRoot',$a.game,'-TargetRole',$a.role,
            '-PlanPath',$a.planPath,'-Backend','Shadow')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Test-NebulaPluginCutover.ps1') $replayVerify) `
            'NEBULA_PLUGIN_RECEIPT_NOT_CURRENT_HEAD'
        [void](Assert-NebulaPluginBoundTree $b.plugins $winnerInventory $winnerIdentity $bindingB `
            'WINNER_B_CHANGED_BY_STALE_A')
    }
    Test-Case 'stage-content-and-file-id-are-revalidated-after-intent' {
        $s=New-Scenario 'stage-content-tamper';[void](New-Plan $s)
        $args=Get-ApplyArgs $s $true 'mutation';$args+=@('-TestAdversaryAction','StageContentTamperAfterIntent')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') $args) `
            'NEBULA_PLUGIN_COMPENSATION_FAILED'
        [void](Assert-NebulaPluginBoundTree $s.plugins $s.preimage $s.preimageIdentity `
            (Get-NebulaPluginTargetBinding $s.game $s.role).digest 'PREIMAGE_NOT_PRESERVED')
        $s2=New-Scenario 'stage-id-swap';[void](New-Plan $s2)
        $args2=Get-ApplyArgs $s2 $true 'mutation';$args2+=@('-TestAdversaryAction','StageIdentitySwapAfterIntent')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') $args2) `
            'NEBULA_PLUGIN_COMPENSATION_FAILED'
        [void](Assert-NebulaPluginBoundTree $s2.plugins $s2.preimage $s2.preimageIdentity `
            (Get-NebulaPluginTargetBinding $s2.game $s2.role).digest 'PREIMAGE_NOT_PRESERVED')
        $sLate=New-Scenario 'stage-tamper-after-quarantine';[void](New-Plan $sLate)
        $argsLate=Get-ApplyArgs $sLate $true 'mutation'
        $argsLate+=@('-TestAdversaryAction','StageContentTamperAfterQuarantineMove')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') $argsLate) `
            'NEBULA_PLUGIN_COMPENSATION_FAILED'
        [void](Assert-NebulaPluginBoundTree $sLate.plugins $sLate.preimage $sLate.preimageIdentity `
            (Get-NebulaPluginTargetBinding $sLate.game $sLate.role).digest 'LATE_TAMPER_PREIMAGE_NOT_RESTORED')
        $s3=New-Scenario 'quarantine-id-swap';[void](New-Plan $s3)
        Assert-Success (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') `
            (Get-ApplyArgs $s3 $true 'mutation'))
        $receipt=Read-NebulaPluginJson (Join-Path $s3.game ('BepInEx\.dyson-private-cutover\receipts\'+$s3.request+'.receipt.json'))
        $quarantine=Join-Path $s3.game ('BepInEx\.plugins.dyson-quarantine.'+$s3.request)
        $displaced=$quarantine+'.displaced';[IO.Directory]::Move($quarantine,$displaced)
        Copy-TreeWithAcl $displaced $quarantine
        $binding=(Get-NebulaPluginTargetBinding $s3.game $s3.role).digest
        $cloneInventory=Get-NebulaPluginTreeInventory $quarantine $binding
        Assert-True ([string]$cloneInventory.inventoryDigest-ceq[string]$s3.preimage.inventoryDigest) 'clone-not-content-acl-identical'
        Assert-True ([string](Get-NebulaPluginDirectoryIdentity $quarantine).identityDigest-cne
            [string]$s3.preimageIdentity.identityDigest) 'clone-file-id-not-replaced'
        $rollback=[guid]::NewGuid().ToString('D').ToLowerInvariant()
        $preview=@('-OriginalRequestId',$s3.request,'-RollbackRequestId',$rollback,'-JobBase',$s3.jobBase,
            '-GameRoot',$s3.game,'-TargetRole',$s3.role,'-OriginalPlanPath',$s3.planPath,
            '-OriginalReceiptSha256',[string]$receipt.receiptDigest,'-MaintenanceWindowStartUtc',$s3.start.ToString('o'),
            '-MaintenanceWindowEndUtc',$s3.end.ToString('o'),'-Backend','Shadow','-ShadowEvidencePath',$s3.evidence)
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Restore-NebulaPluginCutover.ps1') $preview) `
            'NEBULA_PLUGIN_ROLLBACK_SOURCE_CHANGED'
    }
    Test-Case 'maintenance-window-expiry-after-intent-fails-closed' {
        # Plan/tree hashing and lease creation may take several seconds on a
        # loaded VM. Complete that preparation before arming the short window;
        # otherwise this case tests preflight expiry instead of post-intent expiry.
        $s=New-Scenario 'window-expiry'
        [void](New-Plan $s)
        [void](Use-ScenarioLease $s 'mutation')
        $plan=Read-NebulaPluginJson $s.planPath
        $s.start=[datetimeoffset]::UtcNow.AddMinutes(-1)
        $s.end=[datetimeoffset]::UtcNow.AddSeconds(8)
        $plan.maintenanceWindow.startUtc=$s.start.ToString('o')
        $plan.maintenanceWindow.endUtc=$s.end.ToString('o')
        Rewrite-PlanDigest $plan $s.request $s.planPath
        $args=Get-ApplyArgs $s $true 'mutation';$args+=@('-TestDelayAfterIntentMilliseconds','10000')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') $args) `
            'NEBULA_PLUGIN_COMPENSATION_FAILED'
        $intentPath=Join-Path $s.game ('BepInEx\.dyson-private-cutover\requests\'+$s.request+'.intent.json')
        Assert-True (Test-Path -LiteralPath $intentPath -PathType Leaf) 'window-expired-before-durable-intent'
        [void](Read-NebulaPluginIntent -Path $intentPath)
        [void](Assert-NebulaPluginBoundTree $s.plugins $s.preimage $s.preimageIdentity `
            (Get-NebulaPluginTargetBinding $s.game $s.role).digest 'PREIMAGE_NOT_PRESERVED')
    }
    Test-Case 'lease-kind-and-mid-operation-lease-loss-fail-closed' {
        $wrong=New-Scenario 'wrong-kind';[void](New-Plan $wrong)
        [void](Use-ScenarioLease $wrong 'mutation')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') `
            (Get-ApplyArgs $wrong $true 'recovery')) 'NEBULA_PLUGIN_HOST_MUTATION_LEASE_KIND_INVALID'
        Assert-True (-not(Test-Path (Join-Path $wrong.game 'BepInEx\.dyson-private-cutover')))
        $s=New-Scenario 'lease-loss';[void](New-Plan $s)
        $args=Get-ApplyArgs $s $true 'mutation';$args+=@('-TestAdversaryAction','LeaseLossAfterIntent')
        Assert-Failure (Invoke-Child (Join-Path $PSScriptRoot 'Invoke-NebulaPluginCutover.ps1') $args) `
            'NEBULA_PLUGIN_COMPENSATION_FAILED'
        [void](Assert-NebulaPluginBoundTree $s.plugins $s.preimage $s.preimageIdentity `
            (Get-NebulaPluginTargetBinding $s.game $s.role).digest 'PREIMAGE_NOT_PRESERVED')
    }
    Test-Case 'extended-path-selftest-fixture-cleanup' {
        $probeRoot=Join-Path $temp ('dyson-nebula-transaction-selftest-cleanup-'+[guid]::NewGuid().ToString('N').Substring(0,8))
        try{
            $deep=$probeRoot
            while(($deep+'\probe.bin').Length-le 270){$deep=Join-Path $deep 'deep-cleanup-segment'}
            [IO.Directory]::CreateDirectory(('\\?\'+$deep))|Out-Null
            $probe=Join-Path $deep 'probe.bin'
            [IO.File]::WriteAllText(('\\?\'+$probe),'fixture',[Text.UTF8Encoding]::new($false))
            Assert-True ($probe.Length-gt 260) 'cleanup-probe-not-extended-length'
            Remove-NebulaTransactionSelfTestFixture $probeRoot
            Assert-True (-not[IO.Directory]::Exists($probeRoot)) 'cleanup-probe-remained'
        }
        finally{
            if([IO.Directory]::Exists($probeRoot)){Remove-NebulaTransactionSelfTestFixture $probeRoot}
        }
    }
}
catch{Add-Result 'selftest-harness' $false $_.Exception.Message}
finally{
    foreach($scenario in $script:scenarios){
        try{Stop-ScenarioLease $scenario 'released'}catch{}
    }
    if($null-ne $fixtureRoot -and (Test-Path -LiteralPath $fixtureRoot)){
        try{Remove-NebulaTransactionSelfTestFixture $fixtureRoot}
        catch{Add-Result 'selftest-cleanup' $false $_.Exception.GetType().Name}
    }
}
$summary=[pscustomobject][ordered]@{protocol='DYSON_NEBULA_PLUGIN_TRANSACTION_SELFTEST_V1';passed=$script:passed
    failed=$script:failed;results=@($script:results | ForEach-Object { $_ })}
$summary|ConvertTo-Json -Depth 8
if($script:failed-ne 0){exit 1}
