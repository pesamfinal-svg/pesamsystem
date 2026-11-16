"use client";

import React from "react";

export interface LiquidationItem {
    id: string;
    inventoryId?: string;
    name: string;
    inventoryNumber: string;
    quantity: number;
    unit: string;
    currentStock: number;
    estimatedCost: number;
    reason: string;
    disposalMethod: string;
    isExcluded?: boolean;
}

export interface LiquidationProtocolData {
    protocolNumber: string;
    documentDate: string;
    siteName: string;
    siteId: string;
    closeoutId?: string;
    createdByName: string;
    managerName?: string;
    directorName?: string;
    items: LiquidationItem[];
    totalValue: number;
    committeeNotes?: string;
    isApprovedByDirector?: boolean;
    directorSignedAt?: string;
}

interface Props {
    protocol: LiquidationProtocolData;
    isOpen: boolean;
    onClose: () => void;
}

export default function PrintableLiquidationProtocol({ protocol, isOpen, onClose }: Props) {
    if (!isOpen) return null;

    const activeItems = protocol.items.filter(i => !i.isExcluded);

    const handlePrint = () => {
        window.print();
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/75 flex justify-center p-2 sm:p-6 print:p-0 print:bg-white print:static print:overflow-visible">
            {/* KONTENER OKNA */}
            <div className="bg-white w-full max-w-4xl rounded-2xl shadow-2xl flex flex-col overflow-hidden my-auto print:shadow-none print:rounded-none print:max-w-none print:w-full print:my-0">
                
                {/* PASEK PRZYCISKÓW (UKRYTY NA WYDRUKU) */}
                <div className="bg-slate-900 text-white p-4 px-6 flex justify-between items-center no-print">
                    <div className="flex items-center gap-3">
                        <span className="text-xl">📋</span>
                        <div>
                            <h3 className="font-black text-sm uppercase tracking-wider">Protokół Likwidacji Majątku (PL)</h3>
                            <p className="text-[11px] text-slate-400">Oficjalny dokument zdjęcia środków ze stanu do podpisu Prezesa i Komisji</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handlePrint}
                            className="bg-red-600 hover:bg-red-500 text-white font-black text-xs uppercase px-5 py-2.5 rounded-xl shadow-md transition flex items-center gap-2 cursor-pointer"
                        >
                            <span>🖨️</span> Drukuj Protokół Likwidacji (PDF)
                        </button>
                        <button
                            onClick={onClose}
                            className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs uppercase px-4 py-2.5 rounded-xl transition cursor-pointer"
                        >
                            Zamknij ✕
                        </button>
                    </div>
                </div>

                {/* ARKUSZ DOKUMENTU A4 */}
                <div id="printable-liquidation-document" className="p-8 sm:p-12 text-slate-900 bg-white font-sans text-xs leading-relaxed space-y-6 print:p-0 print:text-[11px]">
                    
                    {/* NAGŁÓWEK DOKUMENTU */}
                    <div className="border-b-2 border-slate-900 pb-4 flex justify-between items-start">
                        <div>
                            <div className="flex items-center gap-2">
                                <span className="text-2xl font-black tracking-tighter text-blue-900">PESAM</span>
                                <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Spółka z o.o. • Dział Logistyki i Gospodarki Majątkiem</span>
                            </div>
                            <h1 className="text-xl sm:text-2xl font-black text-slate-900 uppercase tracking-tight mt-1">
                                PROTOKÓŁ LIKWIDACJI ŚRODKÓW TRWAŁYCH I WYPOSAŻENIA
                            </h1>
                            <p className="text-xs font-bold text-slate-700 mt-0.5">
                                Nr dokumentu: <span className="font-mono font-black text-red-700">{protocol.protocolNumber}</span>
                            </p>
                        </div>
                        <div className="text-right">
                            <p className="text-[10px] text-slate-500">Miejscowość i data:</p>
                            <p className="font-bold text-slate-800 text-xs">
                                Kraków / Tarnów, dn. {protocol.documentDate || new Date().toLocaleDateString("pl-PL")}
                            </p>
                            <p className="text-[10px] text-slate-500 mt-2">Miejsce powstawania strat:</p>
                            <p className="font-black text-slate-900 text-xs">{protocol.siteName}</p>
                        </div>
                    </div>

                    {/* SKŁAD KOMISJI LIKWIDACYJNEJ */}
                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                        <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">
                            Komisja Likwidacyjna powołana do oceny stanu fizycznego i spisania majątku:
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                            <div>
                                <p className="text-[10px] text-slate-400 uppercase font-bold">1. Przewodniczący Komisji (Magazyn):</p>
                                <p className="font-black text-slate-800">{protocol.createdByName}</p>
                            </div>
                            <div>
                                <p className="text-[10px] text-slate-400 uppercase font-bold">2. Członek Komisji (Kierownik Budowy):</p>
                                <p className="font-black text-slate-800">{protocol.managerName || "Przedstawiciel budowy"}</p>
                            </div>
                            <div>
                                <p className="text-[10px] text-slate-400 uppercase font-bold">3. Organ Zatwierdzający (Zarząd):</p>
                                <p className="font-black text-slate-800">{protocol.directorName || "Prezes Zarządu / Dyrekcja"}</p>
                            </div>
                        </div>
                    </div>

                    {/* ORZECZENIE KOMISJI */}
                    <div>
                        <p className="text-xs font-semibold text-slate-800 leading-relaxed text-justify">
                            Komisja Likwidacyjna w wyżej wymienionym składzie po dokonaniu szczegółowych oględzin, weryfikacji ewidencji magazynowej oraz rozliczenia inwestycji <b>{protocol.siteName}</b> stwierdza, że niżej wymienione składniki majątku uległy zniszczeniu, zużyciu nienaprawialnemu bądź trwałej utracie. Dalsza ich eksploatacja jest technicznie lub ekonomicznie nieuzasadniona. Komisja wnioskuje o ich formalne spisanie ze stanu ilościowo-wartościowego spółki.
                        </p>
                    </div>

                    {/* TABELA LIKWIDOWANYCH SKŁADNIKÓW MAJĄTKU */}
                    <div>
                        <table className="w-full border-collapse text-left border border-slate-300">
                            <thead>
                                <tr className="bg-slate-100 border-b border-slate-300 text-[10px] font-black uppercase text-slate-700">
                                    <th className="p-2 border-r border-slate-300 w-8 text-center">Lp.</th>
                                    <th className="p-2 border-r border-slate-300">Nazwa Składnika Majątku</th>
                                    <th className="p-2 border-r border-slate-300 w-24 text-center">Nr Inw./Mag.</th>
                                    <th className="p-2 border-r border-slate-300 w-16 text-center">Ilość</th>
                                    <th className="p-2 border-r border-slate-300 w-20 text-center">Stan Mag.</th>
                                    <th className="p-2 border-r border-slate-300 w-24 text-right">Wartość (zł)</th>
                                    <th className="p-2 border-r border-slate-300">Przyczyna Likwidacji</th>
                                    <th className="p-2 w-28">Sposób Kasacji</th>
                                </tr>
                            </thead>
                            <tbody>
                                {activeItems.map((item, idx) => (
                                    <tr key={idx} className="border-b border-slate-200 hover:bg-slate-50 text-[11px]">
                                        <td className="p-2 border-r border-slate-300 text-center font-bold text-slate-500">{idx + 1}.</td>
                                        <td className="p-2 border-r border-slate-300 font-bold text-slate-900">{item.name}</td>
                                        <td className="p-2 border-r border-slate-300 text-center font-mono text-[10px] text-slate-600">{item.inventoryNumber || "-"}</td>
                                        <td className="p-2 border-r border-slate-300 text-center font-black text-red-700">{item.quantity} {item.unit || "szt."}</td>
                                        <td className="p-2 border-r border-slate-300 text-center font-mono text-[10px] text-slate-500">{item.currentStock} {item.unit || "szt."}</td>
                                        <td className="p-2 border-r border-slate-300 text-right font-black text-slate-800">{item.estimatedCost} zł</td>
                                        <td className="p-2 border-r border-slate-300 text-slate-700 text-[10px]">{item.reason || "Uszkodzenie / strata"}</td>
                                        <td className="p-2 text-slate-800 font-bold text-[10px] uppercase">{item.disposalMethod || "Złomowanie / Kosz"}</td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="bg-slate-100 font-black text-xs border-t-2 border-slate-400">
                                    <td colSpan={5} className="p-2 border-r border-slate-300 text-right uppercase">
                                        ŁĄCZNA WARTOŚĆ LIKWIDOWANYCH SKŁADNIKÓW:
                                    </td>
                                    <td className="p-2 border-r border-slate-300 text-right text-red-700 text-sm">
                                        {protocol.totalValue} zł
                                    </td>
                                    <td colSpan={2} className="p-2 text-[10px] text-slate-500 font-normal">
                                        (Odpis strat w ciężar kosztów działalności)
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>

                    {/* UWAGI I ZALECENIA KOMISJI */}
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1">
                        <p className="font-black text-[10px] uppercase text-slate-500">Uwagi i zalecenia Komisji Likwidacyjnej:</p>
                        <p className="font-medium text-slate-800 italic">
                            {protocol.committeeNotes || "Zezłomowany sprzęt złożyć w wyznaczonym boksie na odpady stalowe / elektrośmieci na placu bazy sprzętowej PESAM. Wykreślić pozycje z ewidencji magazynowej."}
                        </p>
                    </div>

                    {/* MIEJSCA NA PODPISY KOMISJI I ZATWIERDZENIE PREZESA */}
                    <div className="pt-8 border-t-2 border-slate-900 grid grid-cols-3 gap-6 text-center text-[10px]">
                        <div>
                            <p className="font-bold text-slate-400 uppercase">1. Przewodniczący Komisji:</p>
                            <div className="h-16 border-b border-dashed border-slate-300 flex items-end justify-center pb-1">
                                <span className="font-bold text-slate-800">{protocol.createdByName}</span>
                            </div>
                            <p className="text-slate-400 text-[9px] mt-1">Podpis Magazyniera / Data</p>
                        </div>

                        <div>
                            <p className="font-bold text-slate-400 uppercase">2. Członek Komisji:</p>
                            <div className="h-16 border-b border-dashed border-slate-300 flex items-end justify-center pb-1">
                                <span className="font-bold text-slate-800">{protocol.managerName || "Kierownik Budowy"}</span>
                            </div>
                            <p className="text-slate-400 text-[9px] mt-1">Podpis Członka Komisji</p>
                        </div>

                        <div className="border border-red-300 bg-red-50/40 p-2 rounded-xl">
                            <p className="font-black text-red-800 uppercase text-[9px]">DECYZJA PREZESA ZARZĄDU:</p>
                            <div className="h-12 flex flex-col items-center justify-center">
                                <span className="font-black text-slate-900 text-xs">ZATWIERDZAM LIKWIDACJĘ</span>
                                {protocol.directorSignedAt && (
                                    <span className="text-[8px] text-emerald-800 font-mono font-bold mt-0.5">Podpisano: {new Date(protocol.directorSignedAt).toLocaleDateString("pl-PL")}</span>
                                )}
                            </div>
                            <div className="border-t border-dashed border-red-300 pt-1 mt-1">
                                <p className="text-slate-500 font-bold">{protocol.directorName || "Prezes Zarządu / Dyrekcja"}</p>
                                <p className="text-slate-400 text-[8px]">Podpis i Pieczęć Zarządu PESAM</p>
                            </div>
                        </div>
                    </div>

                    {/* STOPKA DOKUMENTU */}
                    <div className="pt-4 border-t border-slate-200 text-center text-[9px] text-slate-400">
                        PESAM System Zarządzania Majątkiem • Protokół Likwidacji stanowi podstawę do księgowego wyksięgowania majątku ze stanu
                    </div>

                </div>
            </div>

            {/* STYLE WYDRUKU CSS */}
            <style jsx global>{`
                @media print {
                    @page {
                        size: A4 portrait;
                        margin: 12mm 10mm 12mm 10mm;
                    }
                    html, body {
                        background: #ffffff !important;
                        color: #000000 !important;
                        margin: 0 !important;
                        padding: 0 !important;
                        height: auto !important;
                        min-height: 0 !important;
                    }
                    aside, nav, header, button, .no-print, [role="navigation"] {
                        display: none !important;
                    }
                    body > div > div > div > aside {
                        display: none !important;
                    }
                    body * {
                        visibility: hidden;
                    }
                    #printable-liquidation-document, #printable-liquidation-document * {
                        visibility: visible;
                    }
                    #printable-liquidation-document {
                        position: absolute;
                        left: 0;
                        top: 0;
                        width: 100% !important;
                        margin: 0 !important;
                        padding: 0 !important;
                        background: #ffffff !important;
                        box-shadow: none !important;
                        border: none !important;
                    }
                }
            `}</style>
        </div>
    );
}
