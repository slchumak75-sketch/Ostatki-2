//go:build windows

package server

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Батч-83: самообновление заменой EXE. Запущенная программа не может
// перезаписать сама себя, поэтому ставится помощник на PowerShell:
// ждёт завершения текущего процесса, копирует новый EXE поверх текущего
// и запускает программу снова.
// Б87: помощник — ВИДИМОЕ окно «Обновление программы» с шагами на экране
// (раньше был скрытым: при сбое пользователь видел только закрывшуюся
// программу и старую версию при запуске). При неудаче окно не закрывается,
// а показывает причину; успех/неудача пишутся и в журнал
// %TEMP%\ostatki_update.log, при неудаче — ещё заметка на рабочий стол.
// Скрипт пишется с UTF-8 BOM, иначе PowerShell 5.1 читает его как ANSI
// и русские строки превращаются в «кракозябры».
func psQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

func stageSelfUpdate(srcPath, exePath string, pid int) error {
	lines := []string{
		"$ErrorActionPreference = 'SilentlyContinue'",
		"$Host.UI.RawUI.WindowTitle = 'Обновление программы Остатки 2'",
		fmt.Sprintf("$targetPid = %d", pid),
		"$src = " + psQuote(srcPath),
		"$dst = " + psQuote(exePath),
		"$log = Join-Path $env:TEMP 'ostatki_update.log'",
		"function Note($t) { try { Add-Content -LiteralPath $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $t) -Encoding UTF8 } catch {} }",
		"function Fail($t) { Note ('FAIL: ' + $t); Write-Host ''; Write-Host ('Обновление не удалось: ' + $t) -ForegroundColor Red; Write-Host 'Что делать: закройте все окна программы и запустите её снова, затем повторите обновление тем же файлом. Если не поможет — пришлите скриншот этого окна.'; try { Set-Content -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Обновление программы не удалось.txt') -Value ('Обновление программы «Остатки 2» не удалось: ' + $t + '. Подробности: %TEMP%\\ostatki_update.log') -Encoding UTF8 } catch {}; Read-Host 'Нажмите Enter, чтобы закрыть это окно'; Remove-Item -LiteralPath $PSCommandPath -Force; exit 1 }",
		"Write-Host 'Программа обновляется…' -ForegroundColor Cyan",
		"Write-Host ''",
		"Write-Host ('Файл новой версии: ' + $src)",
		"Write-Host ('Обновляемая программа: ' + $dst)",
		"Write-Host ''",
		"Note ('update start: ' + $src + ' -> ' + $dst)",
		"if (-not (Test-Path -LiteralPath $src)) { Fail 'файл новой версии не найден (возможно, его удалили или переместили из Загрузок)' }",
		"Write-Host 'Шаг 1 из 3. Закрываем программу… (окно программы закроется само)'",
		"try { Wait-Process -Id $targetPid -Timeout 120 } catch {}",
		"Start-Sleep -Milliseconds 500",
		"Write-Host 'Шаг 2 из 3. Ставим новую версию…'",
		"$ok = $false",
		"for ($i = 0; $i -lt 45 -and -not $ok; $i++) {",
		"  try { Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop; $ok = $true } catch { Start-Sleep -Seconds 1 }",
		"}",
		"if (-not $ok) { Fail 'не удалось заменить файл программы — он остался занят' }",
		"if ((Get-Item -LiteralPath $dst).Length -ne (Get-Item -LiteralPath $src).Length) { Fail 'новый файл записался не полностью' }",
		"Note 'replaced OK'",
		"Write-Host 'Шаг 3 из 3. Запускаем новую версию…'",
		"Start-Process -FilePath $dst",
		"Start-Sleep -Seconds 3",
		"$running = Get-Process | Where-Object { $_.Path -eq $dst }",
		"if (-not $running) { Start-Process -FilePath $dst; Start-Sleep -Seconds 2 }",
		"Note 'started'",
		"Write-Host ''",
		"Write-Host 'Готово! Открылось окно новой версии программы.' -ForegroundColor Green",
		"Write-Host 'Это окно закроется само через несколько секунд.'",
		"Start-Sleep -Seconds 4",
		"Remove-Item -LiteralPath $PSCommandPath -Force",
		"",
	}
	scriptPath := filepath.Join(os.TempDir(), fmt.Sprintf("ostatki_update_%d.ps1", pid))
	content := append([]byte{0xEF, 0xBB, 0xBF}, []byte(strings.Join(lines, "\r\n"))...)
	if err := os.WriteFile(scriptPath, content, 0o600); err != nil {
		return err
	}
	// Видимое окно обновления: без -WindowStyle Hidden (батч-87).
	cmd := exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath)
	if err := cmd.Start(); err != nil {
		_ = os.Remove(scriptPath)
		return err
	}
	return nil
}

// Батч-83: выбран файл установщика (…_Setup.exe) — просто запускаем его,
// программа закроется штатно, дальше работает мастер установки.
func launchUpdateInstaller(path string) error {
	cmd := exec.Command(path)
	return cmd.Start()
}
