"use client";

import React, { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/AuthContext";
import { collection, getDocs, query, orderBy, limit } from "firebase/firestore";
import { db } from "@/lib/firebase/config";

interface OrderItem {
  id?: string;
  name: string;
  quantity: number;
  unit?: string;
  category?: string;
}

interface Order {
  id: string;
  orderId?: string;
  siteId?: string;
  siteName?: string;
  orderedByName?: string;
  orderedBy?: string;
  createdAt: string;
  status?: string;
  notes?: string;
  items?: OrderItem[];
}

type FilterType = "aktualne" | "wszystkie";

const CACHE_KEY = "pesam_plac_orders_cache";
const CHECKED_CACHE_KEY = "pesam_driver_checked_items";

const WEEKDAYS = [
  "Niedziela",
  "Poniedziałek",
  "Wtorek",
  "Środa",
  "Czwartek",
  "Piątek",
  "Sobota",
];

const pad = (n: number) => n.toString().padStart(2, "0");

const parseDate = (value: any): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === "string") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value?.toDate === "function") {
    try {
      return value.toDate();
    } catch (_) {
      return null;
    }
  }
  if (typeof value?.seconds === "number") {
    return new Date(value.seconds * 1000);
  }
  return null;
};

const formatTime = (value: any) => {
  const d = parseDate(value);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "--:--";
};

const formatDateShort = (value: any) => {
  const d = parseDate(value);
  if (!d) return "";
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
};

/**
 * Sprawdza dzień złożenia zamówienia względem daty dzisiejszej:
 * - "TODAY": Dzień dzisiejszy (np. 22.10)
 * - "YESTERDAY": Dzień poprzedni (np. 21.10)
 * - "OLDER": Starsze niż 2 dni
 */
export const getOrderDayType = (
  createdAtValue: any,
  nowDate: Date = new Date()
): "TODAY" | "YESTERDAY" | "OLDER" => {
  const d = parseDate(createdAtValue);
  if (!d) return "OLDER";

  const orderYear = d.getFullYear();
  const orderMonth = d.getMonth();
  const orderDay = d.getDate();

  const nowYear = nowDate.getFullYear();
  const nowMonth = nowDate.getMonth();
  const nowDay = nowDate.getDate();

  const todayKey = `${nowYear}-${pad(nowMonth + 1)}-${pad(nowDay)}`;
  const orderDateKey = `${orderYear}-${pad(orderMonth + 1)}-${pad(orderDay)}`;

  const yesterday = new Date(nowYear, nowMonth, nowDay - 1);
  const yesterdayKey = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;

  if (orderDateKey === todayKey) return "TODAY";
  if (orderDateKey === yesterdayKey) return "YESTERDAY";
  if (orderDateKey > todayKey) return "TODAY"; // margines bezpieczeństwa dla zegara
  return "OLDER";
};

const pluralizeItems = (count: number) => {
  if (count === 1) return "1 pozycja";
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} pozycje`;
  }
  return `${count} pozycji`;
};

export default function PlacZamowieniaPage() {
  const { user } = useAuth();

  const [orders, setOrders] = useState<Order[]>([]);
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [filter, setFilter] = useState<FilterType>("aktualne");
  const [search, setSearch] = useState<string>("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [checkedMap, setCheckedMap] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState<Date>(new Date());

  // Toast
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  // Zegar dla aktualności okna 15:00
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Monitorowanie połączenia
  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsOnline(navigator.onLine);

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Wczytanie odznaczonych pozycji z pamięci telefonu
  useEffect(() => {
    try {
      const savedChecked = localStorage.getItem(CHECKED_CACHE_KEY);
      if (savedChecked) {
        setCheckedMap(JSON.parse(savedChecked));
      }
    } catch (e) {
      console.warn("Błąd odczytu checklisty kierowcy:", e);
    }
  }, []);

  // Zapis checklisty
  const toggleItemCheck = (orderId: string, itemIdx: number, itemName: string) => {
    const key = `${orderId}_${itemIdx}_${itemName}`;
    setCheckedMap((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(CHECKED_CACHE_KEY, JSON.stringify(next));
      } catch (e) {
        console.warn("Błąd zapisu checklisty:", e);
      }
      return next;
    });
  };

  const isItemChecked = (orderId: string, itemIdx: number, itemName: string) => {
    const key = `${orderId}_${itemIdx}_${itemName}`;
    return !!checkedMap[key];
  };

  // Wczytanie zamówień z cache
  const loadFromCache = () => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Order[];
        if (Array.isArray(parsed)) {
          setOrders(parsed);
          // Domyślnie rozwiń wszystkie zamówienia, żeby kierowca od razu widział listę
          const ids = new Set(parsed.map((o) => o.id));
          setExpanded(ids);
        }
      }
    } catch (err) {
      console.error("Nie udało się odczytać cache zamówień:", err);
    }
  };

  // Pobieranie świeżych zamówień z bazy
  const fetchOrders = async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setIsOnline(false);
      return;
    }
    setIsLoading(true);
    try {
      const q = query(
        collection(db, "orders"),
        orderBy("createdAt", "desc"),
        limit(60)
      );
      const snapshot = await getDocs(q);
      const fresh: Order[] = snapshot.docs.map((d) => {
        const data = d.data();
        let createdAtStr = "";
        const parsedD = parseDate(data.createdAt);
        if (parsedD) {
          createdAtStr = parsedD.toISOString();
        } else if (typeof data.createdAt === "string") {
          createdAtStr = data.createdAt;
        }

        return {
          id: d.id,
          ...(data as Omit<Order, "id">),
          createdAt: createdAtStr,
        };
      });
      setOrders(fresh);
      setIsOnline(true);

      // Rozwiń domyślnie zamówienia
      const ids = new Set(fresh.map((o) => o.id));
      setExpanded(ids);

      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(fresh));
      } catch (err) {
        console.error("Nie udało się zapisać cache zamówień:", err);
      }
    } catch (err) {
      console.error("Błąd pobierania zamówień:", err);
      showToast("⚠️ Nie udało się odświeżyć zamówień z bazy");
    } finally {
      setIsLoading(false);
    }
  };

  // Start
  useEffect(() => {
    loadFromCache();
    if (typeof navigator !== "undefined" && navigator.onLine) {
      fetchOrders();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Filtrowanie i sortowanie (Dziś na początku, potem Wczoraj)
  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase();

    const matchesSearch = (o: Order) => {
      if (!q) return true;
      const inSite = o.siteName?.toLowerCase().includes(q);
      const inOrderer = o.orderedByName?.toLowerCase().includes(q);
      const inItems = o.items?.some((i) => i.name?.toLowerCase().includes(q));
      const inOrderId = o.orderId?.toLowerCase().includes(q);
      return Boolean(inSite || inOrderer || inItems || inOrderId);
    };

    if (filter === "aktualne") {
      const active = orders.filter((o) => {
        const dayType = getOrderDayType(o.createdAt, now);
        return (dayType === "TODAY" || dayType === "YESTERDAY") && matchesSearch(o);
      });

      // Sortowanie: DZISIEJSZE na początku (od najnowszego), potem WCZORAJSZE (od najnowszego)
      return active.sort((a, b) => {
        const typeA = getOrderDayType(a.createdAt, now);
        const typeB = getOrderDayType(b.createdAt, now);

        if (typeA === "TODAY" && typeB !== "TODAY") return -1;
        if (typeB === "TODAY" && typeA !== "TODAY") return 1;

        const timeA = parseDate(a.createdAt)?.getTime() || 0;
        const timeB = parseDate(b.createdAt)?.getTime() || 0;
        return timeB - timeA;
      });
    }

    // Zakładka "wszystkie": sortowanie chronologicznie od najnowszego
    return orders
      .filter(matchesSearch)
      .sort((a, b) => {
        const timeA = parseDate(a.createdAt)?.getTime() || 0;
        const timeB = parseDate(b.createdAt)?.getTime() || 0;
        return timeB - timeA;
      });
  }, [orders, filter, search, now]);

  // Licznik dzisiejszych i wczorajszych
  const currentCounts = useMemo(() => {
    let today = 0;
    let yesterday = 0;
    for (const o of orders) {
      const type = getOrderDayType(o.createdAt, now);
      if (type === "TODAY") today++;
      else if (type === "YESTERDAY") yesterday++;
    }
    return { today, yesterday, total: today + yesterday };
  }, [orders, now]);

  const dateLabel = `${WEEKDAYS[now.getDay()]}, ${pad(now.getDate())}.${pad(
    now.getMonth() + 1
  )}.${now.getFullYear()}`;

  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  return (
    <div className="min-h-screen bg-slate-950 text-white font-sans pb-20 select-none">
      {/* Sticky Header */}
      <header className="sticky top-0 z-30 bg-slate-900/95 backdrop-blur border-b border-slate-800 shadow-xl">
        <div className="flex items-center justify-between gap-2 px-4 py-3 max-w-xl mx-auto">
          <Link
            href="/plac"
            className="shrink-0 flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 px-3 py-2 text-xs font-bold text-slate-200 active:scale-95 transition"
          >
            <span>🔙</span>
            <span>Menu</span>
          </Link>

          <div className="flex-1 min-w-0 text-center">
            <h1 className="text-base font-black tracking-wide text-white uppercase truncate">
              📦 Zamówienia Materiałowe
            </h1>
            <p className="text-[11px] font-bold text-amber-400 truncate">{dateLabel}</p>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className={`text-[10px] font-black rounded-full px-2 py-0.5 border uppercase tracking-wider ${
                isOnline
                  ? "border-emerald-700/60 bg-emerald-950/80 text-emerald-400"
                  : "border-amber-700/60 bg-amber-950/80 text-amber-400"
              }`}
            >
              {isOnline ? "🟢 Online" : "🟠 Offline"}
            </span>
            <button
              type="button"
              onClick={fetchOrders}
              disabled={isLoading || !isOnline}
              aria-label="Odśwież"
              className="w-9 h-9 flex items-center justify-center rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 active:scale-95 transition disabled:opacity-40"
            >
              <span className={isLoading ? "inline-block animate-spin text-sm" : "text-sm"}>🔄</span>
            </button>
          </div>
        </div>

        {/* Wyszukiwarka i przełącznik filtrów */}
        <div className="px-4 pb-3 space-y-2.5 max-w-xl mx-auto">
          <div className="relative">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Szukaj: budowa, zamawiający, materiał..."
              className="w-full rounded-xl border border-slate-700/80 bg-slate-800/90 px-3.5 py-2 pl-9 text-xs text-white placeholder:text-slate-400 focus:border-amber-500 focus:outline-none transition"
            />
            <span className="absolute left-3 top-2.5 text-xs text-slate-400">🔍</span>
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-2 text-xs text-slate-400 hover:text-white"
              >
                ✕
              </button>
            )}
          </div>

          {/* Przełącznik: Aktualne (Dziś + Wczoraj) vs Wszystkie */}
          <div className="flex gap-1.5 bg-slate-950/60 p-1 rounded-2xl border border-slate-800">
            <button
              type="button"
              onClick={() => setFilter("aktualne")}
              className={`flex-1 py-2 px-3 rounded-xl text-xs font-black transition flex items-center justify-center gap-1.5 ${
                filter === "aktualne"
                  ? "bg-amber-500 text-slate-950 shadow-md"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              <span>🚚 Dziś + Wczoraj</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full font-black ${
                  filter === "aktualne"
                    ? "bg-slate-950/20 text-slate-950"
                    : "bg-slate-800 text-slate-300"
                }`}
              >
                {currentCounts.total}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setFilter("wszystkie")}
              className={`flex-1 py-2 px-3 rounded-xl text-xs font-black transition flex items-center justify-center gap-1.5 ${
                filter === "wszystkie"
                  ? "bg-blue-600 text-white shadow-md"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              <span>📁 Archiwalne / Wszystkie</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full font-black ${
                  filter === "wszystkie"
                    ? "bg-white/20 text-white"
                    : "bg-slate-800 text-slate-300"
                }`}
              >
                {orders.length}
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* Toast Alert */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-4 left-4 right-4 max-w-md mx-auto z-50 rounded-2xl px-4 py-3 text-xs font-black shadow-2xl border bg-amber-950 border-amber-600 text-amber-300 flex items-center justify-between animate-bounce"
        >
          <span>{toast}</span>
          <button onClick={() => setToast(null)} className="ml-2 font-bold opacity-80 hover:opacity-100">
            ✕
          </button>
        </div>
      )}

      {/* Lista zamówień */}
      <main className="px-4 pt-3.5 space-y-3.5 max-w-xl mx-auto">
        {filteredOrders.length === 0 ? (
          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-8 text-center mt-6">
            <p className="text-4xl mb-3">📭</p>
            <h3 className="text-base font-black text-slate-200">
              {filter === "aktualne"
                ? "Brak zamówień z dzisiaj ani z wczoraj"
                : "Brak zamówień w systemie"}
            </h3>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              {filter === "aktualne"
                ? "Brak zleceń z ostatnich 2 dni. Wszystkie wcześniejsze zamówienia znajdziesz w zakładce „Archiwalne / Wszystkie” powyżej."
                : "Nowe zamówienia złożone przez kierowników pojawią się automatycznie."}
            </p>
          </div>
        ) : (
          filteredOrders.map((order, idx) => {
            const items = order.items ?? [];
            const isExpanded = expanded.has(order.id);
            const displayNumber = order.orderId ?? order.id.slice(0, 8).toUpperCase();
            const dayType = getOrderDayType(order.createdAt, now);

            // Oblicz ile pozycji jest już odhaczonych przez kierowcę
            const checkedCount = items.filter((item, i) =>
              isItemChecked(order.id, i, item.name)
            ).length;
            const isAllChecked = items.length > 0 && checkedCount === items.length;

            // Sprawdzamy czy pokazać nagłówek sekcji
            const prevOrder = idx > 0 ? filteredOrders[idx - 1] : null;
            const prevDayType = prevOrder ? getOrderDayType(prevOrder.createdAt, now) : null;
            const isFirstToday = idx === 0 && dayType === "TODAY";
            const isFirstYesterday = dayType === "YESTERDAY" && (!prevOrder || prevDayType === "TODAY");
            const isFirstOlder = dayType === "OLDER" && (!prevOrder || prevDayType !== "OLDER");

            return (
              <React.Fragment key={order.id}>
                {/* Nagłówek sekcji DZISIAJ */}
                {isFirstToday && (
                  <div className="flex items-center gap-2 pt-1 pb-0.5">
                    <span className="text-[11px] font-black uppercase tracking-wider text-emerald-400 bg-emerald-950/80 px-3 py-1 rounded-full border border-emerald-800/60 flex items-center gap-1.5 shadow-sm">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                      ⚡ Zamówienia z dzisiaj ({formatDateShort(order.createdAt)})
                    </span>
                    <div className="h-[1px] flex-1 bg-slate-800"></div>
                  </div>
                )}

                {/* Nagłówek sekcji WCZORAJ */}
                {isFirstYesterday && (
                  <div className="flex items-center gap-2 pt-3 pb-0.5">
                    <span className="text-[11px] font-black uppercase tracking-wider text-sky-400 bg-sky-950/80 px-3 py-1 rounded-full border border-sky-800/60 flex items-center gap-1.5 shadow-sm">
                      <span>⏮️</span>
                      Zamówienia z wczoraj ({pad(yesterdayDate.getDate())}.{pad(yesterdayDate.getMonth() + 1)})
                    </span>
                    <div className="h-[1px] flex-1 bg-slate-800"></div>
                  </div>
                )}

                {/* Nagłówek sekcji STARSZE (dla widoku Wszystkie) */}
                {isFirstOlder && filter === "wszystkie" && (
                  <div className="flex items-center gap-2 pt-3 pb-0.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 bg-slate-900 px-3 py-1 rounded-full border border-slate-800 flex items-center gap-1.5">
                      <span>📁</span>
                      Starsze zamówienia
                    </span>
                    <div className="h-[1px] flex-1 bg-slate-800"></div>
                  </div>
                )}

                <article
                  className={`rounded-3xl border p-4 shadow-lg flex flex-col justify-between relative overflow-hidden transition ${
                    isAllChecked
                      ? "border-emerald-600/70 bg-gradient-to-br from-emerald-950/25 via-slate-900 to-slate-900"
                      : dayType === "TODAY"
                      ? "border-emerald-500/50 bg-gradient-to-br from-emerald-950/20 via-slate-900 to-slate-900 shadow-emerald-950/30"
                      : dayType === "YESTERDAY"
                      ? "border-sky-500/40 bg-gradient-to-br from-sky-950/20 via-slate-900 to-slate-900"
                      : "border-slate-800/90 bg-slate-900 hover:border-slate-700"
                  }`}
                >
                  {/* Górny wiersz z numerem i etykietą dnia */}
                  <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400 mb-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-black text-amber-400 text-xs">#{displayNumber}</span>
                      {dayType === "TODAY" && (
                        <span className="inline-flex items-center gap-1 font-black text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-500/25 text-emerald-300 border border-emerald-500/60 uppercase tracking-wider">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>
                          ⚡ DZISIAJ
                        </span>
                      )}
                      {dayType === "YESTERDAY" && (
                        <span className="inline-flex items-center gap-1 font-black text-[10px] px-2.5 py-0.5 rounded-full bg-sky-500/25 text-sky-300 border border-sky-500/60 uppercase tracking-wider">
                          ⏮️ WCZORAJ
                        </span>
                      )}
                      {dayType === "OLDER" && (
                        <span className="inline-flex items-center gap-1 font-bold text-[9px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 uppercase tracking-wider">
                          📁 STARSZE
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-slate-300 bg-slate-800/90 px-2 py-0.5 rounded-lg border border-slate-700/60">
                        📅 {formatDateShort(order.createdAt)} 🕒 {formatTime(order.createdAt)}
                      </span>
                    </div>
                  </div>

                {/* Budowa */}
                <h2 className="text-lg font-black text-white leading-snug">
                  🏗️ {order.siteName ?? "Budowa bez nazwy"}
                </h2>

                {/* Osoba zamawiająca + postęp zakupów */}
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-slate-300">
                    👤 <span className="font-semibold text-slate-200">{order.orderedByName ?? order.orderedBy ?? "Kierownik"}</span>
                  </p>

                  {items.length > 0 && (
                    <span
                      className={`text-[11px] font-black px-2.5 py-0.5 rounded-full border ${
                        isAllChecked
                          ? "bg-emerald-950 text-emerald-300 border-emerald-500"
                          : checkedCount > 0
                          ? "bg-amber-950 text-amber-300 border-amber-600"
                          : "bg-slate-800 text-slate-300 border-slate-700"
                      }`}
                    >
                      {isAllChecked
                        ? "✅ Wszystko skompletowane"
                        : `Kupiono: ${checkedCount} / ${items.length}`}
                    </span>
                  )}
                </div>

                {/* Uwagi kierownika wyróżnione w ramce */}
                {order.notes && (
                  <div className="mt-3 rounded-2xl border border-amber-500/60 bg-amber-500/10 p-3">
                    <p className="text-[10px] font-black uppercase tracking-wider text-amber-300">
                      ⚠️ Uwagi kierownika:
                    </p>
                    <p className="mt-0.5 text-xs text-amber-100 font-medium leading-relaxed">
                      {order.notes}
                    </p>
                  </div>
                )}

                {/* Nagłówek listy pozycji z przyciskiem zwijania */}
                <button
                  type="button"
                  onClick={() => toggleExpanded(order.id)}
                  className="mt-3 w-full flex items-center justify-between rounded-2xl bg-slate-800/80 hover:bg-slate-800 px-3.5 py-2.5 text-xs font-bold text-blue-300 active:scale-[0.99] transition border border-slate-700/60"
                  aria-expanded={isExpanded}
                >
                  <span className="flex items-center gap-1.5">
                    <span>📋 {pluralizeItems(items.length)}</span>
                    <span className="text-[10px] text-slate-400 font-normal">
                      (dotknij pozycji aby odhaczyć zakup)
                    </span>
                  </span>
                  <span className="text-slate-400">{isExpanded ? "▲ Zwiń" : "▼ Pokaż"}</span>
                </button>

                {/* Rozwijana lista pozycji z opcją ODHACZANIA dla kierowcy */}
                {isExpanded && (
                  <div className="mt-2.5 space-y-1.5 pt-1">
                    {items.length > 0 ? (
                      <ul className="space-y-1.5">
                        {items.map((item, idx) => {
                          const checked = isItemChecked(order.id, idx, item.name);
                          return (
                            <li
                              key={item.id ?? `${order.id}-${idx}`}
                              onClick={() => toggleItemCheck(order.id, idx, item.name)}
                              className={`flex items-center justify-between gap-3 p-3 rounded-2xl border cursor-pointer active:scale-[0.98] transition ${
                                checked
                                  ? "bg-emerald-950/30 border-emerald-600/50 text-slate-400"
                                  : "bg-slate-950/70 border-slate-800 text-white hover:border-slate-700"
                              }`}
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                {/* Checkbox dotykowy */}
                                <div
                                  className={`w-6 h-6 rounded-lg flex items-center justify-center font-bold text-sm shrink-0 border transition ${
                                    checked
                                      ? "bg-emerald-500 border-emerald-400 text-slate-950"
                                      : "bg-slate-900 border-slate-600 text-transparent"
                                  }`}
                                >
                                  ✓
                                </div>
                                <span
                                  className={`text-xs font-semibold leading-snug break-words ${
                                    checked ? "line-through text-slate-400" : "text-slate-100"
                                  }`}
                                >
                                  {item.name}
                                </span>
                              </div>

                              <span
                                className={`font-black text-xs whitespace-nowrap px-2.5 py-1 rounded-xl border shrink-0 ${
                                  checked
                                    ? "bg-emerald-950/60 border-emerald-700/40 text-emerald-300"
                                    : "bg-amber-500/15 border-amber-500/30 text-amber-300"
                                }`}
                              >
                                {item.quantity} {item.unit ?? "szt."}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="text-xs text-slate-500 italic px-2 py-1">
                        Brak sprecyzowanych pozycji
                      </p>
                    )}
                  </div>
                )}
              </article>
            </React.Fragment>
          );
        })
        )}
      </main>
    </div>
  );
}
