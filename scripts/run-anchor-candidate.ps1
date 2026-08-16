param(
    [switch]$DryRun,
    [switch]$OpenWorkstream,
    [ValidateSet('deepseek-v4-pro', 'deepseek-v4-flash')]
    [string]$Model = 'deepseek-v4-pro',
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]*$')]
    [string]$ArtifactId,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$defaultId = if ($OpenWorkstream) {
    'dsh-minimal-open-workstream-two-tool-v2'
}
else {
    'dsh-minimal-two-tool-v1'
}
$resolvedId = if ($ArtifactId) { $ArtifactId } else { $defaultId }
$resolvedOutput = if ($OutputPath) {
    if ([IO.Path]::IsPathRooted($OutputPath)) {
        [IO.Path]::GetFullPath($OutputPath)
    }
    else {
        [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputPath))
    }
}
else {
    Join-Path $projectRoot "anchors\$resolvedId.json"
}
$nodeArguments = @('.\src\lab\run-anchor-candidate.mjs')
if ($OpenWorkstream) { $nodeArguments += '--open-workstream' }
if ($DryRun) { $nodeArguments += '--dry-run' } else { $nodeArguments += '--freeze' }

$previousModel = $env:DEEPSEEK_MODEL
$previousArtifactId = $env:ANCHOR_ARTIFACT_ID
$previousOutputPath = $env:ANCHOR_OUTPUT_PATH

try {
    $env:DEEPSEEK_MODEL = $Model
    $env:ANCHOR_ARTIFACT_ID = $resolvedId
    $env:ANCHOR_OUTPUT_PATH = $resolvedOutput

    if ($DryRun) {
        Push-Location $projectRoot
        try {
            & node $nodeArguments
            if ($LASTEXITCODE -ne 0) {
                throw "The anchor dry run exited with code $LASTEXITCODE."
            }
        }
        finally {
            Pop-Location
        }
        return
    }

    if (Test-Path -LiteralPath $resolvedOutput) {
        throw "Refusing to overwrite immutable anchor before requesting an API key: $resolvedOutput"
    }

    $secureKey = Read-Host 'DeepSeek API key' -AsSecureString
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try {
        $env:DEEPSEEK_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
        Push-Location $projectRoot
        try {
            & node $nodeArguments
            if ($LASTEXITCODE -ne 0) {
                throw "The anchor builder exited with code $LASTEXITCODE."
            }
        }
        finally {
            Pop-Location
        }
    }
    finally {
        Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    }
}
finally {
    if ($null -eq $previousModel) { Remove-Item Env:DEEPSEEK_MODEL -ErrorAction SilentlyContinue } else { $env:DEEPSEEK_MODEL = $previousModel }
    if ($null -eq $previousArtifactId) { Remove-Item Env:ANCHOR_ARTIFACT_ID -ErrorAction SilentlyContinue } else { $env:ANCHOR_ARTIFACT_ID = $previousArtifactId }
    if ($null -eq $previousOutputPath) { Remove-Item Env:ANCHOR_OUTPUT_PATH -ErrorAction SilentlyContinue } else { $env:ANCHOR_OUTPUT_PATH = $previousOutputPath }
}
