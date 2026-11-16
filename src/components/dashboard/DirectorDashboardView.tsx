"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";

interface Props {
    inventoryItems: any[];
    sites: any[];
    onSwitchToOperational?: () => void;
}

export default function DirectorDashboardView({ inventoryItems, sites, onSwitchToOperational }: Props) {
    const { user } = useAuth();

    const [closeoutsPendingDirector, setCloseoutsPendingDirector] = useState<any[]>([]);
    const [closeoutsPendingManager, setCloseoutsPendingManager] = useState<any[]>([]);
    const [recentClosedCloseouts, setRecentClosedCloseouts] = useState<any[]>([]);
    const [pendingClaims, setPendingClaims] = useState<any[]>([]);
    const [liquidationProtocols, setLiquidationProtocols] = useState<any[]>([]);
    const [siteExpensesThisMonth, setSiteExpensesThisMonth] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const fetchExecutiveData = async () => {
            setIsLoading(true);
            try {
                // 1. Zamknięcia budów
                const closeoutsSnap = await getDocs(collection(db, "closeouts"));
                const allCloseouts = closeoutsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
                
                setCloseoutsPendingDirector(allCloseouts.filter((c: any) => c.status === "OCZEKUJE_NA_DYREKCJE"));
                setCloseoutsPendingManager(allCloseouts.filter((c: any) => c.status === "OCZEKUJE_NA_KIEROWNIKA"));
                setRecentClosedCloseouts(
                    allCloseouts
                        .filter((c: any) => c.status === "ROZLICZONA")
                        .slice(0, 5)
                );

                // 2. Sąd CLS / Sprawy sporne
                try {
                    const claimsSnap = await getDocs(collection(db, "claims"));
                    const allClaims = claimsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
                    setPendingClaims(allClaims.filter((c: any) => c.status !== "ZAKOŃCZONA" && c.status !== "ARCHIWUM"));
                } catch (err) {
                    console.warn("Błąd pobierania claims:", err);
                }

                // 3. Protokoły Likwidacji (PL)
                try {
                    const protoQ = query(collection(db, "protocols"), where("type", "==", "LIKWIDACJA"));
                    const protoSnap = await getDocs(protoQ);
                    setLiquidationProtocols(protoSnap.docs.map(d => ({ id: d.id, ...d.data() })));
                } catch (err) {
                    console.warn("Błąd pobierania protokołów likwidacji:", err);
                }

                // 4. Drobne wydatki budów
                try {
                    const expSnap = await getDocs(collection(db, "site_expenses"));
                    setSiteExpensesThisMonth(expSnap.docs.map(d => ({ id: d.id, ...d.data() })));
                } catch (err) {
                    console.warn("Błąd pobierania site_expenses:", err);
                }

            } catch (error) {
                console.error("Błąd ładowania danych kokpitu dyrekcji:", error);
            } finally {
                setIsLoading(false);
            }
        };

        fetchExecutiveData();
    }, []);

    // --- KALKULACJE MAJĄTKOWE ---
    const totalAssetsValue = inventoryItems.reduce((sum, item) => {
        const qty = item.type === "UNIQUE" ? 1 : (item.totalQuantity || 0);
        return sum + ((item.purchasePrice || 0) * qty);
    }, 0);

    const activeSitesList = sites.filter(s => s.status !== "ZAKOŃCZONA");
    const activeSiteIds = new Set(activeSitesList.map(s => s.id));

    // Wartość sprzętu w terenie na budowach
    let assetsInField = 0;
    inventoryItems.forEach(item => {
        if (item.allocations) {
            Object.entries(item.allocations).forEach(([sId, qty]) => {
                if (activeSiteIds.has(sId) && typeof qty === "number" && qty > 0) {
                    assetsInField += (item.purchasePrice || 0) * qty;
                }
            });
        }
    });

    // Sprzęt wolny na bazie
    const assetsInWarehouse = Math.max(0, totalAssetsValue - assetsInField);

    // Suma zablokowana u inwestorów ze spraw oczekujących
    const totalDisputedAtInvestors = closeoutsPendingDirector.reduce((sum, c) => {
        return sum + (c.financialSummary?.totalDisputedCost || 0);
    }, 0);

    // Suma strat z oczekujących zamknięć
    const totalPendingLosses = closeoutsPendingDirector.reduce((sum, c) => {
        return sum + (c.financialSummary?.totalLossCost || 0);
    }, 0);

    return (
        <div className="space-y-8 animate-fade-in font-sans">
            
            {/* GÓRNY BANER POWITALNY ZARZĄDU */}
            <div className="bg-gradient-to-r from-slate-900 via-blue-950 to-slate-900 text-white rounded-3xl p-6 sm:p-8 shadow-xl relative overflow-hidden">
                <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="bg-amber-400 text-slate-950 font-black text-[10px] uppercase tracking-wider px-2.5 py-0.5 rounded-full">
                                KOKPIT ZARZĄDU PESAM
                            </span>
                            <span className="text-slate-400 text-xs">
                                • {new Date().toLocaleDateString("pl-PL", { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                            </span>
                        </div>
                        <h1 className="text-2xl sm:text-3xl font-black tracking-tight mt-1.5">
                            Dzień dobry, {user?.firstName} {user?.lastName}
                        </h1>
                        <p className="text-slate-300 text-xs sm:text-sm mt-1 max-w-2xl leading-relaxed">
                            Panel decyzyjny Dyrekcji i Prezesa Zarządu. Sprawdź oczekujące zamknięcia budów, orzeczenia strat oraz stan majątku spółki.
                        </p>
                    </div>

                    <div className="flex items-center gap-2.5 w-full md:w-auto justify-end">
                        {onSwitchToOperational && (
                            <button
                                onClick={onSwitchToOperational}
                                className="bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold px-4 py-2.5 rounded-xl transition flex items-center gap-1.5 cursor-pointer shadow-sm"
                            >
                                <span>📦</span> Widok Magazynu
                            </button>
                        )}
                        <Link
                            href="/dashboard/closeout-approvals"
                            className="bg-blue-600 hover:bg-blue-500 text-white font-black text-xs uppercase tracking-wider px-5 py-2.5 rounded-xl shadow-lg shadow-blue-500/30 transition flex items-center gap-2"
                        >
                            <span>✍️</span> Autoryzacje ({closeoutsPendingDirector.length})
                        </Link>
                    </div>
                </div>

                {/* TŁO DEKORACYJNE */}
                <div className="absolute -right-10 -bottom-10 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />
            </div>

            {/* SEKCJA 1: SKRZYNKA DECYZJI ZARZĄDU (CO WYMAGA MOJEJ AKCJI) */}
            <div className="space-y-4">
                <div className="flex justify-between items-center">
                    <div>
                        <h2 className="text-lg font-black text-slate-800 tracking-tight flex items-center gap-2">
                            <span>🚨</span> Skrzynka Decyzji Zarządu
                        </h2>
                        <p className="text-xs text-slate-500">Sprawy wymagające Twojego podpisu, orzeczenia lub akceptacji</p>
                    </div>
                    {isLoading && <span className="text-xs text-slate-400 animate-pulse font-medium">Odświeżanie danych...</span>}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    
                    {/* KAFELEK 1: ZAMKNIĘCIA BUDÓW */}
                    <div className="bg-white rounded-3xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition flex flex-col justify-between">
                        <div>
                            <div className="flex justify-between items-start">
                                <span className="p-3 bg-red-50 text-red-700 rounded-2xl text-xl font-bold">🔒</span>
                                <span className={`font-mono font-black text-xs px-2.5 py-1 rounded-full ${
                                    closeoutsPendingDirector.length > 0 ? "bg-red-100 text-red-800 animate-pulse" : "bg-slate-100 text-slate-600"
                                }`}>
                                    {closeoutsPendingDirector.length} do decyzji
                                </span>
                            </div>
                            <h3 className="font-black text-slate-900 text-base mt-3">Zamknięcia Budów</h3>
                            <p className="text-slate-500 text-xs mt-1">
                                Sprawy rozliczone przez magazyn i podpisane przez kierowników, czekające na ostateczną autoryzację Zarządu.
                            </p>

                            {/* SZYBKA LISTA SPRAW */}
                            <div className="mt-3 space-y-1.5 border-t pt-2.5">
                                {closeoutsPendingDirector.length === 0 ? (
                                    <p className="text-slate-400 text-[11px] italic">Brak spraw oczekujących na Zarząd.</p>
                                ) : (
                                    closeoutsPendingDirector.slice(0, 2).map((c: any) => (
                                        <div key={c.id} className="p-2 bg-slate-50 rounded-xl text-[11px] flex justify-between items-center">
                                            <span className="font-bold text-slate-800 truncate max-w-[140px]">{c.siteName}</span>
                                            <span className="text-red-700 font-bold">{c.financialSummary?.totalLossCost || 0} zł strat</span>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>

                        <div className="pt-4 border-t mt-4">
                            <Link
                                href="/dashboard/closeout-approvals"
                                className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs py-2.5 rounded-xl transition flex items-center justify-center gap-1.5"
                            >
                                <span>Otwórz Centrum Zatwierdzeń</span> &rarr;
                            </Link>
                        </div>
                    </div>

                    {/* KAFELEK 2: SĄD PESAM / SPRAWY CLS */}
                    <div className="bg-white rounded-3xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition flex flex-col justify-between">
                        <div>
                            <div className="flex justify-between items-start">
                                <span className="p-3 bg-amber-50 text-amber-700 rounded-2xl text-xl font-bold">⚖️</span>
                                <span className={`font-mono font-black text-xs px-2.5 py-1 rounded-full ${
                                    pendingClaims.length > 0 ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-600"
                                }`}>
                                    {pendingClaims.length} w toku
                                </span>
                            </div>
                            <h3 className="font-black text-slate-900 text-base mt-3">Sąd Sprzętowy (CLS)</h3>
                            <p className="text-slate-500 text-xs mt-1">
                                Spory dotyczące uszkodzeń sprzętu na budowach. AI przesłuchało kierowników i przygotowało raporty do wyroku.
                            </p>

                            <div className="mt-3 space-y-1.5 border-t pt-2.5">
                                {pendingClaims.length === 0 ? (
                                    <p className="text-slate-400 text-[11px] italic">Brak otwartych postępowań szkodowych.</p>
                                ) : (
                                    pendingClaims.slice(0, 2).map((cl: any) => (
                                        <div key={cl.id} className="p-2 bg-amber-50/50 rounded-xl text-[11px] flex justify-between items-center">
                                            <span className="font-bold text-slate-800 truncate max-w-[140px]">{cl.inventoryName || "Sprzęt"}</span>
                                            <span className="text-amber-800 font-bold uppercase text-[9px]">{cl.status || "W toku"}</span>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>

                        <div className="pt-4 border-t mt-4">
                            <Link
                                href="/dashboard/claims"
                                className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs py-2.5 rounded-xl transition flex items-center justify-center gap-1.5"
                            >
                                <span>Przejdź do Wokandy CLS</span> &rarr;
                            </Link>
                        </div>
                    </div>

                    {/* KAFELEK 3: PROTOKOŁY LIKWIDACJI MAJĄTKU (PL) */}
                    <div className="bg-white rounded-3xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition flex flex-col justify-between">
                        <div>
                            <div className="flex justify-between items-start">
                                <span className="p-3 bg-blue-50 text-blue-700 rounded-2xl text-xl font-bold">📋</span>
                                <span className="font-mono font-black text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">
                                    {liquidationProtocols.length} w rejestrze
                                </span>
                            </div>
                            <h3 className="font-black text-slate-900 text-base mt-3">Likwidacja Majątku (PL)</h3>
                            <p className="text-slate-500 text-xs mt-1">
                                Protokoły fizycznego wykreślenia zniszczonego i zużytego sprzętu z ewidencji księgowej spółki.
                            </p>

                            <div className="mt-3 space-y-1.5 border-t pt-2.5 text-[11px] text-slate-600">
                                <p>Wnioski likwidacyjne komisji magazynowej generują się bezpośrednio z zatwierdzeń budów do podpisu Prezesa.</p>
                            </div>
                        </div>

                        <div className="pt-4 border-t mt-4">
                            <Link
                                href="/dashboard/closeout-approvals"
                                className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs py-2.5 rounded-xl transition flex items-center justify-center gap-1.5"
                            >
                                <span>Podgląd i Druk Protokołów</span> &rarr;
                            </Link>
                        </div>
                    </div>

                </div>
            </div>

            {/* SEKCJA 2: RADAR MAJĄTKU I FINANSÓW (KPI NA ŻYWO) */}
            <div className="space-y-4">
                <div>
                    <h2 className="text-lg font-black text-slate-800 tracking-tight flex items-center gap-2">
                        <span>📊</span> Radar Majątku i Ryzyk Finansowych
                    </h2>
                    <p className="text-xs text-slate-500">Kluczowe wskaźniki wartości i alokacji sprzętu PESAM</p>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    
                    <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm">
                        <p className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Majątek na Budowach</p>
                        <p className="text-xl sm:text-2xl font-black text-blue-900 mt-1">
                            {assetsInField.toLocaleString("pl-PL")} zł
                        </p>
                        <p className="text-[10px] text-slate-500 mt-1">Pracuje na {activeSitesList.length} budowach</p>
                    </div>

                    <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm">
                        <p className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Majątek Wolny (Baza)</p>
                        <p className="text-xl sm:text-2xl font-black text-slate-900 mt-1">
                            {assetsInWarehouse.toLocaleString("pl-PL")} zł
                        </p>
                        <p className="text-[10px] text-slate-500 mt-1">Dostępny w magazynie centralnym</p>
                    </div>

                    <div className="bg-white p-5 rounded-3xl border border-amber-300 bg-amber-50/40 shadow-sm">
                        <p className="text-[10px] font-black uppercase text-amber-800 tracking-wider">Spór / U Inwestora</p>
                        <p className="text-xl sm:text-2xl font-black text-amber-900 mt-1">
                            {totalDisputedAtInvestors.toLocaleString("pl-PL")} zł
                        </p>
                        <p className="text-[10px] text-amber-700 mt-1">Do refakturowania lub odbioru</p>
                    </div>

                    <div className="bg-white p-5 rounded-3xl border border-red-200 bg-red-50/40 shadow-sm">
                        <p className="text-[10px] font-black uppercase text-red-800 tracking-wider">Straty do Autoryzacji</p>
                        <p className="text-xl sm:text-2xl font-black text-red-900 mt-1">
                            {totalPendingLosses.toLocaleString("pl-PL")} zł
                        </p>
                        <p className="text-[10px] text-red-700 mt-1">Wnioski o odpis w koszty</p>
                    </div>

                </div>
            </div>

            {/* SEKCJA 3: AKTYWNE INWESTYCJE I SZYBKIE PRZEJŚCIE */}
            <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm space-y-4">
                <div className="flex justify-between items-center">
                    <div>
                        <h2 className="text-base font-black text-slate-900 uppercase tracking-tight">
                            Status Inwestycji ({activeSitesList.length} aktywnych budów)
                        </h2>
                        <p className="text-xs text-slate-500">Szybki podgląd prowadzonych kontraktów i ich kierowników</p>
                    </div>
                    <Link
                        href="/dashboard/sites"
                        className="text-xs font-bold text-blue-600 hover:text-blue-800 underline"
                    >
                        Zarządzaj budowami &rarr;
                    </Link>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {activeSitesList.slice(0, 6).map(site => (
                        <div key={site.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-200/80 hover:border-blue-300 transition flex flex-col justify-between">
                            <div>
                                <div className="flex justify-between items-start">
                                    <h4 className="font-bold text-slate-900 text-sm">{site.name}</h4>
                                    <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 uppercase">
                                        Aktywna
                                    </span>
                                </div>
                                <p className="text-[11px] text-slate-500 mt-1">📍 {site.location || "Polska"}</p>
                            </div>
                            <div className="mt-3 pt-2 border-t border-slate-200 flex justify-between items-center text-[10px]">
                                <span className="text-slate-400">Rozliczenie:</span>
                                <Link
                                    href="/dashboard/closeouts"
                                    className="font-bold text-blue-600 hover:underline"
                                >
                                    Audyt majątku &rarr;
                                </Link>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* SEKCJA 4: SZYBKIE SKRÓTY DYREKCJI */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Link
                    href="/dashboard/closeout-approvals"
                    className="p-4 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl font-bold text-xs flex items-center gap-2 transition shadow-sm"
                >
                    <span className="text-lg">✍️</span>
                    <span>Zatwierdzanie Zamknięć</span>
                </Link>
                <Link
                    href="/dashboard/claims"
                    className="p-4 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl font-bold text-xs flex items-center gap-2 transition shadow-sm"
                >
                    <span className="text-lg">⚖️</span>
                    <span>Centrum Spraw (CLS)</span>
                </Link>
                <Link
                    href="/dashboard/inventory"
                    className="p-4 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl font-bold text-xs flex items-center gap-2 transition shadow-sm"
                >
                    <span className="text-lg">📦</span>
                    <span>Katalog Majątku i Wyceny</span>
                </Link>
                <Link
                    href="/dashboard/admin/settings"
                    className="p-4 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl font-bold text-xs flex items-center gap-2 transition shadow-sm"
                >
                    <span className="text-lg">⚙️</span>
                    <span>Ustawienia Systemu</span>
                </Link>
            </div>

        </div>
    );
}
