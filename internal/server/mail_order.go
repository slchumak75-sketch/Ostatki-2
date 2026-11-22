package server

import (
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

// Батч-70: отправка заказа поставщику по почте (SMTP) с вложением XLSX.
// Настройки почты задаёт пользователь («Настройка почты»); адрес
// получателя запоминается по поставщику+складу, в следующий раз
// подставляется тот, на который отправляли в последний раз.

func buildOrderMailMessage(from, to, subject, bodyText, fileName string, attachment []byte) ([]byte, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	textPart, err := mw.CreatePart(textproto.MIMEHeader{
		"Content-Type": {"text/plain; charset=utf-8"},
	})
	if err != nil {
		return nil, err
	}
	if _, err := textPart.Write([]byte(bodyText)); err != nil {
		return nil, err
	}
	filePart, err := mw.CreatePart(textproto.MIMEHeader{
		"Content-Type":              {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
		"Content-Disposition":       {fmt.Sprintf("attachment; filename*=UTF-8''%s", mime.QEncoding.Encode("utf-8", fileName))},
		"Content-Transfer-Encoding": {"base64"},
	})
	if err != nil {
		return nil, err
	}
	encoded := base64.StdEncoding.EncodeToString(attachment)
	for len(encoded) > 76 {
		if _, err := filePart.Write([]byte(encoded[:76] + "\r\n")); err != nil {
			return nil, err
		}
		encoded = encoded[76:]
	}
	if _, err := filePart.Write([]byte(encoded)); err != nil {
		return nil, err
	}
	if err := mw.Close(); err != nil {
		return nil, err
	}
	var msg bytes.Buffer
	msg.WriteString("From: " + from + "\r\n")
	msg.WriteString("To: " + to + "\r\n")
	msg.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", subject) + "\r\n")
	msg.WriteString("MIME-Version: 1.0\r\n")
	msg.WriteString("Content-Type: multipart/mixed; boundary=" + mw.Boundary() + "\r\n\r\n")
	msg.Write(buf.Bytes())
	return msg.Bytes(), nil
}

func sendMailSMTP(cfg mailSettings, from, to string, msg []byte) error {
	host := strings.TrimSpace(cfg.Host)
	if host == "" || cfg.Port <= 0 {
		return fmt.Errorf("почта не настроена: укажите сервер и порт в «Настройка почты»")
	}
	addr := net.JoinHostPort(host, strconv.Itoa(cfg.Port))
	dialer := &net.Dialer{Timeout: 20 * time.Second}
	var client *smtp.Client
	if cfg.UseTLS {
		conn, err := tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
		if err != nil {
			return fmt.Errorf("не удалось подключиться к почтовому серверу: %w", err)
		}
		client, err = smtp.NewClient(conn, host)
		if err != nil {
			return fmt.Errorf("почтовый сервер отклонил соединение: %w", err)
		}
	} else {
		conn, err := dialer.Dial("tcp", addr)
		if err != nil {
			return fmt.Errorf("не удалось подключиться к почтовому серверу: %w", err)
		}
		client, err = smtp.NewClient(conn, host)
		if err != nil {
			return fmt.Errorf("почтовый сервер отклонил соединение: %w", err)
		}
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}); err != nil {
				_ = client.Close()
				return fmt.Errorf("не удалось включить шифрование STARTTLS: %w", err)
			}
		}
	}
	defer client.Close()
	if strings.TrimSpace(cfg.Username) != "" {
		if err := client.Auth(smtp.PlainAuth("", cfg.Username, cfg.Password, host)); err != nil {
			return fmt.Errorf("почтовый сервер отклонил логин/пароль: %w", err)
		}
	}
	if err := client.Mail(from); err != nil {
		return fmt.Errorf("почтовый сервер отклонил отправителя: %w", err)
	}
	if err := client.Rcpt(to); err != nil {
		return fmt.Errorf("почтовый сервер отклонил получателя: %w", err)
	}
	wc, err := client.Data()
	if err != nil {
		return fmt.Errorf("почтовый сервер отклонил письмо: %w", err)
	}
	if _, err := wc.Write(msg); err != nil {
		return fmt.Errorf("не удалось передать письмо: %w", err)
	}
	if err := wc.Close(); err != nil {
		return fmt.Errorf("почтовый сервер отклонил письмо: %w", err)
	}
	return client.Quit()
}

func (s *AppServer) handleSendSupplierOrderMail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, 405, "требуется POST")
		return
	}
	s.touchHeartbeat()
	var req struct {
		Supplier string `json:"supplier"`
		Warehouse string `json:"warehouse"`
		Extended bool   `json:"extended"`
		To       string `json:"to"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeError(w, 400, "некорректный запрос отправки")
		return
	}
	to := strings.TrimSpace(req.To)
	if !strings.Contains(to, "@") || strings.ContainsAny(to, " \t\r\n") {
		writeError(w, 400, "Укажите корректный адрес электронной почты получателя")
		return
	}
	filterWarehouse := strings.TrimSpace(req.Warehouse)
	filterSupplier := strings.TrimSpace(req.Supplier)

	s.mu.RLock()
	selActive := s.supplierSelectionActive
	supAllowed := true
	if selActive && filterSupplier != "" {
		supAllowed = s.selectedSuppliers[filterSupplier]
	}
	rep := s.reportForExportLocked()
	s.mu.RUnlock()
	if rep == nil {
		writeError(w, 400, "нет данных расчёта")
		return
	}
	if !supAllowed {
		writeError(w, 400, "поставщик не отмечен галочкой для формирования заказа")
		return
	}
	// Заказ по почте всегда относится к конкретной паре поставщик+склад.
	scoped := *rep
	scoped.Items = make([]model.CalculatedItem, 0)
	for _, it := range rep.Items {
		if it.Warehouse == filterWarehouse {
			scoped.Items = append(scoped.Items, it)
		}
	}
	rep = &scoped
	outBytes, err := xlsx.GenerateSingleSupplierOrderXLSXEx(rep, filterWarehouse, filterSupplier, req.Extended)
	if err != nil {
		writeError(w, 500, "ошибка генерации заказа поставщику: "+err.Error())
		return
	}
	fileName := xlsx.FormatSupplierOrderFilename(filterWarehouse, filterSupplier, time.Now())

	s.settingsMu.Lock()
	s.loadUserSettingsLocked()
	cfg := s.settings.Mail
	s.settingsMu.Unlock()
	from := strings.TrimSpace(cfg.From)
	if from == "" {
		from = strings.TrimSpace(cfg.Username)
	}
	if strings.TrimSpace(cfg.Host) == "" {
		writeError(w, 400, "Почта не настроена: откройте «Настройка почты» рядом с «Конфигурация» и укажите параметры вашей почты")
		return
	}
	subject := fmt.Sprintf("Заказ: %s — %s, %s", filterSupplier, filterWarehouse, time.Now().Format("02.01.2006"))
	bodyText := fmt.Sprintf("Здравствуйте!\n\nВо вложении заказ: %s.\nСклад: %s.\nФайл: %s\n\nСформировано программой «Заказ» автоматически.", filterSupplier, filterWarehouse, fileName)
	msg, err := buildOrderMailMessage(from, to, subject, bodyText, fileName, outBytes)
	if err != nil {
		writeError(w, 500, "не удалось собрать письмо: "+err.Error())
		return
	}
	if err := sendMailSMTP(cfg, from, to, msg); err != nil {
		writeError(w, 502, err.Error())
		return
	}
	key := supplierEmailKey(filterSupplier, filterWarehouse)
	s.settingsMu.Lock()
	s.loadUserSettingsLocked()
	if s.settings.SupplierEmails == nil {
		s.settings.SupplierEmails = map[string][]string{}
	}
	if s.settings.LastSupplierEmail == nil {
		s.settings.LastSupplierEmail = map[string]string{}
	}
	found := false
	for _, existing := range s.settings.SupplierEmails[key] {
		if strings.EqualFold(existing, to) {
			found = true
		}
	}
	if !found {
		s.settings.SupplierEmails[key] = append(s.settings.SupplierEmails[key], to)
	}
	s.settings.LastSupplierEmail[key] = to
	s.persistUserSettingsLocked()
	s.settingsMu.Unlock()
	writeJSON(w, 200, map[string]any{"sent": true, "to": to, "fileName": fileName})
}
