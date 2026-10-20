//go:build !windows

package desktop

import (
	"os/exec"
	"runtime"
)

// OpenAppWindow открывает URL приложения в системном браузере на Linux / macOS.
func OpenAppWindow(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}
