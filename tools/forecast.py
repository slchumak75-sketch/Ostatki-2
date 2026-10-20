# -*- coding: utf-8 -*-
"""
Эталонная (reference) реализация алгоритма «К закупке» на Python.

ВАЖНО ДЛЯ АГЕНТОВ: этот файл — зеркало Go-пакета internal/forecast.
Формулы и параметры по умолчанию ОБЯЗАНЫ совпадать. При изменении алгоритма
меняйте оба места и docs/ALGORITHM.md. См. docs/AGENT_HANDOFF.md.

Используется:
  - tools/analyze.py       — анализ исходного файла (цифры для docs/ANALYSIS.md)
  - tools/fill_purchase.py — заполнение столбца H (8-го) в копии исходного xlsx
  - tools/dev_server.py    — dev-сервер с тем же API, что и Go-приложение
"""
import math
import re
import statistics

MONTHS_RU = {
    "январ": 1, "феврал": 2, "март": 3, "апрел": 4, "май": 5, "мая": 5,
    "июн": 6, "июл": 7, "август": 8, "сентябр": 9, "октябр": 10,
    "ноябр": 11, "декабр": 12,
}
MONTH_NAMES_RU = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
                  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"]

DEFAULT_PARAMS = {
    "horizon": 3,           # на сколько ПОЛНЫХ месяцев вперёд закупаем
    "safetyPercent": 20.0,  # страховой запас, % от прогноза на горизонт
    "leadDays": 14.0,       # срок поставки, дней (спрос за время поставки)
    "deadMonths": 12,       # нет продаж N полных мес. -> не закупать
    "partialLast": True,    # последний месячный столбец — неполный месяц
    "useTrend": True,       # затухающий тренд для «больших» SKU
    "shrinkageK": 30.0,     # сглаживание сезонности товара к группе
}

_NUM_RE = re.compile(r"-?\d+(?:[.,]\d+)?")


def parse_num(value):
    """Число из ячейки 1С-выгрузки.

    Особенности файла: числа часто строками ("8.00"), пустая цена — " ",
    а в розничной цене встречается ДВА числа через перевод строки
    (старая и новая цена) — берём ПОСЛЕДНЕЕ (оно даёт типовую наценку 50%).
    Возвращает None, если числа нет.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value)
    found = _NUM_RE.findall(s.replace("\u00a0", " "))
    if not found:
        return None
    try:
        return float(found[-1].replace(",", "."))
    except ValueError:
        return None


def parse_month_header(text):
    """'Октябрь 2023 г.' -> (2023, 10) или None."""
    if text is None:
        return None
    s = str(text).lower()
    year_m = re.search(r"(20\d\d)", s)
    if not year_m:
        return None
    for stem, num in MONTHS_RU.items():
        if stem in s:
            return (int(year_m.group(1)), num)
    return None


def _median_or(values, default=0.0):
    vals = [v for v in values if v is not None]
    return statistics.median(vals) if vals else default


def _seasonal_indices(series_list, cal_months):
    """Индексы сезонности [12] по набору рядов; среднее индексов = 1."""
    sums = [0.0] * 13
    counts = [0] * 13
    total = 0.0
    n_months = len(cal_months)
    for series in series_list:
        for t, v in enumerate(series):
            c = cal_months[t]
            sums[c] += v
            total += v
    for c in cal_months:
        counts[c] += 1
    if total <= 0 or n_months == 0:
        return [1.0] * 12
    avg_month = total / n_months
    idx = []
    for c in range(1, 13):
        if counts[c] == 0 or avg_month == 0:
            idx.append(1.0)
        else:
            # sums[c] накоплена по всем рядам; нормируем на число рядов через total:
            # средний объём месяца c (на все ряды) / средний объём месяца вообще
            idx.append((sums[c] / counts[c]) / avg_month)
    m = sum(idx) / 12.0
    if m > 0:
        idx = [x / m for x in idx]
    return idx


def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


def compute(rows, months, params=None):
    """Главная функция.

    rows: list[dict] с ключами warehouse, group, article, name, unit, rashod,
          stock, purchasePrice, retailPrice(None), supplier, sales[list[float]]
    months: list[(year, month)] — по числу месячных столбцов, по порядку.
    Возвращает dict состояния (тот же JSON, что отдаёт Go-сервер, без fileName).
    """
    p = dict(DEFAULT_PARAMS)
    if params:
        p.update({k: v for k, v in params.items() if v is not None})
    horizon = int(p["horizon"])
    safety_pct = float(p["safetyPercent"])
    lead_days = float(p["leadDays"])
    dead_months = int(p["deadMonths"])
    partial_last = bool(p["partialLast"])
    use_trend = bool(p["useTrend"])
    shrink_k = float(p["shrinkageK"])

    n_cols = len(months)
    n_full = n_cols - 1 if partial_last and n_cols > 1 else n_cols
    full_months = months[:n_full]                     # только полные месяцы
    cal_full = [m for (_y, m) in full_months]
    partial_sold_idx = n_full if partial_last and n_cols > 1 else None

    # --- сезонность: глобальная и по группам (только полные месяцы) ---
    hist = [r["sales"][:n_full] for r in rows]
    seasonal_global = _seasonal_indices(hist, cal_full)
    groups = {}
    for i, r in enumerate(rows):
        groups.setdefault(r["group"] or "", []).append(i)
    seasonal_group = {}
    for g, idxs in groups.items():
        tot = sum(sum(hist[i]) for i in idxs)
        if tot >= 100:
            seasonal_group[g] = _seasonal_indices([hist[i] for i in idxs], cal_full)
        else:
            seasonal_group[g] = list(seasonal_global)

    # --- медианная наценка по группам (для оценки розницы, где её нет) ---
    markup_by_group = {}
    all_markups = []
    for g, idxs in groups.items():
        mk = []
        for i in idxs:
            r = rows[i]
            pp, rp = r["purchasePrice"], r["retailPrice"]
            if pp and rp and pp > 0 and rp > 0:
                mk.append((rp - pp) / pp * 100.0)
        markup_by_group[g] = _median_or(mk, 50.0)
        all_markups += mk
    median_markup_all = _median_or(all_markups, 50.0)

    # --- месяцы прогноза: остаток неполного + horizon полных ---
    forecast_months = []  # [{year, month, label, remainder}]
    if n_cols:
        if partial_last and n_cols > 1:
            y, m = months[n_full]
            forecast_months.append({"year": y, "month": m, "remainder": True,
                                    "label": f"{MONTH_NAMES_RU[m-1]} {y} (остаток)"})
            start_y, start_m = y, m
        else:
            start_y, start_m = months[-1]
        y, m = start_y, start_m
        for _ in range(horizon):
            m += 1
            if m > 12:
                m, y = 1, y + 1
            forecast_months.append({"year": y, "month": m, "remainder": False,
                                    "label": f"{MONTH_NAMES_RU[m-1]} {y}"})

    out_rows = []
    for i, r in enumerate(rows):
        s_full = hist[i]
        total_full = sum(s_full)
        sales12 = sum(s_full[-12:]) if n_full else 0.0
        sales_prev12 = sum(s_full[-24:-12]) if n_full >= 24 else 0.0
        g_idx = seasonal_group.get(r["group"] or "", seasonal_global)

        # сезонность товара со сглаживанием к группе
        if total_full > 0 and n_full:
            avg = total_full / n_full
            raw = []
            for c in range(1, 13):
                vals = [s_full[t] for t in range(n_full) if cal_full[t] == c]
                raw.append((sum(vals) / len(vals) / avg) if vals and avg > 0 else g_idx[c-1])
            w = total_full / (total_full + shrink_k) if shrink_k > 0 else 1.0
            blended = [w * _clamp(raw[c], 0.0, 3.0) + (1 - w) * g_idx[c] for c in range(12)]
            mean_b = sum(blended) / 12.0
            if mean_b > 0:
                blended = [x / mean_b for x in blended]
            item_idx = [_clamp(x, 0.15, 3.0) for x in blended]
        else:
            item_idx = list(g_idx)

        # базовый (десезонализированный) уровень по последним 12 полным месяцам
        window = s_full[-12:] if n_full >= 12 else s_full
        window_cal = cal_full[-len(window):] if window else []
        if window and sum(window) > 0:
            base = sum(v / item_idx[c-1] for v, c in zip(window, window_cal)) / len(window)
        elif total_full > 0:
            base = sum(v / item_idx[c-1] for v, c in zip(s_full, cal_full)) / n_full
        else:
            base = 0.0

        # затухающий тренд (только для SKU с достаточной историей)
        trend = 1.0
        if use_trend and total_full >= 36 and n_full >= 24 and sales_prev12 > 0:
            ds_last = sum(v / item_idx[c-1] for v, c in zip(s_full[-12:], cal_full[-12:]))
            ds_prev = sum(v / item_idx[c-1] for v, c in zip(s_full[-24:-12], cal_full[-24:-12:]))
            if ds_prev > 0:
                ratio = _clamp(ds_last / ds_prev, 0.5, 1.8)
                trend = _clamp(1.0 + 0.5 * (ratio - 1.0), 0.75, 1.4)
                base *= trend

        # прогноз по месяцам
        fc = []
        full_fc_values = []
        for fm in forecast_months:
            v = base * item_idx[fm["month"] - 1]
            if fm["remainder"]:
                v = max(0.0, v - (r["sales"][partial_sold_idx] if partial_sold_idx is not None else 0.0))
            else:
                full_fc_values.append(v)
            fc.append(round(v, 2))
        forecast_total = sum(fc)
        avg_fc_month = (sum(full_fc_values) / len(full_fc_values)) if full_fc_values else 0.0
        lead_demand = avg_fc_month * (lead_days / 30.44)
        safety = forecast_total * safety_pct / 100.0
        need = forecast_total + lead_demand + safety

        stock = r["stock"] or 0.0
        # «мёртвый» товар: нет продаж за последние dead_months полных месяцев
        recent = s_full[-dead_months:] if dead_months > 0 and n_full else s_full
        no_recent_sales = (sum(recent) == 0)
        # дробный товар?
        fractional = any(abs(v - round(v)) > 1e-9 for v in r["sales"]) or abs(stock - round(stock)) > 1e-9
        raw_rec = need - stock
        if no_recent_sales or total_full == 0 or raw_rec <= 0:
            rec = 0.0
        else:
            rec = math.ceil(raw_rec * 100) / 100.0 if fractional else float(math.ceil(raw_rec))

        # последний месяц с продажей (по полным + неполному)
        last_sale_label, months_since = None, None
        for t in range(n_cols - 1, -1, -1):
            if r["sales"][t] > 0:
                yy, mm = months[t]
                last_sale_label = f"{MONTH_NAMES_RU[mm-1]} {yy}"
                months_since = (n_full - 1 - t) if t < n_full else 0
                break

        pp = r["purchasePrice"] or 0.0
        rp = r["retailPrice"]
        retail_est = False
        if not rp or rp <= 0:
            rp_eff = pp * (1 + markup_by_group.get(r["group"] or "", median_markup_all) / 100.0) if pp > 0 else 0.0
            retail_est = True
        else:
            rp_eff = rp
        margin = ((rp_eff - pp) / rp_eff * 100.0) if rp_eff > 0 and pp > 0 else None
        markup = ((rp_eff - pp) / pp * 100.0) if rp_eff > 0 and pp > 0 else None
        profit_unit = (rp_eff - pp) if pp > 0 else 0.0
        # Запас в месяцах — от ДЕСЕЗОНАЛИЗИРОВАННОГО темпа (base), иначе зимой
        # летний товар ложно выглядит «избыточным». base уже с трендом.
        months_of_stock = (stock / base) if base > 0 else None

        if rec > 0 and stock == 0:
            status = "urgent"
        elif rec > 0:
            status = "order"
        elif no_recent_sales:
            status = "dead"
        elif months_of_stock is not None and months_of_stock > 12 and stock > 0:
            status = "excess"
        else:
            status = "ok"

        nz_months = sum(1 for v in s_full if v > 0)
        regularity = ("regular" if nz_months >= 18 else
                      "irregular" if nz_months >= 6 else "sporadic")

        out_rows.append({
            **r,
            "id": i,
            "sales12": sales12, "sales36": total_full,
            "avgMonthly12": (sales12 / 12.0) if n_full >= 12 else (total_full / n_full if n_full else 0.0),
            "seasonal": [round(x, 3) for x in item_idx],
            "baseLevel": round(base, 3), "trendFactor": round(trend, 3),
            "forecast": fc, "forecastTotal": round(forecast_total, 2),
            "leadDemand": round(lead_demand, 2), "safetyStock": round(safety, 2),
            "need": round(need, 2), "recommend": rec,
            "retailEstimated": retail_est,
            "retailEffective": round(rp_eff, 2) if rp_eff else None,
            "marginPct": round(margin, 2) if margin is not None else None,
            "markupPct": round(markup, 2) if markup is not None else None,
            "profitPerUnit": round(profit_unit, 2),
            "stockPurchase": round(stock * pp, 2),
            "stockRetail": round(stock * rp_eff, 2) if rp_eff else 0.0,
            "orderCost": round(rec * pp, 2),
            "expectedProfit": round(rec * profit_unit, 2),
            "monthsOfStock": round(months_of_stock, 1) if months_of_stock is not None else None,
            "lastSaleLabel": last_sale_label, "monthsSinceSale": months_since,
            "status": status, "regularity": regularity, "abc": "",
            "_gross12": sales12 * profit_unit,
        })

    # ABC по валовой прибыли за 12 мес.
    order = sorted(out_rows, key=lambda x: -x["_gross12"])
    total_gross = sum(max(0.0, x["_gross12"]) for x in out_rows)
    acc = 0.0
    for x in order:
        g = max(0.0, x["_gross12"])
        if total_gross <= 0 or g == 0:
            x["abc"] = "C"
        else:
            acc += g
            share = acc / total_gross
            x["abc"] = "A" if share <= 0.80 else ("B" if share <= 0.95 else "C")
        x["grossProfit12"] = round(x["_gross12"], 2)
        del x["_gross12"]

    return {
        "params": p,
        "months": [{"year": y, "month": m, "label": f"{MONTH_NAMES_RU[m-1]} {y}"} for (y, m) in months],
        "forecastMonths": forecast_months,
        "seasonalGlobal": [round(x, 3) for x in seasonal_global],
        "seasonalByGroup": {g: [round(x, 3) for x in v] for g, v in seasonal_group.items()},
        "rows": out_rows,
    }


def summarize(state, rows_raw):
    """Сводные KPI + разрезы по группам/поставщикам + предупреждения о данных."""
    rows = state["rows"]
    dead = [r for r in rows if r["status"] == "dead" and (r["stock"] or 0) > 0]
    order = [r for r in rows if r["recommend"] > 0]
    margins = [r["marginPct"] for r in rows if r["marginPct"] is not None and not r["retailEstimated"]]
    markups = [r["markupPct"] for r in rows if r["markupPct"] is not None and not r["retailEstimated"]]
    summary = {
        "sku": len(rows),
        "warehouses": len(set(r["warehouse"] for r in rows)),
        "groups": len(set(r["group"] for r in rows)),
        "suppliers": len(set(r["supplier"] for r in rows)),
        "stockUnits": round(sum(r["stock"] or 0 for r in rows), 2),
        "stockPurchase": round(sum(r["stockPurchase"] for r in rows), 2),
        "stockRetail": round(sum(r["stockRetail"] for r in rows), 2),
        "potentialProfit": round(sum(r["stockRetail"] - r["stockPurchase"] for r in rows), 2),
        "avgMarginPct": round(sum(margins) / len(margins), 2) if margins else None,
        "medianMarkupPct": round(_median_or(markups), 2) if markups else None,
        "orderSku": len(order),
        "orderUnits": round(sum(r["recommend"] for r in order), 2),
        "orderBudget": round(sum(r["orderCost"] for r in order), 2),
        "orderExpectedProfit": round(sum(r["expectedProfit"] for r in order), 2),
        "urgentSku": sum(1 for r in rows if r["status"] == "urgent"),
        "deadSku": len(dead),
        "deadValue": round(sum(r["stockPurchase"] for r in dead), 2),
        "zeroActiveSku": sum(1 for r in rows if (r["stock"] or 0) == 0 and r["sales12"] > 0),
        "excessSku": sum(1 for r in rows if r["status"] == "excess"),
        "sales12Units": round(sum(r["sales12"] for r in rows), 2),
        "sales36Units": round(sum(r["sales36"] for r in rows), 2),
    }

    def agg(key):
        out = {}
        for r in rows:
            a = out.setdefault(r[key] or "", {"name": r[key] or "", "sku": 0, "stockUnits": 0.0,
                                              "stockPurchase": 0.0, "stockRetail": 0.0, "sales12": 0.0,
                                              "orderSku": 0, "orderUnits": 0.0, "orderBudget": 0.0,
                                              "grossProfit12": 0.0})
            a["sku"] += 1
            a["stockUnits"] += r["stock"] or 0
            a["stockPurchase"] += r["stockPurchase"]
            a["stockRetail"] += r["stockRetail"]
            a["sales12"] += r["sales12"]
            a["grossProfit12"] += r["grossProfit12"]
            if r["recommend"] > 0:
                a["orderSku"] += 1
                a["orderUnits"] += r["recommend"]
                a["orderBudget"] += r["orderCost"]
        for a in out.values():
            for k in ("stockUnits", "stockPurchase", "stockRetail", "sales12", "orderUnits", "orderBudget", "grossProfit12"):
                a[k] = round(a[k], 2)
        return sorted(out.values(), key=lambda x: -x["orderBudget"])

    warnings = []
    mismatch = sum(1 for r in rows_raw
                   if abs((r["rashod"] or 0) - sum(r["sales"])) > 0.01)
    if mismatch:
        warnings.append(f"«Расход» не равен сумме помесячных продаж у {mismatch} строк из {len(rows_raw)} "
                        "(сумма месяцев всегда ≥ «Расхода»). Прогноз построен по помесячным столбцам.")
    n_retail = sum(1 for r in rows_raw if r["retailPrice"])
    if n_retail < len(rows_raw):
        warnings.append(f"Розничная цена заполнена только у {n_retail} из {len(rows_raw)} строк "
                        "(ровно у товаров с остатком > 0). Для остальных розница оценена по медианной наценке группы.")
    n_zero_pp = sum(1 for r in rows_raw if not r["purchasePrice"])
    if n_zero_pp:
        warnings.append(f"Цена поставщика = 0/пуста у {n_zero_pp} строк: бюджет закупки по ним занижен.")
    neg = [r for r in rows if r["marginPct"] is not None and r["marginPct"] < 0 and not r["retailEstimated"]]
    if neg:
        warnings.append(f"Отрицательная маржа (розница < закупка) у {len(neg)} строк.")

    state["summary"] = summary
    state["groupsAgg"] = agg("group")
    state["suppliersAgg"] = agg("supplier")
    state["warehousesAgg"] = agg("warehouse")
    state["warnings"] = warnings
    return state
