"use client";

import React from "react";

export interface CloseoutReportData {
    id: string;
    siteId: string;
    siteName: string;
    status: string;
    initiatedAt: string;
    initiatedByName: string;
    managerName?: string;
    managerEmail?: string;
    managerSignedAt?: string;
    managerNotes?: string;
    directorName?: string;
    directorSignedAt?: string;
    generalNotes?: string;
    debtsList?: Array<{
        id?: string;
        name: string;
        inventoryNumber?: string;
        quantity: number;
        unit?: string;
        resolution?: "LOSS" | "DISPUTED_INVESTOR" | "SCRAPPED" | "CONSUMED" | "EXCLUDED";
        estimatedUnitCost?: number;
        estimatedTotalCost?: number;
        notes?: string;
        isManualEntry?: boolean;
    }>;
    detectiveList?: Array<{
        name: string;
        inventoryNumber?: string;
        status?: string;
        failureDescription?: string;
        isRepaired?: boolean;
        repairCost?: number;
    }>;
    siteDamagesList?: Array<{
        id?: string;
        inventoryName: string;
        inventoryNumber?: string;
        quantity?: number;
        unit?: string;
        description: string;
        estimatedRepairCost?: number;
    }>;
    siteExpensesList?: Array<{
        id?: string;
        title: string;
        category?: string;
        amount?: number;
        notes?: string;
        date?: string;
    }>;
    financialSummary?: {
        totalLossCost: number;
        totalDisputedCost: number;
        totalScrappedCost: number;
        totalRepairsCost?: number;
        totalExpensesCost?: number;
    };
    isCorrection?: boolean;
    correctionNumber?: number;
}

interface Props {
    closeout: CloseoutReportData;
    isOpen: boolean;
    onClose: () => void;
}

export default function PrintableCloseoutReport({ closeout, isOpen, onClose }: Props) {
    if (!isOpen) return null;

    const debts = closeout.debtsList || [];
    const lossItems = debts.filter(i => i.resolution === "LOSS" || !i.resolution);
    const disputedItems = debts.filter(i => i.resolution === "DISPUTED_INVESTOR");
    const scrappedItems = debts.filter(i => i.resolution === "SCRAPPED");
    const consumedItems = debts.filter(i => i.resolution === "CONSUMED");

    const damages = closeout.siteDamagesList || [];
    const expenses = closeout.siteExpensesList || [];
    const detective = closeout.detectiveList || [];

    const fin = closeout.financialSummary || {
        totalLossCost: 0,
        totalDisputedCost: 0,
        totalScrappedCost: 0,
        totalRepairsCost: 0,
        totalExpensesCost: 0,
    };

    const handlePrint = () => {
        window.print();
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/75 flex justify-center p-2 sm:p-6 print:p-0 print:bg-white print:static print:overflow-visible">
            {/* KONTENER RAPORTU */}
            <div className="bg-white w-full max-w-4xl rounded-2xl shadow-2xl flex flex-col overflow-hidden my-auto print:shadow-none print:rounded-none print:max-w-none print:w-full print:my-0">
                
                {/* PASEK AKCJI DLA UŻYTKOWNIKA (UKRYTY NA WYDRUKU) */}
                <div className="bg-slate-900 text-white p-4 px-6 flex justify-between items-center no-print">
                    <div className="flex items-center gap-3">
                        <span className="text-xl">📄</span>
                        <div>
                            <h3 className="font-black text-sm uppercase tracking-wider">Podgląd Oficjalnego Raportu Rozliczenia</h3>
                            <p className="text-[11px] text-slate-400">Dokładny widok dokumentu przekazywanego Zarządowi i do wydruku biurowego</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handlePrint}
                            className="bg-blue-600 hover:bg-blue-500 text-white font-black text-xs uppercase px-5 py-2.5 rounded-xl shadow-md transition flex items-center gap-2 cursor-pointer"
                        >
                            <span>🖨️</span> Drukuj / Zapisz PDF
                        </button>
                        <button
                            onClick={onClose}
                            className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs uppercase px-4 py-2.5 rounded-xl transition cursor-pointer"
                        >
                            Zamknij ✕
                        </button>
                    </div>
                </div>

                {/* WŁAŚCIWY ARKUSZ DOKUMENTU A4 DO WYDRUKU */}
                <div id="printable-closeout-document" className="p-8 sm:p-12 text-slate-900 bg-white font-sans text-xs leading-relaxed space-y-6 print:p-0 print:text-[11px]">
                    
                    {/* NAGŁÓWEK FIRMOWY */}
                    <div className="border-b-2 border-slate-900 pb-4 flex justify-between items-start">
                        <div>
                            <div className="flex items-center gap-2">
                                <span className="text-2xl font-black tracking-tighter text-blue-900">PESAM</span>
                                <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">System Zarządzania Majątkiem i Budowami</span>
                            </div>
                            <h1 className="text-xl sm:text-2xl font-black text-slate-900 uppercase tracking-tight mt-1">
                                PROTOKÓŁ ZAMKNIĘCIA I ROZLICZENIA BUDOWY
                            </h1>
                            {closeout.isCorrection && (
                                <div className="inline-block bg-amber-100 text-amber-900 border border-amber-300 font-black px-2.5 py-0.5 rounded text-[10px] uppercase mt-1">
                                    ⚠️ KOREKTA ROZLICZENIA NR {closeout.correctionNumber || 1}
                                </div>
                            )}
                        </div>
                        <div className="text-right">
                            <p className="text-[10px] font-bold text-slate-400 uppercase">Identyfikator audytu:</p>
                            <p className="font-mono font-bold text-slate-800 text-xs">{closeout.id}</p>
                            <p className="text-[10px] text-slate-500 mt-1">
                                Data sporządzenia: <b>{new Date(closeout.initiatedAt || Date.now()).toLocaleDateString("pl-PL")}</b>
                            </p>
                            <div className="mt-1">
                                <span className={`inline-block px-2 py-0.5 rounded font-black text-[9px] uppercase tracking-wider ${
                                    closeout.status === "ROZLICZONA" ? "bg-emerald-100 text-emerald-800 border border-emerald-300" :
                                    closeout.status === "OCZEKUJE_NA_DYREKCJE" ? "bg-amber-100 text-amber-900 border border-amber-300" :
                                    "bg-blue-100 text-blue-900 border border-blue-300"
                                }`}>
                                    {closeout.status === "ROZLICZONA" ? "✅ ROZLICZONA I ZAMKNIĘTA" :
                                     closeout.status === "OCZEKUJE_NA_DYREKCJE" ? "⏳ CZEKA NA AUTORYZACJĘ ZARZĄDU" :
                                     "⏳ WERYFIKACJA KIEROWNIKA"}
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* METADANE INWESTYCJI I UCZESTNIKÓW */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200">
                        <div>
                            <p className="text-[10px] font-black text-slate-400 uppercase">Nazwa Inwestycji / Budowy:</p>
                            <p className="font-black text-slate-900 text-sm mt-0.5">{closeout.siteName}</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-black text-slate-400 uppercase">Audytor / Magazyn PESAM:</p>
                            <p className="font-bold text-slate-800 mt-0.5">{closeout.initiatedByName}</p>
                            <p className="text-[10px] text-slate-500">Dział Logistyki i Sprzętu</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-black text-slate-400 uppercase">Odpowiedzialny Kierownik:</p>
                            <p className="font-bold text-slate-800 mt-0.5">{closeout.managerName || "Nie wskazano"}</p>
                            {closeout.managerEmail && <p className="text-[10px] text-slate-500 font-mono">{closeout.managerEmail}</p>}
                        </div>
                    </div>

                    {/* BILANS FINANSOWY ROZLICZENIA */}
                    <div>
                        <h2 className="text-xs font-black uppercase tracking-wider text-slate-700 mb-2 border-b pb-1">
                            Podsumowanie Finansowe Strat i Roszczeń Inwestycji
                        </h2>
                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
                            <div className="p-2.5 rounded-lg border border-red-200 bg-red-50/70">
                                <p className="text-[9px] font-black text-red-700 uppercase">Straty Bezpośrednie</p>
                                <p className="text-sm font-black text-red-800 mt-0.5">{fin.totalLossCost || 0} zł</p>
                                <p className="text-[9px] text-red-600 mt-0.5">Odpis w koszty firmy</p>
                            </div>
                            <div className="p-2.5 rounded-lg border border-amber-300 bg-amber-50/70">
                                <p className="text-[9px] font-black text-amber-800 uppercase">U Inwestora / Spór</p>
                                <p className="text-sm font-black text-amber-900 mt-0.5">{fin.totalDisputedCost || 0} zł</p>
                                <p className="text-[9px] text-amber-700 mt-0.5">Do refakturowania / odbioru</p>
                            </div>
                            <div className="p-2.5 rounded-lg border border-slate-200 bg-slate-100">
                                <p className="text-[9px] font-black text-slate-600 uppercase">Złomowanie</p>
                                <p className="text-sm font-black text-slate-800 mt-0.5">{fin.totalScrappedCost || 0} zł</p>
                                <p className="text-[9px] text-slate-500 mt-0.5">Utylizacja zużytych</p>
                            </div>
                            <div className="p-2.5 rounded-lg border border-blue-200 bg-blue-50/70">
                                <p className="text-[9px] font-black text-blue-700 uppercase">Naprawy Sprzętu</p>
                                <p className="text-sm font-black text-blue-800 mt-0.5">{fin.totalRepairsCost || 0} zł</p>
                                <p className="text-[9px] text-blue-600 mt-0.5">Serwis uszkodzeń</p>
                            </div>
                            <div className="p-2.5 rounded-lg border border-emerald-200 bg-emerald-50/70 col-span-2 sm:col-span-1">
                                <p className="text-[9px] font-black text-emerald-700 uppercase">Wydatki Budowy</p>
                                <p className="text-sm font-black text-emerald-800 mt-0.5">{fin.totalExpensesCost || 0} zł</p>
                                <p className="text-[9px] text-emerald-600 mt-0.5">Drobne z placu</p>
                            </div>
                        </div>
                    </div>

                    {/* TABELA 1: BEZPOŚREDNIE STRATY SPRZĘTOWE */}
                    <div>
                        <h2 className="text-xs font-black uppercase tracking-wider text-red-800 mb-1 flex items-center justify-between border-b border-red-200 pb-1">
                            <span>❌ Bezpośrednie Straty i Braki Sprzętu (Odpis na koszt budowy):</span>
                            <span className="font-mono text-[10px] text-slate-500">{lossItems.length} pozycji</span>
                        </h2>
                        {lossItems.length === 0 ? (
                            <p className="p-3 bg-emerald-50 text-emerald-800 font-bold text-center rounded-lg border border-emerald-200 text-xs">
                                ✅ Brak bezpośrednich strat sprzętu. Wszystkie narzędzia i rusztowania zostały rozliczone.
                            </p>
                        ) : (
                            <table className="w-full border-collapse text-left border border-slate-200">
                                <thead>
                                    <tr className="bg-slate-100 border-b border-slate-200 text-[10px] font-black uppercase text-slate-600">
                                        <th className="p-2 border-r border-slate-200">Nazwa Sprzętu / Materiału</th>
                                        <th className="p-2 border-r border-slate-200 w-24 text-center">Nr Mag.</th>
                                        <th className="p-2 border-r border-slate-200 w-20 text-center">Ilość</th>
                                        <th className="p-2 border-r border-slate-200 w-24 text-right">Szacunek PLN</th>
                                        <th className="p-2">Uwagi Audytora</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {lossItems.map((item, idx) => (
                                        <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50">
                                            <td className="p-2 border-r border-slate-200 font-bold text-slate-800">
                                                {item.name}
                                                {item.isManualEntry && <span className="ml-1 text-[8px] bg-slate-200 px-1 py-0.2 rounded font-normal">Wpis ręczny</span>}
                                            </td>
                                            <td className="p-2 border-r border-slate-200 text-center font-mono text-[10px] text-slate-500">
                                                {item.inventoryNumber || "-"}
                                            </td>
                                            <td className="p-2 border-r border-slate-200 text-center font-bold text-red-700">
                                                {item.quantity} {item.unit || "szt."}
                                            </td>
                                            <td className="p-2 border-r border-slate-200 text-right font-bold text-slate-700">
                                                {item.estimatedTotalCost ? `${item.estimatedTotalCost} zł` : item.estimatedUnitCost ? `${item.estimatedUnitCost * item.quantity} zł` : "-"}
                                            </td>
                                            <td className="p-2 text-slate-600 italic text-[10px]">
                                                {item.notes || "Brak dodatkowych uwag"}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>

                    {/* TABELA 2: SPRZĘT U INWESTORA / SPRAWA SPORNA */}
                    {disputedItems.length > 0 && (
                        <div>
                            <h2 className="text-xs font-black uppercase tracking-wider text-amber-800 mb-1 flex items-center justify-between border-b border-amber-200 pb-1">
                                <span>🚧 Sprzęt Pozostawiony u Inwestora / Sprawa Sporna (Do refakturowania lub odbioru):</span>
                                <span className="font-mono text-[10px] text-amber-700">{disputedItems.length} pozycji</span>
                            </h2>
                            <p className="text-[10px] text-amber-900 mb-1 italic">
                                * Sprzęt nie został uznany za zniszczony, lecz pozostał na obiekcie. Podlega procedurze odzyskania lub refakturowania na inwestora.
                            </p>
                            <table className="w-full border-collapse text-left border border-amber-200">
                                <thead>
                                    <tr className="bg-amber-100/70 border-b border-amber-200 text-[10px] font-black uppercase text-amber-900">
                                        <th className="p-2 border-r border-amber-200">Element / Sprzęt</th>
                                        <th className="p-2 border-r border-amber-200 w-24 text-center">Nr Mag.</th>
                                        <th className="p-2 border-r border-amber-200 w-20 text-center">Ilość</th>
                                        <th className="p-2 border-r border-amber-200 w-28 text-right">Wartość Roszczenia</th>
                                        <th className="p-2">Ustalenia / Sytuacja</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {disputedItems.map((item, idx) => (
                                        <tr key={idx} className="border-b border-amber-100 hover:bg-amber-50/50">
                                            <td className="p-2 border-r border-amber-200 font-bold text-slate-800">
                                                {item.name}
                                            </td>
                                            <td className="p-2 border-r border-amber-200 text-center font-mono text-[10px] text-slate-500">
                                                {item.inventoryNumber || "-"}
                                            </td>
                                            <td className="p-2 border-r border-amber-200 text-center font-bold text-amber-800">
                                                {item.quantity} {item.unit || "szt."}
                                            </td>
                                            <td className="p-2 border-r border-amber-200 text-right font-black text-amber-900">
                                                {item.estimatedTotalCost ? `${item.estimatedTotalCost} zł` : item.estimatedUnitCost ? `${item.estimatedUnitCost * item.quantity} zł` : "-"}
                                            </td>
                                            <td className="p-2 text-slate-700 italic text-[10px]">
                                                {item.notes || "Sprzęt zablokowany u inwestora"}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {/* TABELA 3: ZŁOMOWANIE I UTYLIZACJA */}
                    {scrappedItems.length > 0 && (
                        <div>
                            <h2 className="text-xs font-black uppercase tracking-wider text-slate-700 mb-1 border-b pb-1">
                                ♻️ Sprzęt Przekazany do Złomowania / Utylizacji:
                            </h2>
                            <table className="w-full border-collapse text-left border border-slate-200">
                                <thead>
                                    <tr className="bg-slate-100 border-b border-slate-200 text-[10px] font-black uppercase text-slate-600">
                                        <th className="p-2 border-r border-slate-200">Nazwa Sprzętu</th>
                                        <th className="p-2 border-r border-slate-200 w-24 text-center">Ilość</th>
                                        <th className="p-2">Powód Likwidacji</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {scrappedItems.map((item, idx) => (
                                        <tr key={idx} className="border-b border-slate-100">
                                            <td className="p-2 border-r border-slate-200 font-bold text-slate-800">{item.name}</td>
                                            <td className="p-2 border-r border-slate-200 text-center font-bold text-slate-700">{item.quantity} {item.unit || "szt."}</td>
                                            <td className="p-2 text-slate-600 italic text-[10px]">{item.notes || "Fizyczne zużycie / uszkodzenie nienaprawialne"}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {/* TABELA 4: USZKODZENIA BUDOWY I NAPRAWY SPRZĘTU */}
                    {(damages.length > 0 || detective.length > 0) && (
                        <div>
                            <h2 className="text-xs font-black uppercase tracking-wider text-blue-900 mb-1 border-b border-blue-200 pb-1">
                                🔧 Uszkodzenia Sprzętu na Budowie i Naprawy Serwisowe:
                            </h2>
                            <table className="w-full border-collapse text-left border border-blue-200">
                                <thead>
                                    <tr className="bg-blue-50 border-b border-blue-200 text-[10px] font-black uppercase text-blue-900">
                                        <th className="p-2 border-r border-blue-200">Urządzenie</th>
                                        <th className="p-2 border-r border-blue-200 w-24 text-center">Nr Mag.</th>
                                        <th className="p-2 border-r border-blue-200">Opis Uszkodzenia / Usterki</th>
                                        <th className="p-2 border-r border-blue-200 w-28 text-right">Koszt Naprawy</th>
                                        <th className="p-2 w-24 text-center">Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {damages.map((dmg, idx) => (
                                        <tr key={`dmg-${idx}`} className="border-b border-blue-100">
                                            <td className="p-2 border-r border-blue-200 font-bold text-slate-800">{dmg.inventoryName}</td>
                                            <td className="p-2 border-r border-blue-200 text-center font-mono text-[10px] text-slate-500">{dmg.inventoryNumber || "-"}</td>
                                            <td className="p-2 border-r border-blue-200 text-slate-700 text-[10px]">{dmg.description}</td>
                                            <td className="p-2 border-r border-blue-200 text-right font-bold text-blue-800">{dmg.estimatedRepairCost ? `${dmg.estimatedRepairCost} zł` : "0 zł"}</td>
                                            <td className="p-2 text-center text-[10px] font-bold text-amber-700">Zgłoszono</td>
                                        </tr>
                                    ))}
                                    {detective.map((det, idx) => (
                                        <tr key={`det-${idx}`} className="border-b border-blue-100">
                                            <td className="p-2 border-r border-blue-200 font-bold text-slate-800">{det.name}</td>
                                            <td className="p-2 border-r border-blue-200 text-center font-mono text-[10px] text-slate-500">{det.inventoryNumber || "-"}</td>
                                            <td className="p-2 border-r border-blue-200 text-slate-700 text-[10px]">{det.failureDescription || "Naprawa po zwrocie z budowy"}</td>
                                            <td className="p-2 border-r border-blue-200 text-right font-bold text-blue-800">{det.repairCost ? `${det.repairCost} zł` : "0 zł"}</td>
                                            <td className="p-2 text-center text-[10px] font-black text-emerald-700">Naprawione</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {/* TABELA 5: DROBNE WYDATKI Z PLACU BUDOWY */}
                    {expenses.length > 0 && (
                        <div>
                            <h2 className="text-xs font-black uppercase tracking-wider text-emerald-900 mb-1 border-b border-emerald-200 pb-1">
                                💰 Drobne Wydatki i Naprawy Podręczne na Placu Budowy:
                            </h2>
                            <table className="w-full border-collapse text-left border border-emerald-200">
                                <thead>
                                    <tr className="bg-emerald-50 border-b border-emerald-200 text-[10px] font-black uppercase text-emerald-900">
                                        <th className="p-2 border-r border-emerald-200">Tytuł Wydatku / Usługi</th>
                                        <th className="p-2 border-r border-emerald-200 w-32">Kategoria</th>
                                        <th className="p-2 border-r border-emerald-200 w-24 text-right">Kwota</th>
                                        <th className="p-2">Szczegóły / Notatka</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {expenses.map((exp, idx) => (
                                        <tr key={idx} className="border-b border-emerald-100">
                                            <td className="p-2 border-r border-emerald-200 font-bold text-slate-800">{exp.title}</td>
                                            <td className="p-2 border-r border-emerald-200 text-slate-600 text-[10px]">{exp.category || "Inne"}</td>
                                            <td className="p-2 border-r border-emerald-200 text-right font-black text-emerald-800">{exp.amount || 0} zł</td>
                                            <td className="p-2 text-slate-600 italic text-[10px]">{exp.notes || "-"}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {/* OŚWIADCZENIA I UWAGI STRON */}
                    <div className="space-y-3 pt-2">
                        {/* Uwagi Audytora */}
                        <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                            <p className="font-black text-[10px] uppercase text-slate-500">Uwagi i Wnioski Audytora Magazynu PESAM:</p>
                            <p className="font-medium text-slate-800 mt-1 italic">
                                {closeout.generalNotes ? `„${closeout.generalNotes}”` : "Brak uwag ogólnych audytora do rozliczenia."}
                            </p>
                        </div>

                        {/* Oświadczenie Kierownika Budowy */}
                        <div className="p-3 bg-blue-50/60 border border-blue-200 rounded-xl">
                            <div className="flex justify-between items-center">
                                <p className="font-black text-[10px] uppercase text-blue-900">Stanowisko / Oświadczenie Kierownika Budowy:</p>
                                {closeout.managerSignedAt && (
                                    <span className="text-[9px] font-bold text-blue-700 bg-blue-100 px-2 py-0.5 rounded">
                                        Podpisano cyfrowo: {new Date(closeout.managerSignedAt).toLocaleString("pl-PL")}
                                    </span>
                                )}
                            </div>
                            <p className="font-medium text-slate-800 mt-1 italic">
                                {closeout.managerNotes ? `„${closeout.managerNotes}”` : "Kierownik budowy nie wniósł dodatkowych zastrzeżeń do protokołu (zgodność pełna)."}
                            </p>
                            {closeout.managerName && (
                                <p className="text-[10px] text-slate-500 mt-1 font-semibold">
                                    Podpisano przez: {closeout.managerName} ({closeout.managerEmail || "PESAM"})
                                </p>
                            )}
                        </div>
                    </div>

                    {/* PODPISY I PIECZĘCIE */}
                    <div className="pt-8 border-t-2 border-slate-900 grid grid-cols-3 gap-6 text-center text-[10px]">
                        <div>
                            <p className="font-bold text-slate-400 uppercase">Sporządził (Audytor Magazynu):</p>
                            <div className="h-14 border-b border-dashed border-slate-300 flex items-end justify-center pb-1">
                                <span className="font-bold text-slate-800">{closeout.initiatedByName}</span>
                            </div>
                            <p className="text-slate-400 text-[9px] mt-1">Podpis fizyczny / Data</p>
                        </div>

                        <div>
                            <p className="font-bold text-slate-400 uppercase">Kierownik Budowy:</p>
                            <div className="h-14 border-b border-dashed border-slate-300 flex flex-col items-center justify-end pb-1">
                                {closeout.managerSignedAt ? (
                                    <>
                                        <span className="text-[8px] text-blue-800 font-mono font-bold">CERTYFIKAT PODPISU CYFROWEGO</span>
                                        <span className="font-bold text-slate-900">{closeout.managerName}</span>
                                    </>
                                ) : (
                                    <span className="text-slate-300 italic">Oczekuje na podpis</span>
                                )}
                            </div>
                            <p className="text-slate-400 text-[9px] mt-1">Podpis elektroniczny</p>
                        </div>

                        <div>
                            <p className="font-bold text-slate-400 uppercase">Zatwierdził (Dyrekcja / Prezes):</p>
                            <div className="h-14 border-b border-dashed border-slate-300 flex flex-col items-center justify-end pb-1">
                                {closeout.directorSignedAt ? (
                                    <>
                                        <span className="text-[8px] text-emerald-800 font-mono font-bold">AUTORYZOWANO ZARZĄD PESAM</span>
                                        <span className="font-bold text-slate-900">{closeout.directorName}</span>
                                    </>
                                ) : (
                                    <span className="text-slate-300 italic">Oczekuje na akceptację</span>
                                )}
                            </div>
                            <p className="text-slate-400 text-[9px] mt-1">Podpis i Pieczęć Zarządu</p>
                        </div>
                    </div>

                    {/* STOPKA OFICJALNA */}
                    <div className="pt-4 border-t border-slate-200 text-center text-[9px] text-slate-400">
                        PESAM System Zarządzania Produkcją i Magazynem • Dokument wygenerowany automatycznie • Wszelkie prawa zastrzeżone
                    </div>

                </div>
            </div>

            {/* STYLE WYDRUKU CSS DLA CZYSTEGO A4 */}
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
                    /* Ukryj całą aplikację: sidebar, menu, nawigację, przyciski */
                    aside, nav, header, button, .no-print, [role="navigation"] {
                        display: none !important;
                    }
                    body > div > div > div > aside {
                        display: none !important;
                    }
                    /* Ukryj wszystkie inne elementy poza printable-closeout-document */
                    body * {
                        visibility: hidden;
                    }
                    #printable-closeout-document, #printable-closeout-document * {
                        visibility: visible;
                    }
                    #printable-closeout-document {
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
