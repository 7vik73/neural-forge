param([string]$Action = "start")
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (Get-Command node -ErrorAction SilentlyContinue) {
  & node scripts/manage.mjs $Action
} else {
  switch ($Action) {
    { $_ -in "start", "setup" } {
      & docker run --rm -e "FORGE_HOST_ROOT=$PSScriptRoot" -v "${PSScriptRoot}:/project" -w /project node:24.18.0-bookworm-slim node scripts/manage.mjs setup
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      if ($Action -eq "start") {
        & docker run --rm --network host -v "${PSScriptRoot}:/project:ro" -w /project node:24.18.0-bookworm-slim node scripts/ollama-check.mjs 2>$null
        if ($LASTEXITCODE -eq 0) {
          Set-Content -Path .local/network-mode -Value host
          & docker compose --profile app up -d --build --wait
        } else {
          Set-Content -Path .local/network-mode -Value bridge
          & docker compose -f compose.yaml -f compose.bridge.yaml --profile app up -d --build --wait
        }
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & docker run --rm -v "${PSScriptRoot}:/project:ro" -w /project node:24.18.0-bookworm-slim node scripts/manage.mjs link
      }
    }
    "stop" { & docker compose --profile app stop }
    "status" { & docker compose --profile app ps }
    "diagnostics" { & docker compose --profile app logs --tail=30 api worker }
    default { Write-Error "Use Settings for browser backups, or install Node.js 24 for extended command-line tools." }
  }
}
exit $LASTEXITCODE
