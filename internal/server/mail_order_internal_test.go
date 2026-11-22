package server

import (
	"bytes"
	"mime"
	"mime/multipart"
	"net/mail"
	"strings"
	"testing"
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
