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
// перезаписать сама себя, поэтому ставится скрытый помощник на PowerShell:
// ждёт завершения текущего процесса, копирует новый EXE поверх текущего
// (с повторами — файл освобождается не мгновенно) и запускает программу снова.
// Б85: помощник запускается тем же способом, что и проверенные окна выбора
// папки/файла (без DETACHED_PROCESS), ведёт журнал в %TEMP%\ostatki_update.log,
// а если замену завершить не удалось — оставляет заметку на рабочем столе,
// чтобы молчаливого «ничего не изменилось» не было.
func psQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

func stageSelfUpdate(srcPath, exePath string, pid int) error {
	script := strings.Join([]string{
		"$ErrorActionPreference = 'SilentlyContinue'",
		fmt.Sprintf("$targetPid = %d", pid),
		"$src = " + psQuote(srcPath),
		"$dst = " + psQuote(exePath),
		"$log = Join-Path $env:TEMP 'ostatki_update.log'",
		"function Note($t) { try { Add-Content -LiteralPath $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $t) -Encoding UTF8 } catch {} }",
		"Note ('update start: ' + $src + ' -> ' + $dst)",
		"try { Wait-Process -Id $targetPid -Timeout 120 } catch {}",
		"Start-Sleep -Milliseconds 500",
		"$ok = $false",
		"for ($i = 0; $i -lt 45 -and -not $ok; $i++) {",
		"  try { Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop; $ok = $true } catch { Start-Sleep -Seconds 1 }",
		"}",
		"if ($ok) { Note 'replaced OK' } else {",
		"  Note 'REPLACE FAILED'",
		"  try { Set-Content -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Обновление программы не удалось.txt') -Value 'Программа «Остатки 2» не смогла завершить обновление: файл программы был занят. Закройте все окна программы и повторите: кнопка «Обновление» и тот же файл новой версии. Подробности: %TEMP%\\ostatki_update.log' -Encoding UTF8 } catch {}",
		"}",
		"Start-Process -FilePath $dst",
		"Note 'started'",
		"Remove-Item -LiteralPath $PSCommandPath -Force",
		"",
	}, "\r\n")
	scriptPath := filepath.Join(os.TempDir(), fmt.Sprintf("ostatki_update_%d.ps1", pid))
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		return err
	}
	// Как окна выбора папки/файла: без специальных флагов создания процесса.
	cmd := exec.Command("powershell", "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", scriptPath)
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
