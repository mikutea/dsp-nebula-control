[CmdletBinding()]
param([Parameter(Mandatory)][string]$InputPath,[Parameter(Mandatory)][string]$OutputPath,[datetimeoffset]$NowUtc=[datetimeoffset]::UtcNow)
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'PostGsManagerRemovalObservationV2.Common.ps1')
$inputValue=Read-DysonPostRemovalV2JsonFile -Path $InputPath
$observation=New-DysonPostGsManagerRemovalObservationV2 -InputValue $inputValue
$validation=Assert-DysonPostGsManagerRemovalObservationV2 -Observation $observation -NowUtc $NowUtc
$fullOutputPath=[IO.Path]::GetFullPath($OutputPath);$parent=Split-Path -Path $fullOutputPath -Parent
if([string]::IsNullOrWhiteSpace($parent) -or -not(Test-Path -LiteralPath $parent -PathType Container) -or [IO.Path]::GetExtension($fullOutputPath)-cne '.json'){Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_OUTPUT_INVALID'}
$parentItem=Get-Item -LiteralPath $parent -Force
if(($parentItem.Attributes-band[IO.FileAttributes]::ReparsePoint) -or (Test-Path -LiteralPath $fullOutputPath)){if(Test-Path -LiteralPath $fullOutputPath){Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_OUTPUT_EXISTS'};Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_OUTPUT_INVALID'}
$stream=$null;$writer=$null
try{$stream=New-Object IO.FileStream -ArgumentList $fullOutputPath,([IO.FileMode]::CreateNew),([IO.FileAccess]::Write),([IO.FileShare]::None);$writer=New-Object IO.StreamWriter -ArgumentList $stream,(New-Object Text.UTF8Encoding -ArgumentList $false);$writer.Write((ConvertTo-DysonQualificationV2CanonicalJson -Value $observation));$writer.Flush();$stream.Flush($true)}catch{if(Test-Path -LiteralPath $fullOutputPath){Throw-DysonPostRemovalV2Error -Code 'DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_V2_OUTPUT_EXISTS'};throw}finally{if($null-ne $writer){$writer.Dispose()}elseif($null-ne $stream){$stream.Dispose()}}
[pscustomobject][ordered]@{protocol='DYSON_POST_GSMANAGER_REMOVAL_OBSERVATION_GENERATOR_RESULT_V2';schemaVersion=2;qualified=[bool]$validation.qualified;observationId=[string]$validation.observationId;runId=[string]$validation.runId;targetIdentity=[string]$validation.targetIdentity;releaseVersion=[string]$validation.releaseVersion;observationSha256=[string]$validation.observationSha256;outputPath=$fullOutputPath;networkTouched=$false;productionChanged=$false}|ConvertTo-Json -Depth 4 -Compress
