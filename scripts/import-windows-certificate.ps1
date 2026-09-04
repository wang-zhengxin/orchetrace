$ErrorActionPreference = "Stop"

if (-not $env:WINDOWS_CERTIFICATE -or -not $env:WINDOWS_CERTIFICATE_PASSWORD) {
  throw "WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD are required"
}

$configPath = Join-Path $PSScriptRoot "../apps/desktop/src-tauri/tauri.release.conf.json"
$certificatePath = Join-Path $env:RUNNER_TEMP "orchetrace-release-certificate.pfx"
$certificateBytes = [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE)
[IO.File]::WriteAllBytes($certificatePath, $certificateBytes)

try {
  $password = ConvertTo-SecureString -String $env:WINDOWS_CERTIFICATE_PASSWORD -Force -AsPlainText
  $certificate = Import-PfxCertificate `
    -FilePath $certificatePath `
    -CertStoreLocation Cert:\CurrentUser\My `
    -Password $password `
    -Exportable | Select-Object -First 1
  if (-not $certificate.Thumbprint) { throw "imported Windows certificate has no thumbprint" }

  $config = Get-Content -Raw $configPath | ConvertFrom-Json
  if (-not $config.bundle.windows) {
    $config.bundle | Add-Member -NotePropertyName windows -NotePropertyValue ([PSCustomObject]@{})
  }
  $config.bundle.windows | Add-Member -Force -NotePropertyName certificateThumbprint -NotePropertyValue $certificate.Thumbprint
  $config.bundle.windows | Add-Member -Force -NotePropertyName digestAlgorithm -NotePropertyValue "sha256"
  $config.bundle.windows | Add-Member -Force -NotePropertyName timestampUrl -NotePropertyValue "http://timestamp.digicert.com"
  $config | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 $configPath
  Write-Host "Imported Windows signing certificate and configured its thumbprint."
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $certificatePath
}
