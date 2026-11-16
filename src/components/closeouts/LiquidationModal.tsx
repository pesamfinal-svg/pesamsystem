"use client";

import React, { useState, useEffect } from "react";
import { collection, getDocs, doc, runTransaction } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import PrintableLiquidationProtocol, { LiquidationItem, LiquidationProtocolData } from "./PrintableLiquidationProtocol";

interface Props {
    isOpen: boolean;
    onClose: () => void;
    siteId: string;
    siteName: string;
    closeoutId: string;
    managerName?: string;
    directorName?: string;
    initialDebts: Array<{
        id?: string;
        name: string;
        inventoryNumber?: string;
        quantity: number;
        unit?: string;
        resolution?: string;
        estimatedTotalCost?: number;
        estimatedUnitCost?: number;
        notes?: string;
        isManualEntry?: boolean;
    }>;
    onLiquidationComplete?: (protocolData: LiquidationProtocolData) => void;
}

export default function LiquidationModal({
    isOpen,
    onClose,
    siteId,
    siteName,
    closeoutId,
    managerName,
    directorName,
    initialDebts,
    onLiquidationComplete
}: Props) {
    const { user } = useAuth();
    const [inventoryItems, setInventoryItems] = useState<any[]>([]);
    const [isLoadingInventory, setIsLoadingInventory] = useState(false);
    const [items, setItems] = useState<LiquidationItem[]>([]);
    const [committeeNotes, setCommitteeNotes] = useState("Komisja stwierdza fizyczne zużycie / utratę sprzętu i wnioskuje o wyksięgowanie.");
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Stan wygenerowanego protokołu do druku
    const [createdProtocol, setCreatedProtocol] = useState<LiquidationProtocolData | null>(null);
    const [isPrintProtocolOpen, setIsPrintProtocolOpen] = useState(false);

    // Stan wyszukiwarki do podmiany pozycji
    const [editingItemId, setEditingItemId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");

    // Wczytanie inwentarza i przygotowanie pozycji do likwidacji
    useEffect(() => {
        if (!isOpen) return;

        const loadData = async () => {
            setIsLoadingInventory(true);
            try {
                const snap = await getDocs(collection(db, "inventory"));
                const allInv: any[] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                setInventoryItems(allInv);

                // Pozycje kwalifikujące się do likwidacji: LOSS (Strata) oraz SCRAPPED (Złomowanie)
                const candidateDebts = (initialDebts || []).filter(
                    d => d.resolution === "LOSS" || d.resolution === "SCRAPPED" || !d.resolution
                );

                const mapped: LiquidationItem[] = candidateDebts.map((debt, idx) => {
                    // Próba znalezienia pozycji w bazie
                    const matched = allInv.find(
                        inv => inv.id === debt.id || (debt.inventoryNumber && inv.inventoryNumber === debt.inventoryNumber)
                    );

                    const currentStock = matched
                        ? (matched.type === "UNIQUE" ? (matched.status === "sprawne" ? 1 : 0) : (matched.totalQuantity || 0))
                        : 0;

                    const unitCost = debt.estimatedUnitCost || (debt.estimatedTotalCost ? Math.round(debt.estimatedTotalCost / (debt.quantity || 1)) : 0);
                    const qty = debt.quantity || 1;

                    return {
                        id: debt.id || `manual-${idx}-${Date.now()}`,
                        inventoryId: matched?.id || debt.id,
                        name: matched?.name || debt.name,
                        inventoryNumber: matched?.inventoryNumber || debt.inventoryNumber || "BRAK",
                        quantity: qty,
                        unit: debt.unit || matched?.unit || "szt.",
                        currentStock,
                        estimatedCost: debt.estimatedTotalCost || (unitCost * qty),
                        reason: debt.notes || (debt.resolution === "SCRAPPED" ? "Zużycie techniczne nienaprawialne" : "Utrata / brak zwrotu z budowy"),
                        disposalMethod: debt.resolution === "SCRAPPED" ? "Złomowanie stalowe / utylizacja" : "Odpis w koszty (strata)",
                        isExcluded: false
                    };
                });

                setItems(mapped);
            } catch (err) {
                console.error("Błąd wczytywania inwentarza:", err);
            } finally {
                setIsLoadingInventory(false);
            }
        };

        loadData();
    }, [isOpen, initialDebts]);

    if (!isOpen) return null;

    // Zmiana ilości
    const handleQtyChange = (id: string, newQty: number) => {
        setItems(prev => prev.map(item => {
            if (item.id === id) {
                const q = Math.max(1, newQty);
                const unitPrice = item.quantity > 0 ? item.estimatedCost / item.quantity : 0;
                return { ...item, quantity: q, estimatedCost: Math.round(unitPrice * q) };
            }
            return item;
        }));
    };

    // Zmiana przyczyny lub sposobu
    const handleFieldChange = (id: string, field: keyof LiquidationItem, val: any) => {
        setItems(prev => prev.map(item => item.id === id ? { ...item, [field]: val } : item));
    };

    // Podmiana pozycji z bazy PESAM
    const handleSelectInventoryReplacement = (itemId: string, newInv: any) => {
        setItems(prev => prev.map(item => {
            if (item.id === itemId) {
                const currentStock = newInv.type === "UNIQUE" ? (newInv.status === "sprawne" ? 1 : 0) : (newInv.totalQuantity || 0);
                const price = newInv.purchasePrice || item.estimatedCost;
                return {
                    ...item,
                    inventoryId: newInv.id,
                    name: newInv.name,
                    inventoryNumber: newInv.inventoryNumber || "BRAK",
                    unit: newInv.unit || item.unit,
                    currentStock,
                    estimatedCost: price * item.quantity
                };
            }
            return item;
        }));
        setEditingItemId(null);
        setSearchQuery("");
    };

    // Łączna wartość likwidacji
    const totalLiquidationValue = items.filter(i => !i.isExcluded).reduce((sum, i) => sum + (i.estimatedCost || 0), 0);

    // ZATWIERDZENIE LIKWIDACJI I ZDJĘCIE ZE STANÓW
    const handleExecuteLiquidation = async () => {
        const active = items.filter(i => !i.isExcluded);
        if (active.length === 0) {
            alert("Wszystkie pozycje zostały wykluczone. Brak składników do likwidacji.");
            return;
        }

        if (!window.confirm(`⚠️ POTWIERDZENIE LIKWIDACJI MAJĄTKU\n\nCzy na pewno zatwierdzasz spisanie ${active.length} pozycji o łącznej wartości ${totalLiquidationValue} zł?\n\nSystem zaktualizuje stany magazynowe w bazie i wygeneruje Protokół Likwidacji (PL) do podpisu Prezesa.`)) {
            return;
        }

        setIsSubmitting(true);
        try {
            const protocolNumber = `PL-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.floor(100 + Math.random() * 900)}`;
            const nowIso = new Date().toISOString();

            await runTransaction(db, async (transaction) => {
                for (const item of active) {
                    if (!item.inventoryId || item.inventoryId.startsWith("manual-")) continue;

                    const itemRef = doc(db, "inventory", item.inventoryId);
                    const itemSnap = await transaction.get(itemRef);
                    if (!itemSnap.exists()) continue;

                    const data = itemSnap.data();

                    if (data.type === "UNIQUE") {
                        // Elektronarzędzie / sprzęt unikalny
                        const historyEntry = {
                            date: nowIso,
                            type: "LIKWIDACJA",
                            description: `Likwidacja sprzętu wg Protokołu ${protocolNumber} (Budowa: ${siteName}). Przyczyna: ${item.reason}`,
                            person: user ? `${user.firstName} ${user.lastName}` : "Magazynier"
                        };

                        transaction.update(itemRef, {
                            status: item.disposalMethod.toLowerCase().includes("złom") ? "złomowane" : "zagubione",
                            currentLocation: "UTYLIZACJA / ZŁOM (Spisano)",
                            availableQuantity: 0,
                            history: [...(data.history || []), historyEntry],
                            [`allocations.${siteId}`]: 0
                        });
                    } else {
                        // Sprzęt masowy (BULK)
                        const currentTotal = data.totalQuantity || 0;
                        const currentAvail = data.availableQuantity || 0;
                        const toDeduct = item.quantity;

                        const historyEntry = {
                            date: nowIso,
                            type: "LIKWIDACJA",
                            description: `Zdjęto ze stanu ${toDeduct} ${item.unit} wg Protokołu ${protocolNumber} (Budowa: ${siteName}).`,
                            person: user ? `${user.firstName} ${user.lastName}` : "Magazynier"
                        };

                        transaction.update(itemRef, {
                            totalQuantity: Math.max(0, currentTotal - toDeduct),
                            availableQuantity: Math.max(0, currentAvail - toDeduct),
                            history: [...(data.history || []), historyEntry],
                            [`allocations.${siteId}`]: 0
                        });
                    }
                }

                // Zapis protokołu likwidacji w Firestore
                const protocolDocRef = doc(collection(db, "protocols"));
                transaction.set(protocolDocRef, {
                    protocolId: protocolNumber,
                    type: "LIKWIDACJA",
                    sourceId: siteId,
                    sourceName: siteName,
                    destinationId: "UTYLIZACJA",
                    destinationName: "Złom / Likwidacja Majątku",
                    createdAt: nowIso,
                    documentDate: nowIso.split("T")[0],
                    createdBy: user?.uid,
                    createdByName: user ? `${user.firstName} ${user.lastName}` : "Magazynier",
                    status: "ZAAKCEPTOWANY",
                    closeoutId,
                    totalValue: totalLiquidationValue,
                    notes: committeeNotes,
                    items: active.map(i => ({
                        inventoryId: i.inventoryId,
                        name: i.name,
                        inventoryNumber: i.inventoryNumber,
                        quantity: i.quantity,
                        unit: i.unit,
                        estimatedCost: i.estimatedCost,
                        reason: i.reason,
                        disposalMethod: i.disposalMethod
                    }))
                });
            });

            const protocolData: LiquidationProtocolData = {
                protocolNumber,
                documentDate: new Date().toLocaleDateString("pl-PL"),
                siteName,
                siteId,
                closeoutId,
                createdByName: user ? `${user.firstName} ${user.lastName}` : "Magazynier",
                managerName,
                directorName,
                items: active,
                totalValue: totalLiquidationValue,
                committeeNotes,
                isApprovedByDirector: false
            };

            setCreatedProtocol(protocolData);
            setIsPrintProtocolOpen(true);

            if (onLiquidationComplete) {
                onLiquidationComplete(protocolData);
            }

            alert(`✅ LIKWIDACJA ZATWIERDZONA!\n\nStany magazynowe zostały zaktualizowane, a Protokół Likwidacji nr ${protocolNumber} wygenerowany do podpisu Prezesa.`);
        } catch (error) {
            console.error("Błąd podczas zatwierdzania likwidacji:", error);
            alert("Błąd operacji likwidacji: " + error);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/75 flex justify-center p-3 sm:p-6 animate-fade-in">
            <div className="bg-white w-full max-w-5xl rounded-3xl shadow-2xl flex flex-col overflow-hidden my-auto max-h-[92vh]">
                
                {/* NAGŁÓWEK OKNA */}
                <div className="bg-gradient-to-r from-red-900 via-slate-900 to-slate-900 text-white p-5 px-6 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                        <span className="text-3xl">⚖️</span>
                        <div>
                            <h2 className="font-black text-base uppercase tracking-wider">
                                Weryfikacja Likwidacji Magazynowej i Zdjęcie ze Stanu
                            </h2>
                            <p className="text-xs text-red-200 mt-0.5">
                                Inwestycja: <b>{siteName}</b> • Magazynier weryfikuje stany przed fizycznym wykreśleniem majątku
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-slate-400 hover:text-white text-lg font-bold p-1 px-3 rounded-lg hover:bg-slate-800 transition"
                    >
                        ✕
                    </button>
                </div>

                {/* ZAWARTOŚĆ OKNA */}
                <div className="p-6 overflow-y-auto space-y-5 text-xs flex-1">
                    
                    {/* INSTRUKCJA DLA MAGAZYNIERA */}
                    <div className="bg-amber-50 border-l-4 border-amber-500 p-3.5 rounded-r-xl text-amber-950 flex items-start gap-3">
                        <span className="text-xl">⚠️</span>
                        <div>
                            <p className="font-bold text-xs">Uwaga Magazynierze:</p>
                            <p className="text-[11px] text-amber-900 mt-0.5 leading-relaxed">
                                System przygotował pozycje spisane w audycie jako <b>Strata</b> lub <b>Złomowanie</b>. Sprawdź aktualny stan w bazie, zweryfikuj czy powiązano właściwe urządzenie, skoryguj ilości i wybierz sposób kasacji. Dopiero po Twoim zatwierdzeniu sprzęt zostanie odliczony ze stanu magazynu, a gotowy dokument trafi do podpisu Prezesa Zarządu.
                            </p>
                        </div>
                    </div>

                    {isLoadingInventory ? (
                        <div className="p-8 text-center text-slate-500 animate-pulse font-bold">
                            Ładowanie stanów magazynowych z bazy PESAM...
                        </div>
                    ) : items.length === 0 ? (
                        <div className="p-8 text-center text-slate-500 font-bold bg-slate-50 rounded-2xl border">
                            Brak pozycji zakwalifikowanych do likwidacji (brak bezpośrednich strat i złomowania).
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <div className="flex justify-between items-center">
                                <h3 className="font-black text-xs uppercase tracking-wider text-slate-700">
                                    Pozycje do likwidacji ({items.filter(i => !i.isExcluded).length} z {items.length}):
                                </h3>
                                <span className="font-mono font-black text-red-700 bg-red-50 border border-red-200 px-3 py-1 rounded-lg">
                                    Łączna wartość: {totalLiquidationValue} zł
                                </span>
                            </div>

                            {/* LISTA KAFELKÓW POZYCJI DO LIKWIDACJI */}
                            <div className="space-y-3">
                                {items.map((item, idx) => (
                                    <div
                                        key={item.id}
                                        className={`p-4 rounded-2xl border transition ${
                                            item.isExcluded
                                                ? "bg-slate-100 border-slate-200 opacity-50"
                                                : "bg-white border-slate-200 shadow-sm hover:border-slate-300"
                                        }`}
                                    >
                                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                                            
                                            {/* DANE SPRZĘTU */}
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-bold text-slate-900 text-sm">{item.name}</span>
                                                    <span className="font-mono text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-bold">
                                                        Nr: {item.inventoryNumber}
                                                    </span>
                                                    <span className="text-[10px] bg-blue-50 text-blue-800 border border-blue-200 px-2 py-0.5 rounded font-bold">
                                                        Stan w bazie: <b>{item.currentStock} {item.unit}</b>
                                                    </span>
                                                </div>

                                                <div className="flex items-center gap-2 mt-1">
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setEditingItemId(item.id);
                                                            setSearchQuery("");
                                                        }}
                                                        className="text-[10px] text-blue-600 hover:text-blue-800 font-bold underline cursor-pointer"
                                                    >
                                                        🔄 Podmień / powiąż inną pozycję z magazynu
                                                    </button>
                                                </div>
                                            </div>

                                            {/* STEROWANIE ILOŚCIĄ I WARTOŚCIĄ */}
                                            <div className="flex flex-wrap items-center gap-2">
                                                {/* Edycja ilości */}
                                                <div className="flex items-center gap-1 bg-slate-50 border rounded-xl px-2 py-1">
                                                    <span className="text-[10px] font-bold text-slate-400">Do zdjęcia:</span>
                                                    <input
                                                        type="number"
                                                        min="1"
                                                        value={item.quantity}
                                                        onChange={e => handleQtyChange(item.id, parseInt(e.target.value) || 1)}
                                                        className="w-14 text-center font-black text-red-700 bg-transparent outline-none text-xs"
                                                    />
                                                    <span className="text-[10px] text-slate-500">{item.unit}</span>
                                                </div>

                                                {/* Wartość */}
                                                <div className="flex items-center gap-1 bg-slate-50 border rounded-xl px-2 py-1">
                                                    <span className="text-[10px] font-bold text-slate-400">Wartość:</span>
                                                    <input
                                                        type="number"
                                                        min="0"
                                                        value={item.estimatedCost}
                                                        onChange={e => handleFieldChange(item.id, "estimatedCost", Math.max(0, parseInt(e.target.value) || 0))}
                                                        className="w-16 text-center font-black text-slate-800 bg-transparent outline-none text-xs"
                                                    />
                                                    <span className="text-[10px] text-slate-500">zł</span>
                                                </div>

                                                {/* Wyklucz / Włącz */}
                                                <button
                                                    type="button"
                                                    onClick={() => handleFieldChange(item.id, "isExcluded", !item.isExcluded)}
                                                    className={`px-3 py-1.5 rounded-xl font-bold text-[10px] uppercase transition cursor-pointer ${
                                                        item.isExcluded
                                                            ? "bg-slate-300 text-slate-700 hover:bg-slate-400"
                                                            : "bg-red-50 text-red-700 hover:bg-red-100 border border-red-200"
                                                    }`}
                                                >
                                                    {item.isExcluded ? "➕ Przywróć" : "✕ Pomiń"}
                                                </button>
                                            </div>
                                        </div>

                                        {/* POWÓD I SPOSÓB KASACJI */}
                                        {!item.isExcluded && (
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 pt-3 border-t border-slate-100">
                                                <div>
                                                    <label className="block text-[9px] font-bold uppercase text-slate-400 mb-0.5">
                                                        Przyczyna likwidacji (uzasadnienie):
                                                    </label>
                                                    <input
                                                        type="text"
                                                        value={item.reason}
                                                        onChange={e => handleFieldChange(item.id, "reason", e.target.value)}
                                                        placeholder="np. Spalony silnik, brak możliwości regeneracji..."
                                                        className="w-full p-2 border rounded-xl text-xs bg-slate-50 focus:bg-white outline-none focus:border-red-400"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="block text-[9px] font-bold uppercase text-slate-400 mb-0.5">
                                                        Sposób fizycznej kasacji:
                                                    </label>
                                                    <select
                                                        value={item.disposalMethod}
                                                        onChange={e => handleFieldChange(item.id, "disposalMethod", e.target.value)}
                                                        className="w-full p-2 border rounded-xl text-xs bg-slate-50 focus:bg-white outline-none focus:border-red-400 font-bold text-slate-800 cursor-pointer"
                                                    >
                                                        <option value="Złomowanie stalowe / kontener złomu">Złomowanie stalowe / kontener złomu</option>
                                                        <option value="Utylizacja odpadów / elektrośmieci">Utylizacja odpadów / elektrośmieci</option>
                                                        <option value="Odpis w koszty (utrata na budowie)">Odpis w koszty (utrata na budowie)</option>
                                                        <option value="Demontaż na części zamienne do innych maszyn">Demontaż na części zamienne</option>
                                                    </select>
                                                </div>
                                            </div>
                                        )}

                                        {/* WYSZUKIWARKA PODMIANY POZYCJI W BAZIE */}
                                        {editingItemId === item.id && (
                                            <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-2xl space-y-2">
                                                <div className="flex justify-between items-center">
                                                    <span className="font-bold text-blue-900 text-xs">Wybierz właściwy sprzęt z kartoteki PESAM:</span>
                                                    <button
                                                        type="button"
                                                        onClick={() => setEditingItemId(null)}
                                                        className="text-blue-600 hover:text-blue-800 font-bold text-[10px]"
                                                    >
                                                        Anuluj podmianę ✕
                                                    </button>
                                                </div>
                                                <input
                                                    type="text"
                                                    placeholder="Wpisz nazwę lub numer magazynowy..."
                                                    value={searchQuery}
                                                    onChange={e => setSearchQuery(e.target.value)}
                                                    className="w-full p-2 border rounded-xl bg-white text-xs outline-none focus:border-blue-500 font-bold"
                                                    autoFocus
                                                />
                                                <div className="max-h-40 overflow-y-auto space-y-1 bg-white border rounded-xl p-1">
                                                    {inventoryItems
                                                        .filter(inv => {
                                                            const q = searchQuery.toLowerCase().trim();
                                                            if (!q) return true;
                                                            return inv.name?.toLowerCase().includes(q) || inv.inventoryNumber?.toLowerCase().includes(q);
                                                        })
                                                        .slice(0, 10)
                                                        .map(inv => (
                                                            <div
                                                                key={inv.id}
                                                                onClick={() => handleSelectInventoryReplacement(item.id, inv)}
                                                                className="p-2 hover:bg-blue-100 rounded-lg cursor-pointer flex justify-between items-center text-xs transition"
                                                            >
                                                                <div>
                                                                    <p className="font-bold text-slate-800">{inv.name}</p>
                                                                    <p className="text-[10px] text-slate-500 font-mono">Nr: {inv.inventoryNumber || "-"}</p>
                                                                </div>
                                                                <span className="font-bold text-blue-800 text-[10px]">
                                                                    Stan: {inv.type === "UNIQUE" ? (inv.status === "sprawne" ? "1 szt." : "0 szt.") : `${inv.totalQuantity || 0} ${inv.unit || "szt."}`}
                                                                </span>
                                                            </div>
                                                        ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>

                            {/* WNIOSKI KOMISJI LIKWIDACYJNEJ */}
                            <div className="pt-2">
                                <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                                    Wnioski i uwagi Komisji Likwidacyjnej:
                                </label>
                                <textarea
                                    rows={2}
                                    value={committeeNotes}
                                    onChange={e => setCommitteeNotes(e.target.value)}
                                    className="w-full p-3 border rounded-2xl bg-slate-50 focus:bg-white text-xs outline-none focus:border-red-400 font-medium"
                                />
                            </div>
                        </div>
                    )}
                </div>

                {/* STOPKA OKNA */}
                <div className="p-4 px-6 border-t bg-slate-100 flex flex-col sm:flex-row justify-between items-center gap-3">
                    <p className="text-[11px] text-slate-500">
                        Zalogowany: <b>{user?.firstName} {user?.lastName}</b> (Magazynier)
                    </p>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-xl text-xs uppercase"
                        >
                            Zamknij
                        </button>
                        <button
                            type="button"
                            onClick={handleExecuteLiquidation}
                            disabled={isSubmitting || items.filter(i => !i.isExcluded).length === 0}
                            className="px-6 py-2.5 bg-red-600 hover:bg-red-700 text-white font-black rounded-xl text-xs uppercase shadow-lg shadow-red-500/20 disabled:opacity-50 flex items-center gap-2 cursor-pointer"
                        >
                            {isSubmitting ? "Zdejmowanie ze stanu..." : "💾 Zatwierdź Likwidację i Zdejmij ze Stanu"}
                        </button>
                    </div>
                </div>

            </div>

            {/* DEDYKOWANY PROTOKÓŁ LIKWIDACJI DO DRUKU */}
            {createdProtocol && (
                <PrintableLiquidationProtocol
                    protocol={createdProtocol}
                    isOpen={isPrintProtocolOpen}
                    onClose={() => setIsPrintProtocolOpen(false)}
                />
            )}
        </div>
    );
}
