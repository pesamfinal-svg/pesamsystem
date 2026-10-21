"use client";

import React, { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/AuthContext";
import {
  collection,
  getDocs,
  query,
  orderBy,
  limit,
  doc,
  updateDoc,
} from "firebase/firestore";
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

type FilterType = "dzisiejsze" | "oczekujace" | "wszystkie";

const CACHE_KEY = "pesam_plac_orders_cache";
const STATUS_NEW = "NOWE";
const STATUS_IN_PROGRESS = "W_REALIZACJI";
const STATUS_DONE = "ZREALIZOWANE";

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

const toLocalDateKey = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const parseDate = (value: string): Date | null => {
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
};

const formatTime = (value: string) => {
  const d = parseDate(value);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "--:--";
};

const isToday = (value: string, todayKey: string) => {
  const d = parseDate(value);
  return d ? toLocalDateKey(d) === todayKey : false;
};

const statusStyle = (status?: string) => {
  switch (status) {
    case STATUS_NEW:
      return { label: "NOWE", cls: "bg-blue-600/20 text-blue-300 border-blue-500" };
    case STATUS_IN_PROGRESS:
      return {
        label: "W REALIZACJI",
        cls: "bg-amber-600/20 text-amber-300 border-amber-500",
      };
    case STATUS_DONE:
      return {
        label: "ZREALIZOWANE",
        cls: "bg-emerald-600/20 text-emerald-300 border-emerald-500",
      };
    default:
      return {
        label: status ?? "NOWE",
        cls: "bg-slate-700/40 text-slate-300 border-slate-600",
      };
  }
};

const pluralizeItems = (count: number) => {
  if (count === 1) return "1 pozycja materiałowa";
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} pozycje materiałowe`;
  }
  return `${count} pozycji materiałowych`;
};

export default function PlacZamowieniaPage() {
  const { user } = useAuth();

  const [orders, setOrders] = useState<Order[]>([]);
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [filter, setFilter] = useState<FilterType>("dzisiejsze");
  const [search, setSearch] = useState<string>("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "ok" | "warn" | "error"; text: string } | null>(
    null
  );
  const [now, setNow] = useState<Date>(new Date());

  const todayKey = toLocalDateKey(now);

  // Toast auto-hide
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Odświeżanie daty
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Stan online/offline
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

  const loadFromCache = () => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Order[];
        if (Array.isArray(parsed)) {
          setOrders(parsed);
          // Rozwiń domyślnie pierwsze zamówienie
          if (parsed.length > 0) {
            setExpanded(new Set([parsed[0].id]));
          }
        }
      }
    } catch (err) {
      console.error("Nie udało się odczytać cache zamówień:", err);
    }
  };

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
        limit(50)
      );
      const snapshot = await getDocs(q);
      const fresh: Order[] = snapshot.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Order, "id">),
      }));
      setOrders(fresh);
      setIsOnline(true);
      if (fresh.length > 0 && expanded.size === 0) {
        setExpanded(new Set([fresh[0].id]));
      }
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(fresh));
      } catch (err) {
        console.error("Nie udało się zapisać cache zamówień:", err);
      }
    } catch (err) {
      console.error("Błąd pobierania zamówień:", err);
      setToast({ type: "error", text: "Nie udało się pobrać zamówień z bazy" });
    } finally {
      setIsLoading(false);
    }
  };

  // Start: cache natychmiast, potem Firestore jeśli online
  useEffect(() => {
    loadFromCache();
    if (typeof navigator !== "undefined" && navigator.onLine) {
      fetchOrders();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateStatus = async (order: Order, newStatus: string) => {
    if (!isOnline) {
      setToast({
        type: "warn",
        text: "Brak połączenia z internetem – zmiana statusu wymaga sieci",
      });
      return;
    }
    setUpdatingId(order.id);
    try {
      await updateDoc(doc(db, "orders", order.id), {
        status: newStatus,
        updatedAt: new Date().toISOString(),
        updatedBy: user?.uid ?? null,
      });
      const next = orders.map((o) =>
        o.id === order.id ? { ...o, status: newStatus } : o
      );
      setOrders(next);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(next));
      } catch (err) {
        console.error("Nie udało się zaktualizować cache:", err);
      }
      setToast({
        type: "ok",
        text:
          newStatus === STATUS_IN_PROGRESS
            ? "🚚 Dostawa rozpoczęta"
            : "✅ Oznaczono jako dostarczone",
      });
    } catch (err) {
      console.error("Błąd aktualizacji statusu:", err);
      setToast({ type: "error", text: "Nie udało się zmienić statusu" });
    } finally {
      setUpdatingId(null);
    }
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase();

    return orders.filter((o) => {
      if (filter === "dzisiejsze" && !isToday(o.createdAt, todayKey)) return false;
      if (filter === "oczekujace" && o.status === STATUS_DONE) return false;

      if (!q) return true;
      const inSite = o.siteName?.toLowerCase().includes(q);
      const inOrderer = o.orderedByName?.toLowerCase().includes(q);
      const inItems = o.items?.some((i) => i.name?.toLowerCase().includes(q));
      const inOrderId = o.orderId?.toLowerCase().includes(q);
      return Boolean(inSite || inOrderer || inItems || inOrderId);
    });
  }, [orders, filter, search, todayKey]);

  const dateLabel = `${WEEKDAYS[now.getDay()]}, ${pad(now.getDate())}.${pad(
    now.getMonth() + 1
  )}.${now.getFullYear()}`;

  const filters: { key: FilterType; label: string }[] = [
    { key: "dzisiejsze", label: "Dzisiejsze" },
    { key: "oczekujace", label: "Oczekujące" },
    { key: "wszystkie", label: "Wszystkie" },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-white font-sans pb-16 select-none">
      {/* Sticky Header */}
      <header className="sticky top-0 z-30 bg-slate-900/95 backdrop-blur border-b border-slate-800 shadow-xl">
        <div className="flex items-center justify-between gap-2 px-4 py-3 max-w-xl mx-auto">
          <Link
            href="/plac"
            className="shrink-0 flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 px-3 py-2 text-xs font-bold text-slate-200 active:scale-95 transition"
          >
            <span>🔙</span>
            <span>Menu</span>
          </Link>

          <div className="flex-1 min-w-0 text-center">
            <h1 className="text-base font-black tracking-wide text-white uppercase truncate">
              📦 Zamówienia Dzisiejsze
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

        {/* Wyszukiwarka i filtry */}
        <div className="px-4 pb-3 space-y-2.5 max-w-xl mx-auto">
          <div className="relative">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Szukaj budowy, materiału, zamawiającego..."
              className="w-full rounded-xl border border-slate-700/80 bg-slate-800/90 px-3.5 py-2 pl-9 text-xs text-white placeholder:text-slate-400 focus:border-blue-500 focus:outline-none transition"
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

          <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
            {filters.map((f) => {
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={`shrink-0 rounded-xl px-3 py-1.5 text-xs font-bold transition border ${
                    active
                      ? "bg-blue-600 border-blue-500 text-white shadow"
                      : "bg-slate-800/80 border-slate-700/80 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* Toast Alert */}
      {toast && (
        <div
          role="status"
          className={`fixed bottom-4 left-4 right-4 max-w-md mx-auto z-50 rounded-2xl px-4 py-3 text-xs font-black shadow-2xl border flex items-center justify-between animate-bounce ${
            toast.type === "ok"
              ? "bg-emerald-950 border-emerald-600 text-emerald-300"
              : toast.type === "warn"
              ? "bg-amber-950 border-amber-600 text-amber-300"
              : "bg-red-950 border-red-600 text-red-300"
          }`}
        >
          <span>{toast.text}</span>
          <button onClick={() => setToast(null)} className="ml-2 font-bold opacity-80 hover:opacity-100">
            ✕
          </button>
        </div>
      )}

      {/* Główna lista zamówień */}
      <main className="px-4 pt-4 space-y-3.5 max-w-xl mx-auto">
        {filteredOrders.length === 0 ? (
          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-8 text-center mt-6">
            <p className="text-4xl mb-3">📭</p>
            <h3 className="text-base font-black text-slate-200">
              {filter === "dzisiejsze"
                ? "Brak zamówień z dzisiejszego dnia"
                : "Brak zamówień spełniających kryteria"}
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Gdy kierownicy złożą zamówienia w sklepie lub notatką głosową, pojawią się one w tym miejscu.
            </p>
          </div>
        ) : (
          filteredOrders.map((order) => {
            const st = statusStyle(order.status);
            const items = order.items ?? [];
            const isExpanded = expanded.has(order.id);
            const isBusy = updatingId === order.id;
            const displayNumber = order.orderId ?? order.id.slice(0, 8).toUpperCase();

            return (
              <article
                key={order.id}
                className="rounded-3xl border border-slate-800/90 bg-slate-900 p-4 shadow-lg flex flex-col justify-between relative overflow-hidden transition hover:border-slate-700"
              >
                {/* Górny wiersz */}
                <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400 mb-1">
                  <span className="font-mono font-bold text-amber-400/90">#{displayNumber}</span>
                  <span className="font-bold text-slate-300 bg-slate-800/80 px-2 py-0.5 rounded-lg border border-slate-700/60">
                    🕒 {formatTime(order.createdAt)}
                  </span>
                </div>

                {/* Budowa */}
                <h2 className="text-base font-black text-white leading-snug">
                  🏗️ {order.siteName ?? "Budowa bez nazwy"}
                </h2>

                {/* Zamawiający + status */}
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-slate-300">
                    👤 <span className="font-semibold text-slate-200">{order.orderedByName ?? order.orderedBy ?? "Kierownik"}</span>
                  </p>
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider ${st.cls}`}
                  >
                    {st.label}
                  </span>
                </div>

                {/* Przycisk rozwijania pozycji */}
                <button
                  type="button"
                  onClick={() => toggleExpanded(order.id)}
                  className="mt-3 w-full flex items-center justify-between rounded-2xl bg-slate-800/70 hover:bg-slate-800 px-3.5 py-2.5 text-xs font-bold text-blue-300 active:scale-[0.99] transition border border-slate-700/50"
                  aria-expanded={isExpanded}
                >
                  <span>📋 {pluralizeItems(items.length)}</span>
                  <span className="text-slate-400">{isExpanded ? "▲ Zwiń" : "▼ Pokaż"}</span>
                </button>

                {isExpanded && (
                  <div className="mt-3 space-y-2.5 pt-2 border-t border-slate-800">
                    {items.length > 0 ? (
                      <ul className="divide-y divide-slate-800/80 rounded-2xl border border-slate-800 bg-slate-950/60">
                        {items.map((item, idx) => (
                          <li
                            key={item.id ?? `${order.id}-${idx}`}
                            className="flex items-baseline justify-between gap-2 px-3.5 py-2.5 text-xs"
                          >
                            <span className="text-slate-200 font-semibold">{item.name}</span>
                            <span className="font-black text-amber-400 whitespace-nowrap bg-amber-500/10 px-2 py-0.5 rounded-lg border border-amber-500/20">
                              {item.quantity} {item.unit ?? "szt."}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-slate-500 italic px-2">Brak sprecyzowanych pozycji</p>
                    )}

                    {order.notes && (
                      <div className="rounded-2xl border border-amber-500/50 bg-amber-500/10 p-3">
                        <p className="text-[10px] font-black uppercase tracking-wider text-amber-300">
                          ⚠️ Uwagi kierownika:
                        </p>
                        <p className="mt-1 text-xs text-amber-100 font-medium leading-relaxed">{order.notes}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Akcje kierowcy / załadunku */}
                {order.status !== STATUS_DONE && (
                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {order.status !== STATUS_IN_PROGRESS && (
                      <button
                        type="button"
                        disabled={isBusy || !isOnline}
                        onClick={() => updateStatus(order, STATUS_IN_PROGRESS)}
                        className="w-full rounded-xl bg-amber-500 hover:bg-amber-400 px-3.5 py-2.5 text-xs font-black uppercase tracking-wider text-slate-950 active:scale-95 transition disabled:opacity-50 shadow"
                      >
                        🚚 W drodze / Załadunek
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={isBusy || !isOnline}
                      onClick={() => updateStatus(order, STATUS_DONE)}
                      className={`w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 px-3.5 py-2.5 text-xs font-black uppercase tracking-wider text-white active:scale-95 transition disabled:opacity-50 shadow ${
                        order.status === STATUS_IN_PROGRESS ? "sm:col-span-2" : ""
                      }`}
                    >
                      ✅ Oznacz jako dostarczone
                    </button>
                  </div>
                )}
              </article>
            );
          })
        )}
      </main>
    </div>
  );
}
