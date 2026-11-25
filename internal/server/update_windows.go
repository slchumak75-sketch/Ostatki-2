//go:build windows

package server

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// Батч-83: самообновление заменой EXE. Запущенная программа не может
// перезаписать сама себя, поэтому ставится скрытый помощник на PowerShell:
// ждёт завершения текущего процесса, копирует новый EXE поверх текущего
// (с повторами — файл освобождается не мгновенно) и запускает программу снова.
func psQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

func stageSelfUpdate(srcPath, exePath string, pid int) error {
	script := strings.Join([]string{
		"$ErrorActionPreference = 'SilentlyContinue'",
		fmt.Sprintf("$targetPid = %d", pid),
		"$src = " + psQuote(srcPath),
		"$dst = " + psQuote(exePath),
		"try { Wait-Process -Id $targetPid -Timeout 120 } catch {}",
		"Start-Sleep -Milliseconds 500",
		"$ok = $false",
		"for ($i = 0; $i -lt 45 -and -not $ok; $i++) {",
		"  try { Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop; $ok = $true } catch { Start-Sleep -Seconds 1 }",
		"}",
		"Start-Process -FilePath $dst",
		"Remove-Item -LiteralPath $PSCommandPath -Force",
		"",
	}, "\r\n")
	scriptPath := filepath.Join(os.TempDir(), fmt.Sprintf("ostatki_update_%d.ps1", pid))
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		return err
	}
	cmd := exec.Command("powershell", "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", scriptPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200} // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
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
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200}
	return cmd.Start()
}
