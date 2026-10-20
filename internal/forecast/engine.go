package forecast

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

// NormalizeParams проверяет и приводит параметры расчёта «Варианта 4» к допустимым границам.
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
	if p.BudgetCap < 0 {
		p.BudgetCap = 0
	}
	if p.MinSupplierOrder < 0 {
		p.MinSupplierOrder = 0
	}
	if p.PackMultiple < 1 {
		p.PackMultiple = 1
	}
	if p.PackMultiple > 1000 {
		p.PackMultiple = 1000
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

// Calculate выполняет полный расчёт сборки «Вариант 4».
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

	// Предварительная очистка рядов от разовых оптовых выбросов (Winsorization)
	nItems := len(wb.Items)
	cleanedSeries := make([][]float64, nItems)
	outlierCounts := make([]int, nItems)
	for i, it := range wb.Items {
		if params.OutlierFilter {
			cleanedSeries[i], outlierCounts[i] = winsorizeItemSales(it.MonthlySales)
		} else {
			cp := make([]float64, len(it.MonthlySales))
			copy(cp, it.MonthlySales)
			cleanedSeries[i] = cp
		}
	}

	// 1. Расчёт очищенных сезонных индексов групп
	periodTotals := make([]float64, T)
	groupRawTotals := make(map[string][]float64)
	groupCleanTotals := make(map[string][]float64)
	groupNamesMap := make(map[string]int)

	for i, it := range wb.Items {
		groupNamesMap[it.Group]++
		if _, ok := groupRawTotals[it.Group]; !ok {
			groupRawTotals[it.Group] = make([]float64, T)
			groupCleanTotals[it.Group] = make([]float64, T)
		}
		for idx := 0; idx < T && idx < len(it.MonthlySales); idx++ {
			rawV := it.MonthlySales[idx]
			cleanV := cleanedSeries[i][idx]
			periodTotals[idx] += rawV
			groupRawTotals[it.Group][idx] += rawV
			groupCleanTotals[it.Group][idx] += cleanV
		}
	}

	groupDecay := math.Max(0.5, params.RecencyDecay)
	groupIndices := buildGroupIndices(groupCleanTotals, periods, groupDecay)

	// 2. Классификация ABC, 6-уровневая сегментация продаж (0..5), медианная наценка по группам и дневная сетка горизонта
	abcClasses := computeABCClasses(wb.Items, periods)
	salesSegments, sumLast6List := computeSalesSegments(wb.Items, periods)
	groupMarkup := computeGroupMedianMarkup(wb.Items)

	type dayStep struct {
		monthIdx  int
		daysInMon float64
	}
	steps := make([]dayStep, totalSpanDays)
	for d := 0; d < totalSpanDays; d++ {
		cur := startDate.AddDate(0, 0, d)
		steps[d] = dayStep{
			monthIdx:  int(cur.Month()) - 1,
			daysInMon: float64(daysInMonth(cur.Year(), int(cur.Month()))),
		}
	}

	// 3. Построчный расчёт всех SKU
	calcItems := make([]model.CalculatedItem, nItems)
	report := &model.CalculationReport{
		BuildVariant:          "Вариант 4",
		FileName:              wb.FileName,
		Title:                 wb.Title,
		CreatedDate:           wb.CreatedDate,
		EffectiveStartDate:    startDate.Format("2006-01-02"),
		EffectiveEndDate:      endDate.Format("2006-01-02"),
		LastMonthCompleteness: roundTo(lastCompleteness, 4),
		Params:                params,
		Periods:               periods,
		PeriodTotals:          periodTotals,
		TotalItems:            nItems,
	}

	codesABC := [3]string{"A", "B", "C"}
	codesXYZ := [3]string{"X", "Y", "Z"}
	for r := 0; r < 3; r++ {
		for c := 0; c < 3; c++ {
			report.MatrixABCXYZ[r][c].Code = codesABC[r] + codesXYZ[c]
		}
	}

	for i, item := range wb.Items {
		rawSales := item.MonthlySales
		cleanSales := cleanedSeries[i]
		gIdx := groupIndices[item.Group]

		if outlierCounts[i] > 0 {
			report.OutlierItemsCount++
		}

		sumAll := 0.0
		sumLast12 := 0.0
		firstNZ := -1
		nzMonths := 0
		for idx := 0; idx < T && idx < len(rawSales); idx++ {
			v := rawSales[idx]
			sumAll += v
			if idx >= T-12 {
				sumLast12 += v
			}
			if v > 0 {
				nzMonths++
				if firstNZ < 0 {
					firstNZ = idx
				}
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

		// Расчёт XYZ и коэффициента вариации на активном интервале
		xyz, cv := classifyXYZ(cleanSales[activeStart:], gIdx, periods[activeStart:], sumAll)
		abc := abcClasses[i]
		abcxyz := abc + xyz
		if abc == "D" {
			xyz = "D"
			abcxyz = "DD"
		}

		// --- Расчёт потребности «Вариант 4» ---
		v2MonthForecast, baseRate, flatRate := forecastItem12Months(cleanSales, activeStart, periods, gIdx, params.RecencyDecay, params.ShrinkageK, params.SeasonMode)

		flatDemand := 0.0
		for _, st := range steps {
			flatDemand += flatRate / st.daysInMon
		}
		flatTarget := flatDemand * (1.0 + params.SafetyStockPct/100.0)
		flatQty := roundOrderQty(math.Max(0, flatTarget-item.ClosingStock), params.Rounding)

		// Для редких позиций класса Z при включённом UseCrostonZ применяем демпфирование Syntetos–Boylan (SBA)
		if params.UseCrostonZ && xyz == "Z" && sumAll > 0 {
			sbaMonthly := computeCrostonSBARate(cleanSales[activeStart:], periods[activeStart:])
			for m := 0; m < 12; m++ {
				seasonalSBA := sbaMonthly * (0.5 + 0.5*gIdx[m])
				if v2MonthForecast[m] > seasonalSBA*1.25 {
					v2MonthForecast[m] = 0.55*seasonalSBA + 0.45*v2MonthForecast[m]
				}
			}
		}

		demand := 0.0
		groupWeightedIdxSum := 0.0
		for _, st := range steps {
			demand += v2MonthForecast[st.monthIdx] / st.daysInMon
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

		effSafetyPct := params.SafetyStockPct
		if params.AdaptiveSafetySLA {
			effSafetyPct = params.SafetyStockPct * safetyMultiplierForSegment(abc, xyz)
		}

		safetyUnits := demand * (effSafetyPct / 100.0)
		targetStock := demand + safetyUnits

		minDisplayApplied := false
		if params.MinDisplayStock > 0 && (abc == "A" || abc == "B") && sumLast12 >= 4 {
			if targetStock < float64(params.MinDisplayStock) {
				targetStock = float64(params.MinDisplayStock)
				minDisplayApplied = true
			}
		}

		rawDeficit := math.Max(0, targetStock-item.ClosingStock)
		autoQty := roundOrderQty(rawDeficit, params.Rounding)
		if autoQty > 0 && params.PackMultiple > 1 {
			rem := autoQty % params.PackMultiple
			if rem != 0 {
				autoQty += params.PackMultiple - rem
			}
		}

		cleanSum := 0.0
		for idx := activeStart; idx < len(cleanSales); idx++ {
			cleanSum += cleanSales[idx]
		}
		theta := 0.0
		if cleanSum > 0 {
			if params.ShrinkageK == 0 {
				theta = 1.0
			} else {
				theta = cleanSum / (cleanSum + params.ShrinkageK)
			}
		}

		daysSupply := 999.0
		if demand > 1e-6 {
			daily := demand / float64(totalSpanDays)
			daysSupply = math.Min(999.0, item.ClosingStock/daily)
		}

		// Детектор сверхнормативного запаса / замороженного капитала (> 365 дней продаж или мёртвый остаток)
		annualExpected := baseRate * 12.0
		isOverstock := false
		overstockVal := 0.0
		if item.ClosingStock > 0 && item.PurchasePrice > 0 {
			excessUnits := item.ClosingStock - math.Max(2.0, annualExpected)
			if excessUnits >= 2.0 && (sumLast12 <= 0 || daysSupply >= 365.0) {
				isOverstock = true
				overstockVal = excessUnits * item.PurchasePrice
			}
		}

		effectiveRetail := item.RetailPrice
		if effectiveRetail <= 0 && item.PurchasePrice > 0 {
			mult := groupMarkup[item.Group]
			if mult <= 1.0 {
				mult = 1.0
			}
			effectiveRetail = item.PurchasePrice * mult
		}

		prio := computePriorityScore(abc, xyz, item.ClosingStock, daysSupply, item.PurchasePrice, effectiveRetail, effSeasonIdx)

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

		var roundedM12 [12]float64
		for m := 0; m < 12; m++ {
			roundedM12[m] = roundTo(v2MonthForecast[m], 2)
		}
		cappedRounded := make([]float64, len(cleanSales))
		for k, cvVal := range cleanSales {
			cappedRounded[k] = roundTo(cvVal, 1)
		}

		salesSeg := salesSegments[i]
		salesSegLabel := model.SalesSegmentLabelByCode(salesSeg)
		sumLast6 := sumLast6List[i]

		calcItems[i] = model.CalculatedItem{
			RawItem:           item,
			ABCClass:          abc,
			XYZClass:          xyz,
			ABCXYZ:            abcxyz,
			SalesSegment:      salesSeg,
			SalesSegmentLabel: salesSegLabel,
			CV:                roundTo(cv, 2),
			NonZeroMonths:     nzMonths,
			OutlierMonths:     outlierCounts[i],
			CappedSales:       cappedRounded,
			SumSalesAll:       roundTo(sumAll, 2),
			SumSalesLast12M:   roundTo(sumLast12, 2),
			SumSalesLast6M:    roundTo(sumLast6, 2),
			ActiveMonths:      activeMonths,
			BaseMonthlyRate:   roundTo(baseRate, 2),
			HorizonSeasonIdx:  roundTo(effSeasonIdx, 2),
			BayesWeight:       roundTo(theta, 2),
			EffectiveSafety:   roundTo(effSafetyPct, 1),
			ForecastDemand:    roundTo(demand, 2),
			SafetyUnits:       roundTo(safetyUnits, 2),
			TargetStock:       roundTo(targetStock, 2),
			AutoOrderQty:      autoQty,
			FinalOrderQty:     finalQty,
			ManualOverride:    overridePtr,
			FlatComparisonQty: flatQty,
			PriorityScore:     roundTo(prio, 1),
			OrderCost:         roundTo(float64(finalQty)*item.PurchasePrice, 2),
			OrderRetailValue:  roundTo(float64(finalQty)*effectiveRetail, 2),
			DaysOfSupply:      roundTo(daysSupply, 1),
			IsOverstock:       isOverstock,
			OverstockValue:    roundTo(overstockVal, 2),
			MonthlyForecast12: roundedM12,
			Explanation:       buildExplanationV2(salesSegLabel, baseRate, effSeasonIdx, totalSpanDays, demand, effSafetyPct, targetStock, item.ClosingStock, autoQty, outlierCounts[i], overridePtr, minDisplayApplied, 0),
		}

		report.UncappedOrderCost += float64(finalQty) * item.PurchasePrice
		report.FlatOrderUnits += flatQty
		report.FlatOrderCost += float64(flatQty) * item.PurchasePrice
	}

	report.UncappedOrderCost = roundTo(report.UncappedOrderCost, 2)

	// 4. Оптимизатор лимита бюджета (BudgetCap > 0): сохраняет самые приоритетные единицы в пределах выделенной суммы
	if params.BudgetCap > 0 && report.UncappedOrderCost > params.BudgetCap+1e-6 {
		applyBudgetCapOptimizer(calcItems, params.BudgetCap, groupMarkup, totalSpanDays)
	}

	// 5. Подсчёт финальных сводок по отчёту, матрице ABC-XYZ, группам, складам и поставщикам
	whMap := make(map[string]*model.WarehouseSummary)
	supMap := make(map[string]*model.SupplierSummary)
	grpOrderItems := make(map[string]int)
	grpOrderUnits := make(map[string]int)
	grpOrderCost := make(map[string]float64)
	grpOverstock := make(map[string]float64)

	for i := range calcItems {
		it := &calcItems[i]
		report.BudgetTrimmedUnits += it.BudgetTrimmedQty

		if it.ClosingStock <= 0 {
			report.ZeroStockCount++
		}
		if it.IsOverstock {
			report.OverstockItemsCount++
			report.OverstockFrozenCost += it.OverstockValue
			grpOverstock[it.Group] += it.OverstockValue
		}
		if it.FinalOrderQty > 0 {
			report.OrderItemsCount++
			report.TotalOrderUnits += it.FinalOrderQty
			report.TotalOrderCost += it.OrderCost
			report.TotalRetailValue += it.OrderRetailValue
			grpOrderItems[it.Group]++
			grpOrderUnits[it.Group] += it.FinalOrderQty
			grpOrderCost[it.Group] += it.OrderCost
		}

		if rIdx, cIdx, ok := matrixCoords(it.ABCClass, it.XYZClass); ok {
			cell := &report.MatrixABCXYZ[rIdx][cIdx]
			cell.ItemCount++
			if it.FinalOrderQty > 0 {
				cell.OrderItems++
				cell.OrderUnits += it.FinalOrderQty
				cell.OrderCost = roundTo(cell.OrderCost+it.OrderCost, 2)
			}
		}

		ws, ok := whMap[it.Warehouse]
		if !ok {
			ws = &model.WarehouseSummary{Warehouse: it.Warehouse}
			whMap[it.Warehouse] = ws
		}
		ws.TotalItems++
		if it.ClosingStock <= 0 {
			ws.ZeroStockItems++
		}
		if it.IsOverstock {
			ws.OverstockItems++
			ws.OverstockCost += it.OverstockValue
		}
		if it.FinalOrderQty > 0 {
			ws.OrderItems++
			ws.TotalOrderQty += it.FinalOrderQty
			ws.TotalOrderCost += it.OrderCost
			ws.TotalRetailVal += it.OrderRetailValue
		}

		supName := it.Supplier
		if supName == "" {
			supName = "(Поставщик не указан)"
		}
		ss, ok := supMap[supName]
		if !ok {
			ss = &model.SupplierSummary{Supplier: supName}
			supMap[supName] = ss
		}
		ss.TotalItems++
		if it.FinalOrderQty > 0 {
			ss.OrderItems++
			ss.TotalOrderQty += it.FinalOrderQty
			ss.TotalOrderCost += it.OrderCost
			ss.TotalRetailVal += it.OrderRetailValue
		}
	}

	report.TotalOrderCost = roundTo(report.TotalOrderCost, 2)
	report.TotalRetailValue = roundTo(report.TotalRetailValue, 2)
	report.ExpectedMargin = roundTo(report.TotalRetailValue-report.TotalOrderCost, 2)
	report.FlatOrderCost = roundTo(report.FlatOrderCost, 2)
	report.OverstockFrozenCost = roundTo(report.OverstockFrozenCost, 2)
	report.Items = calcItems

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
			PeriodTotals:   groupRawTotals[g],
			HorizonIndex:   roundTo(hAvg, 3),
			OverstockCost:  roundTo(grpOverstock[g], 2),
		})
	}

	for _, ws := range whMap {
		ws.TotalOrderCost = roundTo(ws.TotalOrderCost, 2)
		ws.TotalRetailVal = roundTo(ws.TotalRetailVal, 2)
		ws.OverstockCost = roundTo(ws.OverstockCost, 2)
		report.Warehouses = append(report.Warehouses, *ws)
	}
	sort.Slice(report.Warehouses, func(i, j int) bool {
		return report.Warehouses[i].Warehouse < report.Warehouses[j].Warehouse
	})

	for _, ss := range supMap {
		ss.TotalOrderCost = roundTo(ss.TotalOrderCost, 2)
		ss.TotalRetailVal = roundTo(ss.TotalRetailVal, 2)
		if report.TotalOrderCost > 0 {
			ss.ShareOfBudget = roundTo(ss.TotalOrderCost/report.TotalOrderCost*100.0, 2)
		}
		if ss.OrderItems > 0 && params.MinSupplierOrder > 0 && ss.TotalOrderCost < params.MinSupplierOrder {
			ss.BelowMinOrder = true
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

func buildGroupIndices(groupTotals map[string][]float64, periods []model.PeriodColumn, decay float64) map[string][12]float64 {
	T := len(periods)
	res := make(map[string][12]float64, len(groupTotals))
	for g, gTotals := range groupTotals {
		var mNum [12]float64
		var mDen [12]float64
		for idx, p := range periods {
			if p.Month < 1 || p.Month > 12 {
				continue
			}
			mIdx := p.Month - 1
			recency := math.Pow(decay, float64(T-1-idx)/12.0)
			w := p.Completeness
			if w <= 0 {
				w = 1.0
			}
			mNum[mIdx] += recency * gTotals[idx]
			mDen[mIdx] += recency * w
		}
		var raw [12]float64
		presentSum, presentCnt := 0.0, 0
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
		res[g] = norm
	}
	return res
}

func forecastItem12Months(
	sales []float64,
	activeStart int,
	periods []model.PeriodColumn,
	gIdx [12]float64,
	recencyDecay float64,
	shrinkageK float64,
	mode model.SeasonMode,
) (monthForecast [12]float64, baseRate float64, flatRate float64) {
	T := len(periods)
	numB, denB, denFlat, activeSum := 0.0, 0.0, 0.0, 0.0
	var mNum [12]float64
	var mDen [12]float64

	for idx := activeStart; idx < T && idx < len(sales); idx++ {
		mIdx := periods[idx].Month - 1
		w := periods[idx].Completeness
		if w <= 0 {
			w = 1.0
		}
		lam := math.Pow(recencyDecay, float64(T-1-idx)/12.0)
		numB += lam * sales[idx]
		denB += lam * w * gIdx[mIdx]
		denFlat += lam * w
		activeSum += sales[idx]
		mNum[mIdx] += lam * sales[idx]
		mDen[mIdx] += lam * w
	}

	if denB > 0 {
		baseRate = numB / denB
	}
	if denFlat > 0 {
		flatRate = numB / denFlat
	}

	theta := 0.0
	if activeSum > 0 {
		if shrinkageK == 0 {
			theta = 1.0
		} else {
			theta = activeSum / (activeSum + shrinkageK)
		}
	}

	for m := 0; m < 12; m++ {
		groupEst := baseRate * gIdx[m]
		directEst := groupEst
		if mDen[m] > 0 {
			directEst = mNum[m] / mDen[m]
		}
		switch mode {
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
		default:
			monthForecast[m] = theta*directEst + (1.0-theta)*groupEst
		}
	}
	return monthForecast, baseRate, flatRate
}

// winsorizeItemSales мягко ограничивает разовые оптовые/тендерные выбросы продаж (например 1100 шт. в одном месяце при обычных 2..18 шт.).
func winsorizeItemSales(sales []float64) ([]float64, int) {
	out := make([]float64, len(sales))
	copy(out, sales)

	var nz []float64
	for _, v := range sales {
		if v > 0 {
			nz = append(nz, v)
		}
	}
	if len(nz) < 2 {
		return out, 0
	}
	sort.Float64s(nz)
	withoutMax := nz[:len(nz)-1]
	med := withoutMax[len(withoutMax)/2]
	secondMax := withoutMax[len(withoutMax)-1]

	capThreshold := math.Max(8.0, math.Max(med*3.8, secondMax*1.75))
	cappedCount := 0
	for i, v := range out {
		if v > capThreshold {
			out[i] = capThreshold
			cappedCount++
		}
	}
	return out, cappedCount
}

func classifyXYZ(activeSales []float64, gIdx [12]float64, activePeriods []model.PeriodColumn, sumAll float64) (string, float64) {
	if sumAll <= 0 || len(activeSales) == 0 {
		return "D", 0
	}
	n := len(activeSales)
	deseason := make([]float64, n)
	sum := 0.0
	nz := 0
	for i, v := range activeSales {
		if v > 0 {
			nz++
		}
		idx := 1.0
		if i < len(activePeriods) {
			g := gIdx[activePeriods[i].Month-1]
			if g > 0.2 {
				idx = g
			}
		}
		w := 1.0
		if i < len(activePeriods) && activePeriods[i].Completeness > 0 {
			w = activePeriods[i].Completeness
		}
		dv := v / (w * idx)
		deseason[i] = dv
		sum += dv
	}
	mean := sum / float64(n)
	if mean <= 1e-9 {
		return "Z", 9.99
	}
	variance := 0.0
	for _, dv := range deseason {
		diff := dv - mean
		variance += diff * diff
	}
	cv := math.Sqrt(variance/float64(n)) / mean
	nzShare := float64(nz) / float64(n)

	switch {
	case nzShare >= 0.45 && cv <= 0.85:
		return "X", cv
	case nzShare >= 0.16 && cv <= 1.65:
		return "Y", cv
	default:
		return "Z", cv
	}
}

// computeCrostonSBARate реализует Syntetos–Boylan Approximation для редкого прерывистого спроса (класс Z).
func computeCrostonSBARate(activeSales []float64, activePeriods []model.PeriodColumn) float64 {
	alpha := 0.25
	sizeEst := 0.0
	intervalEst := 0.0
	sinceLast := 0.0
	initialized := false

	for i, v := range activeSales {
		w := 1.0
		if i < len(activePeriods) && activePeriods[i].Completeness > 0 {
			w = activePeriods[i].Completeness
		}
		sinceLast += w
		if v > 0 {
			if !initialized {
				sizeEst = v
				intervalEst = math.Max(1.0, sinceLast)
				initialized = true
			} else {
				sizeEst = alpha*v + (1.0-alpha)*sizeEst
				intervalEst = alpha*sinceLast + (1.0-alpha)*intervalEst
			}
			sinceLast = 0
		}
	}
	if !initialized {
		return 0
	}
	if sinceLast > intervalEst {
		intervalEst = 0.5*intervalEst + 0.5*sinceLast
	}
	if intervalEst < 1.0 {
		intervalEst = 1.0
	}
	return (1.0 - alpha/2.0) * (sizeEst / intervalEst)
}

func safetyMultiplierForSegment(abc, xyz string) float64 {
	switch abc {
	case "A":
		switch xyz {
		case "X":
			return 1.25
		case "Y":
			return 1.15
		default:
			return 0.95
		}
	case "B":
		switch xyz {
		case "X":
			return 1.10
		case "Y":
			return 1.00
		default:
			return 0.75
		}
	default:
		switch xyz {
		case "X":
			return 0.95
		case "Y":
			return 0.80
		default:
			return 0.50
		}
	}
}

func computePriorityScore(abc, xyz string, stock, daysSupply, price, retail, seasonIdx float64) float64 {
	abcBase := 35.0
	switch abc {
	case "A":
		abcBase = 62.0
	case "B":
		abcBase = 48.0
	}
	xyzBonus := 0.0
	if xyz == "X" {
		xyzBonus = 12.0
	} else if xyz == "Y" {
		xyzBonus = 6.0
	}
	urgency := 20.0 / (1.0 + math.Max(0, daysSupply)/7.0)
	if stock <= 0 {
		urgency += 8.0
	}
	marginBonus := 0.0
	if price > 0 && retail > price {
		marginBonus = math.Min(8.0, (retail/price-1.0)*8.0)
	}
	seasonBonus := math.Min(6.0, math.Max(-4.0, (seasonIdx-1.0)*6.0))
	return math.Min(100.0, math.Max(1.0, abcBase+xyzBonus+urgency+marginBonus+seasonBonus))
}

func applyBudgetCapOptimizer(items []model.CalculatedItem, budgetCap float64, groupMarkup map[string]float64, totalSpanDays int) {
	type unitSlot struct {
		itemIdx   int
		unitScore float64
		unitPrice float64
	}

	remaining := budgetCap
	for i := range items {
		if items[i].ManualOverride != nil {
			remaining -= float64(items[i].FinalOrderQty) * items[i].PurchasePrice
		}
	}
	if remaining < 0 {
		remaining = 0
	}

	var slots []unitSlot
	autoInitial := make([]int, len(items))
	for i := range items {
		it := &items[i]
		if it.ManualOverride != nil || it.FinalOrderQty <= 0 {
			continue
		}
		autoInitial[i] = it.FinalOrderQty
		if it.PurchasePrice <= 0 {
			continue
		}
		for u := 0; u < it.FinalOrderQty; u++ {
			diminishing := 1.0 / (1.0 + 0.18*float64(u))
			efficiency := (it.PriorityScore * diminishing) / math.Pow(math.Max(0.5, it.PurchasePrice), 0.35)
			slots = append(slots, unitSlot{
				itemIdx:   i,
				unitScore: efficiency,
				unitPrice: it.PurchasePrice,
			})
		}
		it.FinalOrderQty = 0
	}

	sort.Slice(slots, func(i, j int) bool {
		return slots[i].unitScore > slots[j].unitScore
	})

	for _, sl := range slots {
		if sl.unitPrice <= remaining+1e-9 {
			items[sl.itemIdx].FinalOrderQty++
			remaining -= sl.unitPrice
		}
	}

	for i := range items {
		it := &items[i]
		if autoInitial[i] > 0 && it.FinalOrderQty < autoInitial[i] {
			it.BudgetTrimmedQty = autoInitial[i] - it.FinalOrderQty
			effectiveRetail := it.RetailPrice
			if effectiveRetail <= 0 && it.PurchasePrice > 0 {
				mult := groupMarkup[it.Group]
				if mult <= 1.0 {
					mult = 1.0
				}
				effectiveRetail = it.PurchasePrice * mult
			}
			it.OrderCost = roundTo(float64(it.FinalOrderQty)*it.PurchasePrice, 2)
			it.OrderRetailValue = roundTo(float64(it.FinalOrderQty)*effectiveRetail, 2)
			it.Explanation = buildExplanationV2(
				it.SalesSegmentLabel, it.BaseMonthlyRate, it.HorizonSeasonIdx,
				totalSpanDays,
				it.ForecastDemand, it.EffectiveSafety, it.TargetStock, it.ClosingStock,
				it.AutoOrderQty, it.OutlierMonths, it.ManualOverride, false, it.BudgetTrimmedQty,
			)
		}
	}
}

func matrixCoords(abc, xyz string) (int, int, bool) {
	r, c := -1, -1
	switch abc {
	case "A":
		r = 0
	case "B":
		r = 1
	case "C":
		r = 2
	}
	switch xyz {
	case "X":
		c = 0
	case "Y":
		c = 1
	case "Z":
		c = 2
	}
	if r < 0 || c < 0 {
		return 0, 0, false
	}
	return r, c, true
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

func quantileSorted(sorted []float64, p float64) float64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	if n == 1 {
		return sorted[0]
	}
	pos := float64(n-1) * p
	lo := int(math.Floor(pos))
	hi := int(math.Ceil(pos))
	if lo < 0 {
		lo = 0
	}
	if hi >= n {
		hi = n - 1
	}
	frac := pos - float64(lo)
	return sorted[lo] + (sorted[hi]-sorted[lo])*frac
}

// computeSalesSegments рассчитывает 6-уровневый параметр сегментов продаж (0..5):
//   - 0 ("0-Нет продаж") — продажи отсутствуют в течение последних 6 месяцев (sumLast6 <= 0)
//   - 1 ("1-Низкий") .. 5 ("5-Высокий") — квинтили (20/40/60/80%) интенсивности продаж за 6 месяцев среди активных SKU
func computeSalesSegments(items []model.RawItem, periods []model.PeriodColumn) ([]int, []float64) {
	T := len(periods)
	startIdx := T - 6
	if startIdx < 0 {
		startIdx = 0
	}

	n := len(items)
	sum6 := make([]float64, n)
	active := make([]float64, 0, n)
	for i, it := range items {
		s6 := 0.0
		for pIdx := startIdx; pIdx < T && pIdx < len(it.MonthlySales); pIdx++ {
			s6 += it.MonthlySales[pIdx]
		}
		sum6[i] = s6
		if s6 > 0 {
			active = append(active, s6)
		}
	}

	segments := make([]int, n)
	if len(active) == 0 {
		return segments, sum6
	}

	sort.Float64s(active)
	allSame := active[0] == active[len(active)-1]
	q20 := quantileSorted(active, 0.20)
	q40 := quantileSorted(active, 0.40)
	q60 := quantileSorted(active, 0.60)
	q80 := quantileSorted(active, 0.80)

	for i, s6 := range sum6 {
		if s6 <= 0 {
			segments[i] = 0
			continue
		}
		if allSame {
			segments[i] = 3
			continue
		}
		switch {
		case s6 <= q20+1e-9:
			segments[i] = 1
		case s6 <= q40+1e-9:
			segments[i] = 2
		case s6 <= q60+1e-9:
			segments[i] = 3
		case s6 <= q80+1e-9:
			segments[i] = 4
		default:
			segments[i] = 5
		}
	}
	return segments, sum6
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
	default:
		if deficit < 0.5 {
			return 0
		}
		return int(math.Floor(deficit + 0.5))
	}
}

func buildExplanationV2(
	abcxyz string,
	baseRate float64,
	seasonIdx float64,
	spanDays int,
	demand float64,
	safetyPct float64,
	targetStock float64,
	closingStock float64,
	autoQty int,
	outliers int,
	override *int,
	minDisplay bool,
	budgetTrimmed int,
) string {
	var parts []string
	parts = append(parts, fmt.Sprintf("[%s] База %.2f/мес. (×%.2f)", abcxyz, baseRate, seasonIdx))
	if outliers > 0 {
		parts = append(parts, fmt.Sprintf("(сглажено опт-выбросов: %d)", outliers))
	}
	if spanDays > 1 {
		parts = append(parts, fmt.Sprintf("→ спрос %d дн.: %.2f", spanDays, demand))
	} else {
		parts = append(parts, fmt.Sprintf("→ спрос: %.2f", demand))
	}
	parts = append(parts, fmt.Sprintf("+ SLA %.0f%% → запас %.2f", safetyPct, targetStock))
	if minDisplay {
		parts = append(parts, "(витрина)")
	}
	parts = append(parts, fmt.Sprintf("− ост. %.0f = авто %d ед.", closingStock, autoQty))
	if budgetTrimmed > 0 {
		parts = append(parts, fmt.Sprintf("[лимит бюджета: −%d ед.]", budgetTrimmed))
	}
	if override != nil {
		parts = append(parts, fmt.Sprintf("[вручную: %d ед.]", *override))
	}
	return strings.Join(parts, " ")
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

func roundTo(v float64, decimals int) float64 {
	p := math.Pow(10, float64(decimals))
	return math.Round(v*p) / p
}
