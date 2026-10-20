//go:build !windows && !darwin && !linux

package main

import "fmt"

func openBrowser(url string) error {
	return fmt.Errorf("автозапуск браузера не поддерживается на этой платформе")
}
