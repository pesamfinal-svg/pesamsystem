// src/app/(dashboard)/my-site/page.tsx
"use client";

import React, { useState, useEffect, Suspense, Fragment } from "react";
import { collection, getDocs, doc, query, orderBy, where } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";
import { useRouter, useSearchParams } from "next/navigation";

// --- INTERFEJSY ---
interface InventoryItem {
    id: string; name: string; inventoryNumber: string; type: "UNIQUE" | "BULK"; subType?: "MAIN_CAT" | "SUB_ITEM" | "MANUAL"; category: string;
    imageUrl: string; allocations: Record<string, number>; unit?: string;
}
interface Site { id: string; name: string; status?: string; location?: string; }
interface Protocol {
    protocolId: string; type: string; createdAt: string;
    status: string; createdByName: string; items: any[];
    sourceId?: string; destinationId?: string;
    documentSource?: string; paperDocumentSource?: string;
}

// Podkomponent MySiteHubContent
function MySiteHubContent() {
    const { user } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();

    const [mySites, setMySites] = useState<Site[]>([]);
    const [selectedSiteId, setSelectedSiteId] = useState("");
    const [loading, setLoading] = useState(true);

    const [activeView, setActiveView] = useState<"HUB" | "INVENTORY" | "HISTORY" | "DAMAGES" | "CLAIMS">("HUB");

    const [itemsOnSite, setItemsOnSite] = useState<InventoryItem[]>([]);
    const [siteProtocols, setSiteProtocols] = useState<Protocol[]>([]);
    const [damages, setDamages] = useState<any[]>([]);

    const [inventoryActiveTab, setInventoryActiveTab] = useState<"UNIQUE" | "BULK" | "MANUAL" | "ALL">("ALL");
    const [inventorySearchQuery, setInventorySearchQuery] = useState("");

    const [expandedProtocolId, setExpandedProtocolId] = useState<string | null>(null);

    // Stan selektywnego wyboru urządzeń do druku PDF
    const [selectedPrintIds, setSelectedPrintIds] = useState<string[]>([]);

    const canViewSiteState = user ? hasPermission("viewSiteState", user.rolePermissions, user.permissionOverrides) : false;

    // Odczytywanie parametru ?view= z adresu URL
    useEffect(() => {
        if (searchParams) {
            const viewParam = searchParams.get("view");
            if (viewParam) {
                const upperView = viewParam.toUpperCase();
                if (["HUB", "INVENTORY", "HISTORY", "DAMAGES", "CLAIMS"].includes(upperView)) {
                    setActiveView(upperView as any);
                }
            }
        }
    }, [searchParams]);

    useEffect(() => {
        if (user && !canViewSiteState) {
            alert("Brak uprawnień do przeglądania stanów na budowach.");
            router.push("/dashboard");
        }
    }, [user, canViewSiteState, router]);

    useEffect(() => {
        const fetchInitialData = async () => {
            setLoading(true);
            try {
                const sitesSnap = await getDocs(query(collection(db, "sites"), orderBy("name", "asc")));
                const allSites = sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[];
                const userAssigned = user?.assignedSites || [];

                const filteredSites = allSites.filter(s =>
                    (userAssigned.includes("ALL") || userAssigned.includes(s.id)) &&
                    s.location !== "Wpis ręczny" &&
                    s.status !== "ZAKOŃCZONA"
                );
                setMySites(filteredSites);

                if (filteredSites.length > 0) setSelectedSiteId(filteredSites[0].id);
            } catch (error) { console.error(error); } finally { setLoading(false); }
        };

        if (user && canViewSiteState) fetchInitialData();
    }, [user, canViewSiteState]);

    useEffect(() => {
        const fetchDataForSite = async () => {
            if (!selectedSiteId || !canViewSiteState) return;

            const invSnap = await getDocs(collection(db, "inventory"));
            const allItems = invSnap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[];
            setItemsOnSite(allItems.filter(item => item.allocations && item.allocations[selectedSiteId] > 0));

            const protoSnap = await getDocs(query(collection(db, "protocols"), where("destinationId", "==", selectedSiteId)));
            const protoSourceSnap = await getDocs(query(collection(db, "protocols"), where("sourceId", "==", selectedSiteId)));

            const combinedProtos = [
                ...protoSnap.docs.map(d => d.data() as Protocol),
                ...protoSourceSnap.docs.map(d => d.data() as Protocol)
            ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

            setSiteProtocols(combinedProtos);

            const damagesList: any[] = [];
            combinedProtos.forEach(p => {
                if (p.type === "ZWROT" && p.sourceId === selectedSiteId) {
                    p.items.forEach(item => {
                        if (item.finalStatus === "uszkodzone" || item.declaredStatus === "uszkodzone") {
                            damagesList.push({ protocolId: p.protocolId, date: p.createdAt, status: p.status, ...item });
                        }
                    });
                }
            });
            setDamages(damagesList);
        };
        fetchDataForSite();
    }, [selectedSiteId, canViewSiteState]);

    const checkDiscrepancies = (protocol: Protocol) => {
        if (protocol.type !== "ZWROT" || protocol.status === "OCZEKUJACY") return false;
        if (protocol.documentSource === "PAPER" && protocol.paperDocumentSource === "BRAK_PROTOKOLU") return true;

        return protocol.items.some(item => {
            const decQty = item.declaredQty !== undefined ? item.declaredQty : (item.quantity !== undefined ? item.quantity : 1);
            const recQty = item.receivedQty !== undefined ? item.receivedQty : decQty;
            const decStatus = item.declaredStatus || "sprawne";
            const finStatus = item.finalStatus || decStatus;
            const hasNotes = !!item.warehouseNotes;

            return (
                decQty !== recQty ||
                decStatus !== finStatus ||
                finStatus === "uszkodzone" ||
                hasNotes ||
                item.isNewManual
            );
        });
    };

    const toggleExpandProtocol = (protocolId: string) => {
        setExpandedProtocolId(prev => prev === protocolId ? null : protocolId);
    };

    // Dynamiczne pobieranie osprzętu z ostatniego wydania dla danego przedmiotu na tej budowie
    const getAccessoriesForItem = (itemId: string) => {
        const lastIssueProto = siteProtocols.find(p =>
            p.type === "WYDANIE" &&
            p.destinationId === selectedSiteId &&
            p.items.some(i => i.inventoryId === itemId)
        );
        if (!lastIssueProto) return [];

        const foundItem = lastIssueProto.items.find(i => i.inventoryId === itemId);
        return foundItem?.accessories?.filter((acc: any) => acc.mustReturn) || [];
    };

    const getFilteredInventory = () => {
        return itemsOnSite.filter(item => {
            if (inventoryActiveTab === "UNIQUE" && item.type !== "UNIQUE") return false;
            if (inventoryActiveTab === "BULK" && (item.type !== "BULK" || item.subType === "MANUAL" || item.category === "Wpis ręczny")) return false;
            if (inventoryActiveTab === "MANUAL" && item.subType !== "MANUAL" && item.category !== "Wpis ręczny") return false;
            if (inventorySearchQuery) {
                const queryStr = inventorySearchQuery.toLowerCase();
                const matchesName = item.name.toLowerCase().includes(queryStr);
                const matchesNum = item.inventoryNumber ? item.inventoryNumber.toLowerCase().includes(queryStr) : false;
                if (!matchesName && !matchesNum) return false;
            }
            return true;
        });
    };

    const filteredInventoryList = getFilteredInventory();

    // Logika wybiórczego zaznaczania wierszy do wydruku
    const handleTogglePrintSelect = (itemId: string) => {
        setSelectedPrintIds(prev =>
            prev.includes(itemId) ? prev.filter(id => id !== itemId) : [...prev, itemId]
        );
    };

    const handleSelectAllVisiblePrint = () => {
        const visibleIds = filteredInventoryList.map(item => item.id);
        setSelectedPrintIds(visibleIds);
    };

    const handleClearPrintSelect = () => {
        setSelectedPrintIds([]);
    };

    // Budowanie ostatecznej listy przedmiotów, która ukaże się na wydruku PDF
    const itemsToPrint = selectedPrintIds.length > 0
        ? itemsOnSite.filter(item => selectedPrintIds.includes(item.id))
        : filteredInventoryList;

    if (!canViewSiteState) return null;
    if (loading && mySites.length === 0) return <div className="p-10 text-center text-slate-500 animate-pulse">Analizowanie przypisanych budów...</div>;

    const renderContent = () => {
        switch (activeView) {
            case "HISTORY":
                return (
                    <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden animate-fade-in">
                        <div className="bg-slate-800 text-white p-6 flex justify-between items-center">
                            <div>
                                <h3 className="font-bold text-xl">Historia Operacji</h3>
                                <p className="text-slate-400 text-xs mt-1">Wszystkie wydania i zwroty powiązane z tą budową. Kliknij protokół, aby zobaczyć szczegóły.</p>
                            </div>
                            <button onClick={() => setActiveView("HUB")} className="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-lg font-bold transition">Powrót</button>
                        </div>
                        <div className="p-6 space-y-4 bg-slate-50">
                            {siteProtocols.length === 0 ? (
                                <div className="text-center p-10 text-slate-400">Brak historii dla tej budowy.</div>
                            ) : (
                                siteProtocols.map((p, idx) => {
                                    const isPending = p.status === "OCZEKUJACY";
                                    const isIssue = p.type === "WYDANIE";
                                    const isPaper = p.documentSource === "PAPER";
                                    const hasAlert = checkDiscrepancies(p);
                                    const isExpanded = expandedProtocolId === p.protocolId;

                                    return (
                                        <div key={idx} className={`border rounded-2xl transition shadow-sm overflow-hidden ${isPending ? 'bg-yellow-50 border-yellow-200' : hasAlert ? 'bg-red-50/30 border-red-300' : 'bg-white hover:border-slate-300'}`}>
                                            <div onClick={() => toggleExpandProtocol(p.protocolId)} className="p-4 cursor-pointer flex justify-between items-center select-none">
                                                <div className="flex items-center gap-4">
                                                    <div className={`w-12 h-12 rounded-full flex items-center justify-center text-2xl ${isIssue ? 'bg-green-100' : 'bg-blue-100'}`}>
                                                        {isIssue ? '📥' : '📤'}
                                                    </div>
                                                    <div>
                                                        <div className="flex items-center gap-2">
                                                            <p className="font-black text-slate-800 text-lg">{p.protocolId}</p>
                                                            {hasAlert && (
                                                                <span className="bg-red-100 text-red-700 text-[10px] px-2 py-0.5 rounded font-black uppercase tracking-wider animate-pulse">
                                                                    {p.paperDocumentSource === "BRAK_PROTOKOLU" ? '⚠️ BRAK PROTOKOŁU' : '⚠️ NIEZGODNOŚĆ'}
                                                                </span>
                                                            )}
                                                            {isPaper && p.paperDocumentSource !== "BRAK_PROTOKOLU" && !hasAlert && (
                                                                <span className="bg-slate-100 text-slate-500 text-[9px] px-2 py-0.5 rounded uppercase border border-slate-200">
                                                                    Papier ({p.paperDocumentSource})
                                                                </span>
                                                            )}
                                                        </div>
                                                        <p className="text-xs text-slate-500 mt-0.5">{new Date(p.createdAt).toLocaleString()} • Wystawił: {p.createdByName}</p>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-4">
                                                    <span className={`px-3 py-1 rounded-lg text-xs font-black uppercase tracking-wider ${isPending ? 'bg-yellow-200 text-yellow-800' : 'bg-green-100 text-green-700'}`}>
                                                        {isPending ? '⏳ Oczekuje' : '✅ Zrealizowany'}
                                                    </span>
                                                    <span className="text-slate-400 text-xl font-bold w-6 text-center">{isExpanded ? '−' : '+'}</span>
                                                </div>
                                            </div>

                                            {isExpanded && (
                                                <div className="bg-slate-50 border-t border-slate-100 p-4 animate-fade-in">
                                                    <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3 pl-2">Pozycje w protokole:</h4>
                                                    <div className="space-y-2">
                                                        {p.items.map((item: any, itemIdx: number) => {
                                                            const decQty = item.declaredQty !== undefined ? item.declaredQty : (item.quantity !== undefined ? item.quantity : (item.receivedQty || 1));
                                                            const recQty = item.receivedQty !== undefined ? item.receivedQty : decQty;
                                                            const isQtyDiff = !isIssue && !isPending && decQty !== recQty;
                                                            const isStatusDiff = !isIssue && !isPending && item.declaredStatus && item.finalStatus && item.declaredStatus !== item.finalStatus;
                                                            const hasNotes = !!item.warehouseNotes;
                                                            const hasItemAlert = isQtyDiff || isStatusDiff || hasNotes || item.isNewManual || item.finalStatus === "uszkodzone";

                                                            return (
                                                                <div key={itemIdx} className={`p-3 rounded-xl border ${hasItemAlert ? 'bg-orange-50 border-orange-200' : 'bg-white border-slate-200'}`}>
                                                                    <div className="flex justify-between items-start">
                                                                        <div>
                                                                            <p className="font-bold text-slate-800 text-sm">
                                                                                {item.name}
                                                                                {item.isNewManual && <span className="ml-2 text-[9px] bg-slate-200 text-slate-600 px-2 py-0.5 rounded font-black uppercase">Wpis ręczny</span>}
                                                                            </p>
                                                                            <p className="text-[10px] font-mono text-slate-500">Nr Mag: {item.inventoryNumber || "BRAK"}</p>
                                                                        </div>
                                                                        <div className="text-right">
                                                                            {isIssue || isPending ? (
                                                                                <div className="flex flex-col items-end gap-1">
                                                                                    <p className="font-black text-slate-700 bg-slate-100 px-2 py-1 rounded">Ilość: {decQty} {item.unit || "szt."}</p>
                                                                                </div>
                                                                            ) : (
                                                                                <div className="flex flex-col items-end text-xs">
                                                                                    {isQtyDiff ? (
                                                                                        <div className="bg-orange-100 text-orange-800 px-2 py-1 rounded border border-orange-200 shadow-sm">
                                                                                            {isPaper ? 'Kwit' : 'Zgłoszono'}: <b>{decQty}</b> ➔ Fizycznie: <b className="text-red-600">{recQty}</b> {item.unit || "szt."}
                                                                                        </div>
                                                                                    ) : (
                                                                                        <p className="font-black text-slate-700 bg-slate-100 px-2 py-1 rounded">Ilość: {recQty} {item.unit || "szt."}</p>
                                                                                    )}
                                                                                    {isStatusDiff && <p className="mt-1 text-[10px] text-red-600 font-bold">Zgłoszono: {item.declaredStatus} ➔ Przyjęto: {item.finalStatus}</p>}
                                                                                    {(!isStatusDiff && item.finalStatus && item.finalStatus !== "sprawne") && (
                                                                                        <p className="mt-1 text-[10px] text-red-600 font-bold uppercase bg-red-100 px-2 py-0.5 rounded">{item.finalStatus}</p>
                                                                                    )}
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                    {hasNotes && (
                                                                        <div className="mt-2 text-xs bg-red-50 text-red-800 p-2 rounded border border-red-100 shadow-sm"><span className="font-bold">Notatka magazynu:</span> {item.warehouseNotes}</div>
                                                                    )}
                                                                </div>
                                                            )
                                                        })}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )
                                })
                            )}
                        </div>
                    </div>
                );
            case "INVENTORY":
                return (
                    <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden animate-fade-in flex flex-col h-[800px] max-h-[85vh]">
                        {/* NAGŁÓWEK */}
                        <div className="bg-slate-800 text-white p-6 flex justify-between items-center shrink-0">
                            <div>
                                <h3 className="font-bold text-xl">Wykaz sprzętu na budowie</h3>
                                <p className="text-slate-400 text-xs mt-1 font-medium">To wszystko masz fizycznie u siebie na placu.</p>
                            </div>
                            <div className="flex gap-2.5">
                                {/* PRZYCISK DRUKOWANIA PDF */}
                                <button
                                    onClick={() => window.print()}
                                    className="bg-blue-600 hover:bg-blue-700 text-white font-black px-4 py-2.5 rounded-xl transition shadow-md text-xs sm:text-sm flex items-center gap-1.5"
                                >
                                    🖨️ {selectedPrintIds.length > 0 ? `Drukuj wybrane (${selectedPrintIds.length})` : "Drukuj wykaz (PDF)"}
                                </button>
                                <button onClick={() => { setActiveView("HUB"); setInventorySearchQuery(""); setInventoryActiveTab("ALL"); setSelectedPrintIds([]); }} className="bg-slate-700 hover:bg-slate-600 text-white font-bold px-4 py-2.5 rounded-xl transition text-xs sm:text-sm">Powrót</button>
                            </div>
                        </div>

                        {/* PASEK Z FILTRAMI (ZAKŁADKI + WYSZUKIWARKA) */}
                        <div className="bg-slate-50 border-b border-slate-200 p-4 flex flex-col sm:flex-row justify-between items-center gap-4 shrink-0">
                            <div className="flex gap-2 bg-white p-1 rounded-xl shadow-sm border border-slate-200 w-full sm:w-auto overflow-x-auto">
                                <button onClick={() => { setInventoryActiveTab("ALL"); setSelectedPrintIds([]); }} className={`px-4 py-2 rounded-lg text-xs font-black transition-all whitespace-nowrap ${inventoryActiveTab === 'ALL' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>WSZYSTKO</button>
                                <button onClick={() => { setInventoryActiveTab("UNIQUE"); setSelectedPrintIds([]); }} className={`px-4 py-2 rounded-lg text-xs font-black transition-all whitespace-nowrap ${inventoryActiveTab === 'UNIQUE' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>NARZĘDZIA</button>
                                <button onClick={() => { setInventoryActiveTab("BULK"); setSelectedPrintIds([]); }} className={`px-4 py-2 rounded-lg text-xs font-black transition-all whitespace-nowrap ${inventoryActiveTab === 'BULK' ? 'bg-orange-600 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>RUSZTOWANIA</button>
                                <button onClick={() => { setInventoryActiveTab("MANUAL"); setSelectedPrintIds([]); }} className={`px-4 py-2 rounded-lg text-xs font-black transition-all whitespace-nowrap ${inventoryActiveTab === 'MANUAL' ? 'bg-slate-600 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>INNE (RĘCZNE)</button>
                            </div>

                            <div className="relative w-full sm:w-72">
                                <span className="absolute inset-y-0 left-3 flex items-center text-slate-400">🔍</span>
                                <input
                                    type="text"
                                    placeholder="Szukaj (nazwa lub nr mag.)..."
                                    value={inventorySearchQuery}
                                    onChange={(e) => { setInventorySearchQuery(e.target.value); setSelectedPrintIds([]); }}
                                    className="w-full pl-10 pr-4 py-2 bg-white border border-slate-300 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 text-sm font-medium shadow-sm transition"
                                />
                                {inventorySearchQuery && (
                                    <button onClick={() => { setInventorySearchQuery(""); setSelectedPrintIds([]); }} className="absolute inset-y-0 right-3 flex items-center text-slate-400 hover:text-red-500 font-bold">&times;</button>
                                )}
                            </div>
                        </div>

                        {/* TABELA Z WYKAZEM */}
                        <div className="flex-1 overflow-auto bg-white relative">
                            <table className="w-full text-left border-collapse relative">
                                <thead className="bg-slate-50 text-xs uppercase font-black text-slate-400 tracking-wider sticky top-0 z-10 shadow-sm border-b">
                                    <tr>
                                        <th className="p-4 pl-6 w-12 text-center">
                                            <input
                                                type="checkbox"
                                                checked={filteredInventoryList.length > 0 && filteredInventoryList.every(item => selectedPrintIds.includes(item.id))}
                                                onChange={(e) => {
                                                    if (e.target.checked) {
                                                        handleSelectAllVisiblePrint();
                                                    } else {
                                                        handleClearPrintSelect();
                                                    }
                                                }}
                                                className="w-4 h-4 cursor-pointer rounded text-blue-600 focus:ring-blue-500 border-slate-300"
                                                title="Zaznacz / odznacz wszystkie widoczne"
                                            />
                                        </th>
                                        <th className="p-4 w-24">Zdjęcie</th>
                                        <th className="p-4">Przedmiot</th>
                                        <th className="p-4 text-center">Nr Mag.</th>
                                        <th className="p-4 text-right pr-6">Ilość na budowie</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 text-sm">
                                    {filteredInventoryList.length === 0 ? (
                                        <tr>
                                            <td colSpan={5} className="p-16 text-center">
                                                <div className="text-4xl mb-3 opacity-30">📦</div>
                                                <p className="text-slate-500 font-medium">Brak wyników w tej kategorii lub dla tego wyszukiwania.</p>
                                            </td>
                                        </tr>
                                    ) : (
                                        filteredInventoryList.map(item => {
                                            const isSelectedForPrint = selectedPrintIds.includes(item.id);
                                            return (
                                                <tr key={item.id} className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 transition ${isSelectedForPrint ? 'bg-blue-50/40' : ''}`}>
                                                    <td className="p-4 pl-6 text-center">
                                                        <input
                                                            type="checkbox"
                                                            checked={isSelectedForPrint}
                                                            onChange={() => handleTogglePrintSelect(item.id)}
                                                            className="w-4 h-4 cursor-pointer rounded text-blue-600 focus:ring-blue-500 border-slate-300"
                                                        />
                                                    </td>
                                                    <td className="p-4">
                                                        <div className="w-12 h-12 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center overflow-hidden">
                                                            {item.imageUrl ? (
                                                                <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />
                                                            ) : (
                                                                <span className="text-xl opacity-30">📷</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className="p-4">
                                                        <p className="font-bold text-slate-800">{item.name}</p>
                                                        {item.subType === "MANUAL" && <span className="inline-block mt-1 text-[9px] bg-slate-200 text-slate-600 px-2 py-0.5 rounded font-black uppercase tracking-wider">Wpis ręczny</span>}

                                                        {/* Wyświetlanie osprzętu na ekranie */}
                                                        {getAccessoriesForItem(item.id).length > 0 && (
                                                            <div className="mt-1.5 pl-3 border-l-2 border-orange-300 text-[10px] text-orange-800 font-semibold space-y-0.5">
                                                                <span className="uppercase text-[9px] text-slate-400 block tracking-wider font-bold">Osprzęt do zwrotu:</span>
                                                                {getAccessoriesForItem(item.id).map((acc: any, accIdx: number) => (
                                                                    <p key={accIdx}>• {acc.name} ({acc.quantity || 1} szt.)</p>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </td>
                                                    <td className="p-4 text-center font-mono text-slate-500 text-sm">
                                                        {item.inventoryNumber || <span className="opacity-50">-</span>}
                                                    </td>
                                                    <td className="p-4 pr-6 text-right">
                                                        <span className={`font-black text-2xl ${item.subType === 'MANUAL' ? 'text-slate-700' : 'text-blue-600'}`}>
                                                            {item.allocations[selectedSiteId]}
                                                        </span>
                                                        <span className="text-xs font-bold text-slate-400 ml-1">{item.unit || "szt."}</span>
                                                    </td>
                                                </tr>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                );
            case "DAMAGES":
                return (
                    <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden animate-fade-in">
                        <div className="bg-red-600 text-white p-6 flex justify-between items-center">
                            <div>
                                <h3 className="font-bold text-xl">Szkody i Straty Budowy</h3>
                                <p className="text-red-200 text-xs mt-1">Lista sprzętu, który zjechał uszkodzony lub zaginął.</p>
                            </div>
                            <button onClick={() => setActiveView("HUB")} className="bg-red-800 hover:bg-red-900 px-4 py-2 rounded-lg font-bold transition">Powrót</button>
                        </div>
                        <div className="p-6">
                            {damages.length === 0 ? (
                                <div className="text-center p-10 text-slate-400 border-2 border-dashed rounded-2xl">
                                    <div className="text-4xl mb-2">🎉</div>
                                    Brak uszkodzonego sprzętu na koncie tej budowy!
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    {damages.map((dmg, idx) => (
                                        <div key={idx} className="flex justify-between items-center p-4 border border-red-200 bg-red-50 rounded-2xl">
                                            <div>
                                                <p className="font-bold text-red-900 text-lg">{dmg.name}</p>
                                                <p className="text-xs text-red-700 font-mono mt-1">Nr Mag: {dmg.inventoryNumber || "Brak"} • Protokół: {dmg.protocolId}</p>
                                                {dmg.warehouseNotes && <p className="text-xs text-red-600 mt-2 bg-red-100 p-2 rounded"><b>Uwagi magazynu:</b> {dmg.warehouseNotes}</p>}
                                            </div>
                                            <div className="text-right">
                                                <p className="text-[10px] uppercase font-black text-red-400 mb-1">Status na magazynie</p>
                                                <span className="bg-red-600 text-white px-3 py-1 rounded-lg text-sm font-bold uppercase">{dmg.finalStatus || dmg.declaredStatus}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                );
            case "CLAIMS":
                return (
                    <div className="animate-fade-in flex flex-col items-center justify-center p-10 bg-gradient-to-br from-purple-50 to-white rounded-3xl border border-purple-100 shadow-inner">
                        <div className="text-6xl mb-6 shadow-lg bg-white w-24 h-24 flex items-center justify-center rounded-full">⚖️</div>
                        <h3 className="text-2xl font-black text-purple-900 mb-2">Wewnętrzny Sąd PESAM</h3>
                        <p className="text-purple-700 text-center max-w-lg mb-8">
                            Centrum Likwidacji Szkód. W tym miejscu kierownicy budów, dyrekcja i prezes będą rozstrzygać, co zrobić ze sprzętem zniszczonym z winy pracowników.
                        </p>
                        <button onClick={() => setActiveView("HUB")} className="bg-purple-900 hover:bg-purple-800 text-white font-bold px-8 py-3 rounded-xl transition shadow-lg">
                            Wróć do Panelu Budowy
                        </button>
                    </div>
                );
            default:
                return (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 animate-fade-in">
                        <div onClick={() => setActiveView("INVENTORY")} className="bg-white hover:bg-green-50 border border-slate-200 p-8 rounded-3xl cursor-pointer transition shadow-sm hover:shadow-md group">
                            <div className="text-4xl mb-4 group-hover:scale-110 transition">🏗️</div>
                            <h3 className="font-black text-slate-800 uppercase text-xs tracking-widest">Wykaz sprzętu</h3>
                            <p className="text-slate-400 text-[11px] mt-1 font-medium">Co aktualnie masz na budowie ({itemsOnSite.length} poz.)</p>
                        </div>
                        <div onClick={() => setActiveView("HISTORY")} className="bg-white hover:bg-blue-50 border border-slate-200 p-8 rounded-3xl cursor-pointer transition shadow-sm hover:shadow-md group">
                            <div className="text-4xl mb-4 group-hover:scale-110 transition">📜</div>
                            <h3 className="font-black text-slate-800 uppercase text-xs tracking-widest">Historia protokołów</h3>
                            <p className="text-slate-400 text-[11px] mt-1 font-medium">Wydania, zwroty, oczekujące</p>
                        </div>
                        <div onClick={() => setActiveView("DAMAGES")} className="bg-white hover:bg-red-50 border border-slate-200 p-8 rounded-3xl cursor-pointer transition shadow-sm hover:shadow-md group relative">
                            {damages.length > 0 && (
                                <div className="absolute top-4 right-4 bg-red-500 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold animate-pulse">{damages.length}</div>
                            )}
                            <div className="text-4xl mb-4 group-hover:scale-110 transition">💥</div>
                            <h3 className="font-black text-slate-800 uppercase text-xs tracking-widest">Szkody / Straty</h3>
                            <p className="text-slate-400 text-[11px] mt-1 font-medium">Sprzęt uszkodzony i utracony</p>
                        </div>
                        <div onClick={() => setActiveView("CLAIMS")} className="bg-white hover:bg-purple-50 border border-slate-200 p-8 rounded-3xl cursor-pointer transition shadow-sm hover:shadow-md group relative">
                            <div className="absolute top-4 right-4 bg-purple-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shadow-md">0</div>
                            <div className="text-4xl mb-4 group-hover:scale-110 transition">⚖️</div>
                            <h3 className="font-black text-slate-800 uppercase text-xs tracking-widest">Likwidacja szkód</h3>
                            <p className="text-slate-400 text-[11px] mt-1 font-medium">Kontakt z Dyrekcją i Szefem</p>
                        </div>
                    </div>
                );
        }
    };

    return (
        <div className="relative">
            {/* --- FORCE LAYOUT RESET DLA WYDRUKU (WYCINA SIDEBAR I HEADER PROJEKTU) --- */}
            <style dangerouslySetInnerHTML={{
                __html: `
                @media print {
                    /* Bezwzględne ukrycie menu bocznego, nagłówków i pasków nawigacji */
                    aside, nav, header, 
                    [id*="sidebar"], [class*="sidebar"], [class*="Sidebar"], 
                    [class*="menu"], [class*="navbar"], [class*="Header"],
                    button, .print\\:hidden {
                        display: none !important;
                        width: 0 !important;
                        height: 0 !important;
                        overflow: hidden !important;
                        opacity: 0 !important;
                    }
                    /* Rozciągnięcie kontenera głównego na pełną szerokość kartki A4 */
                    body, html, main, 
                    div[class*="content"], 
                    div[class*="wrapper"], 
                    div[class*="container"],
                    div[class*="layout"] {
                        margin: 0 !important;
                        padding: 0 !important;
                        width: 100% !important;
                        max-width: 100% !important;
                        min-width: 100% !important;
                        left: 0 !important;
                        right: 0 !important;
                        position: relative !important;
                        display: block !important;
                    }
                }
            `}} />

            {/* --- WIDOK EKRANOWY (UKRYTY NA WYDRUKU) --- */}
            <div className="p-6 md:p-10 max-w-7xl mx-auto min-h-screen print:hidden">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                    <div>
                        <h1 className="text-3xl font-black text-slate-800 tracking-tighter">Twoja Budowa</h1>
                        <p className="text-slate-500 text-sm">Centrum operacyjne dla kierownika budowy</p>
                    </div>

                    {mySites.length > 0 && (
                        <select
                            value={selectedSiteId}
                            onChange={(e) => { setSelectedSiteId(e.target.value); setActiveView("HUB"); setSelectedPrintIds([]); }}
                            className="p-3 bg-white border border-slate-300 rounded-xl font-bold text-blue-700 shadow-sm outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer transition hover:bg-slate-50"
                        >
                            {mySites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    )}
                </div>

                {!selectedSiteId ? (
                    <div className="bg-white border border-dashed border-slate-300 h-64 flex flex-col items-center justify-center rounded-3xl text-slate-500 shadow-sm">
                        <div className="text-4xl mb-3 opacity-50">🏗️</div>
                        <span className="font-bold">Nie przypisano Cię do żadnej budowy.</span>
                        <span className="text-sm mt-1">Skontaktuj się z administratorem.</span>
                    </div>
                ) : (
                    <>
                        <div className="bg-slate-900 text-white p-8 rounded-3xl mb-8 relative overflow-hidden shadow-xl transition-all">
                            <div className="relative z-10 flex justify-between items-end">
                                <div>
                                    <p className="text-blue-400 text-[10px] font-black uppercase tracking-[0.2em] mb-2">Panel Zarządzania</p>
                                    <h2 className="text-4xl font-black mb-1">{mySites.find(s => s.id === selectedSiteId)?.name}</h2>
                                    <p className="text-slate-400 text-sm font-medium">📍 {mySites.find(s => s.id === selectedSiteId)?.location || "Lokalizacja nieznana"}</p>
                                </div>
                                <div className="text-right hidden md:block">
                                    <p className="text-slate-400 text-xs font-bold uppercase mb-1">Status Budowy</p>
                                    <div className="bg-green-500/20 text-green-400 border border-green-500/30 px-3 py-1 rounded-lg text-sm font-black flex items-center gap-2">
                                        <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></div>
                                        AKTYWNA
                                    </div>
                                </div>
                            </div>
                            <div className="absolute right-[-5%] top-[-30%] text-[12rem] opacity-5 select-none pointer-events-none transform -rotate-12">🏗️</div>
                        </div>

                        {renderContent()}
                    </>
                )}
            </div>

            {/* --- DEDYKOWANY ARKUSZ WYDRUKU (WIDOCZNY TYLKO NA PODGLĄDZIE DRUKU / PDF) --- */}
            {selectedSiteId && (
                <div className="hidden print:block p-8 bg-white text-black font-sans leading-tight">
                    {/* Nagłówek raportu */}
                    <div className="border-b-4 border-slate-900 pb-4 mb-6 flex justify-between items-end">
                        <div>
                            <h1 className="text-2xl font-black uppercase tracking-wider text-slate-900">Arkusz Inwentaryzacyjny Sprzętu</h1>
                            <p className="text-md font-extrabold text-slate-800 mt-1">Budowa: {mySites.find(s => s.id === selectedSiteId)?.name}</p>
                            <p className="text-xs text-slate-500 mt-0.5">📍 {mySites.find(s => s.id === selectedSiteId)?.location || "Adres nieznany"}</p>
                        </div>
                        <div className="text-right">
                            <p className="text-sm font-bold text-slate-900">Data spisu: {new Date().toLocaleDateString("pl-PL")}</p>
                            <p className="text-xs text-slate-400">System Zarządzania Magazynem PESAM</p>
                        </div>
                    </div>

                    {/* Tabela do fizycznej inwentaryzacji */}
                    <table className="w-full text-left border-collapse border-2 border-slate-800">
                        <thead>
                            <tr className="bg-slate-100 text-slate-900 text-xs font-black uppercase border-b-2 border-slate-800">
                                <th className="p-3 border border-slate-400 w-16 text-center">Zdj.</th>
                                <th className="p-3 border border-slate-400">Przedmiot / Nazwa sprzętu</th>
                                <th className="p-3 border border-slate-400 text-center w-36">Nr Magazynowy</th>
                                <th className="p-3 border border-slate-400 text-center w-28">Ilość systemowa</th>
                                <th className="p-3 border border-slate-400 text-center w-32">[ ✓ ] Stan fizyczny</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-300 text-sm">
                            {itemsToPrint.map((item, idx) => (
                                <tr key={item.id} className="border-b border-slate-300">
                                    <td className="p-2 border border-slate-300 text-center">
                                        <div className="w-10 h-10 mx-auto rounded border border-slate-300 flex items-center justify-center overflow-hidden bg-slate-50">
                                            {item.imageUrl ? (
                                                <img src={item.imageUrl} alt="" className="object-cover w-full h-full" />
                                            ) : (
                                                <span className="text-slate-300 text-[9px] uppercase font-bold">brak</span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="p-3 border border-slate-300 font-bold text-slate-900">
                                        {item.name}
                                        {item.subType === "MANUAL" && <span className="ml-2 text-[9px] border border-slate-300 px-1.5 py-0.5 rounded text-slate-500 uppercase font-black bg-slate-100">Ręczny</span>}

                                        {/* Wyświetlanie osprzętu na wydruku PDF */}
                                        {getAccessoriesForItem(item.id).length > 0 && (
                                            <div className="mt-1 pl-3 border-l-2 border-orange-400 text-[10px] text-orange-900 font-bold leading-normal">
                                                <span className="uppercase text-[8px] text-slate-400 block font-black">Osprzęt:</span>
                                                {getAccessoriesForItem(item.id).map((acc: any, accIdx: number) => (
                                                    <p key={accIdx} className="font-medium">• {acc.name} ({acc.quantity || 1} szt.)</p>
                                                ))}
                                            </div>
                                        )}
                                    </td>
                                    <td className="p-3 border border-slate-300 text-center font-mono text-xs text-slate-700">
                                        {item.inventoryNumber || "-"}
                                    </td>
                                    <td className="p-3 border border-slate-300 text-center font-black text-slate-900 text-base">
                                        {item.allocations[selectedSiteId]} <span className="text-xs font-normal text-slate-500">{item.unit || "szt."}</span>
                                    </td>
                                    <td className="p-3 border border-slate-300 text-center">
                                        {/* Puste pole (checkbox) do fizycznego odhaczenia ołówkiem */}
                                        <div className="w-5 h-5 border-2 border-slate-500 rounded mx-auto"></div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    {/* Sekcja podpisów na dole arkusza */}
                    <div className="mt-16 pt-8 border-t border-dashed border-slate-400 grid grid-cols-2 gap-16 text-xs text-slate-500">
                        <div>
                            <p className="border-b border-slate-400 pb-10"></p>
                            <p className="mt-2 text-center font-bold text-slate-700">Podpis osoby kontrolującej stan placu</p>
                        </div>
                        <div>
                            <p className="border-b border-slate-400 pb-10"></p>
                            <p className="mt-2 text-center font-bold text-slate-700">Podpis Kierownika Budowy</p>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function MySitePage() {
    return (
        <Suspense fallback={<div className="p-10 text-center animate-pulse text-slate-500">Wczytywanie budowy...</div>}>
            <MySiteHubContent />
        </Suspense>
    );
}