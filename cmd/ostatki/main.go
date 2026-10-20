// Ostatki — анализ остатков ТМЦ и расчёт «К закупке» с учётом сезонности.
//
// Режимы:
//   - GUI (по умолчанию): локальный веб-сервер 127.0.0.1 + открытие браузера;
//   - CLI (-cli -in file.xlsx -out result.xlsx): пакетный расчёт без браузера.
//
// Документация: README.md, docs/ALGORITHM.md, docs/ARCHITECTURE.md.
package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"time"

	"ostatki/internal/app"
	"ostatki/internal/forecast"
	"ostatki/internal/model"
	"ostatki/internal/xlsxio"
)

// version подставляется GitHub Actions: -ldflags "-X main.version=...".
var version = "dev"

func main() {
	var (
		port       = flag.Int("port", 8765, "порт локального веб-сервера (0 — любой свободный)")
		noBrowser  = flag.Bool("no-browser", false, "не открывать браузер автоматически")
		file       = flag.String("file", "", "файл ведомости .xlsx, загрузить при старте")
		cli        = flag.Bool("cli", false, "консольный режим: посчитать и записать -out, без GUI")
		inPath     = flag.String("in", "", "входной xlsx (режим -cli)")
		outPath    = flag.String("out", "", "выходной xlsx (режим -cli)")
		horizon    = flag.Int("horizon", 3, "горизонт закупки, полных месяцев")
		safety     = flag.Float64("safety", 20, "страховой запас, % от прогноза")
		lead       = flag.Float64("lead", 14, "срок поставки, дней")
		dead       = flag.Int("dead", 12, "нет продаж N мес. -> не закупать")
		partial    = flag.Bool("partial-last", true, "последний месячный столбец — неполный месяц")
		trend      = flag.Bool("trend", true, "учитывать тренд для крупных SKU")
		showVer    = flag.Bool("version", false, "показать версию и выйти")
	)
	flag.Parse()

	if *showVer {
		fmt.Println("ostatki " + version)
		return
	}
	params := model.DefaultParams()
	params.Horizon = *horizon
	params.SafetyPercent = *safety
	params.LeadDays = *lead
	params.DeadMonths = *dead
	params.PartialLast = *partial
	params.UseTrend = *trend

	if *cli {
		if err := runCLI(*inPath, *outPath, params); err != nil {
			fmt.Fprintln(os.Stderr, "Ошибка:", err)
			os.Exit(1)
		}
		return
	}
	if err := runServer(*port, *noBrowser, *file, params); err != nil {
		fmt.Fprintln(os.Stderr, "Ошибка:", err)
		os.Exit(1)
	}
}

func runCLI(inPath, outPath string, p model.Params) error {
	if inPath == "" || outPath == "" {
		return fmt.Errorf("для режима -cli нужны -in и -out")
	}
	data, err := os.ReadFile(inPath)
	if err != nil {
		return err
	}
	parsed, err := xlsxio.Parse(data)
	if err != nil {
		return err
	}
	st := forecast.Compute(parsed.Items, parsed.Months, p)
	st.FileName = inPath
	st.Version = version
	st.LoadedAt = time.Now().Format("2006-01-02 15:04:05")
	out, err := xlsxio.Write(st)
	if err != nil {
		return err
	}
	if err := os.WriteFile(outPath, out, 0o644); err != nil {
		return err
	}
	s := st.Summary
	fmt.Printf("Товаров: %d | К закупке: %d SKU, %.0f ед., бюджет %.2f | Файл записан: %s\n",
		s.SKU, s.OrderSKU, s.OrderUnits, s.OrderBudget, outPath)
	for _, w := range st.Warnings {
		fmt.Println("ВНИМАНИЕ:", w)
	}
	return nil
}

func listenWithFallback(port int) (net.Listener, int, error) {
	if port == 0 {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, 0, err
		}
		return ln, ln.Addr().(*net.TCPAddr).Port, nil
	}
	var lastErr error
	for i := 0; i < 20; i++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port+i))
		if err == nil {
			return ln, port + i, nil
		}
		lastErr = err
	}
	return nil, 0, lastErr
}

func runServer(port int, noBrowser bool, file string, p model.Params) error {
	srv := app.NewServer(version)
	httpSrv := &http.Server{Handler: srv.Handler()}
	srv.OnShutdown = func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(ctx)
	}
	if file != "" {
		data, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		if _, err := srv.LoadData(file, data, p); err != nil {
			return fmt.Errorf("файл %s: %w", file, err)
		}
		fmt.Println("Загружена ведомость:", file)
	}
	ln, actualPort, err := listenWithFallback(port)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d/", actualPort)
	fmt.Println("==================================================")
	fmt.Println(" Ostatki " + version + " — остатки и закупка")
	fmt.Println(" Интерфейс: " + url)
	fmt.Println(" Не закрывайте это окно, пока работаете.")
	fmt.Println(" Остановка: кнопка «Выход» в интерфейсе или Ctrl+C")
	fmt.Println("==================================================")
	if !noBrowser {
		go func() {
			time.Sleep(400 * time.Millisecond)
			if err := openBrowser(url); err != nil {
				fmt.Println("Не удалось открыть браузер автоматически. Откройте вручную:", url)
			}
		}()
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(sctx)
	}()
	err = httpSrv.Serve(ln)
	if err == http.ErrServerClosed {
		fmt.Println("Сервер остановлен.")
		return nil
	}
	return err
}
