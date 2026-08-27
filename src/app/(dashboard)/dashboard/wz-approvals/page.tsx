"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, doc, query, where, orderBy, runTransaction } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";
import { useRouter } from "next/navigation";

interface Site { id: string; name: string; }

interface PendingWzItem {
    id: string;
    siteId: string;
    siteName: string;
    rawItemName: string;
    type: "UNIQUE" | "BULK";
    quantity: number;
    unit: string;
    purchasePrice: number;
    invoiceNumber: string;
    purchaseDate: string;
    notes?: string;
    status: "OCZEKUJE_NA_PRZYPISANIE" | "ZATWIERDZONY";
    createdBy: string;
    createdByName: string;
    createdAt: string;
    assignedToItemId?: string;
    assignedToItemName?: string;
    acceptedByName?: string;
    acceptedAt?: string;
}

interface InventoryItem {
    id: string;
    name: string;
    type: "UNIQUE" | "BULK";
    inventoryNumber: string;
    category: string;
    availableQuantity: number;
    totalQuantity: number;
    unit?: string;
    allocations: Record<string, number>;
}

export default function WzApprovalsPage() {
    const { user } = useAuth();
    const router = useRouter();

    const [sites, setSites] = useState<Site[]>([]);
    const [pendingWzItems, setPendingWzItems] = useState<PendingWzItem[]>([]);
    const [inventory, setInventory] = useState<InventoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<"PENDING" | "HISTORY">("PENDING");
    const [selectedSiteFilter, setSelectedSiteFilter] = useState<string>("ALL");

    // Stan modala przypisywania
    const [activeItem, setActiveItem] = useState<PendingWzItem | null>(null);
    const [searchTerm, setSearchTerm] = useState("");
    const [matchedInventoryItem, setMatchedInventoryItem] = useState<InventoryItem | null>(null);
    const [customNewName, setCustomNewName] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const canApproveWz = user ? hasPermission("wzApproveDelivery", user.rolePermissions, user.permissionOverrides) : false;

    useEffect(() => {
        if (user && !canApproveWz) {
            alert("Brak uprawnień do przypisywania pozycji z WZ do budowy.");
            router.push("/dashboard");
        }
    }, [user, canApproveWz, router]);

    const fetchData = async () => {
        setLoading(true);
        try {
            // Pobieranie budów
            const sitesSnap = await getDocs(query(collection(db, "sites"), orderBy("name", "asc")));
            setSites(sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[]);

            // Pobieranie wpisów WZ
            const wzSnap = await getDocs(query(collection(db, "pending_wz_items"), orderBy("createdAt", "desc")));
            setPendingWzItems(wzSnap.docs.map(d => ({ id: d.id, ...d.data() })) as PendingWzItem[]);

            // Pobieranie katalogu sprzętu
            const invSnap = await getDocs(query(collection(db, "inventory"), orderBy("name", "asc")));
            setInventory(invSnap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[]);
        } catch (error) {
            console.error("Błąd pobierania danych WZ:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (user && canApproveWz) fetchData();
    }, [user, canApproveWz]);

    // Funkcja do oczyszczania i porównywania nazw (wyszukiwanie rozmyte)
    const normalizeString = (str: string) => {
        return str
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9\s]/g, "");
    };

    // Otwarcie modala dopasowania dla danej pozycji z WZ
    const handleOpenAssignModal = (item: PendingWzItem) => {
        setActiveItem(item);
        setSearchTerm(item.rawItemName);
        setCustomNewName(item.rawItemName);
        setMatchedInventoryItem(null);
    };

    // Filtrowanie sugestii przedmiotów z katalogu dla wybranej budowy
    const filteredSuggestions = () => {
        if (!activeItem || !searchTerm.trim()) return [];
        const cleanQuery = normalizeString(searchTerm);
        const queryWords = cleanQuery.split(/\s+/).filter(w => w.length > 0);

        const matches = inventory.filter(inv => {
            if (inv.type !== activeItem.type) return false;
            const cleanInvName = normalizeString(inv.name);
            return queryWords.every(word => cleanInvName.includes(word));
        });

        // Sortujemy: najpierw te, które już istnieją na danej budowie
        return matches.sort((a, b) => {
            const aQty = a.allocations?.[activeItem.siteId] || 0;
            const bQty = b.allocations?.[activeItem.siteId] || 0;
            return bQty - aQty;
        }).slice(0, 6);
    };

    // POTWIERDZENIE PRZYPISANIA POZYCJI Z WZ NA STAN BUDOWY
    const handleConfirmAssignment = async (mode: "EXISTING_BULK" | "NEW_BULK" | "UNIQUE") => {
        if (!activeItem) return;

        setIsSubmitting(true);
        try {
            await runTransaction(db, async (transaction) => {
                const siteName = activeItem.siteName;
                const now = new Date().toISOString();
                let finalTargetItemId = "";
                let finalTargetItemName = "";

                if (mode === "EXISTING_BULK") {
                    if (!matchedInventoryItem) throw new Error("Nie wybrano istniejącego przedmiotu do powiązania!");

                    const itemRef = doc(db, "inventory", matchedInventoryItem.id);
                    const itemDoc = await transaction.get(itemRef);
                    if (!itemDoc.exists()) throw new Error("Wybrany przedmiot nie istnieje w bazie!");

                    const itemData = itemDoc.data() as InventoryItem;
                    const currentAlloc = itemData.allocations?.[activeItem.siteId] || 0;

                    transaction.update(itemRef, {
                        totalQuantity: (itemData.totalQuantity || 0) + activeItem.quantity,
                        [`allocations.${activeItem.siteId}`]: currentAlloc + activeItem.quantity
                    });

                    finalTargetItemId = matchedInventoryItem.id;
                    finalTargetItemName = itemData.name;

                    // Zapis w historii przedmiotu
                    const historyRef = doc(collection(db, `inventory/${matchedInventoryItem.id}/history`));
                    transaction.set(historyRef, {
                        date: now,
                        documentDate: activeItem.purchaseDate || now.split("T")[0],
                        type: "DOSTAWA_BEZP_WZ",
                        description: `Przypisanie z WZ (Wpis z biura: "${activeItem.rawItemName}"). Dok: ${activeItem.invoiceNumber}. Ilość: +${activeItem.quantity} ${activeItem.unit}. Budowa: ${siteName}.`,
                        status: "sprawne",
                        user: `${user?.firstName} ${user?.lastName}`
                    });

                } else if (mode === "NEW_BULK") {
                    const finalName = customNewName.trim() || activeItem.rawItemName;
                    const newDocRef = doc(collection(db, "inventory"));

                    const codePrefix = "ZAKUP-B";
                    const count = inventory.filter(i => i.type === "BULK" && i.inventoryNumber?.startsWith(codePrefix)).length;
                    const generatedCode = `${codePrefix}-${String(count + 1).padStart(4, '0')}`;

                    transaction.set(newDocRef, {
                        name: finalName,
                        type: "BULK",
                        subType: "SUB_ITEM",
                        inventoryNumber: generatedCode,
                        category: "Dostawy WZ",
                        subcategory: "Drobnica",
                        unit: activeItem.unit || "szt.",
                        totalQuantity: activeItem.quantity,
                        availableQuantity: 0, // idzie bezpośrednio na budowę
                        allocations: { [activeItem.siteId]: activeItem.quantity },
                        currentLocation: siteName,
                        purchasePrice: activeItem.purchasePrice || 0,
                        invoiceNumber: activeItem.invoiceNumber,
                        purchaseDate: activeItem.purchaseDate,
                        additionalInfo: activeItem.notes ? `${activeItem.notes} | Zakup z WZ.` : "Zakup bezpośredni z WZ.",
                        createdAt: now
                    });

                    finalTargetItemId = newDocRef.id;
                    finalTargetItemName = finalName;

                    const historyRef = doc(collection(db, `inventory/${newDocRef.id}/history`));
                    transaction.set(historyRef, {
                        date: now,
                        documentDate: activeItem.purchaseDate || now.split("T")[0],
                        type: "DOSTAWA_BEZP_WZ",
                        description: `Utworzono nowy przedmiot BULK z WZ. Dok: ${activeItem.invoiceNumber}. Ilość: ${activeItem.quantity} ${activeItem.unit}. Budowa: ${siteName}.`,
                        status: "sprawne",
                        user: `${user?.firstName} ${user?.lastName}`
                    });

                } else if (mode === "UNIQUE") {
                    const finalName = customNewName.trim() || activeItem.rawItemName;
                    const tempInvNumber = `DO_NADANIA-${activeItem.invoiceNumber || Date.now()}`;

                    for (let i = 0; i < activeItem.quantity; i++) {
                        const newDocRef = doc(collection(db, "inventory"));
                        transaction.set(newDocRef, {
                            name: finalName,
                            type: "UNIQUE",
                            inventoryNumber: tempInvNumber,
                            status: "do nadania numeru",
                            category: "Dostawy WZ (Unique)",
                            subcategory: "Narzędzia",
                            unit: "szt.",
                            totalQuantity: 1,
                            availableQuantity: 0,
                            allocations: { [activeItem.siteId]: 1 },
                            currentLocation: siteName,
                            purchasePrice: activeItem.purchasePrice || 0,
                            invoiceNumber: activeItem.invoiceNumber,
                            purchaseDate: activeItem.purchaseDate,
                            additionalInfo: `${activeItem.notes ? activeItem.notes + ' | ' : ''}Zakup bezpośredni z WZ. Wymaga nadania numeru przy zwrocie.`,
                            createdAt: now
                        });

                        const historyRef = doc(collection(db, `inventory/${newDocRef.id}/history`));
                        transaction.set(historyRef, {
                            date: now,
                            documentDate: activeItem.purchaseDate || now.split("T")[0],
                            type: "ZAKUP_WZ",
                            description: `Zakup z WZ dla budowy: ${siteName}. Dok: ${activeItem.invoiceNumber}. Status: Oczekuje na nadanie numeru magazynowego.`,
                            status: "do nadania numeru",
                            user: `${user?.firstName} ${user?.lastName}`
                        });

                        if (i === 0) finalTargetItemId = newDocRef.id;
                    }
                    finalTargetItemName = finalName;
                }

                // Aktualizujemy status w kolekcji pending_wz_items
                const wzRef = doc(db, "pending_wz_items", activeItem.id);
                transaction.update(wzRef, {
                    status: "ZATWIERDZONY",
                    assignedToItemId: finalTargetItemId,
                    assignedToItemName: finalTargetItemName,
                    acceptedBy: user?.uid || "nieznany",
                    acceptedByName: `${user?.firstName || ''} ${user?.lastName || ''}`.trim(),
                    acceptedAt: now
                });

                // Tworzymy protokol zapisu ewidencji dostaw WZ
                const protocolRef = doc(collection(db, "protocols"));
                const protocolId = `WZ-${now.slice(2, 10).replace(/-/g, "")}-${Math.floor(100 + Math.random() * 900)}`;

                transaction.set(protocolRef, {
                    protocolId,
                    type: "DOSTAWA_BEZP_WZ",
                    destinationId: activeItem.siteId,
                    destinationName: siteName,
                    createdBy: user?.uid,
                    createdByName: `${user?.firstName} ${user?.lastName}`,
                    status: "ZAAKCEPTOWANY",
                    createdAt: now,
                    documentDate: activeItem.purchaseDate || now.split("T")[0],
                    invoiceNumber: activeItem.invoiceNumber,
                    items: [{
                        name: finalTargetItemName,
                        originalWzName: activeItem.rawItemName,
                        quantity: activeItem.quantity,
                        unit: activeItem.unit,
                        price: activeItem.purchasePrice || 0
                    }]
                });
            });

            alert(`✅ Pomyślnie przypisano pozycję z WZ na stan budowy: ${activeItem.siteName}!`);
            setActiveItem(null);
            fetchData();
        } catch (error: any) {
            console.error("Błąd zatwierdzania WZ:", error);
            alert("Nie udało się zatwierdzić pozycji z WZ: " + error.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (!canApproveWz) return null;
    if (loading) return <div className="p-10 text-center animate-pulse">Ładowanie kolejki WZ i budów...</div>;

    const filteredPendingItems = pendingWzItems
        .filter(item => activeTab === "PENDING" ? item.status === "OCZEKUJE_NA_PRZYPISANIE" : item.status === "ZATWIERDZONY")
        .filter(item => selectedSiteFilter === "ALL" || item.siteId === selectedSiteFilter);

    const pendingCount = pendingWzItems.filter(i => i.status === "OCZEKUJE_NA_PRZYPISANIE").length;

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-6">
            {/* NAGŁÓWEK */}
            <div className="bg-white rounded-3xl p-6 border shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h1 className="text-2xl font-black text-slate-900 uppercase italic tracking-tight">Dodaj do stanu budowy z WZ</h1>
                    <p className="text-xs text-slate-500 mt-1">
                        Przeglądaj i przypisuj surowe pozycje z WZ wpisane przez biuro do istniejących lub nowych zasobów na budowach.
                    </p>
                </div>

                <div className="flex items-center gap-3">
                    <span className="text-xs font-bold text-slate-500">Filtruj wg budowy:</span>
                    <select
                        value={selectedSiteFilter}
                        onChange={e => setSelectedSiteFilter(e.target.value)}
                        className="p-3 bg-slate-50 border rounded-xl font-bold text-xs outline-none focus:border-blue-500 cursor-pointer"
                    >
                        <option value="ALL">-- Wszystkie budowy --</option>
                        {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                </div>
            </div>

            {/* ZAKŁADKI: OCZEKUJĄCE vs HISTORIA */}
            <div className="flex border-b border-slate-200 gap-4">
                <button
                    onClick={() => setActiveTab("PENDING")}
                    className={`pb-3 font-black text-xs uppercase tracking-wider transition relative ${activeTab === 'PENDING' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-slate-400 hover:text-slate-600'}`}
                >
                    📥 Oczekujące na przypisanie
                    {pendingCount > 0 && (
                        <span className="ml-2 bg-blue-600 text-white text-[10px] px-2 py-0.5 rounded-full">
                            {pendingCount}
                        </span>
                    )}
                </button>
                <button
                    onClick={() => setActiveTab("HISTORY")}
                    className={`pb-3 font-black text-xs uppercase tracking-wider transition relative ${activeTab === 'HISTORY' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-slate-400 hover:text-slate-600'}`}
                >
                    📜 Historia zatwierdzonych WZ
                </button>
            </div>

            {/* LISTA POZYCJI WZ */}
            {filteredPendingItems.length === 0 ? (
                <div className="bg-white border rounded-3xl p-12 text-center text-slate-400 font-bold">
                    {activeTab === "PENDING"
                        ? "Brak oczekujących pozycji z WZ do przypisania na stan budowy. 👍"
                        : "Brak historii zatwierdzonych pozycji WZ."
                    }
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {filteredPendingItems.map(item => (
                        <div key={item.id} className="bg-white border-2 border-slate-200 rounded-3xl p-6 shadow-sm hover:shadow-md transition flex flex-col justify-between space-y-4">
                            <div>
                                <div className="flex justify-between items-start mb-3">
                                    <span className="bg-slate-100 text-slate-700 text-[10px] font-black px-3 py-1 rounded-lg uppercase tracking-wider border border-slate-200">
                                        🏢 {item.siteName}
                                    </span>
                                    <span className={`text-[10px] font-black px-2.5 py-1 rounded-md uppercase ${item.type === 'BULK' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-900'}`}>
                                        {item.type === 'BULK' ? '⚖️ BULK' : '⚡ UNIQUE'}
                                    </span>
                                </div>

                                <h3 className="text-lg font-black text-slate-900 leading-snug">
                                    {item.rawItemName}
                                </h3>

                                <div className="mt-3 bg-slate-50 p-3 rounded-2xl space-y-1.5 text-xs">
                                    <div className="flex justify-between">
                                        <span className="text-slate-400 font-bold">Ilość z WZ:</span>
                                        <span className="font-black text-slate-900">{item.quantity} {item.unit}</span>
                                    </div>
                                    {item.purchasePrice > 0 && (
                                        <div className="flex justify-between">
                                            <span className="text-slate-400 font-bold">Cena netto:</span>
                                            <span className="font-mono font-bold text-slate-800">{item.purchasePrice} zł / szt.</span>
                                        </div>
                                    )}
                                    <div className="flex justify-between">
                                        <span className="text-slate-400 font-bold">Dokument / FV:</span>
                                        <span className="font-mono font-bold text-blue-700">{item.invoiceNumber || 'Brak'}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-400 font-bold">Wprowadził(a):</span>
                                        <span className="font-bold text-slate-700">{item.createdByName}</span>
                                    </div>
                                </div>

                                {item.notes && (
                                    <p className="text-[11px] text-slate-500 italic mt-3 bg-amber-50/60 p-2.5 rounded-xl border border-amber-100">
                                        💬 {item.notes}
                                    </p>
                                )}
                            </div>

                            {activeTab === "PENDING" ? (
                                <button
                                    onClick={() => handleOpenAssignModal(item)}
                                    className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-black text-xs uppercase tracking-wider rounded-xl shadow transition"
                                >
                                    ⚡ Przypisz do stanu budowy ➡️
                                </button>
                            ) : (
                                <div className="pt-2 border-t text-[11px] text-slate-500 space-y-1">
                                    <div>✓ Przypisano do: <b className="text-slate-800">{item.assignedToItemName}</b></div>
                                    <div>Zatwierdził: <b>{item.acceptedByName}</b> ({new Date(item.acceptedAt || '').toLocaleDateString('pl-PL')})</div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* MODAL PRZYPISYWANIA I DOPASOWYWANIA NAZWY */}
            {activeItem && (
                <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 md:p-8 space-y-6 animate-fade-in">
                        <div className="flex justify-between items-start border-b pb-4">
                            <div>
                                <span className="bg-blue-100 text-blue-800 text-[10px] font-black px-2.5 py-1 rounded-md uppercase">
                                    Przypisywanie pozycji z WZ
                                </span>
                                <h2 className="text-xl font-black text-slate-900 mt-1">
                                    Wpis z WZ: „{activeItem.rawItemName}”
                                </h2>
                                <p className="text-xs text-slate-500 mt-0.5">
                                    Budowa: <b>{activeItem.siteName}</b> | Ilość: <b>{activeItem.quantity} {activeItem.unit}</b>
                                </p>
                            </div>
                            <button
                                onClick={() => setActiveItem(null)}
                                className="text-slate-400 hover:text-slate-600 text-2xl font-bold"
                            >
                                ✕
                            </button>
                        </div>

                        {/* WIZUALNY WARUNEK DLA TYPU BULK vs UNIQUE */}
                        {activeItem.type === "BULK" ? (
                            <div className="space-y-6">
                                {/* WYSZUKIWARKA ISTNIEJĄCYCH POZYCJI */}
                                <div>
                                    <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">
                                        1. Szukaj w istniejących pozycjach na budowie i w katalogu:
                                    </label>
                                    <input
                                        type="text"
                                        value={searchTerm}
                                        onChange={e => setSearchTerm(e.target.value)}
                                        placeholder="Wpisz nazwę... (np. Nożyce do blachy)"
                                        className="w-full p-3.5 border-2 rounded-xl font-bold outline-none focus:border-blue-500"
                                    />
                                </div>

                                {/* LISTA SUGESTII */}
                                <div className="space-y-2">
                                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                        Wybierz pasującą pozycję (lub utwórz nową poniżej):
                                    </label>

                                    {filteredSuggestions().length === 0 ? (
                                        <div className="p-4 bg-slate-50 border rounded-2xl text-xs text-slate-500 text-center">
                                            Nie znaleziono bezpośrednich dopasowań dla "{searchTerm}". Możesz utworzyć nową pozycję poniżej.
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {filteredSuggestions().map(inv => {
                                                const siteAlloc = inv.allocations?.[activeItem.siteId] || 0;
                                                const isSelected = matchedInventoryItem?.id === inv.id;

                                                return (
                                                    <div
                                                        key={inv.id}
                                                        onClick={() => setMatchedInventoryItem(inv)}
                                                        className={`p-4 border-2 rounded-2xl cursor-pointer transition flex justify-between items-center ${
                                                            isSelected ? 'bg-green-50 border-green-500 shadow-sm' : 'bg-white border-slate-200 hover:border-blue-300'
                                                        }`}
                                                    >
                                                        <div>
                                                            <div className="font-bold text-sm text-slate-800">{inv.name}</div>
                                                            <div className="text-[10px] text-slate-400 font-mono">Kod: {inv.inventoryNumber}</div>
                                                        </div>

                                                        <div className="flex items-center gap-2">
                                                            {siteAlloc > 0 ? (
                                                                <span className="bg-green-100 text-green-800 text-[10px] px-3 py-1 rounded-full font-black uppercase">
                                                                    ✓ Obecny na budowie ({siteAlloc} {inv.unit || 'szt.'})
                                                                </span>
                                                            ) : (
                                                                <span className="bg-blue-50 text-blue-700 text-[10px] px-3 py-1 rounded-full font-black uppercase border border-blue-200">
                                                                    + Z katalogu (Baza)
                                                                </span>
                                                            )}
                                                            {isSelected && <span className="text-green-600 font-black text-lg">✓</span>}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>

                                {/* AKCJA 1: DOPISZ DO ISTNIEJĄCEGO */}
                                {matchedInventoryItem && (
                                    <div className="p-4 bg-green-50 border-2 border-green-300 rounded-2xl space-y-3">
                                        <div className="text-xs font-bold text-green-950">
                                            Wybrano powiązanie: <b>{matchedInventoryItem.name}</b>
                                        </div>
                                        <p className="text-[11px] text-green-800 leading-relaxed">
                                            Dopiszesz <b>+{activeItem.quantity} {activeItem.unit}</b> do stanu tej pozycji na budowie <b>{activeItem.siteName}</b>.
                                        </p>
                                        <button
                                            disabled={isSubmitting}
                                            onClick={() => handleConfirmAssignment("EXISTING_BULK")}
                                            className="w-full py-3.5 bg-green-600 hover:bg-green-700 text-white font-black text-xs uppercase tracking-wider rounded-xl shadow transition"
                                        >
                                            {isSubmitting ? "ZAPISYWANIE..." : `⚡ DOPISZ +${activeItem.quantity} DO POZYCJI: ${matchedInventoryItem.name}`}
                                        </button>
                                    </div>
                                )}

                                {/* AKCJA 2: UTWÓRZ JAKO NOWY BULK */}
                                <div className="pt-4 border-t space-y-3">
                                    <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest">
                                        Lub stwórz jako NOWĄ pozycję w stanie budowy:
                                    </label>
                                    <input
                                        type="text"
                                        value={customNewName}
                                        onChange={e => setCustomNewName(e.target.value)}
                                        placeholder="Oficjalna nazwa przedmiotu w systemie..."
                                        className="w-full p-3 border-2 rounded-xl font-bold text-sm outline-none focus:border-blue-500"
                                    />
                                    <button
                                        disabled={isSubmitting}
                                        onClick={() => handleConfirmAssignment("NEW_BULK")}
                                        className="w-full py-3.5 bg-slate-800 hover:bg-slate-900 text-white font-black text-xs uppercase tracking-wider rounded-xl shadow transition"
                                    >
                                        {isSubmitting ? "ZAPISYWANIE..." : `➕ STWÓRZ NOWĄ POZYCJĘ BULK („${customNewName || activeItem.rawItemName}”)`}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            /* WIDOK DLA TYPU UNIQUE */
                            <div className="space-y-6">
                                <div className="p-4 bg-amber-50 border-2 border-amber-200 rounded-2xl space-y-2">
                                    <h4 className="text-xs font-bold text-amber-950">⚡ Urządzenia / Narzędzia Indywidualne (UNIQUE)</h4>
                                    <p className="text-[11px] text-amber-800 leading-relaxed">
                                        Zostaną utworzone <b>{activeItem.quantity} szt.</b> osobnych kartotek sprzętu przypisanych do budowy <b>{activeItem.siteName}</b>. Sprzęt otrzyma status <span className="font-bold underline">"do nadania numeru"</span> i tymczasowy kod, co umożliwi nadanie docelowego numeru magazynowego przy późniejszym zwrocie na magazyn główny.
                                    </p>
                                </div>

                                <div>
                                    <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">
                                        Oficjalna nazwa urządzenia w katalogu:
                                    </label>
                                    <input
                                        type="text"
                                        value={customNewName}
                                        onChange={e => setCustomNewName(e.target.value)}
                                        className="w-full p-3.5 border-2 rounded-xl font-bold outline-none focus:border-blue-500"
                                    />
                                </div>

                                <button
                                    disabled={isSubmitting}
                                    onClick={() => handleConfirmAssignment("UNIQUE")}
                                    className="w-full py-4 bg-amber-600 hover:bg-amber-700 text-white font-black text-xs uppercase tracking-wider rounded-xl shadow-lg transition"
                                >
                                    {isSubmitting ? "TWORZENIE SPRZĘTU..." : `⚡ ZATWIERDŹ SPRZĘT UNIQUE NA STAN BUDOWY (${activeItem.quantity} SZT.)`}
                                </button>
                            </div>
                        )}

                        <div className="pt-4 border-t flex justify-end">
                            <button
                                onClick={() => setActiveItem(null)}
                                className="px-6 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-xs rounded-xl transition"
                            >
                                Zamknij
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
