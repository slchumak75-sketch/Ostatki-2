package forecast

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

// NormalizeParams проверяет и приводит параметры расчёта к допустимым границам.
func NormalizeParams(p model.ForecastParams) model.ForecastParams {
	if p.HorizonDays < 1 {
		p.HorizonDays = 30
	}
	if p.HorizonDays > 365 {
		p.HorizonDays = 365
	}
	if p.LeadTimeDays < 0 {
		p.LeadTimeDays = 0
	}
	if p.LeadTimeDays > 180 {
		p.LeadTimeDays = 180
	}
	if p.SafetyStockPct < 0 {
		p.SafetyStockPct = 0
	}
	if p.SafetyStockPct > 300 {
		p.SafetyStockPct = 300
	}
	if p.RecencyDecay < 0.15 || p.RecencyDecay > 1.0 {
		p.RecencyDecay = 0.65
	}
	if p.ShrinkageK < 0 {
		p.ShrinkageK = 12.0
	}
	if p.MinDisplayStock < 0 {
		p.MinDisplayStock = 0
	}
	if p.MinDisplayStock > 50 {
		p.MinDisplayStock = 50
	}
	switch p.SeasonMode {
	case model.SeasonHybrid, model.SeasonGroupOnly, model.SeasonItemOnly, model.SeasonFlatSimple:
	default:
		p.SeasonMode = model.SeasonHybrid
	}
	switch p.Rounding {
	case model.RoundNearest, model.RoundCeil, model.RoundFloor:
	default:
		p.Rounding = model.RoundNearest
	}
	if strings.TrimSpace(p.ColumnHeader) == "" {
		p.ColumnHeader = "К закупкам"
	}
	return p
}

// Calculate выполняет полный сезонно-трендовый расчёт столбца 8 («К закупкам») и формирует аналитический отчёт.
func Calculate(wb *model.WorkbookData, rawParams model.ForecastParams, manualOverrides map[int]int) *model.CalculationReport {
	params := NormalizeParams(rawParams)
	periods := make([]model.PeriodColumn, len(wb.Periods))
	copy(periods, wb.Periods)

	T := len(periods)
	startDate, lastCompleteness := resolveDatesAndCompleteness(wb, periods, params)
	if T > 0 {
		periods[T-1].Completeness = lastCompleteness
	}

	totalSpanDays := params.HorizonDays + params.LeadTimeDays
	endDate := startDate.AddDate(0, 0, totalSpanDays-1)

	// 1. Агрегация продаж по периодам и расчёт групповых индексов сезонности I_{g, m}
	periodTotals := make([]float64, T)
	groupPeriodTotals := make(map[string][]float64)
	groupNamesMap := make(map[string]int)
	for _, it := range wb.Items {
		groupNamesMap[it.Group]++
		if _, ok := groupPeriodTotals[it.Group]; !ok {
			groupPeriodTotals[it.Group] = make([]float64, T)
		}
		for idx := 0; idx < T && idx < len(it.MonthlySales); idx++ {
			v := it.MonthlySales[idx]
			periodTotals[idx] += v
			groupPeriodTotals[it.Group][idx] += v
		}
	}

	groupIndices := make(map[string][12]float64, len(groupNamesMap))
	groupDecay := math.Max(0.5, params.RecencyDecay)
	for g, gTotals := range groupPeriodTotals {
		var mNum [12]float64
		var mDen [12]float64
		for idx, p := range periods {
			if p.Month < 1 || p.Month > 12 {
				continue
			}
			mIdx := p.Month - 1
			recency := math.Pow(groupDecay, float64(T-1-idx)/12.0)
			w := p.Completeness
			if w <= 0 {
				w = 1.0
			}
			rate := gTotals[idx] / w
			mNum[mIdx] += recency * w * rate
			mDen[mIdx] += recency * w
		}

		var raw [12]float64
		presentSum := 0.0
		presentCnt := 0
		for m := 0; m < 12; m++ {
			if mDen[m] > 0 {
				raw[m] = mNum[m] / mDen[m]
				presentSum += raw[m]
				presentCnt++
			}
		}
		meanVal := 1.0
		if presentCnt > 0 && presentSum > 0 {
			meanVal = presentSum / float64(presentCnt)
		}
		var norm [12]float64
		for m := 0; m < 12; m++ {
			if presentSum == 0 || mDen[m] == 0 {
				norm[m] = 1.0
			} else {
				norm[m] = raw[m] / meanVal
			}
		}
		groupIndices[g] = norm
	}

	// 2. ABC-классификация по обороту за последние 12 месяцев и расчёт медианной наценки по группам (для SKU с 0 остатком, где 1С не выгрузила розн. цену)
	abcClasses := computeABCClasses(wb.Items, periods)
	groupMarkup := computeGroupMedianMarkup(wb.Items)

	// 3. Предрасчёт дневных шагов горизонта (чтобы не вызывать time.AddDate 1850 * N раз)
	type dayStep struct {
		monthIdx   int     // 0..11
		daysInMon  float64 // 28..31
	}
	steps := make([]dayStep, totalSpanDays)
	for d := 0; d < totalSpanDays; d++ {
		cur := startDate.AddDate(0, 0, d)
		steps[d] = dayStep{
			monthIdx:  int(cur.Month()) - 1,
			daysInMon: float64(daysInMonth(cur.Year(), int(cur.Month()))),
		}
	}

	// 4. Построчный расчёт каждого SKU
	calcItems := make([]model.CalculatedItem, len(wb.Items))
	report := &model.CalculationReport{
		FileName:              wb.FileName,
		Title:                 wb.Title,
		CreatedDate:           wb.CreatedDate,
		EffectiveStartDate:    startDate.Format("2006-01-02"),
		EffectiveEndDate:      endDate.Format("2006-01-02"),
		LastMonthCompleteness: roundTo(lastCompleteness, 4),
		Params:                params,
		Periods:               periods,
		PeriodTotals:          periodTotals,
		TotalItems:            len(wb.Items),
	}

	whMap := make(map[string]*model.WarehouseSummary)
	supMap := make(map[string]*model.SupplierSummary)
	grpOrderItems := make(map[string]int)
	grpOrderUnits := make(map[string]int)
	grpOrderCost := make(map[string]float64)

	for i, item := range wb.Items {
		sales := item.MonthlySales
		gIdx := groupIndices[item.Group]

		sumAll := 0.0
		sumLast12 := 0.0
		firstNZ := -1
		for idx := 0; idx < T && idx < len(sales); idx++ {
			v := sales[idx]
			sumAll += v
			if idx >= T-12 {
				sumLast12 += v
			}
			if v > 0 && firstNZ < 0 {
				firstNZ = idx
			}
		}

		activeStart := 0
		if firstNZ >= 0 {
			activeStart = firstNZ
		} else if T > 12 {
			activeStart = T - 12
		}
		if T >= 3 && activeStart > T-3 {
			activeStart = T - 3
		}
		activeMonths := T - activeStart

		// Десезонализированная базовая скорость B_i и плоская (несезонная) скорость F_i
		numB, denB := 0.0, 0.0
		denFlat := 0.0
		activeSalesSum := 0.0
		for idx := activeStart; idx < T && idx < len(sales); idx++ {
			mIdx := periods[idx].Month - 1
			w := periods[idx].Completeness
			if w <= 0 {
				w = 1.0
			}
			lam := math.Pow(params.RecencyDecay, float64(T-1-idx)/12.0)
			numB += lam * sales[idx]
			denB += lam * w * gIdx[mIdx]
			denFlat += lam * w
			activeSalesSum += sales[idx]
		}

		baseRate := 0.0
		if denB > 0 {
			baseRate = numB / denB
		}
		flatRate := 0.0
		if denFlat > 0 {
			flatRate = numB / denFlat
		}

		theta := 0.0
		if activeSalesSum > 0 {
			if params.ShrinkageK == 0 {
				theta = 1.0
			} else {
				theta = activeSalesSum / (activeSalesSum + params.ShrinkageK)
			}
		}

		var mNum [12]float64
		var mDen [12]float64
		for idx := activeStart; idx < T && idx < len(sales); idx++ {
			mIdx := periods[idx].Month - 1
			w := periods[idx].Completeness
			if w <= 0 {
				w = 1.0
			}
			lam := math.Pow(params.RecencyDecay, float64(T-1-idx)/12.0)
			mNum[mIdx] += lam * sales[idx]
			mDen[mIdx] += lam * w
		}

		var monthForecast [12]float64
		for m := 0; m < 12; m++ {
			groupEst := baseRate * gIdx[m]
			directEst := groupEst
			if mDen[m] > 0 {
				directEst = mNum[m] / mDen[m]
			}
			switch params.SeasonMode {
			case model.SeasonGroupOnly:
				monthForecast[m] = groupEst
			case model.SeasonItemOnly:
				if mDen[m] > 0 {
					monthForecast[m] = directEst
				} else {
					monthForecast[m] = flatRate
				}
			case model.SeasonFlatSimple:
				monthForecast[m] = flatRate
			default: // SeasonHybrid
				monthForecast[m] = theta*directEst + (1.0-theta)*groupEst
			}
		}

		// Интегрирование суточного сезонного спроса по дням горизонта (HorizonDays + LeadTimeDays)
		demand := 0.0
		flatDemand := 0.0
		groupWeightedIdxSum := 0.0
		for _, st := range steps {
			demand += monthForecast[st.monthIdx] / st.daysInMon
			flatDemand += flatRate / st.daysInMon
			groupWeightedIdxSum += gIdx[st.monthIdx]
		}

		effSeasonIdx := 1.0
		if baseRate > 1e-9 && totalSpanDays > 0 {
			avgDailyDemand := demand / float64(totalSpanDays)
			avgDailyBase := baseRate / 30.4375
			effSeasonIdx = avgDailyDemand / avgDailyBase
		} else if totalSpanDays > 0 {
			effSeasonIdx = groupWeightedIdxSum / float64(totalSpanDays)
		}

		safetyUnits := demand * (params.SafetyStockPct / 100.0)
		targetStock := demand + safetyUnits

		abc := abcClasses[i]
		minDisplayApplied := false
		if params.MinDisplayStock > 0 && (abc == "A" || abc == "B") && sumLast12 >= 4 {
			if targetStock < float64(params.MinDisplayStock) {
				targetStock = float64(params.MinDisplayStock)
				minDisplayApplied = true
			}
		}

		rawDeficit := math.Max(0, targetStock-item.ClosingStock)
		autoQty := roundOrderQty(rawDeficit, params.Rounding)

		flatTarget := flatDemand * (1.0 + params.SafetyStockPct/100.0)
		flatQty := roundOrderQty(math.Max(0, flatTarget-item.ClosingStock), params.Rounding)

		finalQty := autoQty
		var overridePtr *int
		if manualOverrides != nil {
			if manualVal, ok := manualOverrides[item.ExcelRow]; ok {
				if manualVal < 0 {
					manualVal = 0
				}
				finalQty = manualVal
				vCopy := manualVal
				overridePtr = &vCopy
				report.ManualOverrideCount++
			}
		}

		orderCost := float64(finalQty) * item.PurchasePrice
		effectiveRetail := item.RetailPrice
		if effectiveRetail <= 0 && item.PurchasePrice > 0 {
			mult := groupMarkup[item.Group]
			if mult <= 1.0 {
				mult = 1.0
			}
			effectiveRetail = item.PurchasePrice * mult
		}
		retailVal := float64(finalQty) * effectiveRetail

		daysSupply := 999.0
		if demand > 1e-6 {
			daily := demand / float64(totalSpanDays)
			daysSupply = math.Min(999.0, item.ClosingStock/daily)
		}

		explanation := buildExplanation(baseRate, effSeasonIdx, totalSpanDays, demand, params.SafetyStockPct, targetStock, item.ClosingStock, autoQty, overridePtr, minDisplayApplied)

		var roundedM12 [12]float64
		for m := 0; m < 12; m++ {
			roundedM12[m] = roundTo(monthForecast[m], 2)
		}

		ci := model.CalculatedItem{
			RawItem:           item,
			ABCClass:          abc,
			SumSalesAll:       roundTo(sumAll, 2),
			SumSalesLast12M:   roundTo(sumLast12, 2),
			ActiveMonths:      activeMonths,
			BaseMonthlyRate:   roundTo(baseRate, 2),
			HorizonSeasonIdx:  roundTo(effSeasonIdx, 2),
			BayesWeight:       roundTo(theta, 2),
			ForecastDemand:    roundTo(demand, 2),
			SafetyUnits:       roundTo(safetyUnits, 2),
			TargetStock:       roundTo(targetStock, 2),
			AutoOrderQty:      autoQty,
			FinalOrderQty:     finalQty,
			ManualOverride:    overridePtr,
			FlatComparisonQty: flatQty,
			OrderCost:         roundTo(orderCost, 2),
			OrderRetailValue:  roundTo(retailVal, 2),
			DaysOfSupply:      roundTo(daysSupply, 1),
			MonthlyForecast12: roundedM12,
			Explanation:       explanation,
		}
		calcItems[i] = ci

		// Сводные счётчики
		if item.ClosingStock <= 0 {
			report.ZeroStockCount++
		}
		if item.IsCritical1C {
			report.Critical1CCount++
		}
		if finalQty > 0 {
			report.OrderItemsCount++
			report.TotalOrderUnits += finalQty
			report.TotalOrderCost += orderCost
			report.TotalRetailValue += retailVal
			grpOrderItems[item.Group]++
			grpOrderUnits[item.Group] += finalQty
			grpOrderCost[item.Group] += orderCost
		}
		report.FlatOrderUnits += flatQty
		report.FlatOrderCost += float64(flatQty) * item.PurchasePrice

		// По складам
		ws, ok := whMap[item.Warehouse]
		if !ok {
			ws = &model.WarehouseSummary{Warehouse: item.Warehouse}
			whMap[item.Warehouse] = ws
		}
		ws.TotalItems++
		if item.ClosingStock <= 0 {
			ws.ZeroStockItems++
		}
		if item.IsCritical1C {
			ws.Critical1C++
		}
		if finalQty > 0 {
			ws.OrderItems++
			ws.TotalOrderQty += finalQty
			ws.TotalOrderCost += orderCost
			ws.TotalRetailVal += retailVal
		}

		// По поставщикам
		supName := item.Supplier
		if supName == "" {
			supName = "(Поставщик не указан)"
		}
		ss, ok := supMap[supName]
		if !ok {
			ss = &model.SupplierSummary{Supplier: supName}
			supMap[supName] = ss
		}
		ss.TotalItems++
		if finalQty > 0 {
			ss.OrderItems++
			ss.TotalOrderQty += finalQty
			ss.TotalOrderCost += orderCost
			ss.TotalRetailVal += retailVal
		}
	}

	report.TotalOrderCost = roundTo(report.TotalOrderCost, 2)
	report.TotalRetailValue = roundTo(report.TotalRetailValue, 2)
	report.ExpectedMargin = roundTo(report.TotalRetailValue-report.TotalOrderCost, 2)
	report.FlatOrderCost = roundTo(report.FlatOrderCost, 2)
	report.Items = calcItems

	// Формирование отсортированного списка групп
	var gNames []string
	for g := range groupNamesMap {
		gNames = append(gNames, g)
	}
	sort.Strings(gNames)
	for _, g := range gNames {
		gIdx := groupIndices[g]
		var roundedIdx [12]float64
		for m := 0; m < 12; m++ {
			roundedIdx[m] = roundTo(gIdx[m], 3)
		}
		hSum := 0.0
		for _, st := range steps {
			hSum += gIdx[st.monthIdx]
		}
		hAvg := 1.0
		if totalSpanDays > 0 {
			hAvg = hSum / float64(totalSpanDays)
		}
		report.Groups = append(report.Groups, model.GroupSeasonality{
			Group:          g,
			ItemCount:      groupNamesMap[g],
			OrderItemCount: grpOrderItems[g],
			TotalUnits:     grpOrderUnits[g],
			TotalCost:      roundTo(grpOrderCost[g], 2),
			MonthlyIndices: roundedIdx,
			PeriodTotals:   groupPeriodTotals[g],
			HorizonIndex:   roundTo(hAvg, 3),
		})
	}

	// Сортировка складов
	for _, ws := range whMap {
		ws.TotalOrderCost = roundTo(ws.TotalOrderCost, 2)
		ws.TotalRetailVal = roundTo(ws.TotalRetailVal, 2)
		report.Warehouses = append(report.Warehouses, *ws)
	}
	sort.Slice(report.Warehouses, func(i, j int) bool {
		return report.Warehouses[i].Warehouse < report.Warehouses[j].Warehouse
	})

	// Сортировка поставщиков по убыванию суммы закупки
	for _, ss := range supMap {
		ss.TotalOrderCost = roundTo(ss.TotalOrderCost, 2)
		ss.TotalRetailVal = roundTo(ss.TotalRetailVal, 2)
		if report.TotalOrderCost > 0 {
			ss.ShareOfBudget = roundTo(ss.TotalOrderCost/report.TotalOrderCost*100.0, 2)
		}
		report.Suppliers = append(report.Suppliers, *ss)
	}
	sort.Slice(report.Suppliers, func(i, j int) bool {
		if math.Abs(report.Suppliers[i].TotalOrderCost-report.Suppliers[j].TotalOrderCost) > 1e-6 {
			return report.Suppliers[i].TotalOrderCost > report.Suppliers[j].TotalOrderCost
		}
		return report.Suppliers[i].Supplier < report.Suppliers[j].Supplier
	})

	return report
}

// ExtractOrdersMap извлекает map[excelRow]finalOrderQty для записи в столбец 8 Excel.
func ExtractOrdersMap(report *model.CalculationReport) map[int]int {
	res := make(map[int]int, len(report.Items))
	for _, it := range report.Items {
		res[it.ExcelRow] = it.FinalOrderQty
	}
	return res
}

func resolveDatesAndCompleteness(wb *model.WorkbookData, periods []model.PeriodColumn, params model.ForecastParams) (startDate time.Time, completeness float64) {
	completeness = 1.0
	T := len(periods)

	var reportDate time.Time
	hasReportDate := false
	dateStr := wb.CreatedDate
	if wb.ModifiedDate > dateStr {
		dateStr = wb.ModifiedDate
	}
	if t, err := time.Parse("2006-01-02", dateStr); err == nil {
		reportDate = t
		hasReportDate = true
	}

	if T > 0 {
		last := periods[T-1]
		dim := daysInMonth(last.Year, last.Month)
		if params.NormalizePartialLast {
			if params.LastMonthDaysElapsed > 0 && params.LastMonthDaysElapsed < dim {
				completeness = clampFloat(float64(params.LastMonthDaysElapsed)/float64(dim), 0.25, 1.0)
			} else if hasReportDate && reportDate.Year() == last.Year && int(reportDate.Month()) == last.Month && reportDate.Day() < dim {
				completeness = clampFloat(float64(reportDate.Day())/float64(dim), 0.25, 1.0)
			}
		}
	}

	if params.PlanStartDate != "" {
		if t, err := time.Parse("2006-01-02", params.PlanStartDate); err == nil {
			return t, completeness
		}
	}
	if hasReportDate {
		return reportDate.AddDate(0, 0, 1), completeness
	}
	if T > 0 {
		last := periods[T-1]
		return time.Date(last.Year, time.Month(last.Month), 1, 0, 0, 0, 0, time.UTC).AddDate(0, 1, 0), completeness
	}
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC), completeness
}

func computeABCClasses(items []model.RawItem, periods []model.PeriodColumn) []string {
	T := len(periods)
	type scored struct {
		idx int
		val float64
		all float64
	}
	arr := make([]scored, len(items))
	totalTurnover := 0.0
	for i, it := range items {
		s12 := 0.0
		sAll := 0.0
		for pIdx := 0; pIdx < T && pIdx < len(it.MonthlySales); pIdx++ {
			sAll += it.MonthlySales[pIdx]
			if pIdx >= T-12 {
				s12 += it.MonthlySales[pIdx]
			}
		}
		price := it.PurchasePrice
		if price <= 0 {
			price = 1.0
		}
		turn := s12 * price
		arr[i] = scored{idx: i, val: turn, all: sAll}
		totalTurnover += turn
	}

	sort.Slice(arr, func(i, j int) bool {
		return arr[i].val > arr[j].val
	})

	classes := make([]string, len(items))
	cum := 0.0
	for _, s := range arr {
		if s.all <= 0 {
			classes[s.idx] = "D"
			continue
		}
		if s.val <= 0 || totalTurnover <= 0 {
			classes[s.idx] = "C"
			continue
		}
		shareBefore := cum / totalTurnover
		cum += s.val
		switch {
		case shareBefore < 0.80:
			classes[s.idx] = "A"
		case shareBefore < 0.95:
			classes[s.idx] = "B"
		default:
			classes[s.idx] = "C"
		}
	}
	return classes
}

func roundOrderQty(deficit float64, mode model.RoundingMode) int {
	if deficit <= 1e-6 {
		return 0
	}
	switch mode {
	case model.RoundCeil:
		if deficit < 0.15 {
			return 0
		}
		return int(math.Ceil(deficit - 1e-9))
	case model.RoundFloor:
		return int(math.Floor(deficit + 1e-9))
	default: // RoundNearest
		if deficit < 0.5 {
			return 0
		}
		return int(math.Floor(deficit + 0.5))
	}
}

func buildExplanation(
	baseRate float64,
	seasonIdx float64,
	spanDays int,
	demand float64,
	safetyPct float64,
	targetStock float64,
	closingStock float64,
	autoQty int,
	override *int,
	minDisplay bool,
) string {
	basePart := fmt.Sprintf("База %.2f ед./мес. × сезон %.2f → спрос на %d дн.: %.2f ед.; с запасом +%.0f%% цель %.2f",
		baseRate, seasonIdx, spanDays, demand, safetyPct, targetStock)
	if minDisplay {
		basePart += " (учтён витринный минимум)"
	}
	basePart += fmt.Sprintf(" − остаток %.0f = к закупке %d ед.", closingStock, autoQty)
	if override != nil {
		basePart += fmt.Sprintf(" [вручную: %d ед.]", *override)
	}
	return basePart
}

func daysInMonth(year int, month int) int {
	return time.Date(year, time.Month(month)+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func clampFloat(v, minV, maxV float64) float64 {
	if v < minV {
		return minV
	}
	if v > maxV {
		return maxV
	}
	return v
}

func computeGroupMedianMarkup(items []model.RawItem) map[string]float64 {
	ratios := make(map[string][]float64)
	for _, it := range items {
		if it.PurchasePrice > 0.01 && it.RetailPrice > it.PurchasePrice && it.RetailPrice/it.PurchasePrice < 5.0 {
			ratios[it.Group] = append(ratios[it.Group], it.RetailPrice/it.PurchasePrice)
		}
	}
	res := make(map[string]float64, len(ratios))
	for g, arr := range ratios {
		sort.Float64s(arr)
		res[g] = arr[len(arr)/2]
	}
	return res
}

func roundTo(v float64, decimals int) float64 {
	p := math.Pow(10, float64(decimals))
	return math.Round(v*p) / p
}
