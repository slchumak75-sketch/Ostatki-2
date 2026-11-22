//go:build windows

package server

import (
	"os/exec"
	"strings"
)

// Батч-71: настоящее окно выбора папки Windows (FolderBrowserDialog
// через PowerShell STA) — путь сохранения не нужно вводить руками.
func pickFolderDialog(title string) (string, error) {
	safeTitle := strings.ReplaceAll(title, "'", " ")
	script := "Add-Type -AssemblyName System.Windows.Forms; " +
		"$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
		"$d.Description = '" + safeTitle + "'; " +
		"$d.ShowNewFolderButton = $true; " +
		"if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }"
	cmd := exec.Command("powershell", "-NoProfile", "-STA", "-Command", script)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
