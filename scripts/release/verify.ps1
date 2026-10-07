[CmdletBinding()]
param(
    [switch]$SkipFullTests
)

$ErrorActionPreference = 'Stop'
$project = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Push-Location $project
try {
    $nodeVersion = (& node.exe --version).Trim().TrimStart('v')
    if ([version]$nodeVersion -lt [version]'24.15.0' -or [version]$nodeVersion -ge [version]'25.0.0') {
        throw "Node.js 24.15.x or newer 24.x is required; found $nodeVersion"
    }
    & npm.cmd run inventory
    if ($LASTEXITCODE -ne 0) { throw 'Inventory generation failed.' }
    & npm.cmd run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    & npm.cmd run test:acceptance
    if ($LASTEXITCODE -ne 0) { throw 'Acceptance tests failed.' }
    & npm.cmd run self-test
    if ($LASTEXITCODE -ne 0) { throw 'Required capability self-test failed.' }
    if (-not $SkipFullTests) {
        & npm.cmd test
        if ($LASTEXITCODE -ne 0) { throw 'Full test suite failed.' }
    }
    $required = @(
        'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
        'docs\TOOL_INVENTORY.md', 'docs\PARITY_MATRIX.md', 'docs\ACCEPTANCE_REPORT.md',
        'docs\THAI_QUICKSTART.md', 'docs\THAI_USER_GUIDE.md', 'docs\TROUBLESHOOTING.md',
        'docs\architecture\DATA_FLOW.md', 'docs\architecture\OPERATIONS.md',
        'docs\security\AUTHORIZATION.md', 'docs\security\PRIVILEGED_BROKER.md',
        'docs\security\CREDENTIALS.md', 'docs\security\THREAT_MODEL.md'
    )
    foreach ($relative in $required) {
        $path = Join-Path $project $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -lt 100) {
            throw "Required release document is missing or empty: $relative"
        }
    }
    $inventory = Get-Content -Raw -LiteralPath (Join-Path $project 'config\tool-inventory.v1.json') | ConvertFrom-Json
    if ($inventory.schemaVersion -ne 1 -or $inventory.tools.Count -lt 50) { throw 'Runtime tool inventory is invalid.' }
    $trackedSecrets = & git.exe grep -n -I -E '(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)' -- . ':!package-lock.json'
    if ($LASTEXITCODE -eq 0 -and $trackedSecrets) { throw 'Potential committed secret material was detected.' }
    if ($LASTEXITCODE -notin @(0, 1)) { throw 'Git secret scan failed.' }
    [pscustomobject]@{
        Result = 'PASS'
        Node = $nodeVersion
        Tools = $inventory.tools.Count
        FullTests = -not $SkipFullTests
        LiveReboot = 'Not run by verifier; use the explicit authorized system-test switches.'
    }
} finally {
    Pop-Location
}
