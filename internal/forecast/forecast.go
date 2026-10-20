// Package forecast — алгоритм расчёта столбца «К закупке» с учётом сезонности.
//
// ЗЕРКАЛО: tools/forecast.py (Python) реализует те же формулы.
// При изменении формул меняйте оба места, тесты и docs/ALGORITHM.md.
package forecast

import (
	"fmt"
	"math"
	"sort"

	"ostatki/internal/model"
)

// MonthNamesRU — названия месяцев (индекс 0 = январь).
var MonthNamesRU = [12]string{
	"Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
	"Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
}

// MonthLabel возвращает "Октябрь 2023".
func MonthLabel(year, month int) string {
	if month < 1 || month > 12 {
		return fmt.Sprintf("%d-%d", year, month)
	}
	return fmt.Sprintf("%s %d", MonthNamesRU[month-1], year)
}

func clamp(x, lo, hi float64) float64 {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}

func round(x float64, digits int) float64 {
	p := math.Pow(10, float64(digits))
	return math.Round(x*p) / p
}

func fp(v float64) *float64 { return &v }

func median(vals []float64) (float64, bool) {
	if len(vals) == 0 {
		return 0, false
	}
	cp := make([]float64, len(vals))
	copy(cp, vals)
	sort.Float64s(cp)
	n := len(cp)
	if n%2 == 1 {
		return cp[n/2], true
	}
	return (cp[n/2-1] + cp[n/2]) / 2, true
}

// seasonalIndices считает 12 индексов сезонности по набору рядов.
// calMonths[t] — календарный месяц (1..12) столбца t. Среднее индексов = 1.
func seasonalIndices(series [][]float64, calMonths []int) []float64 {
	idx := make([]float64, 12)
	for i := range idx {
		idx[i] = 1
	}
	nMonths := len(calMonths)
	if nMonths == 0 {
		return idx
	}
	var sums [13]float64
	var counts [13]int
	total := 0.0
	for _, s := range series {
		for t := 0; t < nMonths && t < len(s); t++ {
			sums[calMonths[t]] += s[t]
			total += s[t]
		}
	}
	for _, c := range calMonths {
		counts[c]++
	}
	if total <= 0 {
		return idx
	}
	avgMonth := total / float64(nMonths)
	for c := 1; c <= 12; c++ {
		if counts[c] > 0 && avgMonth > 0 {
			idx[c-1] = (sums[c] / float64(counts[c])) / avgMonth
		}
	}
	m := 0.0
	for _, v := range idx {
		m += v
	}
	m /= 12
	if m > 0 {
		for i := range idx {
			idx[i] /= m
		}
	}
	return idx
}

func sumFloats(vals []float64) float64 {
	s := 0.0
	for _, v := range vals {
		s += v
	}
	return s
}

// Compute выполняет полный расчёт и возвращает состояние без FileName/Version/LoadedAt.
func Compute(items []model.Item, months []model.Month, p model.Params) *model.State {
	nCols := len(months)
	nFull := nCols
	if p.PartialLast && nCols > 1 {
		nFull = nCols - 1
	}
	calFull := make([]int, nFull)
	for i := 0; i < nFull; i++ {
		calFull[i] = months[i].Month
	}
	hist := make([][]float64, len(items))
	for i, it := range items {
		h := make([]float64, nFull)
		copy(h, it.Sales)
		hist[i] = h
	}

	seasonalGlobal := seasonalIndices(hist, calFull)
	groupsIdx := map[string][]int{}
	for i, it := range items {
		groupsIdx[it.Group] = append(groupsIdx[it.Group], i)
	}
	seasonalGroup := map[string][]float64{}
	for g, idxs := range groupsIdx {
		total := 0.0
		series := make([][]float64, 0, len(idxs))
		for _, i := range idxs {
			total += sumFloats(hist[i])
			series = append(series, hist[i])
		}
		if total >= 100 {
			seasonalGroup[g] = seasonalIndices(series, calFull)
		} else {
			cp := make([]float64, 12)
			copy(cp, seasonalGlobal)
			seasonalGroup[g] = cp
		}
	}

	// Медианная наценка по группам — для оценки отсутствующей розницы.
	markupByGroup := map[string]float64{}
	var allMarkups []float64
	for g, idxs := range groupsIdx {
		var mk []float64
		for _, i := range idxs {
			it := items[i]
			if it.PurchasePrice != nil && it.RetailPrice != nil && *it.PurchasePrice > 0 && *it.RetailPrice > 0 {
				v := (*it.RetailPrice - *it.PurchasePrice) / *it.PurchasePrice * 100
				mk = append(mk, v)
				allMarkups = append(allMarkups, v)
			}
		}
		if m, ok := median(mk); ok {
			markupByGroup[g] = m
		} else {
			markupByGroup[g] = 50
		}
	}
	medianMarkupAll := 50.0
	if m, ok := median(allMarkups); ok {
		medianMarkupAll = m
	}

	// Месяцы прогноза.
	var forecastMonths []model.ForecastMonth
	if nCols > 0 {
		startY, startM := months[nCols-1].Year, months[nCols-1].Month
		if p.PartialLast && nCols > 1 {
			y, m := months[nFull].Year, months[nFull].Month
			forecastMonths = append(forecastMonths, model.ForecastMonth{
				Year: y, Month: m, Remainder: true,
				Label: MonthLabel(y, m) + " (остаток)",
			})
			startY, startM = y, m
		}
		y, m := startY, startM
		for k := 0; k < p.Horizon; k++ {
			m++
			if m > 12 {
				m = 1
				y++
			}
			forecastMonths = append(forecastMonths, model.ForecastMonth{
				Year: y, Month: m, Label: MonthLabel(y, m),
			})
		}
	}

	rows := make([]model.Row, len(items))
	for i, it := range items {
		sFull := hist[i]
		totalFull := sumFloats(sFull)
		last12From := nFull - 12
		if last12From < 0 {
			last12From = 0
		}
		sales12 := sumFloats(sFull[last12From:])
		var salesPrev12 float64
		if nFull >= 24 {
			salesPrev12 = sumFloats(sFull[nFull-24 : nFull-12])
		}
		gIdx := seasonalGroup[it.Group]
		if gIdx == nil {
			gIdx = seasonalGlobal
		}

		// Сезонность товара + сглаживание к группе.
		itemIdx := make([]float64, 12)
		copy(itemIdx, gIdx)
		if totalFull > 0 && nFull > 0 {
			avg := totalFull / float64(nFull)
			raw := make([]float64, 12)
			for c := 1; c <= 12; c++ {
				sum, cnt := 0.0, 0
				for t := 0; t < nFull; t++ {
					if calFull[t] == c {
						sum += sFull[t]
						cnt++
					}
				}
				if cnt > 0 && avg > 0 {
					raw[c-1] = (sum / float64(cnt)) / avg
				} else {
					raw[c-1] = gIdx[c-1]
				}
			}
			w := 1.0
			if p.ShrinkageK > 0 {
				w = totalFull / (totalFull + p.ShrinkageK)
			}
			blended := make([]float64, 12)
			meanB := 0.0
			for c := 0; c < 12; c++ {
				blended[c] = w*clamp(raw[c], 0, 3) + (1-w)*gIdx[c]
				meanB += blended[c]
			}
			meanB /= 12
			if meanB > 0 {
				for c := 0; c < 12; c++ {
					blended[c] /= meanB
				}
			}
			for c := 0; c < 12; c++ {
				itemIdx[c] = clamp(blended[c], 0.15, 3)
			}
		}

		// Базовый десезонализированный уровень.
		base := 0.0
		winFrom := last12From
		if nFull > 0 && sumFloats(sFull[winFrom:]) > 0 {
			acc := 0.0
			for t := winFrom; t < nFull; t++ {
				acc += sFull[t] / itemIdx[calFull[t]-1]
			}
			base = acc / float64(nFull-winFrom)
		} else if totalFull > 0 && nFull > 0 {
			acc := 0.0
			for t := 0; t < nFull; t++ {
				acc += sFull[t] / itemIdx[calFull[t]-1]
			}
			base = acc / float64(nFull)
		}

		// Затухающий тренд.
		trend := 1.0
		if p.UseTrend && totalFull >= 36 && nFull >= 24 && salesPrev12 > 0 {
			dsLast, dsPrev := 0.0, 0.0
			for t := nFull - 12; t < nFull; t++ {
				dsLast += sFull[t] / itemIdx[calFull[t]-1]
			}
			for t := nFull - 24; t < nFull-12; t++ {
				dsPrev += sFull[t] / itemIdx[calFull[t]-1]
			}
			if dsPrev > 0 {
				ratio := clamp(dsLast/dsPrev, 0.5, 1.8)
				trend = clamp(1+0.5*(ratio-1), 0.75, 1.4)
				base *= trend
			}
		}

		// Прогноз по месяцам.
		fc := make([]float64, len(forecastMonths))
		fullFcSum, fullFcCnt := 0.0, 0
		for k, fm := range forecastMonths {
			v := base * itemIdx[fm.Month-1]
			if fm.Remainder {
				if p.PartialLast && nCols > 1 && nFull < len(it.Sales) {
					v -= it.Sales[nFull]
				}
				if v < 0 {
					v = 0
				}
			} else {
				fullFcSum += v
				fullFcCnt++
			}
			fc[k] = round(v, 2)
		}
		forecastTotal := sumFloats(fc)
		avgFcMonth := 0.0
		if fullFcCnt > 0 {
			avgFcMonth = fullFcSum / float64(fullFcCnt)
		}
		leadDemand := avgFcMonth * (p.LeadDays / 30.44)
		safety := forecastTotal * p.SafetyPercent / 100
		need := forecastTotal + leadDemand + safety

		stock := it.Stock
		recentFrom := nFull - p.DeadMonths
		if p.DeadMonths <= 0 || recentFrom < 0 {
			recentFrom = 0
		}
		noRecentSales := sumFloats(sFull[recentFrom:]) == 0
		fractional := math.Abs(stock-math.Round(stock)) > 1e-9
		if !fractional {
			for _, v := range it.Sales {
				if math.Abs(v-math.Round(v)) > 1e-9 {
					fractional = true
					break
				}
			}
		}
		recommend := 0.0
		rawRec := need - stock
		if !noRecentSales && totalFull > 0 && rawRec > 0 {
			if fractional {
				recommend = math.Ceil(rawRec*100) / 100
			} else {
				recommend = math.Ceil(rawRec)
			}
		}

		var lastSaleLabel *string
		var monthsSince *int
		for t := nCols - 1; t >= 0; t-- {
			if t < len(it.Sales) && it.Sales[t] > 0 {
				s := MonthLabel(months[t].Year, months[t].Month)
				lastSaleLabel = &s
				ms := 0
				if t < nFull {
					ms = nFull - 1 - t
				}
				monthsSince = &ms
				break
			}
		}

		pp := 0.0
		if it.PurchasePrice != nil {
			pp = *it.PurchasePrice
		}
		retailEff := 0.0
		retailEstimated := false
		if it.RetailPrice != nil && *it.RetailPrice > 0 {
			retailEff = *it.RetailPrice
		} else {
			retailEstimated = true
			mk := medianMarkupAll
			if v, ok := markupByGroup[it.Group]; ok {
				mk = v
			}
			if pp > 0 {
				retailEff = pp * (1 + mk/100)
			}
		}
		var marginPct, markupPct, retailEffPtr *float64
		profitUnit := 0.0
		if pp > 0 {
			profitUnit = retailEff - pp
		}
		if retailEff > 0 && pp > 0 {
			marginPct = fp(round((retailEff-pp)/retailEff*100, 2))
			markupPct = fp(round((retailEff-pp)/pp*100, 2))
		}
		if retailEff > 0 {
			retailEffPtr = fp(round(retailEff, 2))
		}
		var monthsOfStock *float64
		if base > 0 {
			// От десезонализированного темпа, не от зимнего/летнего прогноза.
			monthsOfStock = fp(round(stock/base, 1))
		}

		status := "ok"
		switch {
		case recommend > 0 && stock == 0:
			status = "urgent"
		case recommend > 0:
			status = "order"
		case noRecentSales:
			status = "dead"
		case monthsOfStock != nil && *monthsOfStock > 12 && stock > 0:
			status = "excess"
		}

		nzMonths := 0
		for _, v := range sFull {
			if v > 0 {
				nzMonths++
			}
		}
		regularity := "sporadic"
		if nzMonths >= 18 {
			regularity = "regular"
		} else if nzMonths >= 6 {
			regularity = "irregular"
		}

		avgMonthly12 := 0.0
		if nFull >= 12 {
			avgMonthly12 = sales12 / 12
		} else if nFull > 0 {
			avgMonthly12 = totalFull / float64(nFull)
		}

		seasonalRounded := make([]float64, 12)
		for c := 0; c < 12; c++ {
			seasonalRounded[c] = round(itemIdx[c], 3)
		}

		rows[i] = model.Row{
			Item:            it,
			ID:              i,
			Sales12:         sales12,
			Sales36:         totalFull,
			AvgMonthly12:    avgMonthly12,
			Seasonal:        seasonalRounded,
			BaseLevel:       round(base, 3),
			TrendFactor:     round(trend, 3),
			Forecast:        fc,
			ForecastTotal:   round(forecastTotal, 2),
			LeadDemand:      round(leadDemand, 2),
			SafetyStock:     round(safety, 2),
			Need:            round(need, 2),
			Recommend:       recommend,
			RetailEstimated: retailEstimated,
			RetailEffective: retailEffPtr,
			MarginPct:       marginPct,
			MarkupPct:       markupPct,
			ProfitPerUnit:   round(profitUnit, 2),
			StockPurchase:   round(stock*pp, 2),
			StockRetail:     round(stock*retailEff, 2),
			OrderCost:       round(recommend*pp, 2),
			ExpectedProfit:  round(recommend*profitUnit, 2),
			MonthsOfStock:   monthsOfStock,
			LastSaleLabel:   lastSaleLabel,
			MonthsSinceSale: monthsSince,
			Status:          status,
			Regularity:      regularity,
			GrossProfit12:   round(sales12*profitUnit, 2),
		}
	}

	// ABC по валовой прибыли за 12 месяцев.
	order := make([]int, len(rows))
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(a, b int) bool { return rows[order[a]].GrossProfit12 > rows[order[b]].GrossProfit12 })
	totalGross := 0.0
	for _, r := range rows {
		if r.GrossProfit12 > 0 {
			totalGross += r.GrossProfit12
		}
	}
	acc := 0.0
	for _, i := range order {
		g := rows[i].GrossProfit12
		if totalGross <= 0 || g <= 0 {
			rows[i].ABC = "C"
			continue
		}
		acc += g
		share := acc / totalGross
		switch {
		case share <= 0.80:
			rows[i].ABC = "A"
		case share <= 0.95:
			rows[i].ABC = "B"
		default:
			rows[i].ABC = "C"
		}
	}

	st := &model.State{
		Params:         p,
		Months:         months,
		ForecastMonths: forecastMonths,
		SeasonalGlobal: roundedSlice(seasonalGlobal, 3),
		SeasonalByGroup: func() map[string][]float64 {
			out := map[string][]float64{}
			for g, v := range seasonalGroup {
				out[g] = roundedSlice(v, 3)
			}
			return out
		}(),
		Rows: rows,
	}
	summarize(st, items)
	return st
}

func roundedSlice(vals []float64, digits int) []float64 {
	out := make([]float64, len(vals))
	for i, v := range vals {
		out[i] = round(v, digits)
	}
	return out
}

func aggregate(rows []model.Row, key func(*model.Row) string) []model.Agg {
	m := map[string]*model.Agg{}
	for i := range rows {
		r := &rows[i]
		name := key(r)
		a, ok := m[name]
		if !ok {
			a = &model.Agg{Name: name}
			m[name] = a
		}
		a.SKU++
		a.StockUnits += r.Stock
		a.StockPurchase += r.StockPurchase
		a.StockRetail += r.StockRetail
		a.Sales12 += r.Sales12
		a.GrossProfit12 += r.GrossProfit12
		if r.Recommend > 0 {
			a.OrderSKU++
			a.OrderUnits += r.Recommend
			a.OrderBudget += r.OrderCost
		}
	}
	out := make([]model.Agg, 0, len(m))
	for _, a := range m {
		a.StockUnits = round(a.StockUnits, 2)
		a.StockPurchase = round(a.StockPurchase, 2)
		a.StockRetail = round(a.StockRetail, 2)
		a.Sales12 = round(a.Sales12, 2)
		a.OrderUnits = round(a.OrderUnits, 2)
		a.OrderBudget = round(a.OrderBudget, 2)
		a.GrossProfit12 = round(a.GrossProfit12, 2)
		out = append(out, *a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].OrderBudget > out[j].OrderBudget })
	return out
}

func summarize(st *model.State, items []model.Item) {
	s := model.Summary{SKU: len(st.Rows)}
	warehouses := map[string]bool{}
	groups := map[string]bool{}
	suppliers := map[string]bool{}
	var margins, markups []float64
	for _, r := range st.Rows {
		warehouses[r.Warehouse] = true
		groups[r.Group] = true
		suppliers[r.Supplier] = true
		s.StockUnits += r.Stock
		s.StockPurchase += r.StockPurchase
		s.StockRetail += r.StockRetail
		s.Sales12Units += r.Sales12
		s.Sales36Units += r.Sales36
		if r.MarginPct != nil && !r.RetailEstimated {
			margins = append(margins, *r.MarginPct)
		}
		if r.MarkupPct != nil && !r.RetailEstimated {
			markups = append(markups, *r.MarkupPct)
		}
		if r.Recommend > 0 {
			s.OrderSKU++
			s.OrderUnits += r.Recommend
			s.OrderBudget += r.OrderCost
			s.OrderExpectedProfit += r.ExpectedProfit
		}
		switch r.Status {
		case "urgent":
			s.UrgentSKU++
		case "excess":
			s.ExcessSKU++
		case "dead":
			if r.Stock > 0 {
				s.DeadSKU++
				s.DeadValue += r.StockPurchase
			}
		}
		if r.Stock == 0 && r.Sales12 > 0 {
			s.ZeroActiveSKU++
		}
	}
	s.Warehouses = len(warehouses)
	s.Groups = len(groups)
	s.Suppliers = len(suppliers)
	s.StockUnits = round(s.StockUnits, 2)
	s.StockPurchase = round(s.StockPurchase, 2)
	s.StockRetail = round(s.StockRetail, 2)
	s.PotentialProfit = round(s.StockRetail-s.StockPurchase, 2)
	s.OrderUnits = round(s.OrderUnits, 2)
	s.OrderBudget = round(s.OrderBudget, 2)
	s.OrderExpectedProfit = round(s.OrderExpectedProfit, 2)
	s.DeadValue = round(s.DeadValue, 2)
	s.Sales12Units = round(s.Sales12Units, 2)
	s.Sales36Units = round(s.Sales36Units, 2)
	if len(margins) > 0 {
		s.AvgMarginPct = fp(round(sumFloats(margins)/float64(len(margins)), 2))
	}
	if m, ok := median(markups); ok {
		s.MedianMarkupPct = fp(round(m, 2))
	}
	st.Summary = s
	st.GroupsAgg = aggregate(st.Rows, func(r *model.Row) string { return r.Group })
	st.SuppliersAgg = aggregate(st.Rows, func(r *model.Row) string { return r.Supplier })
	st.WarehousesAgg = aggregate(st.Rows, func(r *model.Row) string { return r.Warehouse })

	var warnings []string
	mismatch := 0
	for _, it := range items {
		if it.Rashod != nil && math.Abs(*it.Rashod-sumFloats(it.Sales)) > 0.01 {
			mismatch++
		}
	}
	if mismatch > 0 {
		warnings = append(warnings, fmt.Sprintf(
			"«Расход» не равен сумме помесячных продаж у %d строк из %d (сумма месяцев всегда ≥ «Расхода»). Прогноз построен по помесячным столбцам.",
			mismatch, len(items)))
	}
	nRetail := 0
	nZeroPP := 0
	for _, it := range items {
		if it.RetailPrice != nil {
			nRetail++
		}
		if it.PurchasePrice == nil || *it.PurchasePrice == 0 {
			nZeroPP++
		}
	}
	if nRetail < len(items) {
		warnings = append(warnings, fmt.Sprintf(
			"Розничная цена заполнена только у %d из %d строк (ровно у товаров с остатком > 0). Для остальных розница оценена по медианной наценке группы.",
			nRetail, len(items)))
	}
	if nZeroPP > 0 {
		warnings = append(warnings, fmt.Sprintf(
			"Цена поставщика = 0/пуста у %d строк: бюджет закупки по ним занижен.", nZeroPP))
	}
	neg := 0
	for _, r := range st.Rows {
		if r.MarginPct != nil && *r.MarginPct < 0 && !r.RetailEstimated {
			neg++
		}
	}
	if neg > 0 {
		warnings = append(warnings, fmt.Sprintf(
			"Отрицательная маржа (розница < закупка) у %d строк.", neg))
	}
	st.Warnings = warnings
}
