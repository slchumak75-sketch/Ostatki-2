//go:build windows

package desktop

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// OpenAppWindow открывает HTML GUI на Windows в режиме отдельного нативного окна приложения
// (Edge / Chrome App Mode без адресной строки и вкладок, с fallback на системный браузер).
func OpenAppWindow(url string) error {
	candidates := findChromiumAppBinaries()
	profileDir := filepath.Join(os.TempDir(), "Ostatki2GUIProfile")
	_ = os.MkdirAll(profileDir, 0o755)

	for _, bin := range candidates {
		cmd := exec.Command(
			bin,
			"--app="+url,
			"--window-size=1460,920",
			"--user-data-dir="+profileDir,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-features=TranslateUI",
		)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := cmd.Start(); err == nil {
			return nil
		}
	}

	// Fallback на стандартный системный обработчик URL в Windows
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Start()
}

func findChromiumAppBinaries() []string {
	var paths []string
	envRoots := []string{
		os.Getenv("ProgramFiles(x86)"),
		os.Getenv("ProgramFiles"),
		os.Getenv("LOCALAPPDATA"),
	}
	relTargets := []string{
		filepath.Join("Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join("Google", "Chrome", "Application", "chrome.exe"),
	}
	for _, root := range envRoots {
		if root == "" {
			continue
		}
		for _, rel := range relTargets {
			full := filepath.Join(root, rel)
			if info, err := os.Stat(full); err == nil && !info.IsDir() {
				paths = append(paths, full)
			}
		}
	}
	return paths
}
