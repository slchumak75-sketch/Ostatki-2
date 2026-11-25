//go:build windows

package server

import (
	"os/exec"
	"strings"
)

// Батч-83: настоящее окно выбора файла Windows (OpenFileDialog через
// PowerShell STA) для кнопки «Обновление». Как и у выбора папки (батч-71/72),
// путь возвращается в base64(UTF-8), чтобы русские имена не искажались.
func pickFileDialog(title string) (string, error) {
	safeTitle := strings.ReplaceAll(title, "'", " ")
	script := "Add-Type -AssemblyName System.Windows.Forms; " +
		"$d = New-Object System.Windows.Forms.OpenFileDialog; " +
		"$d.Title = '" + safeTitle + "'; " +
		"$d.Filter = 'Файл обновления (*.exe)|*.exe|Все файлы (*.*)|*.*'; " +
		"$d.CheckFileExists = $true; " +
		"if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($d.FileName))) }"
	cmd := exec.Command("powershell", "-NoProfile", "-STA", "-Command", script)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
