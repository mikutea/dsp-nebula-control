# Copyright (c) Dyson Control contributors.
# Validates and optionally consumes one protected hostname-preserving WSS qualification.

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$EvidenceRoot,
    [Parameter(Mandatory)][string]$BuildHarvestRootA,
    [Parameter(Mandatory)][string]$BuildHarvestRootB,
    [Parameter(Mandatory)][string]$KeyRingRoot,
    [Parameter(Mandatory)][string]$ReplayRoot,
    [Parameter(Mandatory)][string]$ExpectedQualificationId,
    [Parameter(Mandatory)][string]$ExpectedAuthority,
    [Parameter(Mandatory)][ValidateRange(443,443)][int]$ExpectedPort,
    [switch]$Consume,
    [string]$Confirmation
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'DysonHostnameWssQualification.Common.ps1')

$projection = Invoke-DysonHostnameWssQualificationValidation `
    -EvidenceRoot $EvidenceRoot `
    -BuildHarvestRootA $BuildHarvestRootA `
    -BuildHarvestRootB $BuildHarvestRootB `
    -KeyRingRoot $KeyRingRoot `
    -ReplayRoot $ReplayRoot `
    -ExpectedQualificationId $ExpectedQualificationId `
    -ExpectedAuthority $ExpectedAuthority `
    -ExpectedPort $ExpectedPort `
    -Consume:$Consume `
    -Confirmation $Confirmation

$projection | ConvertTo-Json -Depth 8 -Compress
if ([string]$projection.decision -ceq 'qualified') { exit 0 }
if ([string]$projection.decision -ceq 'preview-valid') { exit 3 }
exit 2
