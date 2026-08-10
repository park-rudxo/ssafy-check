# SSAFY 출석 체크 알리미 - 업데이트 스크립트
#
# 업데이트.bat 이 이 파일을 실행합니다. 직접 실행할 필요는 없습니다.
#
# git 으로 받은 폴더면 git pull 을, zip 으로 설치한 폴더면 최신 Release zip 을
# 내려받아 덮어씁니다. 어느 쪽이든 사용자는 같은 파일만 더블클릭하면 됩니다.

$ErrorActionPreference = "Stop"
# 진행바를 켜두면 Invoke-WebRequest 다운로드가 눈에 띄게 느려진다.
$ProgressPreference = "SilentlyContinue"
$REPO = "park-rudxo/ssafy-check"

function Write-Head($text) {
    Write-Host ""
    Write-Host "  ================================================" -ForegroundColor DarkGray
    Write-Host "    $text"
    Write-Host "  ================================================" -ForegroundColor DarkGray
    Write-Host ""
}

function Get-LocalVersion {
    $f = Join-Path $PSScriptRoot "manifest.json"
    if (-not (Test-Path $f)) { return $null }
    try { return (Get-Content -Raw $f | ConvertFrom-Json).version } catch { return $null }
}

function Fail($msg) {
    Write-Host ""
    Write-Host "  [실패] $msg" -ForegroundColor Red
    Write-Host ""
    exit 1
}

Set-Location $PSScriptRoot
Write-Head "SSAFY 출석 체크 알리미 - 업데이트"

# 엉뚱한 폴더에서 실행되지 않도록 확인
$before = Get-LocalVersion
if (-not $before) {
    Fail "확장 폴더가 아닙니다. manifest.json 이 있는 폴더에 두고 실행하세요."
}
Write-Host "  현재 버전 : v$before"
Write-Host ""

$usedGit = $false

if (Test-Path (Join-Path $PSScriptRoot ".git")) {
    # ── git 으로 받은 경우 ────────────────────────────────────────────
    $usedGit = $true
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Fail "git 폴더인데 git 이 설치되어 있지 않습니다. Git for Windows 를 설치하세요."
    }
    Write-Host "  git 으로 최신 내용을 받는 중..." -ForegroundColor DarkGray
    Write-Host ""

    # 되돌리기 어려운 상태를 만들지 않도록 fast-forward 만 허용한다.
    # git 은 정상 진행 상황도 stderr 로 내보내는데, ErrorActionPreference 가
    # Stop 이면 PowerShell 5.1 이 그걸 예외로 처리해버린다. 이 구간만 완화한다.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    git pull --ff-only 2>&1 | ForEach-Object { Write-Host "  $_" }
    $gitCode = $LASTEXITCODE
    $ErrorActionPreference = $prev

    if ($gitCode -ne 0) {
        Write-Host ""
        Write-Host "  ------------------------------------------------" -ForegroundColor Yellow
        Write-Host "  자동 업데이트를 할 수 없습니다." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  이 폴더의 파일을 직접 수정하셨을 가능성이 큽니다."
        Write-Host "  수정 내용을 버리고 최신으로 맞추려면 이 폴더에서 아래를 실행하세요."
        Write-Host ""
        Write-Host "      git reset --hard" -ForegroundColor White
        Write-Host "      git pull" -ForegroundColor White
        Write-Host "  ------------------------------------------------" -ForegroundColor Yellow
        exit 1
    }
} else {
    # ── zip 으로 설치한 경우: 최신 Release zip 을 받아 덮어쓴다 ───────
    Write-Host "  최신 버전을 확인하는 중..." -ForegroundColor DarkGray
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    } catch {
        # 최신 PowerShell 은 이미 TLS 1.2 이상을 쓰므로 실패해도 무시한다.
    }

    try {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/releases/latest" `
                                 -Headers @{ "User-Agent" = "ssafy-check-updater" }
    } catch {
        Fail "GitHub 에 연결하지 못했습니다. 인터넷 연결을 확인해주세요."
    }

    $asset = $rel.assets | Where-Object { $_.name -like "*.zip" } | Select-Object -First 1
    if (-not $asset) {
        Fail "최신 Release 에 zip 파일이 없습니다. Releases 페이지에서 직접 받아주세요.`n         https://github.com/$REPO/releases/latest"
    }

    $latest = $rel.tag_name -replace '^v', ''
    if ($latest -eq $before) {
        Write-Head "이미 최신 버전입니다. (v$before)"
        Write-Host "  따로 하실 일은 없습니다."
        Write-Host ""
        exit 0
    }

    Write-Host "  v$latest 를 내려받는 중..." -ForegroundColor DarkGray
    $tmp = Join-Path $env:TEMP ("ssafy-check-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $zip = Join-Path $tmp "update.zip"

    try {
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip `
                          -Headers @{ "User-Agent" = "ssafy-check-updater" }
        Expand-Archive -Path $zip -DestinationPath $tmp -Force

        # zip 최상위의 ssafy-check 폴더 안이 실제 확장 파일이다.
        $src = Join-Path $tmp "ssafy-check"
        if (-not (Test-Path (Join-Path $src "manifest.json"))) {
            # 구조가 다르면 manifest.json 이 있는 폴더를 찾아본다.
            $found = Get-ChildItem -Path $tmp -Filter "manifest.json" -Recurse |
                     Select-Object -First 1
            if (-not $found) { Fail "받은 zip 에서 manifest.json 을 찾지 못했습니다." }
            $src = $found.DirectoryName
        }

        Write-Host "  덮어쓰는 중..." -ForegroundColor DarkGray
        Copy-Item -Path (Join-Path $src "*") -Destination $PSScriptRoot -Recurse -Force
    } catch {
        Fail "업데이트 중 오류가 발생했습니다. $($_.Exception.Message)"
    } finally {
        Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$after = Get-LocalVersion

if ($before -eq $after) {
    Write-Head "이미 최신 버전입니다. (v$after)"
    Write-Host "  따로 하실 일은 없습니다."
    Write-Host ""
    exit 0
}

Write-Head "업데이트 완료!   v$before  ->  v$after"
Write-Host "  마지막 한 단계가 남았습니다." -ForegroundColor Yellow
Write-Host ""
Write-Host "    1. 크롬 툴바의 확장 아이콘을 눌러 팝업을 여세요."
Write-Host "    2. 맨 위에 뜨는 [지금 적용하기] 버튼을 누르면 끝입니다."
Write-Host ""
Write-Host "  (버튼이 안 보이면 chrome://extensions 에서" -ForegroundColor DarkGray
Write-Host "   이 확장의 새로고침 아이콘을 눌러주세요)" -ForegroundColor DarkGray
Write-Host ""
