// src/app/(dashboard)/dashboard/co2/page.tsx
"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { db } from "@/lib/firebase/config";
import { collection, query, orderBy, limit, getDocs } from "firebase/firestore";
import {
  CO2_GLOBAL_PARAMS,
  DISPOSAL_CO2_FACTORS_KG_PER_TONNE,
  REUSE_CO2_SAVINGS_KG_PER_TONNE,
  CO2_COST_PARAMS,
  calculateProtocolCo2Summary,
  calculateTransportCo2,
  calculateDisposalCo2,
  calculateCo2Cost,
  estimateItemWeightKg,
  ProtocolInput,
  ProtocolCo2Summary
} from "@/lib/co2/co2-calculator";

interface SiteInfo {
  id: string;
  name: string;
  location?: string;
}

export default function CO2ModulePage() {
  const [activeTab, setActiveTab] = useState<"register" | "simulator" | "settings">("register");
  const [rawProtocols, setRawProtocols] = useState<ProtocolInput[]>([]);
  const [sites, setSites] = useState<SiteInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterWasteOnly, setFilterWasteOnly] = useState(true);
  const [expandedProtocolId, setExpandedProtocolId] = useState<string | null>(null);

  // Widełki i parametry kosztowe (widełki 55 - 150 EUR/t wskazane przez użytkownika)
  const [minEurPerTon, setMinEurPerTon] = useState(CO2_COST_PARAMS.defaultMinEurPerTon);
  const [maxEurPerTon, setMaxEurPerTon] = useState(CO2_COST_PARAMS.defaultMaxEurPerTon);
  const [eurToPlnRate, setEurToPlnRate] = useState(CO2_COST_PARAMS.defaultEurToPlnRate);
  const [fuelConsumption, setFuelConsumption] = useState(CO2_GLOBAL_PARAMS.defaultFleetVehicleFuelConsumptionLPer100km);
  const [defaultDistance, setDefaultDistance] = useState(CO2_GLOBAL_PARAMS.defaultConstructionDistanceKm);
  const [allocationMethod, setAllocationMethod] = useState<'mass' | 'dedicated_100'>('mass');

  // Stan symulatora szybkiego przeliczenia
  const [simName, setSimName] = useState("Gruz betonowy (kawałki)");
  const [simQuantity, setSimQuantity] = useState<number>(1000);
  const [simUnit, setSimUnit] = useState("kg");
  const [simDistance, setSimDistance] = useState<number>(100);
  const [simMethodKey, setSimMethodKey] = useState<string>("util_beton_skladowisko");

  // Pobieranie protokołów i budów z Firestore
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // 1. Budowy
      const sitesSnap = await getDocs(collection(db, "sites"));
      const sitesList: SiteInfo[] = sitesSnap.docs.map(d => ({
        id: d.id,
        name: d.data().name || "Bez nazwy",
        location: d.data().location || ""
      }));
      setSites(sitesList);

      // 2. Protokoły
      const q = query(collection(db, "protocols"), orderBy("createdAt", "desc"), limit(150));
      const snap = await getDocs(q);
      
      const loaded: ProtocolInput[] = snap.docs.map(doc => {
        const d = doc.data();
        return {
          id: doc.id,
          documentNumber: d.documentNumber || d.number || doc.id,
          sourceSiteName: d.sourceSiteName || d.sourceName || d.destinationName || "Brak nazwy budowy",
          sourceId: d.sourceId,
          createdAt: typeof d.createdAt === "string" ? d.createdAt : (d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : ""),
          documentDate: d.documentDate || "",
          items: Array.isArray(d.items) ? d.items.map((it: any) => ({
            id: it.id || it.inventoryId,
            name: it.name || "Pozycja bez nazwy",
            quantity: Number(it.quantity) || 1,
            receivedQty: typeof it.receivedQty === "number" ? Number(it.receivedQty) : undefined,
            unit: it.unit || "szt.",
            notes: it.notes || "",
            condition: it.condition || "",
            category: it.category || "",
            subcategory: it.subcategory || "",
            finalStatus: it.finalStatus || "",
            isWaste: Boolean(it.isWaste || it.inventoryNumber === "ODPAD"),
            isResidual: Boolean(it.isResidual || it.inventoryNumber === "RESZTKI"),
            inventoryNumber: it.inventoryNumber || "",
            disposalMethodKey: it.disposalMethodKey
          })) : []
        };
      });

      setRawProtocols(loaded);
    } catch (err) {
      console.error("Błąd podczas pobierania protokołów do modułu CO2:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Przeliczenie podsumowań CO2 dla wszystkich protokołów z aktualnymi parametrami
  const calculatedSummaries = useMemo<ProtocolCo2Summary[]>(() => {
    return rawProtocols.map(protocol => {
      return calculateProtocolCo2Summary(protocol, defaultDistance, {
        minEurPerTon,
        maxEurPerTon,
        eurToPln: eurToPlnRate,
        fuelLPer100km: fuelConsumption,
        allocationMethod
      });
    });
  }, [rawProtocols, defaultDistance, minEurPerTon, maxEurPerTon, eurToPlnRate, fuelConsumption, allocationMethod]);

  // Filtrowanie listy protokołów
  const filteredSummaries = useMemo(() => {
    return calculatedSummaries.filter(summary => {
      // Filtr tylko odpady/resztki
      if (filterWasteOnly && !summary.hasResiduals) {
        return false;
      }
      // Filtr szukania
      if (searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        const matchesNumber = summary.protocolNumber.toLowerCase().includes(term);
        const matchesSite = summary.siteName.toLowerCase().includes(term);
        const matchesItems = summary.itemDetails.some(it => it.itemName.toLowerCase().includes(term));
        if (!matchesNumber && !matchesSite && !matchesItems) return false;
      }
      return true;
    });
  }, [calculatedSummaries, filterWasteOnly, searchTerm]);

  // KPI Agregaty
  const kpiData = useMemo(() => {
    let totalWeightKg = 0;
    let totalReuseKg = 0;
    let totalWasteKg = 0;
    let totalDisposalCo2Kg = 0;
    let totalCo2Kg = 0;
    let totalSavedCo2Kg = 0;
    let totalMinEur = 0;
    let totalMaxEur = 0;
    let totalMinPln = 0;
    let totalMaxPln = 0;

    for (const s of filteredSummaries) {
      totalWeightKg += s.totalEstimatedWeightKg;
      totalReuseKg += s.totalReuseWeightKg;
      totalWasteKg += s.totalWasteWeightKg;
      totalDisposalCo2Kg += s.disposalCo2Kg;
      totalCo2Kg += s.totalCo2EmissionKg;
      totalSavedCo2Kg += s.totalCo2SavedKg;
      totalMinEur += s.costs.minEur;
      totalMaxEur += s.costs.maxEur;
      totalMinPln += s.costs.minPln;
      totalMaxPln += s.costs.maxPln;
    }

    return {
      totalWeightKg,
      totalReuseKg: Number(totalReuseKg.toFixed(2)),
      totalWasteKg: Number(totalWasteKg.toFixed(2)),
      totalDisposalCo2Kg: Number(totalDisposalCo2Kg.toFixed(3)),
      totalWeightTonnes: Number((totalWeightKg / 1000).toFixed(2)),
      totalCo2Kg: Number(totalCo2Kg.toFixed(2)),
      totalCo2Tonnes: Number((totalCo2Kg / 1000).toFixed(3)),
      totalSavedCo2Kg: Number(totalSavedCo2Kg.toFixed(2)),
      totalMinEur: Number(totalMinEur.toFixed(2)),
      totalMaxEur: Number(totalMaxEur.toFixed(2)),
      totalMinPln: Number(totalMinPln.toFixed(2)),
      totalMaxPln: Number(totalMaxPln.toFixed(2))
    };
  }, [filteredSummaries]);

  // Obliczenia symulatora na żywo
  const simResults = useMemo(() => {
    const itemWeightKg = estimateItemWeightKg({
      name: simName,
      quantity: simQuantity,
      unit: simUnit
    });

    const transportCo2 = calculateTransportCo2(simDistance, fuelConsumption);
    const isReuse = simMethodKey === "reuse_magazyn";

    let disposalCo2 = 0;
    let savedCo2 = 0;

    if (isReuse) {
      disposalCo2 = 0;
      savedCo2 = Number(((itemWeightKg / 1000) * REUSE_CO2_SAVINGS_KG_PER_TONNE).toFixed(3));
    } else {
      disposalCo2 = calculateDisposalCo2(itemWeightKg, simMethodKey);
    }

    const totalCo2 = Number((transportCo2 + disposalCo2).toFixed(3));
    const costs = calculateCo2Cost(totalCo2, minEurPerTon, maxEurPerTon, eurToPlnRate);

    return {
      weightKg: itemWeightKg,
      transportCo2,
      disposalCo2,
      totalCo2,
      savedCo2,
      isReuse,
      costs
    };
  }, [simName, simQuantity, simUnit, simDistance, simMethodKey, fuelConsumption, minEurPerTon, maxEurPerTon, eurToPlnRate]);

  // Zastosowanie szablonu w symulatorze
  const applyTemplate = (name: string, qty: number, unit: string, methodKey: string, distanceKm: number = 80) => {
    setSimName(name);
    setSimQuantity(qty);
    setSimUnit(unit);
    setSimMethodKey(methodKey);
    setSimDistance(distanceKm);
  };

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 p-6 md:p-8 text-slate-900">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* NAGŁÓWEK MODUŁU */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm">
          <div>
            <div className="flex items-center gap-3">
              <span className="text-3xl">🌱</span>
              <div>
                <h1 className="text-2xl font-black text-slate-900 tracking-tight">
                  Moduł CO2 i Ślad Węglowy Odpadów Budowlanych
                </h1>
                <p className="text-sm text-slate-500 font-medium">
                  Ewidencja, transport i zagospodarowanie zwrotów oraz resztek budowlanych na magazyn
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="px-3.5 py-1.5 bg-amber-50 border border-amber-300 rounded-xl text-xs font-bold text-amber-900 flex items-center gap-1.5 shadow-sm">
              <span>💶</span>
              <span>Wycena CO2 (ETS): <strong>{minEurPerTon} € – {maxEurPerTon} € / tonę</strong></span>
            </div>

            <button
              onClick={fetchData}
              disabled={loading}
              className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition flex items-center gap-2 shadow-sm disabled:opacity-50"
            >
              <span className={loading ? "animate-spin" : ""}>🔄</span>
              Odśwież dane
            </button>
          </div>
        </div>

        {/* 4 KARTY KPI */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* KPI 1 */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm relative overflow-hidden">
            <div className="flex justify-between items-start mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Zwiezione Odpady & Resztki</span>
              <span className="p-2 bg-blue-50 text-blue-600 rounded-lg text-lg">🧱</span>
            </div>
            <div className="text-2xl font-black text-slate-900">
              {kpiData.totalWeightTonnes} <span className="text-sm font-semibold text-slate-500">t</span>
            </div>
            <div className="text-xs font-medium text-slate-500 mt-1">
              Łącznie: <strong>{kpiData.totalWeightKg.toLocaleString()} kg</strong> resztek (w tym {kpiData.totalReuseKg.toLocaleString()} kg reuse / {kpiData.totalWasteKg.toLocaleString()} kg utylizacja)
            </div>
          </div>

          {/* KPI 2 */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm relative overflow-hidden">
            <div className="flex justify-between items-start mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Ślad Węglowy Transportu & Utylizacji</span>
              <span className="p-2 bg-rose-50 text-rose-600 rounded-lg text-lg">💨</span>
            </div>
            <div className="text-2xl font-black text-slate-900">
              {kpiData.totalCo2Kg.toLocaleString()} <span className="text-sm font-semibold text-slate-500">kg CO2e</span>
            </div>
            <div className="text-xs font-medium text-slate-500 mt-1">
              Odpowiada: <strong>{kpiData.totalCo2Tonnes} t CO2e</strong>
            </div>
          </div>

          {/* KPI 3 */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm relative overflow-hidden">
            <div className="flex justify-between items-start mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Wycena Emisji (Widełki ETS)</span>
              <span className="p-2 bg-amber-50 text-amber-700 rounded-lg text-lg">⚖️</span>
            </div>
            <div className="text-xl font-black text-slate-900">
              {kpiData.totalMinEur.toLocaleString()} € – {kpiData.totalMaxEur.toLocaleString()} €
            </div>
            <div className="text-xs font-bold text-emerald-700 mt-1">
              {kpiData.totalMinPln.toLocaleString()} PLN – {kpiData.totalMaxPln.toLocaleString()} PLN
            </div>
          </div>

          {/* KPI 4 */}
          <div className="bg-emerald-950 p-5 rounded-2xl border border-emerald-800 shadow-sm text-white relative overflow-hidden">
            <div className="flex justify-between items-start mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-300">Odzysk & Cyrkularność (Reuse)</span>
              <span className="p-2 bg-emerald-900 text-emerald-300 rounded-lg text-lg">♻️</span>
            </div>
            <div className="text-2xl font-black text-emerald-400">
              {kpiData.totalSavedCo2Kg.toLocaleString()} <span className="text-sm font-semibold text-emerald-300">kg CO2</span>
            </div>
            <div className="text-xs font-medium text-emerald-300/80 mt-1">
              Zaoszczędzone dzięki ponownemu użyciu na magazynie
            </div>
          </div>
        </div>

        {/* ZAKŁADKI / TABS */}
        <div className="flex border-b border-slate-200 bg-white px-6 pt-3 rounded-t-2xl">
          <button
            onClick={() => setActiveTab("register")}
            className={`pb-3 px-4 text-sm font-bold border-b-2 transition flex items-center gap-2 ${
              activeTab === "register"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            <span>📋</span>
            Rejestr Protokołów z Odpadami ({filteredSummaries.length})
          </button>

          <button
            onClick={() => setActiveTab("simulator")}
            className={`pb-3 px-4 text-sm font-bold border-b-2 transition flex items-center gap-2 ${
              activeTab === "simulator"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            <span>🧮</span>
            Szybki Symulator / Kalkulator Odpadu
          </button>

          <button
            onClick={() => setActiveTab("settings")}
            className={`pb-3 px-4 text-sm font-bold border-b-2 transition flex items-center gap-2 ${
              activeTab === "settings"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            <span>📚</span>
            Baza Wskaźników & Ustawienia Widełek
          </button>
        </div>

        {/* TAB 1: REJESTR PROTOKOŁÓW */}
        {activeTab === "register" && (
          <div className="bg-white p-6 rounded-b-2xl border-x border-b border-slate-200/80 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="w-full sm:w-80 relative">
                <input
                  type="text"
                  placeholder="Szukaj po numerze, budowie lub materiale..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="absolute left-3 top-2.5 text-slate-400 text-sm">🔍</span>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-700 bg-slate-50 px-3 py-2 border border-slate-200 rounded-xl">
                  <span>Alokacja transportu:</span>
                  <select
                    value={allocationMethod}
                    onChange={(e) => setAllocationMethod(e.target.value as any)}
                    className="bg-white border border-slate-300 rounded px-2 py-1 text-xs font-semibold focus:outline-none"
                  >
                    <option value="mass">Proporcjonalna do masy resztek (wg wzoru)</option>
                    <option value="dedicated_100">100% dedykowany kurs po zwrot</option>
                  </select>
                </div>

                <label className="flex items-center gap-2.5 cursor-pointer text-sm font-bold text-slate-700 bg-slate-50 px-4 py-2 border border-slate-200 rounded-xl">
                  <input
                    type="checkbox"
                    checked={filterWasteOnly}
                    onChange={(e) => setFilterWasteOnly(e.target.checked)}
                    className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                  />
                  <span>Tylko zwroty z resztkami / odpadami</span>
                </label>
              </div>
            </div>

            {loading ? (
              <div className="py-16 text-center text-slate-500 font-medium">
                <span className="inline-block animate-spin text-2xl mr-2">⏳</span>
                Pobieranie i przeliczanie śladu CO2 protokołów...
              </div>
            ) : filteredSummaries.length === 0 ? (
              <div className="py-16 text-center text-slate-500 bg-slate-50 rounded-xl border border-dashed border-slate-300">
                <p className="text-base font-bold text-slate-700">Brak protokołów spełniających kryteria</p>
                <p className="text-xs text-slate-400 mt-1">Zmień frazę wyszukiwania lub odznacz filtr "Tylko zwroty z resztkami / odpadami".</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 text-slate-700 uppercase font-black tracking-wider border-b border-slate-200">
                    <tr>
                      <th className="py-3 px-4">Nr Protokołu</th>
                      <th className="py-3 px-4">Budowa Źródłowa</th>
                      <th className="py-3 px-4">Data</th>
                      <th className="py-3 px-4 text-center">Pozycje Resztek</th>
                      <th className="py-3 px-4 text-right">Masa Resztek (kg)</th>
                      <th className="py-3 px-4 text-right">Transp. CO2 (alokacja)</th>
                      <th className="py-3 px-4 text-right">Utyl. CO2</th>
                      <th className="py-3 px-4 text-right font-black text-slate-900">Łącznie CO2</th>
                      <th className="py-3 px-4 text-right">Wycena ({minEurPerTon}–{maxEurPerTon} €/t)</th>
                      <th className="py-3 px-4 text-center">Szczegóły</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-medium text-slate-800">
                    {filteredSummaries.map((s) => {
                      const isExpanded = expandedProtocolId === s.protocolId;
                      return (
                        <React.Fragment key={s.protocolId}>
                          <tr className={`hover:bg-slate-50/80 transition ${isExpanded ? "bg-blue-50/30" : ""}`}>
                            <td className="py-3 px-4 font-bold text-blue-600">
                              {s.protocolNumber}
                              {s.hasResiduals && (
                                <span className="ml-2 px-1.5 py-0.5 bg-amber-100 text-amber-900 rounded text-[9px] font-black uppercase border border-amber-300">
                                  Resztki
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4 font-bold text-slate-900">{s.siteName}</td>
                            <td className="py-3 px-4 text-slate-500">{s.date || "Brak daty"}</td>
                            <td className="py-3 px-4 text-center">
                              <span className="font-bold text-slate-900">{s.residualItemsCount}</span>
                              <span className="text-[10px] text-slate-400 block font-normal">(z {s.totalItemsCount} w prot.)</span>
                            </td>
                            <td className="py-3 px-4 text-right">
                              <span className="font-bold text-slate-900">{s.totalEstimatedWeightKg.toLocaleString()} kg</span>
                              {s.totalCargoWeightKg > s.totalEstimatedWeightKg && (
                                <span className="text-[10px] text-slate-400 block font-normal">
                                  z {s.totalCargoWeightKg.toLocaleString()} kg ładunku
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-right text-slate-700">
                              <span className="font-bold text-slate-900">{s.transportCo2Kg.toFixed(2)} kg</span>
                              <span className="text-[10px] text-blue-600 block font-semibold">
                                alokacja {(s.allocationRatio * 100).toFixed(1)}%
                              </span>
                            </td>
                            <td className="py-3 px-4 text-right text-slate-600">{s.disposalCo2Kg.toFixed(3)} kg</td>
                            <td className="py-3 px-4 text-right font-black text-rose-700">
                              {s.totalCo2EmissionKg.toFixed(2)} kg
                            </td>
                            <td className="py-3 px-4 text-right">
                              <div className="font-bold text-slate-900">
                                {s.costs.minEur.toFixed(2)} € – {s.costs.maxEur.toFixed(2)} €
                              </div>
                              <div className="text-[10px] text-slate-500">
                                ({s.costs.minPln.toFixed(1)} – {s.costs.maxPln.toFixed(1)} PLN)
                              </div>
                            </td>
                            <td className="py-3 px-4 text-center">
                              <button
                                onClick={() => setExpandedProtocolId(isExpanded ? null : s.protocolId)}
                                className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold transition"
                              >
                                {isExpanded ? "Zwiń ▲" : "Pozycje ▼"}
                              </button>
                            </td>
                          </tr>

                          {/* ROZWINIĘCIE SZCZEGÓŁÓW POZYCJI PROTOKOŁU */}
                          {isExpanded && (
                            <tr>
                              <td colSpan={10} className="p-4 bg-slate-100/60 border-y border-slate-200">
                                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-3">
                                  <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                                    <h4 className="font-black text-xs text-slate-800 uppercase tracking-wider">
                                      Zwiezione resztki materiałów: {s.protocolNumber} (Masa resztek: {s.totalEstimatedWeightKg} kg: {s.totalReuseWeightKg} kg ponowne użycie + {s.totalWasteWeightKg} kg ścinki/odpad do utylizacji | Alokacja transportu: {(s.allocationRatio * 100).toFixed(1)}% | Budowa: {s.siteName})
                                    </h4>
                                    <span className="text-xs font-bold text-emerald-700">
                                      Odzyskane CO2 (Reuse): +{s.totalCo2SavedKg} kg CO2
                                    </span>
                                  </div>

                                  <div className="overflow-x-auto">
                                    <table className="w-full text-left text-xs">
                                      <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-100">
                                        <tr>
                                          <th className="py-2 px-3">Nazwa materiału / odpadu</th>
                                          <th className="py-2 px-3 text-center">Ilość w protokole</th>
                                          <th className="py-2 px-3 text-right">Szacowana waga</th>
                                          <th className="py-2 px-3">Metoda zagospodarowania</th>
                                          <th className="py-2 px-3 text-right">Emisja utylizacji</th>
                                          <th className="py-2 px-3 text-right">Status cyrkularności</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-100">
                                        {s.itemDetails.map((it) => (
                                          <tr key={it.itemId} className="hover:bg-slate-50">
                                            <td className="py-2.5 px-3">
                                              <div className="font-semibold text-slate-900">{it.itemName}</div>
                                              {it.notesAnalysis && (
                                                <div className="text-[10px] text-slate-500 font-medium">{it.notesAnalysis}</div>
                                              )}
                                            </td>
                                            <td className="py-2.5 px-3 text-center font-bold text-slate-800">{it.quantity} {it.unit}</td>
                                            <td className="py-2.5 px-3 text-right">
                                              <span className="font-bold text-slate-900">{it.estimatedWeightKg} kg</span>
                                              <div className="text-[10px] text-slate-500">
                                                {it.reuseWeightKg > 0 && <span className="text-emerald-700 font-bold">{it.reuseWeightKg} kg reuse</span>}
                                                {it.reuseWeightKg > 0 && it.wasteWeightKg > 0 && <span> + </span>}
                                                {it.wasteWeightKg > 0 && <span className="text-orange-700 font-bold">{it.wasteWeightKg} kg odpad</span>}
                                              </div>
                                            </td>
                                            <td className="py-2.5 px-3 text-slate-600">
                                              <div>{it.disposalMethodName}</div>
                                              <div className="text-[10px] text-slate-400">DEFRA 2025</div>
                                            </td>
                                            <td className="py-2.5 px-3 text-right text-rose-700 font-black">
                                              {it.disposalCo2Kg > 0 ? `${it.disposalCo2Kg.toFixed(4)} kg CO2e` : "0.0000 kg"}
                                            </td>
                                            <td className="py-2.5 px-3 text-right">
                                              <div className="flex flex-col items-end gap-1">
                                                {it.reuseWeightKg > 0 && (
                                                  <span className="px-2 py-0.5 bg-emerald-100 text-emerald-900 border border-emerald-300 rounded font-bold text-[10px]">
                                                    ♻️ Reuse: {it.reuseWeightKg} kg
                                                  </span>
                                                )}
                                                {it.wasteWeightKg > 0 && (
                                                  <span className="px-2 py-0.5 bg-orange-100 text-orange-900 border border-orange-300 rounded font-bold text-[10px]">
                                                    🗑️ Odpad/Ścinki: {it.wasteWeightKg} kg
                                                  </span>
                                                )}
                                              </div>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: INTERAKTYWNY SYMULATOR / KALKULATOR */}
        {activeTab === "simulator" && (
          <div className="bg-white p-6 rounded-b-2xl border-x border-b border-slate-200/80 shadow-sm space-y-6">
            <div>
              <h2 className="text-lg font-black text-slate-900">Szybki Symulator Śladu Węglowego CO2 Odpadów</h2>
              <p className="text-xs text-slate-500">
                Wprowadź parametry ładunku lub wybierz gotowy wzorzec, aby natychmiast poznać wygenerowaną emisję oraz koszt w widełkach ETS.
              </p>
            </div>

            {/* SZYBKIE WZORCE */}
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-2">
                Gotowe szablony ładunków z budowy:
              </span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => applyTemplate("Gruz betonowy (kruszywo)", 1000, "kg", "util_beton_skladowisko", 70)}
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-lg border border-slate-200 transition"
                >
                  🧱 Gruz betonowy (1000 kg)
                </button>
                <button
                  type="button"
                  onClick={() => applyTemplate("Płyty G-K odpady / skrawki", 120, "kg", "util_budowlane_otwarta_petla", 50)}
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-lg border border-slate-200 transition"
                >
                  📄 Płyty G-K skrawki (120 kg)
                </button>
                <button
                  type="button"
                  onClick={() => applyTemplate("Otwarte worki kleju / zaprawy", 4, "worki", "util_budowlane_otwarta_petla", 100)}
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-lg border border-slate-200 transition"
                >
                  🥡 Resztki kleju (4 worki = 100 kg)
                </button>
                <button
                  type="button"
                  onClick={() => applyTemplate("Odpady drzewne / palety uszkodzone", 300, "kg", "util_drewno_skladowisko", 80)}
                  className="px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-bold rounded-lg border border-amber-300 transition"
                >
                  🪵 Drewno szalunkowe (300 kg)
                </button>
                <button
                  type="button"
                  onClick={() => applyTemplate("Sprawne resztki na magazyn (farby, kleje)", 80, "kg", "reuse_magazyn", 60)}
                  className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 text-xs font-bold rounded-lg border border-emerald-300 transition"
                >
                  ♻️ Sprawne resztki do magazynu (Reuse 80 kg)
                </button>
              </div>
            </div>

            {/* FORMULARZ SYMULATORA */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 bg-slate-50 p-5 rounded-2xl border border-slate-200">
              <div className="lg:col-span-2">
                <label className="block text-xs font-bold text-slate-700 mb-1">Nazwa materiału / odpadu</label>
                <input
                  type="text"
                  value={simName}
                  onChange={(e) => setSimName(e.target.value)}
                  placeholder="np. Resztki zaprawy, gruz, płyty..."
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-sm font-medium focus:ring-2 focus:ring-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Ilość i Jednostka</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min={0.1}
                    value={simQuantity}
                    onChange={(e) => setSimQuantity(Number(e.target.value))}
                    className="w-2/3 px-3 py-2 bg-white border border-slate-300 rounded-xl text-sm font-bold focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  />
                  <select
                    value={simUnit}
                    onChange={(e) => setSimUnit(e.target.value)}
                    className="w-1/3 px-2 py-2 bg-white border border-slate-300 rounded-xl text-xs font-bold focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  >
                    <option value="kg">kg</option>
                    <option value="tony">tony</option>
                    <option value="worki">worki</option>
                    <option value="wiadra">wiadra</option>
                    <option value="szt.">szt.</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Dystans z budowy (km w 1 stronę)
                </label>
                <input
                  type="number"
                  min={1}
                  value={simDistance}
                  onChange={(e) => setSimDistance(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-sm font-bold focus:ring-2 focus:ring-blue-500 focus:outline-none"
                />
                <span className="text-[10px] text-slate-400 mt-0.5 block">Kurs tam i z powrotem: {simDistance * 2} km</span>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Metoda zagospodarowania</label>
                <select
                  value={simMethodKey}
                  onChange={(e) => setSimMethodKey(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs font-bold focus:ring-2 focus:ring-blue-500 focus:outline-none"
                >
                  {Object.entries(DISPOSAL_CO2_FACTORS_KG_PER_TONNE).map(([key, val]) => (
                    <option key={key} value={key}>
                      {val.name} ({val.factor} kg/t)
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* KARTA WYNIKOWA SYMULACJI */}
            <div className="bg-gradient-to-br from-slate-900 to-slate-800 text-white p-6 rounded-2xl shadow-lg border border-slate-700">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-700 pb-4 mb-4">
                <div>
                  <span className="text-xs font-bold uppercase tracking-wider text-blue-400">Wyniki Szacunkowe dla Zwrotu</span>
                  <h3 className="text-xl font-black text-white">{simName} ({simQuantity} {simUnit})</h3>
                </div>

                <div className="text-right">
                  <div className="text-2xl font-black text-amber-400">
                    {simResults.costs.minEur} € – {simResults.costs.maxEur} €
                  </div>
                  <div className="text-xs font-bold text-emerald-400">
                    {simResults.costs.minPln} PLN – {simResults.costs.maxPln} PLN (ETS)
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-center">
                <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700">
                  <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Masa przeliczona</span>
                  <span className="text-2xl font-black text-white">{simResults.weightKg.toLocaleString()} kg</span>
                  <span className="text-[10px] text-slate-400 block mt-1">({(simResults.weightKg / 1000).toFixed(3)} t)</span>
                </div>

                <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700">
                  <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Emisja transportu ({simDistance * 2} km)</span>
                  <span className="text-2xl font-black text-rose-400">{simResults.transportCo2.toFixed(2)} kg CO2</span>
                  <span className="text-[10px] text-slate-400 block mt-1">ON: {fuelConsumption} l/100km</span>
                </div>

                <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700">
                  <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Emisja utylizacji / procesu</span>
                  <span className="text-2xl font-black text-orange-400">{simResults.disposalCo2.toFixed(3)} kg CO2e</span>
                  <span className="text-[10px] text-slate-400 block mt-1">DEFRA 2025</span>
                </div>

                <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700">
                  <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Łączny ślad węglowy</span>
                  <span className="text-2xl font-black text-blue-400">{simResults.totalCo2.toFixed(2)} kg CO2e</span>
                  <span className="text-[10px] text-slate-400 block mt-1">Suma transport + zagospodarowanie</span>
                </div>
              </div>

              {simResults.isReuse && (
                <div className="mt-4 p-3 bg-emerald-900/50 border border-emerald-600 rounded-xl text-xs text-emerald-200 font-semibold flex items-center justify-between">
                  <span>♻️ Cyrkularność magazynowa: Przyjęcie resztki do powtórnego użycia zapobiega produkcji nowego materiału!</span>
                  <span className="font-black text-sm text-emerald-300">Zaoszczędzono: ~{simResults.savedCo2} kg CO2</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: BAZA WSKAŹNIKÓW I PARAMETRY */}
        {activeTab === "settings" && (
          <div className="bg-white p-6 rounded-b-2xl border-x border-b border-slate-200/80 shadow-sm space-y-6">
            <div>
              <h2 className="text-lg font-black text-slate-900">Baza Wskaźników Emisyjności CO2 i Konfiguracja Kosztów</h2>
              <p className="text-xs text-slate-500">
                Wskaźniki oparte na danych KOBiZE 2026 oraz UK DEFRA 2025 (dokument 'baza_wskaznikow_co2.md').
              </p>
            </div>

            {/* TABELA WSKAŹNIKÓW UTYLIZACJI */}
            <div>
              <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-2">
                1. Wskaźniki utylizacji odpadów budowlanych (DEFRA 2025)
              </h3>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-4">Klucz metody</th>
                      <th className="py-2.5 px-4">Nazwa wskaźnika / procesu</th>
                      <th className="py-2.5 px-4 text-right">Wartość wskaźnika</th>
                      <th className="py-2.5 px-4 text-center">Status źródła</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {Object.entries(DISPOSAL_CO2_FACTORS_KG_PER_TONNE).map(([key, val]) => (
                      <tr key={key} className="hover:bg-slate-50">
                        <td className="py-2 px-4 font-mono text-[11px] text-slate-500">{key}</td>
                        <td className="py-2 px-4 font-semibold text-slate-800">{val.name}</td>
                        <td className="py-2 px-4 text-right font-black text-slate-900">{val.factor} kg CO2e / tonę</td>
                        <td className="py-2 px-4 text-center">
                          <span className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded text-[10px] font-bold">
                            {val.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* PALIWA I TRANSPORT */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-slate-50 p-5 rounded-xl border border-slate-200">
                <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-3">
                  2. Emisja transportu floty (KOBiZE 2026, tabela 16)
                </h3>
                <ul className="space-y-2 text-xs text-slate-700 font-medium">
                  <li className="flex justify-between border-b border-slate-200 pb-1.5">
                    <span>Paliwo pojazdów:</span>
                    <strong className="text-slate-900">Olej napędowy (ON)</strong>
                  </li>
                  <li className="flex justify-between border-b border-slate-200 pb-1.5">
                    <span>Wartość opałowa (WO):</span>
                    <strong className="text-slate-900">43.0 MJ/kg</strong>
                  </li>
                  <li className="flex justify-between border-b border-slate-200 pb-1.5">
                    <span>Wskaźnik emisji (WE):</span>
                    <strong className="text-slate-900">74.1 kg CO2/GJ</strong>
                  </li>
                  <li className="flex justify-between border-b border-slate-200 pb-1.5">
                    <span>Przyjęta gęstość ON:</span>
                    <strong className="text-slate-900">0.835 kg/l</strong>
                  </li>
                  <li className="flex justify-between pt-1 text-blue-900 font-black">
                    <span>Wskaźnik końcowy na 1 litr paliwa:</span>
                    <span>{CO2_GLOBAL_PARAMS.dieselCo2PerLiterKg} kg CO2 / litr</span>
                  </li>
                </ul>
              </div>

              {/* EDYCJA WIDEŁEK KOSZTOWYCH */}
              <div className="bg-slate-50 p-5 rounded-xl border border-slate-200 space-y-4">
                <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">
                  3. Konfiguracja Widełek Finansowych & Floty
                </h3>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">Cena MIN (€ / tonę CO2)</label>
                    <input
                      type="number"
                      value={minEurPerTon}
                      onChange={(e) => setMinEurPerTon(Number(e.target.value))}
                      className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg font-bold"
                    />
                  </div>

                  <div>
                    <label className="block font-bold text-slate-700 mb-1">Cena MAX (€ / tonę CO2)</label>
                    <input
                      type="number"
                      value={maxEurPerTon}
                      onChange={(e) => setMaxEurPerTon(Number(e.target.value))}
                      className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg font-bold"
                    />
                  </div>

                  <div>
                    <label className="block font-bold text-slate-700 mb-1">Kurs EUR/PLN</label>
                    <input
                      type="number"
                      step={0.01}
                      value={eurToPlnRate}
                      onChange={(e) => setEurToPlnRate(Number(e.target.value))}
                      className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg font-bold"
                    />
                  </div>

                  <div>
                    <label className="block font-bold text-slate-700 mb-1">Średnie spalanie pojazdu (l/100km)</label>
                    <input
                      type="number"
                      step={0.1}
                      value={fuelConsumption}
                      onChange={(e) => setFuelConsumption(Number(e.target.value))}
                      className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg font-bold"
                    />
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    onClick={() => alert("Parametry zaktualizowane pomyślnie w bieżącej sesji!")}
                    className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-xs transition"
                  >
                    Zastosuj parametry
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
