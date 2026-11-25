package server

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/smtp"
	"net/textproto"
	"sort"
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
	// Б73: имя файла — строго по RFC 5987 (mime.FormatMediaType), иначе
	// почтовые программы обрезали русское имя («Мирстройма») и теряли .xlsx.
	if err != nil {
		return nil, err
	}
	if _, err := textPart.Write([]byte(bodyText)); err != nil {
		return nil, err
	}
	filePart, err := mw.CreatePart(textproto.MIMEHeader{
		"Content-Type":              {mime.FormatMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", map[string]string{"name": fileName})},
		"Content-Disposition":       {mime.FormatMediaType("attachment", map[string]string{"filename": fileName})},
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

// orderMailSubject/orderMailBody (батч-74): склад в письме — организация.
func orderMailSubject(supplier, warehouse string, now time.Time) string {
	return fmt.Sprintf("Заказ: %s — %s, %s", supplier, xlsx.DisplayWarehouseName(warehouse), now.Format("02.01.2006"))
}

func orderMailBody(supplier, warehouse, fileName string) string {
	return orderMailBodyWithComment(supplier, warehouse, fileName, "")
}

// Б83: необязательный комментарий отправителя — в начале письма, после приветствия.
func orderMailBodyWithComment(supplier, warehouse, fileName, comment string) string {
	comment = strings.TrimSpace(comment)
	if r := []rune(comment); len(r) > 2000 {
		comment = string(r[:2000])
	}
	body := fmt.Sprintf("Здравствуйте!\n\nВо вложении заказ: %s.\nСклад: %s.\nФайл: %s\n\nСформировано программой «Заказ» автоматически.", supplier, xlsx.DisplayWarehouseName(warehouse), fileName)
	if comment == "" {
		return body
	}
	return fmt.Sprintf("Здравствуйте!\n\nКомментарий: %s\n\nВо вложении заказ: %s.\nСклад: %s.\nФайл: %s\n\nСформировано программой «Заказ» автоматически.", comment, supplier, xlsx.DisplayWarehouseName(warehouse), fileName)
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
			return friendlySMTPError(err)
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

// Б78: пометка «Отправлено» на кнопке «Почта». После успешной отправки
// запоминаем контрольный отпечаток заказа (состав, количества, цены,
// расширенный формат). Пока текущий заказ совпадает с отпечатком,
// кнопка показывает галочку; любое изменение заказа снимает пометку.
type orderMailSentMark struct {
	Hash     string `json:"hash"`
	Extended bool   `json:"extended"`
	SentAt   string `json:"sentAt"`
	To       string `json:"to"`
}

func orderMailFingerprint(rep *model.CalculationReport, supplier, warehouse string, extended bool) string {
	if rep == nil {
		return ""
	}
	rows := make([]string, 0, len(rep.Items))
	for _, it := range rep.Items {
		if !strings.EqualFold(strings.TrimSpace(it.Supplier), supplier) || !strings.EqualFold(strings.TrimSpace(it.Warehouse), warehouse) {
			continue
		}
		if it.FinalOrderQty <= 0 {
			continue
		}
		rows = append(rows, fmt.Sprintf("%d:%d:%.2f", it.ExcelRow, it.FinalOrderQty, it.PurchasePrice))
	}
	sort.Strings(rows)
	sum := sha256.Sum256([]byte(strings.Join(rows, ";") + "|" + strconv.FormatBool(extended)))
	return hex.EncodeToString(sum[:])
}

func (s *AppServer) rememberOrderMailSent(supplier, warehouse string, extended bool, to string, rep *model.CalculationReport) {
	hash := orderMailFingerprint(rep, strings.TrimSpace(supplier), strings.TrimSpace(warehouse), extended)
	if hash == "" {
		return
	}
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	s.loadUserSettingsLocked()
	if s.settings.OrderMailSent == nil {
		s.settings.OrderMailSent = map[string]orderMailSentMark{}
	}
	s.settings.OrderMailSent[supplierEmailKey(supplier, warehouse)] = orderMailSentMark{
		Hash: hash, Extended: extended,
		SentAt: time.Now().Format("02.01.2006 15:04"), To: strings.TrimSpace(to),
	}
	s.persistUserSettingsLocked()
}

// handleOrderSentMarks отдаёт пометки, чей отпечаток совпадает с текущим
// заказом: изменился заказ — пометка в список не попадает (снялась).
func (s *AppServer) handleOrderSentMarks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, 405, "требуется GET")
		return
	}
	s.settingsMu.Lock()
	s.loadUserSettingsLocked()
	marks := make(map[string]orderMailSentMark, len(s.settings.OrderMailSent))
	for k, v := range s.settings.OrderMailSent {
		marks[k] = v
	}
	s.settingsMu.Unlock()

	s.mu.RLock()
	rep := s.report
	s.mu.RUnlock()

	type sentMark struct {
		Key       string `json:"key"`
		Supplier  string `json:"supplier"`
		Warehouse string `json:"warehouse"`
		SentAt    string `json:"sentAt"`
		To        string `json:"to"`
	}
	sent := []sentMark{}
	if rep != nil {
		for key, m := range marks {
			idx := strings.LastIndex(key, "|")
			if idx < 0 {
				continue
			}
			supplier, warehouse := key[:idx], key[idx+1:]
			if orderMailFingerprint(rep, supplier, warehouse, m.Extended) == m.Hash {
				sent = append(sent, sentMark{Key: key, Supplier: supplier, Warehouse: warehouse, SentAt: m.SentAt, To: m.To})
			}
		}
	}
	sort.Slice(sent, func(i, j int) bool { return sent[i].Key < sent[j].Key })
	writeJSON(w, 200, map[string]any{"sent": sent})
}

// orderMailCopyRecipients (батч-84): адреса копий заказа из настроек почты —
// корректные, без дублей и без основного получателя (ему копия не нужна).
// orderMailCopySubject (батч-89): тема письма-копии начинается со слова
// «Копия», а не «Заказ»: «Копия: ЧУП "МАВ" — Мирсититорг, 25.11.2026».
func orderMailCopySubject(subject string) string {
	if strings.HasPrefix(subject, "Заказ:") {
		return "Копия:" + strings.TrimPrefix(subject, "Заказ:")
	}
	return "Копия: " + subject
}

func orderMailCopyRecipients(cfg mailSettings, mainTo string) []string {
	out := []string{}
	seen := map[string]bool{strings.ToLower(strings.TrimSpace(mainTo)): true}
	for _, raw := range []string{cfg.Copy1, cfg.Copy2} {
		addr := strings.TrimSpace(raw)
		if addr == "" || !strings.Contains(addr, "@") || strings.ContainsAny(addr, " \t\r\n") {
			continue
		}
		if seen[strings.ToLower(addr)] {
			continue
		}
		seen[strings.ToLower(addr)] = true
		out = append(out, addr)
	}
	return out
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
		Comment  string `json:"comment"`
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
	// Б74: в теме и тексте письма склад называем организацией, как в имени
	// файла и в самом файле («Мирстроймаркет», а не «Склад Мир»).
	subject := orderMailSubject(filterSupplier, filterWarehouse, time.Now())
	bodyText := orderMailBodyWithComment(filterSupplier, filterWarehouse, fileName, req.Comment)
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
	// Б84: копии заказа на адреса из настроек почты — всегда расширенный
	// формат (7 столбцов) с итоговой строкой. Ошибка копии не отменяет
	// уже отправленный основной заказ, а честно сообщается в ответе.
	copiesSent := []string{}
	copiesFailed := []string{}
	if copyAddrs := orderMailCopyRecipients(cfg, to); len(copyAddrs) > 0 {
		copyBytes, cerr := xlsx.GenerateSingleSupplierOrderXLSXCopy(rep, filterWarehouse, filterSupplier)
		if cerr != nil {
			copiesFailed = copyAddrs
		} else {
			copyBody := "Это копия заказа, отправленного поставщику на адрес " + to + ".\n\n" + bodyText
			for _, copyTo := range copyAddrs {
				copyMsg, berr := buildOrderMailMessage(from, copyTo, orderMailCopySubject(subject), copyBody, fileName, copyBytes)
				if berr != nil || sendMailSMTP(cfg, from, copyTo, copyMsg) != nil {
					copiesFailed = append(copiesFailed, copyTo)
				} else {
					copiesSent = append(copiesSent, copyTo)
				}
			}
		}
	}
	// Б78: пометка «Отправлено» с отпечатком именно этого заказа.
	s.rememberOrderMailSent(filterSupplier, filterWarehouse, req.Extended, to, rep)
	writeJSON(w, 200, map[string]any{"sent": true, "to": to, "fileName": fileName, "copiesSent": copiesSent, "copiesFailed": copiesFailed})
}

// Батч-72: технические ответы почтовых серверов переводим на человеческий.
func friendlySMTPError(err error) error {
	text := err.Error()
	lower := strings.ToLower(text)
	if strings.Contains(text, "535") || strings.Contains(lower, "application password") || strings.Contains(lower, "parol prilozheniya") || strings.Contains(lower, "app password") {
		return fmt.Errorf("почтовый сервер требует ПАРОЛЬ ПРИЛОЖЕНИЯ, а не обычный пароль от ящика. Создайте его в настройках вашей почты (для Mail.ru: Настройки → Безопасность → Пароли для внешних приложений; подробнее: https://help.mail.ru/mail/security/protection/external), вставьте в поле «Пароль почты» выше и сохраните настройки. Ответ сервера: %s", text)
	}
	return fmt.Errorf("почтовый сервер отклонил логин/пароль: %w", err)
}
