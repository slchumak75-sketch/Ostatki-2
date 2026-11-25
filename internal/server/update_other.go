//go:build !windows

package server

import "fmt"

// Батч-83: самообновление по файлу есть только в настольной Windows-сборке.
func stageSelfUpdate(srcPath, exePath string, pid int) error {
	return fmt.Errorf("обновление по файлу доступно в настольной программе Windows")
}

func launchUpdateInstaller(path string) error {
	return fmt.Errorf("обновление по файлу доступно в настольной программе Windows")
}
