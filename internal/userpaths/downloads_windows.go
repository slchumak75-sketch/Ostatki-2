//go:build windows

package userpaths

import (
	"fmt"
	"syscall"
	"unsafe"
)

// FOLDERID_Downloads follows redirected/localized Windows Downloads locations.
func DownloadsDir() (string, error) {
	folder := syscall.GUID{Data1: 0x374de290, Data2: 0x123f, Data3: 0x4565, Data4: [8]byte{0x91, 0x64, 0x39, 0xc4, 0x92, 0x5e, 0x46, 0x7b}}
	var ptr *uint16
	proc := syscall.NewLazyDLL("shell32.dll").NewProc("SHGetKnownFolderPath")
	hr, _, _ := proc.Call(uintptr(unsafe.Pointer(&folder)), 0, 0, uintptr(unsafe.Pointer(&ptr)))
	if hr != 0 || ptr == nil {
		return "", fmt.Errorf("не удалось определить папку Загрузки Windows (HRESULT 0x%x)", hr)
	}
	defer syscall.NewLazyDLL("ole32.dll").NewProc("CoTaskMemFree").Call(uintptr(unsafe.Pointer(ptr)))
	n := 0
	for n < 32768 && *(*uint16)(unsafe.Add(unsafe.Pointer(ptr), uintptr(n)*2)) != 0 {
		n++
	}
	if n == 0 || n == 32768 {
		return "", fmt.Errorf("неверный путь папки Загрузки Windows")
	}
	return syscall.UTF16ToString(unsafe.Slice(ptr, n)), nil
}
