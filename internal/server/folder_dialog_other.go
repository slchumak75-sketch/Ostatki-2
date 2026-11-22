//go:build !windows

package server

import "fmt"

// Батч-71: окно выбора папки есть только в настольной Windows-сборке.
func pickFolderDialog(title string) (string, error) {
	return "", fmt.Errorf("выбор папки окном доступен в настольной программе Windows")
}
