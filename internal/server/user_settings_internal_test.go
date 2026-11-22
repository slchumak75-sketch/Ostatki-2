package server

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

// Батч-72: путь из окна выбора папки декодируется без порчи кириллицы,
// а требование пароля приложения объясняется человеческим текстом.
func TestPickedFolderDecodeAndFriendlyMailError(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte(`C:\Users\test\OneDrive\Рабочий стол\Эталоны`))
	got, err := decodePickedFolderPath(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if got != `C:\Users\test\OneDrive\Рабочий стол\Эталоны` {
		t.Fatalf("decoded = %q", got)
	}
	if empty, err := decodePickedFolderPath(""); err != nil || empty != "" {
		t.Fatalf("empty decode = %q, %v", empty, err)
	}
	friendly := friendlySMTPError(errors.New("535 5.7.0 NEOBHODIM parol prilozheniya"))
	if friendly == nil || !strings.Contains(friendly.Error(), "ПАРОЛЬ ПРИЛОЖЕНИЯ") {
		t.Fatalf("friendly = %v", friendly)
	}
	other := friendlySMTPError(errors.New("535 5.7.8 authentication failed"))
	if other == nil || !strings.Contains(other.Error(), "ПАРОЛЬ ПРИЛОЖЕНИЯ") {
		t.Fatalf("535 must also map to the hint: %v", other)
	}
}
