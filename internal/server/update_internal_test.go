package server

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Батч-83: файл обновления обязан быть настоящим EXE программы «Остатки»
// разумного размера; установщик распознаётся по имени …_Setup.exe.
func TestValidateUpdateFile(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, head []byte, size int) string {
		p := filepath.Join(dir, name)
		data := append(append([]byte{}, head...), bytes.Repeat([]byte{0}, size)...)
		if err := os.WriteFile(p, data, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	big := minUpdateFileSize + 1024

	isSetup, err := validateUpdateFile(write("OstatkiZakupki_Variant_7.27.exe", []byte("MZ"), big))
	if err != nil || isSetup {
		t.Fatalf("обычный EXE: isSetup=%v err=%v", isSetup, err)
	}
	isSetup, err = validateUpdateFile(write("OstatkiZakupki_Variant_7.27_Setup.exe", []byte("MZ"), big))
	if err != nil || !isSetup {
		t.Fatalf("установщик: isSetup=%v err=%v", isSetup, err)
	}
	if _, err := validateUpdateFile(write("calculator.exe", []byte("MZ"), big)); err == nil {
		t.Fatal("чужой EXE должен отклоняться")
	}
	if _, err := validateUpdateFile(write("OstatkiZakupki_Variant_7.27.exe.tmp", []byte("MZ"), big)); err == nil {
		t.Fatal("файл без расширения .exe должен отклоняться")
	}
	if _, err := validateUpdateFile(write("OstatkiZakupki_small.exe", []byte("MZ"), 100)); err == nil {
		t.Fatal("слишком маленький файл должен отклоняться")
	}
	if _, err := validateUpdateFile(write("OstatkiZakupki_fake.exe", []byte("PK"), big)); err == nil {
		t.Fatal("файл без MZ-заголовка должен отклоняться")
	}
	if _, err := validateUpdateFile(filepath.Join(dir, "nope.exe")); err == nil {
		t.Fatal("несуществующий файл должен отклоняться")
	}
	if _, err := validateUpdateFile(""); err == nil {
		t.Fatal("пустой путь должен отклоняться")
	}
}

// Батч-83: комментарий отправителя попадает в текст письма; без комментария
// текст письма прежний.
func TestOrderMailBodyWithComment(t *testing.T) {
	plain := orderMailBody("Поставщик", "Склад Мир", "Файл.xlsx")
	withComment := orderMailBodyWithComment("Поставщик", "Склад Мир", "Файл.xlsx", "  Прошу подтвердить сроки  ")
	if !strings.Contains(withComment, "Комментарий: Прошу подтвердить сроки") {
		t.Fatalf("комментарий не попал в письмо: %q", withComment)
	}
	if strings.Contains(plain, "Комментарий:") {
		t.Fatalf("без комментария подпись не нужна: %q", plain)
	}
	if orderMailBodyWithComment("Поставщик", "Склад Мир", "Файл.xlsx", "   ") != plain {
		t.Fatalf("пустой комментарий не должен менять письмо")
	}
}

// Батч-84: адресаты копий заказа — только корректные адреса, без дублей
// и без основного получателя.
func TestOrderMailCopyRecipients(t *testing.T) {
	cfg := mailSettings{Copy1: " Boss@firma.ru ", Copy2: "boss@firma.ru"}
	if got := orderMailCopyRecipients(cfg, "zakaz@sup.ru"); len(got) != 1 || got[0] != "Boss@firma.ru" {
		t.Fatalf("dedupe failed: %v", got)
	}
	cfg = mailSettings{Copy1: "zakaz@sup.ru", Copy2: "не-почта"}
	if got := orderMailCopyRecipients(cfg, "zakaz@sup.ru"); len(got) != 0 {
		t.Fatalf("main recipient and invalid must be skipped: %v", got)
	}
	cfg = mailSettings{Copy1: "a@firma.ru", Copy2: "b@firma.ru"}
	if got := orderMailCopyRecipients(cfg, "zakaz@sup.ru"); len(got) != 2 {
		t.Fatalf("both copies expected: %v", got)
	}
}
