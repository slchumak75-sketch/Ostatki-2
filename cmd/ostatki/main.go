package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/desktop"
	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/server"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func main() {
	var (
		inputPath     string
		outputPath    string
		ordersOutput  string
		inPlace       bool
		headless      bool
		serverMode    bool
		noBrowser     bool
		listenAddr    string
		startDate     string
		horizonDays   int
		leadDays      int
		safetyPct     float64
		seasonMode    string
		decay         float64
		minDisplay    int
		rounding      string
		writeZeros    bool
		headerText    string
		outlierFilter bool
		useCrostonZ   bool
		adaptiveSLA   bool
		budgetCap     float64
		minSupOrder   float64
		packMultiple  int
	)

	def := model.DefaultParams()

	flag.StringVar(&inputPath, "input", "", "Путь к входному файлу Excel (.xlsx)")
	flag.StringVar(&outputPath, "output", "", "Путь для сохранения заполненного Excel (.xlsx) в пакетном режиме")
	flag.StringVar(&ordersOutput, "orders-output", "", "Необязательный путь для сохранения 4-листового отчёта и заявок поставщикам (.xlsx)")
	flag.BoolVar(&inPlace, "inplace", false, "Перезаписать столбец 8 непосредственно во входном файле Excel")
	flag.BoolVar(&headless, "headless", false, "Пакетная обработка без запуска графического интерфейса")
	flag.BoolVar(&serverMode, "server", false, "Серверный режим (без автозавершения при закрытии окна)")
	flag.BoolVar(&noBrowser, "no-browser", false, "Не открывать окно браузера автоматически")
	flag.StringVar(&listenAddr, "addr", "", "Адрес прослушивания HTTP (по умолчанию 127.0.0.1:0 в десктоп-режиме или 0.0.0.0:8080 в -server)")
	flag.StringVar(&startDate, "start-date", def.PlanStartDate, "Дата начала планирования YYYY-MM-DD (пусто = авто из метаданных Excel)")
	flag.IntVar(&horizonDays, "horizon", def.HorizonDays, "Горизонт покрытия запаса (дней)")
	flag.IntVar(&leadDays, "lead", def.LeadTimeDays, "Срок поставки (дней)")
	flag.Float64Var(&safetyPct, "safety", def.SafetyStockPct, "Базовый страховой запас (%)")
	flag.StringVar(&seasonMode, "season-mode", string(def.SeasonMode), "Режим сезонности: hybrid | group | item | flat")
	flag.Float64Var(&decay, "decay", def.RecencyDecay, "Коэффициент затухания старых лет (0.3..1.0)")
	flag.IntVar(&minDisplay, "min-display", def.MinDisplayStock, "Витринный минимум для ходовых SKU ABC A/B")
	flag.StringVar(&rounding, "rounding", string(def.Rounding), "Округление: nearest | ceil | floor")
	flag.BoolVar(&writeZeros, "write-zeros", def.WriteZeroValues, "Записывать 0 в пустые ячейки столбца 8")
	flag.StringVar(&headerText, "header", def.ColumnHeader, "Заголовок столбца 8 в ячейке H7")
	flag.BoolVar(&outlierFilter, "outlier-filter", def.OutlierFilter, "Вариант 2: фильтр разовых оптовых выбросов (Winsorization)")
	flag.BoolVar(&useCrostonZ, "croston-z", def.UseCrostonZ, "Вариант 2: метод Croston/SBA для редких Z-товаров")
	flag.BoolVar(&adaptiveSLA, "adaptive-sla", def.AdaptiveSafetySLA, "Вариант 2: адаптивный SLA страхового запаса по матрице ABC-XYZ")
	flag.Float64Var(&budgetCap, "budget", def.BudgetCap, "Вариант 2: лимит бюджета закупки в руб. (0 = без ограничения)")
	flag.Float64Var(&minSupOrder, "min-supplier", def.MinSupplierOrder, "Вариант 2: порог минимального заказа поставщику (руб.)")
	flag.IntVar(&packMultiple, "pack", def.PackMultiple, "Вариант 2: минимальная кратность упаковки (шт.)")
	flag.Parse()

	if inputPath == "" && flag.NArg() > 0 {
		inputPath = flag.Arg(0)
	}
	if inputPath == "" {
		inputPath = discoverDefaultWorkbook()
	}

	params := model.ForecastParams{
		PlanStartDate:        startDate,
		NormalizePartialLast: true,
		HorizonDays:          horizonDays,
		LeadTimeDays:         leadDays,
		SafetyStockPct:       safetyPct,
		SeasonMode:           model.SeasonMode(seasonMode),
		RecencyDecay:         decay,
		ShrinkageK:           12.0,
		MinDisplayStock:      minDisplay,
		Rounding:             model.RoundingMode(rounding),
		WriteZeroValues:      writeZeros,
		ColumnHeader:         headerText,
		OutlierFilter:        outlierFilter,
		UseCrostonZ:          useCrostonZ,
		AdaptiveSafetySLA:    adaptiveSLA,
		BudgetCap:            budgetCap,
		MinSupplierOrder:     minSupOrder,
		PackMultiple:         packMultiple,
	}

	if headless {
		if err := runHeadless(inputPath, outputPath, ordersOutput, inPlace, params); err != nil {
			log.Fatalf("Ошибка пакетной обработки: %v", err)
		}
		return
	}

	desktopMode := !serverMode
	app := server.New(desktopMode)
	if inputPath != "" {
		if err := app.LoadWorkbookFromPath(inputPath); err != nil {
			log.Printf("Предупреждение: не удалось предзагрузить %s: %v", inputPath, err)
		} else {
			log.Printf("Загружена ведомость (Вариант 2): %s", inputPath)
		}
	}

	if listenAddr == "" {
		if serverMode {
			listenAddr = "0.0.0.0:8080"
		} else {
			listenAddr = "127.0.0.1:0"
		}
	}

	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		log.Fatalf("Не удалось открыть порт %s: %v", listenAddr, err)
	}

	actualPort := ln.Addr().(*net.TCPAddr).Port
	localURL := fmt.Sprintf("http://127.0.0.1:%d", actualPort)
	log.Printf("Интерфейс «Остатки 2 — Вариант 2» запущен: %s (слушает %s)", localURL, ln.Addr().String())

	httpSrv := &http.Server{
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	if desktopMode {
		app.StartDesktopWatchdog(12 * time.Second)
	}

	if !noBrowser && !serverMode {
		go func() {
			time.Sleep(150 * time.Millisecond)
			if err := desktop.OpenAppWindow(localURL); err != nil {
				log.Printf("Не удалось автоматически открыть окно: %v. Откройте вручную: %s", err, localURL)
			}
		}()
	}

	errCh := make(chan error, 1)
	go func() {
		if err := httpSrv.Serve(ln); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-errCh:
		log.Fatalf("Ошибка HTTP-сервера: %v", err)
	case <-sigCh:
		log.Printf("Получен сигнал завершения, остановка сервера…")
	case <-app.ShutdownChan():
		log.Printf("Окно приложения закрыто, завершение работы…")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
}

func runHeadless(inputPath, outputPath, ordersOutput string, inPlace bool, params model.ForecastParams) error {
	if inputPath == "" {
		return fmt.Errorf("не указан входной файл (-input) и в текущей директории не найден .xlsx")
	}
	wb, raw, err := xlsx.ReadFile(inputPath)
	if err != nil {
		return err
	}

	report := forecast.Calculate(wb, params, nil)
	ordersMap := forecast.ExtractOrdersMap(report)

	targetOut := outputPath
	if inPlace {
		targetOut = inputPath
	} else if targetOut == "" {
		ext := filepath.Ext(inputPath)
		base := strings.TrimSuffix(inputPath, ext)
		targetOut = base + " (К закупкам — Вариант 2)" + ext
	}

	if err := xlsx.SaveOrderColumnToFile(
		targetOut,
		raw,
		wb.HeaderRow,
		wb.OrderCol,
		report.Params.ColumnHeader,
		ordersMap,
		report.Params.WriteZeroValues,
	); err != nil {
		return err
	}

	if ordersOutput != "" {
		supBytes, err := xlsx.GenerateSupplierOrdersXLSX(report, "", "")
		if err != nil {
			return err
		}
		if err := os.WriteFile(ordersOutput, supBytes, 0o644); err != nil {
			return err
		}
	}

	fmt.Printf("=== Обработка ведомости завершена успешно (Сборка: Вариант 2) ===\n")
	fmt.Printf("Входной файл:        %s\n", inputPath)
	fmt.Printf("Выходной файл:       %s\n", targetOut)
	fmt.Printf("Период планирования: %s .. %s (%d+%d дн.)\n",
		report.EffectiveStartDate, report.EffectiveEndDate,
		report.Params.HorizonDays, report.Params.LeadTimeDays)
	fmt.Printf("Всего позиций:       %d (сглажено опт-выбросов: %d SKU; неликвидов: %d SKU на %.2f руб.)\n",
		report.TotalItems, report.OutlierItemsCount, report.OverstockItemsCount, report.OverstockFrozenCost)
	fmt.Printf("Позиций к закупке:   %d (%.1f%%)\n", report.OrderItemsCount, float64(report.OrderItemsCount)*100/mathMax1(report.TotalItems))
	fmt.Printf("Единиц к закупке:    %d ед.\n", report.TotalOrderUnits)
	fmt.Printf("Сумма закупки:       %.2f руб.\n", report.TotalOrderCost)
	fmt.Printf("Оценка в рознице:    %.2f руб. (маржа: +%.2f руб.)\n", report.TotalRetailValue, report.ExpectedMargin)
	return nil
}

func mathMax1(v int) float64 {
	if v < 1 {
		return 1
	}
	return float64(v)
}

func discoverDefaultWorkbook() string {
	var searchDirs []string
	if wd, err := os.Getwd(); err == nil {
		searchDirs = append(searchDirs, wd)
	}
	if exe, err := os.Executable(); err == nil {
		searchDirs = append(searchDirs, filepath.Dir(exe))
	}

	for _, dir := range searchDirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		var candidates []string
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			lower := strings.ToLower(name)
			if !strings.HasSuffix(lower, ".xlsx") || strings.HasPrefix(name, "~$") {
				continue
			}
			if strings.HasPrefix(lower, "заявки поставщикам") || strings.Contains(lower, "(вариант 1)") {
				continue
			}
			candidates = append(candidates, filepath.Join(dir, name))
		}
		sort.Strings(candidates)
		for _, c := range candidates {
			if strings.Contains(strings.ToLower(filepath.Base(c)), "ведомость") {
				return c
			}
		}
		if len(candidates) > 0 {
			return candidates[0]
		}
	}
	return ""
}
