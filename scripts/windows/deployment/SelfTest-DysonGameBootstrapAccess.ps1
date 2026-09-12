[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
# Load only the filesystem helpers: do not run production startup, account,
# stopped-game checks, or any bootstrap supplied by a real installation.
$source = Join-Path $PSScriptRoot 'Set-DysonGameBootstrapAccess.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'GAME_ACCESS_SELFTEST_PARSE_FAILED' }
foreach ($name in @('Get-AccessSnapshotHash', 'Get-AccessInventory', 'Get-GameAccessAcl', 'Restore-AccessInventory')) {
    $definition = @($ast.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst]
    }, $false) | Where-Object { $_.Name -eq $name })
    if ($definition.Count -ne 1) { throw 'GAME_ACCESS_SELFTEST_HELPER_MISSING' }
    . ([scriptblock]::Create($definition[0].Extent.Text))
}

$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixture = Join-Path $temporaryRoot ('dyson-game-access-selftest-' + [guid]::NewGuid().ToString('N'))
$stateRoot = Join-Path $fixture 'state'
$gameSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-111111111-222222222-333333333-1000')
$checks = [Collections.Generic.List[string]]::new()
function Assert-Fixture([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
try {
    [void][IO.Directory]::CreateDirectory((Join-Path $stateRoot 'nested'))
    $pointer = Join-Path $stateRoot 'active-pointer.json'
    [IO.File]::WriteAllText($pointer, '{"fixture":true}', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $stateRoot 'nested\receipt.json'), '{}')
    $original = @(Get-AccessInventory)
    $hash = Get-AccessSnapshotHash $pointer
    Assert-Fixture ($hash -cmatch '^[a-f0-9]{64}$') 'snapshot-hash-format'
    [IO.File]::AppendAllText($pointer, ' ')
    Assert-Fixture ((Get-AccessSnapshotHash $pointer) -cne $hash) 'snapshot-hash-missed-change'
    $checks.Add('snapshot hash detects changed bytes')

    $changed = Get-Acl -LiteralPath $stateRoot
    $changed.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),
        [Security.AccessControl.FileSystemRights]::ReadAndExecute,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow))
    [IO.Directory]::SetAccessControl($stateRoot, $changed)
    Restore-AccessInventory $original
    Assert-Fixture (((Get-AccessInventory | ConvertTo-Json -Depth 4 -Compress)) -ceq
        ($original | ConvertTo-Json -Depth 4 -Compress)) 'nested-descriptors-not-restored'
    $checks.Add('nested inherited descriptors restore exactly')
    Restore-AccessInventory $original
    Assert-Fixture (((Get-AccessInventory | ConvertTo-Json -Depth 4 -Compress)) -ceq
        ($original | ConvertTo-Json -Depth 4 -Compress)) 'repeat-restore-changed-state'
    $checks.Add('repeat restore is idempotent')

    $grant = Get-GameAccessAcl
    [IO.Directory]::SetAccessControl($stateRoot, $grant)
    Assert-Fixture ((Get-Acl -LiteralPath $stateRoot).Sddl -ceq $grant.Sddl) 'grant-readback-mismatch'
    Assert-Fixture ((Get-GameAccessAcl).Sddl -ceq $grant.Sddl) 'repeat-grant-not-idempotent'
    $checks.Add('game access grant readback and repeat planning agree')
    Restore-AccessInventory $original

    # A later missing target must be detected before the first descriptor changes.
    $bad = @([ordered]@{path=''; directory=$true; sddl=$changed.Sddl}) + @(
        [ordered]@{path='missing.json'; directory=$false; sddl=$original[1].sddl})
    $rejected = $false
    try { Restore-AccessInventory $bad } catch { $rejected = $true }
    Assert-Fixture $rejected 'missing-target-accepted'
    Assert-Fixture ((Get-Acl -LiteralPath $stateRoot).Sddl -ceq $original[0].sddl) 'preflight-partially-restored'
    $checks.Add('unavailable later target leaves earlier objects unchanged')

    $rejected = $false
    try { Restore-AccessInventory @([ordered]@{path='..\outside'; directory=$true; sddl=$original[0].sddl}) }
    catch { $rejected = $_.Exception.Message -eq 'GAME_ACCESS_RESTORE_PATH_INVALID' }
    Assert-Fixture $rejected 'outside-fixture-target-accepted'
    $checks.Add('invalid snapshot target is rejected before writes')
}
finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if ($resolved.StartsWith($temporaryRoot + '\dyson-game-access-selftest-', [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Directory]::Exists($resolved)) { [IO.Directory]::Delete($resolved, $true) }
}
[ordered]@{protocol='DYSON_GAME_ACCESS_SELFTEST_V1'; passed=$checks.Count; checks=@($checks.ToArray()); productionChanged=$false} |
    ConvertTo-Json -Depth 4 -Compress
