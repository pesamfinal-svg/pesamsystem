"use client";

import React, { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/AuthContext";
import {
  collection,
  getDocs,
  doc,
  query,
  orderBy,
  runTransaction,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";

interface InventoryItem {
  id: string;
  name: string;
  type: "UNIQUE" | "BULK";
  inventoryNumber?: string;
  category?: string;
  subcategory?: string;
  status?: string;
  imageUrl?: string;
  currentLocation?: string;
  totalQuantity: number;
  availableQuantity: number;
  unit?: string;
  additionalInfo?: string;
  allocations?: Record<string, number>;
}

const CACHE_KEY = "pesam_plac_inventory_cache";

export default function PlacInwentaryzacjaPage() {
  const { user } = useAuth();

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [activeTab, setActiveTab] = useState<"UNIQUE" | "BULK">("UNIQUE");
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [search, setSearch] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [toast, setToast] = useState<{ type: "ok" | "warn" | "error"; text: string } | null>(
    null
  );

  // Modal Wpisu Serwisowego (UNIQUE)
  const [serviceItem, setServiceItem] = useState<InventoryItem | null>(null);
  const [serviceForm, setServiceForm] = useState<{
    date: string;
    newStatus: string;
    description: string;
    cost: string;
  }>({
    date: new Date().toISOString().split("T")[0],
    newStatus: "sprawne",
    description: "",
    cost: "",
  });
  const [isServiceSubmitting, setIsServiceSubmitting] = useState(false);

  // Modal Korekty Stanu (BULK)
  const [adjustItem, setAdjustItem] = useState<InventoryItem | null>(null);
  const [adjustType, setAdjustType] = useState<"PATH_A" | "PATH_B">("PATH_A");
  const [pathAAction, setPathAAction] = useState<"ADD" | "SUBTRACT">("ADD");
  const [adjustQty, setAdjustQty] = useState<string>("");
  const [isAdjustSubmitting, setIsAdjustSubmitting] = useState(false);

  // Lightbox dla powiększenia zdjęcia
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const showToast = (text: string, type: "ok" | "warn" | "error" = "ok") => {
    setToast({ text, type });
    setTimeout(() => setToast(null), 3500);
  };

  // Monitorowanie sieci
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

  // Wczytanie z pamięci telefonu
  const loadFromCache = () => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as InventoryItem[];
        if (Array.isArray(parsed)) setItems(parsed);
      }
    } catch (e) {
      console.warn("Błąd odczytu pamięci inwentaryzacji:", e);
    }
  };

  // Pobieranie świeżych danych
  const fetchItems = async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setIsOnline(false);
      return;
    }
    setIsLoading(true);
    try {
      const q = query(collection(db, "inventory"), orderBy("name", "asc"));
      const snap = await getDocs(q);
      const list: InventoryItem[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<InventoryItem, "id">),
      }));
      setItems(list);
      setIsOnline(true);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(list));
      } catch (e) {
        console.warn("Błąd zapisu cache inwentaryzacji:", e);
      }
    } catch (err) {
      console.error("Błąd pobierania inwentaryzacji:", err);
      showToast("Nie udało się pobrać danych z bazy", "error");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadFromCache();
    if (typeof navigator !== "undefined" && navigator.onLine) {
      fetchItems();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- OBSŁUGA SERWISU (UNIQUE) ---
  const openServiceModal = (item: InventoryItem) => {
    setServiceItem(item);
    setServiceForm({
      date: new Date().toISOString().split("T")[0],
      newStatus: item.status?.toLowerCase() || "sprawne",
      description: "",
      cost: "",
    });
  };

  const handleServiceSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!serviceItem) return;

    if (!isOnline) {
      showToast("Brak połączenia z internetem – zmiana wymaga sieci", "warn");
      return;
    }

    setIsServiceSubmitting(true);
    try {
      await runTransaction(db, async (transaction) => {
        const itemRef = doc(db, "inventory", serviceItem.id);
        const historyRef = doc(collection(db, `inventory/${serviceItem.id}/history`));

        transaction.update(itemRef, { status: serviceForm.newStatus.toLowerCase() });

        let desc = serviceForm.description.trim() || "Zmiana statusu / Wpis serwisowy (mobilnie)";
        if (serviceForm.cost.trim()) {
          desc += ` | Koszt: ${serviceForm.cost} PLN`;
        }

        const entryDateIso = serviceForm.date
          ? new Date(`${serviceForm.date}T12:00:00`).toISOString()
          : new Date().toISOString();

        transaction.set(historyRef, {
          date: entryDateIso,
          documentDate: serviceForm.date || entryDateIso.split("T")[0],
          type: "SERWIS",
          description: desc,
          status: serviceForm.newStatus.toLowerCase(),
          user: user ? `${user.firstName} ${user.lastName}` : "Pracownik placu (mobilnie)",
        });
      });

      // Aktualizuj stan lokalny i cache
      const updatedList = items.map((i) =>
        i.id === serviceItem.id
          ? { ...i, status: serviceForm.newStatus.toLowerCase() }
          : i
      );
      setItems(updatedList);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(updatedList));
      } catch (err) {
        console.warn(err);
      }

      showToast(`✅ Status zaktualizowany na: ${serviceForm.newStatus.toUpperCase()}`, "ok");
      setServiceItem(null);
    } catch (err: any) {
      console.error(err);
      showToast("Błąd zapisu wpisu serwisowego: " + (err.message || err), "error");
    } finally {
      setIsServiceSubmitting(false);
    }
  };

  // --- OBSŁUGA KOREKTY STANU (BULK) ---
  const openAdjustModal = (item: InventoryItem) => {
    setAdjustItem(item);
    setAdjustType("PATH_A");
    setPathAAction("ADD");
    setAdjustQty("");
  };

  const handleAdjustSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustItem || !adjustQty || Number(adjustQty) <= 0) {
      showToast("Podaj poprawną liczbę większą od zera", "warn");
      return;
    }

    if (!isOnline) {
      showToast("Brak sieci – korekta stanu wymaga połączenia z bazą", "warn");
      return;
    }

    setIsAdjustSubmitting(true);
    const qtyNum = Number(adjustQty);

    try {
      let finalAvailable = 0;
      let finalTotal = 0;

      await runTransaction(db, async (transaction) => {
        const itemRef = doc(db, "inventory", adjustItem.id);
        const itemDoc = await transaction.get(itemRef);
        if (!itemDoc.exists()) throw new Error("Przedmiot nie istnieje w bazie!");

        const data = itemDoc.data() as InventoryItem;
        let newAvailable = Number(data.availableQuantity || 0);
        let newTotal = Number(data.totalQuantity || 0);

        if (adjustType === "PATH_A") {
          if (pathAAction === "ADD") {
            newAvailable += qtyNum;
            newTotal += qtyNum;
          } else {
            newAvailable -= qtyNum;
            newTotal -= qtyNum;
            if (newAvailable < 0) {
              throw new Error(
                `Nie możesz odjąć ${qtyNum} szt., ponieważ na magazynie dostępnych jest tylko ${data.availableQuantity} szt.!`
              );
            }
            if (newTotal < 0) newTotal = 0;
          }
        } else {
          // PATH_B (Spis z natury na placu)
          const allocations = data.allocations || {};
          const sumAllocations = Object.values(allocations).reduce(
            (sum, val) => sum + (val || 0),
            0
          );
          newAvailable = qtyNum;
          newTotal = qtyNum + sumAllocations;
        }

        finalAvailable = newAvailable;
        finalTotal = newTotal;

        transaction.update(itemRef, {
          availableQuantity: newAvailable,
          totalQuantity: newTotal,
        });

        const historyRef = doc(collection(db, `inventory/${adjustItem.id}/history`));
        const desc =
          adjustType === "PATH_A"
            ? `${
                pathAAction === "ADD" ? "Dostawa / Dopisanie" : "Likwidacja / Odpisanie"
              } ilości o: ${qtyNum} szt. Stan po korekcie: ${newAvailable} (Dostępne) / ${newTotal} (Suma)`
            : `Spis z natury na placu. Ustawiono fizyczny stan placu na: ${qtyNum} szt. Stan po korekcie: ${newAvailable} (Dostępne) / ${newTotal} (Suma)`;

        transaction.set(historyRef, {
          date: new Date().toISOString(),
          type: "KOREKTA",
          description: desc,
          status: data.status || "sprawne",
          user: user ? `${user.firstName} ${user.lastName}` : "Pracownik placu (mobilnie)",
        });
      });

      // Aktualizacja stanu lokalnego i pamięci podręcznej
      const updatedList = items.map((i) =>
        i.id === adjustItem.id
          ? { ...i, availableQuantity: finalAvailable, totalQuantity: finalTotal }
          : i
      );
      setItems(updatedList);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(updatedList));
      } catch (err) {
        console.warn(err);
      }

      showToast("✅ Stan magazynowy został pomyślnie zaktualizowany!", "ok");
      setAdjustItem(null);
      setAdjustQty("");
    } catch (err: any) {
      console.error(err);
      showToast(err.message || "Błąd podczas korekty stanu", "error");
    } finally {
      setIsAdjustSubmitting(false);
    }
  };

  // Filtrowanie listy
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();

    return items.filter((item) => {
      // Filtr typu
      if (item.type !== activeTab) return false;

      // Filtr statusu dla UNIQUE
      if (activeTab === "UNIQUE" && statusFilter !== "ALL") {
        const itemSt = (item.status || "sprawne").toLowerCase();
        if (itemSt !== statusFilter.toLowerCase()) return false;
      }

      if (!q) return true;
      const inName = item.name?.toLowerCase().includes(q);
      const inInv = item.inventoryNumber?.toLowerCase().includes(q);
      const inCat = item.category?.toLowerCase().includes(q);
      const inSub = item.subcategory?.toLowerCase().includes(q);
      const inLoc = item.currentLocation?.toLowerCase().includes(q);
      return Boolean(inName || inInv || inCat || inSub || inLoc);
    });
  }, [items, activeTab, statusFilter, search]);

  const uniqueCount = useMemo(
    () => items.filter((i) => i.type === "UNIQUE").length,
    [items]
  );
  const bulkCount = useMemo(
    () => items.filter((i) => i.type === "BULK").length,
    [items]
  );

  return (
    <div className="min-h-screen bg-slate-950 text-white font-sans pb-24 select-none">
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
              📊 Inwentaryzacja & Narzędzia
            </h1>
            <p className="text-[11px] font-bold text-emerald-400 truncate">
              Katalog sprzętu & korekty stanów
            </p>
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
              onClick={fetchItems}
              disabled={isLoading || !isOnline}
              aria-label="Odśwież"
              className="w-9 h-9 flex items-center justify-center rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 active:scale-95 transition disabled:opacity-40"
            >
              <span className={isLoading ? "inline-block animate-spin text-sm" : "text-sm"}>
                🔄
              </span>
            </button>
          </div>
        </div>

        {/* Zakładki: Narzędzia (UNIQUE) vs Elementy / Rusztowania (BULK) */}
        <div className="px-4 pb-2.5 max-w-xl mx-auto">
          <div className="flex gap-1.5 bg-slate-950/70 p-1 rounded-2xl border border-slate-800">
            <button
              type="button"
              onClick={() => setActiveTab("UNIQUE")}
              className={`flex-1 py-2 px-2.5 rounded-xl text-xs font-black transition flex items-center justify-center gap-1.5 ${
                activeTab === "UNIQUE"
                  ? "bg-amber-500 text-slate-950 shadow-md"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              <span>🔧 Narzędzia (Unikalne)</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                  activeTab === "UNIQUE"
                    ? "bg-slate-950/20 text-slate-950 font-black"
                    : "bg-slate-800 text-slate-300"
                }`}
              >
                {uniqueCount}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("BULK")}
              className={`flex-1 py-2 px-2.5 rounded-xl text-xs font-black transition flex items-center justify-center gap-1.5 ${
                activeTab === "BULK"
                  ? "bg-emerald-600 text-white shadow-md"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              <span>🧱 Rusztowania / BULK</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                  activeTab === "BULK"
                    ? "bg-white/20 text-white font-black"
                    : "bg-slate-800 text-slate-300"
                }`}
              >
                {bulkCount}
              </span>
            </button>
          </div>

          {/* Wyszukiwarka */}
          <div className="mt-2.5 relative">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                activeTab === "UNIQUE"
                  ? "Szukaj narzędzia, nr mag np. 235, marki..."
                  : "Szukaj elementu, ramki, rusztowania..."
              }
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

          {/* Szybkie filtry statusu dla UNIQUE */}
          {activeTab === "UNIQUE" && (
            <div className="mt-2 flex gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
              {[
                { key: "ALL", label: "Wszystkie" },
                { key: "sprawne", label: "✅ Sprawne" },
                { key: "uszkodzone", label: "❌ Uszkodzone" },
                { key: "do przeglądu", label: "⚠️ Do przeglądu" },
              ].map((f) => (
                <button
                  key={f.key}
                  onClick={() => setStatusFilter(f.key)}
                  className={`shrink-0 px-2.5 py-1 rounded-xl text-[11px] font-bold border transition ${
                    statusFilter === f.key
                      ? "bg-amber-500 border-amber-400 text-slate-950 font-black shadow"
                      : "bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
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

      {/* Główna lista urządzeń / elementów */}
      <main className="px-4 pt-3.5 space-y-3 max-w-xl mx-auto">
        {filteredItems.length === 0 ? (
          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-8 text-center mt-6">
            <p className="text-4xl mb-3">🔍</p>
            <h3 className="text-base font-black text-slate-200">Brak pozycji spełniających kryteria</h3>
            <p className="text-xs text-slate-400 mt-1">
              Zmień wyszukiwaną frazę lub status w filtrach powyżej.
            </p>
          </div>
        ) : (
          filteredItems.map((item) => {
            const isUnique = item.type === "UNIQUE";
            const statusLower = (item.status || "sprawne").toLowerCase();

            return (
              <div
                key={item.id}
                className="rounded-3xl border border-slate-800/90 bg-slate-900 p-4 shadow-lg flex flex-col justify-between relative overflow-hidden transition hover:border-slate-700"
              >
                <div className="flex gap-3">
                  {/* Miniatura zdjęcia */}
                  <div
                    onClick={() => item.imageUrl && setLightboxUrl(item.imageUrl)}
                    className="w-16 h-16 rounded-2xl bg-slate-950 border border-slate-800 shrink-0 overflow-hidden flex items-center justify-center cursor-pointer relative"
                  >
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt={item.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-2xl">{isUnique ? "🔧" : "🧱"}</span>
                    )}
                  </div>

                  {/* Informacje o sprzęcie */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1 mb-1">
                      {isUnique && (
                        <span className="font-mono text-[11px] font-black text-amber-400 bg-amber-500/15 px-2 py-0.5 rounded-lg border border-amber-500/30">
                          NR: {item.inventoryNumber || "BRAK"}
                        </span>
                      )}
                      {!isUnique && (
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                          {item.subcategory || item.category || "ELEMENT BULK"}
                        </span>
                      )}

                      {/* Status dla UNIQUE */}
                      {isUnique && (
                        <span
                          className={`text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider border ${
                            statusLower === "sprawne"
                              ? "bg-emerald-950 text-emerald-400 border-emerald-700/60"
                              : statusLower === "uszkodzone"
                              ? "bg-red-950 text-red-400 border-red-700/60"
                              : "bg-amber-950 text-amber-400 border-amber-700/60"
                          }`}
                        >
                          {statusLower}
                        </span>
                      )}
                    </div>

                    <h2 className="text-sm font-black text-white leading-snug line-clamp-2">
                      {item.name}
                    </h2>

                    <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
                      <span className="truncate">
                        📍 {item.currentLocation || "MAGAZYN PESAM"}
                      </span>
                      {!isUnique && (
                        <span className="font-black text-emerald-400 whitespace-nowrap bg-emerald-950/60 px-2 py-0.5 rounded-lg border border-emerald-700/50">
                          {item.availableQuantity} / {item.totalQuantity} {item.unit || "szt."}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Duży przycisk akcji dotykowej */}
                <div className="mt-3.5 pt-2.5 border-t border-slate-800">
                  {isUnique ? (
                    <button
                      type="button"
                      onClick={() => openServiceModal(item)}
                      className="w-full py-2.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 active:scale-95 transition"
                    >
                      <span>🛠️ Zmień status / Wpis serwisowy</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openAdjustModal(item)}
                      className="w-full py-2.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-500/30 font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 active:scale-95 transition"
                    >
                      <span>⚙️ Korekta Stanu Magazynu</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </main>

      {/* MODAL 1: Wpis Serwisowy (UNIQUE) */}
      {serviceItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-4 animate-fade-in"
          onClick={() => !isServiceSubmitting && setServiceItem(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-sm rounded-3xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-3">
              <div className="flex items-center gap-2">
                <span className="text-2xl">🛠️</span>
                <div>
                  <h3 className="text-sm font-black text-white uppercase">Wpis Serwisowy</h3>
                  <p className="text-[10px] text-amber-400 font-mono">
                    Nr: {serviceItem.inventoryNumber || "BRAK"}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setServiceItem(null)}
                className="w-7 h-7 rounded-full bg-slate-800 text-slate-300 font-bold flex items-center justify-center text-xs"
              >
                ✕
              </button>
            </div>

            <p className="text-xs font-bold text-slate-200 mb-3 bg-slate-800/80 p-2.5 rounded-xl border border-slate-700">
              {serviceItem.name}
            </p>

            <form onSubmit={handleServiceSubmit} className="space-y-3">
              {/* Data wykonania */}
              <div>
                <label className="block text-[11px] font-bold text-slate-300 uppercase mb-1">
                  Data wykonania / wpisu:
                </label>
                <input
                  type="date"
                  value={serviceForm.date}
                  onChange={(e) => setServiceForm({ ...serviceForm, date: e.target.value })}
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white focus:border-amber-500 focus:outline-none"
                />
              </div>

              {/* Nowy status */}
              <div>
                <label className="block text-[11px] font-bold text-slate-300 uppercase mb-1">
                  Nowy status urządzenia:
                </label>
                <select
                  value={serviceForm.newStatus}
                  onChange={(e) => setServiceForm({ ...serviceForm, newStatus: e.target.value })}
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white font-bold focus:border-amber-500 focus:outline-none"
                >
                  <option value="sprawne">✅ Sprawne</option>
                  <option value="uszkodzone">❌ Uszkodzone</option>
                  <option value="do przeglądu">⚠️ Do przeglądu</option>
                </select>
              </div>

              {/* Opis / co zrobiono */}
              <div>
                <label className="block text-[11px] font-bold text-slate-300 uppercase mb-1">
                  Opis operacji / naprawy (opcjonalnie):
                </label>
                <textarea
                  rows={2}
                  value={serviceForm.description}
                  onChange={(e) =>
                    setServiceForm({ ...serviceForm, description: e.target.value })
                  }
                  placeholder="np. Wymieniono szczotki, naprawiono kabel, czyszczenie..."
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none resize-none"
                />
              </div>

              {/* Koszt */}
              <div>
                <label className="block text-[11px] font-bold text-slate-300 uppercase mb-1">
                  Koszt naprawy w PLN (opcjonalnie):
                </label>
                <input
                  type="text"
                  value={serviceForm.cost}
                  onChange={(e) => setServiceForm({ ...serviceForm, cost: e.target.value })}
                  placeholder="np. 45.50"
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div className="pt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setServiceItem(null)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-700 bg-slate-800 text-xs font-bold text-slate-300"
                >
                  Anuluj
                </button>
                <button
                  type="submit"
                  disabled={isServiceSubmitting}
                  className="flex-1 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-xs font-black uppercase text-slate-950 shadow disabled:opacity-50"
                >
                  {isServiceSubmitting ? "Zapisywanie..." : "Zapisz wpis"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: Korekta Stanu Magazynu (BULK) */}
      {adjustItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-4 animate-fade-in"
          onClick={() => !isAdjustSubmitting && setAdjustItem(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-sm rounded-3xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-3">
              <div className="flex items-center gap-2">
                <span className="text-2xl">⚙️</span>
                <div>
                  <h3 className="text-sm font-black text-white uppercase">Korekta Stanu</h3>
                  <p className="text-[10px] text-emerald-400 font-bold">
                    Dostępne: {adjustItem.availableQuantity} / Suma: {adjustItem.totalQuantity}{" "}
                    {adjustItem.unit || "szt."}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setAdjustItem(null)}
                className="w-7 h-7 rounded-full bg-slate-800 text-slate-300 font-bold flex items-center justify-center text-xs"
              >
                ✕
              </button>
            </div>

            <p className="text-xs font-bold text-slate-200 mb-3 bg-slate-800/80 p-2.5 rounded-xl border border-slate-700">
              {adjustItem.name}
            </p>

            <form onSubmit={handleAdjustSubmit} className="space-y-3">
              {/* Wybór ścieżki */}
              <div className="flex gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800">
                <button
                  type="button"
                  onClick={() => setAdjustType("PATH_A")}
                  className={`flex-1 py-1.5 px-2 rounded-lg text-[11px] font-bold transition ${
                    adjustType === "PATH_A"
                      ? "bg-amber-500 text-slate-950 font-black shadow"
                      : "text-slate-300"
                  }`}
                >
                  📦 Dostawa / Odpis
                </button>
                <button
                  type="button"
                  onClick={() => setAdjustType("PATH_B")}
                  className={`flex-1 py-1.5 px-2 rounded-lg text-[11px] font-bold transition ${
                    adjustType === "PATH_B"
                      ? "bg-emerald-600 text-white font-black shadow"
                      : "text-slate-300"
                  }`}
                >
                  📋 Z Natury (Plac)
                </button>
              </div>

              {adjustType === "PATH_A" ? (
                <>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setPathAAction("ADD")}
                      className={`flex-1 py-2 rounded-xl text-xs font-black border transition ${
                        pathAAction === "ADD"
                          ? "bg-emerald-600 border-emerald-500 text-white"
                          : "bg-slate-800 border-slate-700 text-slate-400"
                      }`}
                    >
                      ➕ Dodaj (Dostawa)
                    </button>
                    <button
                      type="button"
                      onClick={() => setPathAAction("SUBTRACT")}
                      className={`flex-1 py-2 rounded-xl text-xs font-black border transition ${
                        pathAAction === "SUBTRACT"
                          ? "bg-red-600 border-red-500 text-white"
                          : "bg-slate-800 border-slate-700 text-slate-400"
                      }`}
                    >
                      ➖ Odejmij (Strata)
                    </button>
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-slate-300 uppercase mb-1">
                      Ilość do {pathAAction === "ADD" ? "dopisania" : "odpisania"}:
                    </label>
                    <input
                      type="number"
                      min="1"
                      step="any"
                      value={adjustQty}
                      onChange={(e) => setAdjustQty(e.target.value)}
                      placeholder="np. 20"
                      className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-bold text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none"
                    />
                  </div>
                </>
              ) : (
                <div>
                  <label className="block text-[11px] font-bold text-slate-300 uppercase mb-1">
                    Fizyczna ilość policzona na placu:
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={adjustQty}
                    onChange={(e) => setAdjustQty(e.target.value)}
                    placeholder="np. 45"
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-bold text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                  />
                  <p className="mt-1 text-[10px] text-slate-400 leading-tight">
                    Ta liczba zostanie ustawiona jako aktualny fizyczny stan na magazynie.
                  </p>
                </div>
              )}

              <div className="pt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setAdjustItem(null)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-700 bg-slate-800 text-xs font-bold text-slate-300"
                >
                  Anuluj
                </button>
                <button
                  type="submit"
                  disabled={isAdjustSubmitting}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-black uppercase text-white shadow disabled:opacity-50"
                >
                  {isAdjustSubmitting ? "Zapisywanie..." : "Zatwierdź korektę"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Lightbox do powiększania zdjęć */}
      {lightboxUrl && (
        <div
          onClick={() => setLightboxUrl(null)}
          className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center p-4 cursor-pointer animate-fade-in"
        >
          <button
            onClick={() => setLightboxUrl(null)}
            className="absolute top-4 right-4 text-white font-bold bg-slate-800 px-4 py-2 rounded-full text-xs"
          >
            ✕ Zamknij
          </button>
          <img
            src={lightboxUrl}
            alt="Powiększenie"
            className="max-w-full max-h-[85vh] object-contain rounded-2xl border border-slate-800 shadow-2xl"
          />
        </div>
      )}
    </div>
  );
}
