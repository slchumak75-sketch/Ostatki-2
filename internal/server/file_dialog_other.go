//go:build !windows

package server

import "fmt"

// Батч-83: окно выбора файла есть только в настольной Windows-сборке.
func pickFileDialog(title string) (string, error) {
	return "", fmt.Errorf("выбор файла окном доступен в настольной программе Windows")
}
