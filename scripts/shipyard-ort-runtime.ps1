#Requires -Version 5.1
# ort-sys 2.0.0-rc.10 copies runtime DLLs into OUT_DIR/../../..
# Cargo can place OUT_DIR beneath release/build/ort-sys/<hash>/out,
# which makes that destination release/build instead of release.
function Initialize-OrtRuntimeDirectories {
  param([Parameter(Mandatory = $true)][string]$ReleaseDir)

  foreach ($base in @($ReleaseDir, (Join-Path $ReleaseDir 'build'))) {
    foreach ($dir in @($base, (Join-Path $base 'examples'), (Join-Path $base 'deps'))) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
  }
}

function Stage-OrtRuntimeDlls {
  param([Parameter(Mandatory = $true)][string]$ReleaseDir)

  # Newer Cargo layouts make ort-sys copy its runtime DLLs into
  # release/build, while Shipyard packages files beside release/harbor.exe.
  $buildDir = Join-Path $ReleaseDir 'build'
  $runtimePattern = '^(?:onnxruntime.*|DirectML)\.dll$'
  $fromBuild = @(Get-ChildItem -LiteralPath $buildDir -File -Filter '*.dll' |
    Where-Object { $_.Name -match $runtimePattern })
  foreach ($dll in $fromBuild) {
    Copy-Item -LiteralPath $dll.FullName -Destination (Join-Path $ReleaseDir $dll.Name) -Force
  }

  $runtimeDlls = @(Get-ChildItem -LiteralPath $ReleaseDir -File -Filter '*.dll' |
    Where-Object { $_.Name -match $runtimePattern })
  if (-not ($runtimeDlls | Where-Object { $_.Name -eq 'onnxruntime.dll' -and $_.Length -gt 0 })) {
    throw 'Sidecar Core did not stage a valid onnxruntime.dll for Silero VAD'
  }
}
