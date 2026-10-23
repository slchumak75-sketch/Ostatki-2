//go:build windows

package desktop

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

const (
	smCxScreen      = 0
	smCyScreen      = 1
	swShowMaximized = 3
)

var (
	user32DLL         = syscall.NewLazyDLL("user32.dll")
	procGetSysMetrics = user32DLL.NewProc("GetSystemMetrics")

	shell32DLL       = syscall.NewLazyDLL("shell32.dll")
	procShellExecute = shell32DLL.NewProc("ShellExecuteW")
)

func primaryScreenSize() (int, int) {
	w, _, _ := procGetSysMetrics.Call(smCxScreen)
	h, _, _ := procGetSysMetrics.Call(smCyScreen)
	width, height := int(w), int(h)
	if width < 800 {
		width = 1920
	}
	if height < 600 {
		height = 1080
	}
	return width, height
}

func prepareWindowedMaxProfile(profileDir string, screenW, screenH int) {
	defaultDir := filepath.Join(profileDir, "Default")
	_ = os.MkdirAll(defaultDir, 0o755)

	prefsPath := filepath.Join(defaultDir, "Preferences")
	prefs := map[string]any{
		"browser": map[string]any{
			"has_seen_welcome_page": true,
			"window_placement": map[string]any{
				"left":       0,
				"top":        0,
				"right":      screenW,
				"bottom":     screenH,
				"maximized":  true,
				"fullscreen": false,
			},
		},
	}
	if raw, err := os.ReadFile(prefsPath); err == nil {
		var existing map[string]any
		if json.Unmarshal(raw, &existing) == nil && existing != nil {
			bMap, _ := existing["browser"].(map[string]any)
			if bMap == nil {
				bMap = map[string]any{}
			}
			bMap["window_placement"] = map[string]any{
				"left":       0,
				"top":        0,
				"right":      screenW,
				"bottom":     screenH,
				"maximized":  true,
				"fullscreen": false,
			}
			existing["browser"] = bMap
			prefs = existing
		}
	}
	if data, err := json.Marshal(prefs); err == nil {
		_ = os.WriteFile(prefsPath, data, 0o644)
	}
}

// OpenAppWindow открывает HTML GUI на Windows в развёрнутом на весь экран окне приложения
// (Edge / Chrome App Mode с --start-maximized без полноэкранной всплывающей сверху панели «Свернуть / Закрыть»).
func OpenAppWindow(url string) error {
	screenW, screenH := primaryScreenSize()
	candidates := findChromiumAppBinaries()
	profileDir := filepath.Join(os.TempDir(), "Ostatki2GUIProfileV4Max")
	prepareWindowedMaxProfile(profileDir, screenW, screenH)

	for _, bin := range candidates {
		cmd := exec.Command(
			bin,
			"--app="+url,
			"--start-maximized",
			"--window-position=0,0",
			fmt.Sprintf("--window-size=%d,%d", screenW, screenH),
			"--user-data-dir="+profileDir,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-features=TranslateUI",
		)
		if err := cmd.Start(); err == nil {
			return nil
		}
	}

	// Штатный системный вызов Win32 ShellExecuteW с разворотом окна на весь экран (SW_SHOWMAXIMIZED)
	verbPtr, err := syscall.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	urlPtr, err := syscall.UTF16PtrFromString(url)
	if err != nil {
		return err
	}
	ret, _, callErr := procShellExecute.Call(
		0,
		uintptr(unsafe.Pointer(verbPtr)),
		uintptr(unsafe.Pointer(urlPtr)),
		0,
		0,
		uintptr(swShowMaximized),
	)
	if ret <= 32 {
		return fmt.Errorf("ShellExecuteW error code %d: %w", ret, callErr)
	}
	return nil
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
