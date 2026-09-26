$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sdkPath = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$studioJava = 'C:\Program Files\Android\Android Studio\jbr'

Push-Location $projectRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Build web gagal.' }
    npx cap sync android
    if ($LASTEXITCODE -ne 0) { throw 'Capacitor Android sync gagal.' }

    if (-not $env:JAVA_HOME -and (Test-Path (Join-Path $studioJava 'bin\java.exe'))) {
        $env:JAVA_HOME = $studioJava
        $env:Path = "$env:JAVA_HOME\bin;$env:Path"
    }
    if (-not $env:ANDROID_HOME -and (Test-Path $sdkPath)) { $env:ANDROID_HOME = $sdkPath }
    if ($env:JAVA_TOOL_OPTIONS -notmatch 'jdk\.net\.unixdomain\.tmpdir') {
        $fallback = '-Djdk.net.unixdomain.tmpdir=C:\gradle-socket-fallback-do-not-create'
        $env:JAVA_TOOL_OPTIONS = (@($env:JAVA_TOOL_OPTIONS, $fallback) | Where-Object { $_ }) -join ' '
    }

    Push-Location (Join-Path $projectRoot 'android')
    try {
        & .\gradlew.bat assembleDebug --no-daemon
        if ($LASTEXITCODE -ne 0) { throw 'Build Gradle gagal.' }
    } finally { Pop-Location }

    $artifacts = Join-Path $projectRoot 'artifacts'
    New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'android\app\build\outputs\apk\debug\app-debug.apk') -Destination (Join-Path $artifacts 'Jeda-Android-debug.apk') -Force
} finally { Pop-Location }
