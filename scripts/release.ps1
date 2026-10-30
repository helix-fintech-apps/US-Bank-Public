# One-command release of USA Banc to Vercel on your free Hobby account (no Git integration, no Team).
#   .\scripts\release.ps1
# Clones main into a fresh temp folder, commits as you (Vercel blocks authors it can't match), deploys with the
# Vercel CLI, then checks the live page and /api/health (which queries the database). Prints LIVE or FAILED.
param([string]$Project = 'usa-banc', [string]$Branch = 'main')
$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/helix-fintech-apps/US-Bank.git'

$VercelCli = 'vercel@64.0.2'                                          # pinned; keep in step with .github/workflows/deploy.yml
npm install -g $VercelCli --no-fund --no-audit | Out-Null
if ($LASTEXITCODE -ne 0) { throw "npm install -g $VercelCli failed" }
if (-not (git config --global user.name)) { throw 'Set your name first: git config --global user.name "Your Name"' }
if (-not (git config --global user.email)) { throw 'Set your GitHub email first: git config --global user.email "you@example.com"' }
# Native commands (git, npm) don't stop the script on failure by themselves: check each one.
function Invoke-Git { git @args; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed (exit $LASTEXITCODE)" } }

$home0 = Get-Location
$d = Join-Path $env:TEMP ('usa-banc-' + (Get-Date -Format 'yyyyMMddHHmmss'))
try {
  Invoke-Git -c core.autocrlf=false clone --quiet --depth 1 -b $Branch $repo $d      # LF files, so the live bytes and the seed version match main
  Set-Location $d
  $built = (git rev-parse --short HEAD)                                  # main's commit, before the author is reset below
  if ($LASTEXITCODE -ne 0) { throw 'git rev-parse failed' }
  Invoke-Git commit --amend --reset-author --no-edit --quiet
  $sha = (git rev-parse --short HEAD)
  if ($LASTEXITCODE -ne 0) { throw 'git rev-parse failed' }
  Write-Host "Releasing USA Banc $sha to $Project (your personal Hobby scope) ..."
  $ErrorActionPreference = 'Continue'                                  # the vercel CLI prints its banner on stderr; judge it by exit code
  vercel project add $Project 2>&1 | Out-Null                          # first time only; fine if it already exists
  vercel link --yes --project $Project 2>&1 | ForEach-Object { "$_" } | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'vercel link failed (run "vercel login" once, and pick your personal account, not a Team)' }
  $out = vercel deploy --prod --yes -e BUILD_SHA=$built 2>&1 | ForEach-Object { "$_" }
  $out | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Host "`nUpload failed. Trying once more with details ..." -ForegroundColor Yellow
    vercel deploy --prod --yes -e BUILD_SHA=$built --debug 2>&1 | ForEach-Object { "$_" } | Select-Object -Last 40 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'vercel deploy failed: send the 40 lines above' }
  }
  $ErrorActionPreference = 'Stop'
  # the address Vercel actually gave us: the "Aliased" line if there is one, else the plain project name
  $alias = ($out | Select-String -Pattern 'https://[a-z0-9-]+\.vercel\.app' -AllMatches | ForEach-Object { $_.Matches.Value } | Where-Object { $_ -notmatch '-[a-z0-9]{9}-' } | Select-Object -Last 1)
  $url = if ($alias) { $alias } else { "https://$Project.vercel.app" }
  # LIVE means the page loads AND the API reaches its database (/api/health runs a query and reports the commit it was built from, which must be $built), not just that HTML is served.
  Write-Host "Checking $url and $url/api/health ..."
  $ok = $false
  foreach ($i in 1..12) {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20
      $h = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 20
      if ($r.Content -match 'USA Banc' -and $h.ok -eq $true -and $h.build -eq $built) { $ok = $true; break }
    } catch {}
    Start-Sleep -Seconds 5
  }
  if ($ok) { Write-Host "`nLIVE: $url  ($sha)" -ForegroundColor Green; Start-Process $url }
  else { Write-Host "`nNot confirmed at $url (the page or /api/health did not answer). Look above for the 'Production:' or 'Aliased:' line; that link is your site." -ForegroundColor Yellow; Write-Host "Your projects: https://vercel.com/dashboard"; exit 1 }
}
finally { Set-Location $home0; Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue }
