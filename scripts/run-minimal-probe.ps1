param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

if ($DryRun) {
    Push-Location $projectRoot
    try {
        node ".\src\lab\run-minimal-probe.mjs" --dry-run
        if ($LASTEXITCODE -ne 0) {
            throw "The dry run exited with code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
    return
}

$secureKey = Read-Host 'DeepSeek API key' -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
    $env:DEEPSEEK_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    Push-Location $projectRoot
    try {
        node ".\src\lab\run-minimal-probe.mjs"
        if ($LASTEXITCODE -ne 0) {
            throw "The trajectory probe exited with code $LASTEXITCODE."
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
