"use client";

import React, { useState, useMemo } from "react";

export interface InventoryItemForHistory {
    id: string;
    name: string;
    inventoryNumber: string;
    category?: string;
    subcategory?: string;
    availableQuantity: number;
    totalQuantity: number;
    unit?: string;
    allocations?: Record<string, number>;
    imageUrl?: string;
    status?: string;
    [key: string]: any;
}

export interface DetailedProtocolEntry {
    id: string;
    protocolId: string;
    type: string;
    documentDate: string;
    createdAt?: string;
    siteName: string;
    siteId?: string;
    quantity: number;
    unit: string;
    status?: string;
    user: string;
    notes?: string;
    documentSource?: string;
}

interface BulkDetailedHistoryModalProps {
    isOpen: boolean;
    onClose: () => void;
    item: InventoryItemForHistory | null;
    protocols: DetailedProtocolEntry[];
    loading: boolean;
    sitesDictionary: Record<string, string>;
    onRefresh?: () => void;
}

export default function BulkDetailedHistoryModal({
    isOpen,
    onClose,
    item,
    protocols,
    loading,
    sitesDictionary,
    onRefresh
}: BulkDetailedHistoryModalProps) {
    const [filterType, setFilterType] = useState<"ALL" | "WYDANIE" | "ZWROT">("ALL");
    const [searchQuery, setSearchQuery] = useState("");
    const [selectedSiteFilter, setSelectedSiteFilter] = useState<string | null>(null);

    // Obliczenia stanów magazyn + budowy
    const unit = item?.unit || "szt.";
    const availableQty = Number(item?.availableQuantity) || 0;
    
    // Alokacje na budowach
    const siteAllocations = useMemo(() => {
        if (!item?.allocations) return [];
        return Object.entries(item.allocations)
            .map(([siteId, qty]) => {
                const siteName = sitesDictionary[siteId] || siteId;
                return {
                    siteId,
                    siteName,
                    quantity: Number(qty) || 0
                };
            })
            .filter(alloc => alloc.quantity > 0)
            .sort((a, b) => b.quantity - a.quantity);
    }, [item?.allocations, sitesDictionary]);

    const totalOnSites = useMemo(() => {
        return siteAllocations.reduce((sum, s) => sum + s.quantity, 0);
    }, [siteAllocations]);

    const estimatedTotal = availableQty + totalOnSites;

    // Statystyki z protokołów
    const protocolStats = useMemo(() => {
        let totalIssued = 0;
        let totalReturned = 0;
        let issueCount = 0;
        let returnCount = 0;

        protocols.forEach(p => {
            const isIssue = p.type?.toUpperCase().includes("WYDANIE") || p.type?.toUpperCase() === "WYD";
            const isReturn = p.type?.toUpperCase().includes("ZWROT") || p.type?.toUpperCase() === "ZWR";
            const qty = Number(p.quantity) || 0;

            if (isIssue) {
                totalIssued += qty;
                issueCount++;
            } else if (isReturn) {
                totalReturned += qty;
                returnCount++;
            }
        });

        return {
            totalIssued,
            totalReturned,
            issueCount,
            returnCount,
            netBalance: totalIssued - totalReturned
        };
    }, [protocols]);

    // Filtrowanie listy protokołów
    const filteredProtocols = useMemo(() => {
        return protocols.filter(p => {
            const isIssue = p.type?.toUpperCase().includes("WYDANIE") || p.type?.toUpperCase() === "WYD";
            const isReturn = p.type?.toUpperCase().includes("ZWROT") || p.type?.toUpperCase() === "ZWR";

            if (filterType === "WYDANIE" && !isIssue) return false;
            if (filterType === "ZWROT" && !isReturn) return false;

            if (selectedSiteFilter) {
                const matchesSite = (p.siteId === selectedSiteFilter) || 
                    (p.siteName && p.siteName.toLowerCase() === selectedSiteFilter.toLowerCase());
                if (!matchesSite) return false;
            }

            if (searchQuery.trim()) {
                const q = searchQuery.toLowerCase().trim();
                const matchProtoId = (p.protocolId || "").toLowerCase().includes(q);
                const matchSite = (p.siteName || "").toLowerCase().includes(q);
                const matchUser = (p.user || "").toLowerCase().includes(q);
                const matchNotes = (p.notes || "").toLowerCase().includes(q);
                const matchDate = (p.documentDate || "").includes(q);
                return matchProtoId || matchSite || matchUser || matchNotes || matchDate;
            }

            return true;
        });
    }, [protocols, filterType, selectedSiteFilter, searchQuery]);

    if (!isOpen || !item) return null;

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4 animate-fade-in" onClick={onClose}>
            <div 
                className="bg-white rounded-3xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden border border-slate-200"
                onClick={e => e.stopPropagation()}
            >
                {/* NAGŁÓWEK */}
                <div className="bg-slate-900 text-white p-5 sm:p-6 flex justify-between items-start border-b border-slate-800">
                    <div className="flex items-start gap-4 min-w-0">
                        {item.imageUrl ? (
                            <img 
                                src={item.imageUrl} 
                                alt={item.name} 
                                className="w-14 h-14 object-cover rounded-2xl border-2 border-slate-700 flex-shrink-0 bg-slate-800"
                            />
                        ) : (
                            <div className="w-14 h-14 rounded-2xl bg-slate-800 border-2 border-slate-700 flex items-center justify-center text-2xl flex-shrink-0">
                                📦
                            </div>
                        )}
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap mb-1">
                                <span className="bg-blue-600/30 text-blue-300 border border-blue-500/40 text-[10px] font-black px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                                    Sprzęt Bulk / Systemowy
                                </span>
                                <span className="font-mono text-xs font-bold text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-lg border border-amber-400/20">
                                    Kod: {item.inventoryNumber || "BRAK"}
                                </span>
                                {item.category && (
                                    <span className="text-[11px] text-slate-400">
                                        {item.category} {item.subcategory ? `› ${item.subcategory}` : ""}
                                    </span>
                                )}
                            </div>
                            <h2 className="text-xl sm:text-2xl font-black text-white truncate tracking-tight">
                                {item.name}
                            </h2>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {onRefresh && (
                            <button 
                                onClick={onRefresh}
                                title="Odśwież dane"
                                className="w-9 h-9 rounded-xl bg-slate-800 text-slate-300 hover:text-white hover:bg-slate-700 flex items-center justify-center transition"
                            >
                                🔄
                            </button>
                        )}
                        <button 
                            onClick={onClose}
                            className="w-9 h-9 rounded-xl bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 flex items-center justify-center text-2xl font-light leading-none transition"
                        >
                            &times;
                        </button>
                    </div>
                </div>

                {/* ZAWARTOŚĆ PRZEWIJANA */}
                <div className="p-5 sm:p-6 overflow-y-auto space-y-6 flex-1 bg-slate-50/50">
                    
                    {/* 1. KARTY KPI: SZACUNKOWA ŁĄCZNA ILOŚĆ (MAGAZYN + BUDOWY) */}
                    <div>
                        <div className="flex justify-between items-center mb-3">
                            <h3 className="text-xs font-black uppercase text-slate-500 tracking-wider flex items-center gap-2">
                                <span>📊</span> Bilans Stanu Magazynowego i Budów
                            </h3>
                            <span className="text-[11px] font-bold text-slate-400">
                                Jednostka: <b className="text-slate-700">{unit}</b>
                            </span>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                            {/* Karta 1: Magazyn */}
                            <div className="bg-white border-2 border-blue-100 rounded-2xl p-4 shadow-sm hover:border-blue-300 transition">
                                <div className="flex items-center justify-between text-blue-600 mb-1">
                                    <span className="text-xs font-black uppercase tracking-wider">🏬 Stan na Magazynie</span>
                                    <span className="text-lg">📦</span>
                                </div>
                                <div className="flex items-baseline gap-1.5 mt-1">
                                    <span className="text-3xl font-black text-slate-800">{availableQty}</span>
                                    <span className="text-xs font-bold text-slate-400">{unit}</span>
                                </div>
                                <p className="text-[11px] text-blue-700 font-medium mt-1">
                                    Sprzęt fizycznie dostępny do wydania
                                </p>
                            </div>

                            {/* Karta 2: Budowy */}
                            <div className="bg-white border-2 border-amber-100 rounded-2xl p-4 shadow-sm hover:border-amber-300 transition">
                                <div className="flex items-center justify-between text-amber-600 mb-1">
                                    <span className="text-xs font-black uppercase tracking-wider">🏗️ Łącznie na Budowach</span>
                                    <span className="text-lg">🚧</span>
                                </div>
                                <div className="flex items-baseline gap-1.5 mt-1">
                                    <span className="text-3xl font-black text-slate-800">{totalOnSites}</span>
                                    <span className="text-xs font-bold text-slate-400">{unit}</span>
                                </div>
                                <p className="text-[11px] text-amber-700 font-medium mt-1">
                                    Na {siteAllocations.length} {siteAllocations.length === 1 ? "aktywnej budowie" : "aktywnych budowach"}
                                </p>
                            </div>

                            {/* Karta 3: Łączna Szacowana Ilość (Magazyn + Budowy) */}
                            <div className="bg-gradient-to-br from-emerald-500 to-teal-600 text-white rounded-2xl p-4 shadow-md">
                                <div className="flex items-center justify-between text-emerald-100 mb-1">
                                    <span className="text-xs font-black uppercase tracking-wider">📦 Szacowana Łączna Ilość</span>
                                    <span className="text-lg">⚖️</span>
                                </div>
                                <div className="flex items-baseline gap-1.5 mt-1">
                                    <span className="text-3xl font-black text-white">{estimatedTotal}</span>
                                    <span className="text-xs font-bold text-emerald-100">{unit}</span>
                                </div>
                                <p className="text-[11px] text-emerald-100 font-medium mt-1">
                                    Magazyn ({availableQty}) + Budowy ({totalOnSites})
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* 2. AKTUALNY ROZKŁAD NA BUDOWACH (GDZIE JEST SPRZĘT?) */}
                    <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-sm">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                            <h4 className="text-xs font-black uppercase text-slate-700 tracking-wider flex items-center gap-2">
                                <span>📍</span> Aktualna obecność na budowach (Alokacje)
                            </h4>
                            {selectedSiteFilter && (
                                <button 
                                    onClick={() => setSelectedSiteFilter(null)}
                                    className="text-xs text-blue-600 hover:text-blue-800 font-bold flex items-center gap-1 self-start"
                                >
                                    <span>✕ Wyzeruj filtr budowy ({sitesDictionary[selectedSiteFilter] || selectedSiteFilter})</span>
                                </button>
                            )}
                        </div>

                        {siteAllocations.length === 0 ? (
                            <div className="text-center py-5 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                                <p className="text-slate-500 text-xs font-bold">
                                    Wszystkie sztuki znajdują się obecnie na magazynie.
                                </p>
                                <p className="text-[11px] text-slate-400 mt-0.5">
                                    Brak aktywnych stanów zaalokowanych na budowach.
                                </p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                                {siteAllocations.map(alloc => {
                                    const isSelected = selectedSiteFilter === alloc.siteId || selectedSiteFilter === alloc.siteName;
                                    const percent = estimatedTotal > 0 ? Math.round((alloc.quantity / estimatedTotal) * 100) : 0;
                                    return (
                                        <div 
                                            key={alloc.siteId}
                                            onClick={() => setSelectedSiteFilter(isSelected ? null : alloc.siteId)}
                                            className={`p-3 rounded-xl border transition cursor-pointer flex items-center justify-between gap-3 ${
                                                isSelected 
                                                    ? 'bg-blue-50 border-blue-400 ring-2 ring-blue-300' 
                                                    : 'bg-slate-50 hover:bg-slate-100 border-slate-200'
                                            }`}
                                            title="Kliknij, aby przefiltrować protokoły poniżej do tej budowy"
                                        >
                                            <div className="min-w-0">
                                                <p className="text-xs font-black text-slate-800 truncate">
                                                    🏗️ {alloc.siteName}
                                                </p>
                                                <p className="text-[10px] text-slate-400">
                                                    {percent}% całości sprzętu
                                                </p>
                                            </div>
                                            <div className="text-right flex-shrink-0">
                                                <span className="text-sm font-black text-amber-700 bg-amber-100 px-2 py-0.5 rounded-lg border border-amber-200">
                                                    {alloc.quantity} {unit}
                                                </span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* 3. HISTORIA PROTOKOŁÓW (WYDANIA, ZWROTY) */}
                    <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-sm space-y-4">
                        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b pb-4">
                            <div>
                                <h4 className="text-xs font-black uppercase text-slate-800 tracking-wider flex items-center gap-2">
                                    <span>📜</span> Rejestr Protokołów danego przedmiotu
                                </h4>
                                <div className="flex items-center gap-3 text-[11px] font-bold text-slate-500 mt-1 flex-wrap">
                                    <span>
                                        ↗️ Łącznie wydano: <strong className="text-blue-700">{protocolStats.totalIssued} {unit}</strong> ({protocolStats.issueCount} prot.)
                                    </span>
                                    <span className="text-slate-300">•</span>
                                    <span>
                                        ↙️ Łącznie zwrócono: <strong className="text-emerald-700">{protocolStats.totalReturned} {unit}</strong> ({protocolStats.returnCount} prot.)
                                    </span>
                                </div>
                            </div>

                            {/* FILTRY I WYSZUKIWARKA */}
                            <div className="flex flex-wrap items-center gap-2">
                                <div className="flex bg-slate-100 p-0.5 rounded-xl border border-slate-200 text-xs font-bold">
                                    <button
                                        onClick={() => setFilterType("ALL")}
                                        className={`px-3 py-1.5 rounded-lg transition ${
                                            filterType === "ALL" 
                                                ? "bg-white text-slate-800 shadow-sm" 
                                                : "text-slate-500 hover:text-slate-800"
                                        }`}
                                    >
                                        Wszystkie ({protocols.length})
                                    </button>
                                    <button
                                        onClick={() => setFilterType("WYDANIE")}
                                        className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1 ${
                                            filterType === "WYDANIE" 
                                                ? "bg-blue-600 text-white shadow-sm" 
                                                : "text-slate-500 hover:text-blue-600"
                                        }`}
                                    >
                                        <span>↗️</span> Wydania ({protocolStats.issueCount})
                                    </button>
                                    <button
                                        onClick={() => setFilterType("ZWROT")}
                                        className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1 ${
                                            filterType === "ZWROT" 
                                                ? "bg-emerald-600 text-white shadow-sm" 
                                                : "text-slate-500 hover:text-emerald-600"
                                        }`}
                                    >
                                        <span>↙️</span> Zwroty ({protocolStats.returnCount})
                                    </button>
                                </div>

                                <input
                                    type="text"
                                    placeholder="🔍 Szukaj protokołu, budowy..."
                                    value={searchQuery}
                                    onChange={e => setSearchQuery(e.target.value)}
                                    className="text-xs px-3 py-2 border rounded-xl bg-slate-50 focus:bg-white outline-none focus:ring-2 focus:ring-blue-400 w-48 sm:w-56"
                                />
                            </div>
                        </div>

                        {/* LISTA / TABELA PROTOKOŁÓW */}
                        {loading ? (
                            <div className="py-12 text-center text-slate-400 animate-pulse space-y-2">
                                <span className="text-3xl block">⏳</span>
                                <p className="text-xs font-bold">Przeszukiwanie bazy protokołów dla tego przedmiotu...</p>
                            </div>
                        ) : filteredProtocols.length === 0 ? (
                            <div className="py-10 text-center bg-slate-50 rounded-2xl border border-dashed border-slate-200">
                                <span className="text-3xl block mb-2">📋</span>
                                <p className="text-slate-500 text-sm font-bold">
                                    Brak protokołów spełniających wybrane kryteria.
                                </p>
                                <p className="text-xs text-slate-400 mt-1">
                                    {protocols.length === 0 
                                        ? "Dla tego przedmiotu nie zarejestrowano jeszcze protokołów wydania ani zwrotu."
                                        : "Zmień parametry wyszukiwania lub zresetuj filtr."}
                                </p>
                            </div>
                        ) : (
                            <div className="overflow-x-auto border border-slate-200 rounded-xl">
                                <table className="w-full text-left text-xs">
                                    <thead className="bg-slate-100/80 border-b border-slate-200 text-[10px] font-black uppercase text-slate-500">
                                        <tr>
                                            <th className="p-3">Data</th>
                                            <th className="p-3">Nr Protokołu</th>
                                            <th className="p-3">Typ</th>
                                            <th className="p-3">Budowa</th>
                                            <th className="p-3 text-right">Ilość</th>
                                            <th className="p-3">Osoba</th>
                                            <th className="p-3">Uwagi / Notatka</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100">
                                        {filteredProtocols.map((p, idx) => {
                                            const isIssue = p.type?.toUpperCase().includes("WYDANIE") || p.type?.toUpperCase() === "WYD";
                                            const isReturn = p.type?.toUpperCase().includes("ZWROT") || p.type?.toUpperCase() === "ZWR";
                                            const formattedDate = p.documentDate 
                                                ? new Date(p.documentDate).toLocaleDateString("pl-PL")
                                                : (p.createdAt ? new Date(p.createdAt).toLocaleDateString("pl-PL") : "---");

                                            return (
                                                <tr key={p.id || idx} className="hover:bg-slate-50/80 transition">
                                                    <td className="p-3 font-mono text-slate-600 whitespace-nowrap">
                                                        📅 {formattedDate}
                                                    </td>
                                                    <td className="p-3 whitespace-nowrap">
                                                        <span className="font-mono font-bold text-slate-800 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                                                            {p.protocolId}
                                                        </span>
                                                        {p.documentSource && (
                                                            <span className="ml-1.5 text-[9px] text-slate-400 uppercase">
                                                                ({p.documentSource === "PAPER" ? "papier" : "app"})
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td className="p-3 whitespace-nowrap">
                                                        {isIssue ? (
                                                            <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-100 text-blue-800 rounded-lg font-black text-[10px] uppercase">
                                                                <span>↗️</span> Wydanie
                                                            </span>
                                                        ) : isReturn ? (
                                                            <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-100 text-emerald-800 rounded-lg font-black text-[10px] uppercase">
                                                                <span>↙️</span> Zwrot
                                                            </span>
                                                        ) : (
                                                            <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg font-black text-[10px] uppercase">
                                                                {p.type}
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td className="p-3 font-bold text-slate-700">
                                                        🏗️ {p.siteName}
                                                    </td>
                                                    <td className="p-3 text-right whitespace-nowrap">
                                                        {isIssue ? (
                                                            <span className="font-black text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                                                                -{p.quantity} {p.unit || unit}
                                                            </span>
                                                        ) : (
                                                            <span className="font-black text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                                                                +{p.quantity} {p.unit || unit}
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td className="p-3 text-slate-500 whitespace-nowrap">
                                                        👤 {p.user}
                                                    </td>
                                                    <td className="p-3 text-slate-500 max-w-xs truncate">
                                                        {p.notes || <span className="text-slate-300 italic">Brak uwag</span>}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </div>

                {/* STOPKA MODALA */}
                <div className="p-4 bg-slate-100 border-t border-slate-200 flex justify-between items-center">
                    <p className="text-xs text-slate-500">
                        Podsumowanie: <b>{filteredProtocols.length}</b> pozycji w historii
                    </p>
                    <button
                        onClick={onClose}
                        className="px-6 py-2.5 bg-slate-800 hover:bg-slate-900 text-white font-bold text-xs rounded-xl shadow transition"
                    >
                        Zamknij
                    </button>
                </div>
            </div>
        </div>
    );
}
