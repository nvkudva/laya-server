# Thin wrapper: make sure uv is available, then hand off to the CLI.
# Everything else lives in laya_server/cli.py so macOS, Linux and Windows share one code path.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host "==> uv not found, installing from https://astral.sh/uv"
  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}

Write-Host "==> Setting up Python 3.12 and dependencies"
uv sync --quiet

$cliArgs = if ($args.Count -gt 0) { $args } else { @("serve") }
uv run laya-server @cliArgs
