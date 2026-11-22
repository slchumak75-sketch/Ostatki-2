package server

import (
	"bytes"
	"mime"
	"mime/multipart"
	"net/mail"
	"strings"
	"testing"
	"time"
)

// Батч-73: русское имя вложения в письме кодируется по RFC 5987 и
// читается обратно целиком, с расширением .xlsx.
func TestOrderMailAttachmentFileNameRoundTrip(t *testing.T) {
	name := "Мирстроймаркет, ИТУП «Элсви», 22.11.2026.xlsx"
	raw, err := buildOrderMailMessage("u@mail.ru", "zakaz@sup.ru", "Заказ", "текст письма", name, []byte("xlsx-bytes"))
	if err != nil {
		t.Fatal(err)
	}
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	mediaType, params, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if err != nil || !strings.HasPrefix(mediaType, "multipart/") {
		t.Fatalf("content type: %q %v", mediaType, err)
	}
	reader := multipart.NewReader(msg.Body, params["boundary"])
	var fileName string
	for {
		part, err := reader.NextPart()
		if err != nil {
			break
		}
		if part.FileName() != "" {
			fileName = part.FileName()
		}
	}
	if fileName != name {
		t.Fatalf("attachment name = %q, want %q", fileName, name)
	}
}

// Батч-74: в теме и тексте письма склад — организация, как в имени файла.
func TestOrderMailSubjectBodyUseOrganizationName(t *testing.T) {
	now := time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)
	subject := orderMailSubject("ИТУП «Элсви»", "Склад Мир", now)
	if subject != "Заказ: ИТУП «Элсви» — Мирстроймаркет, 22.11.2026" {
		t.Fatalf("subject = %q", subject)
	}
	body := orderMailBody("ИТУП «Элсви»", "Склад Мир", "Мирстроймаркет, ИТУП «Элсви», 22.11.2026.xlsx")
	if !strings.Contains(body, "Склад: Мирстроймаркет.") || strings.Contains(body, "Склад Мир") {
		t.Fatalf("body = %q", body)
	}
}
