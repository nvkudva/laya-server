# Thin wrapper: make sure uv is available, then hand off to the CLI.
# Everything else lives in server/cli.py so macOS, Linux and Windows share one code path.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host "==> uv not found, installing from https://astral.sh/uv"
  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}

Write-Host "==> Setting up Python 3.12 and dependencies"
uv sync --quiet

# Offer the global install, but only on a bare interactive run — see the comment in start.sh.
if ($args.Count -eq 0 -and [Environment]::UserInteractive -and -not ((uv tool list 2>$null) -match '^laya-server')) {
  $reply = Read-Host "`nInstall laya-server globally, so you can run it from anywhere? [y/N]"
  if ($reply -match '^[yY]') {
    uv tool install --editable . --quiet
    if ($LASTEXITCODE -eq 0) {
      Write-Host "==> Installed. From now on just run:  laya-server"
    } else {
      Write-Host "==> Install failed; carrying on with this checkout."
    }
  }
  Write-Host ""
}

uv run laya-server @args
