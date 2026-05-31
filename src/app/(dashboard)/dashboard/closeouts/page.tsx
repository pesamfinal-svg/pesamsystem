"use client";

import React, { useState, useEffect } from "react";
import { collection, getDocs, doc, setDoc, query, where, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";

interface Site { id: string; name: string; status?: string; location?: string; }
interface InventoryItem {
    id: string; name: string; type: string; subType?: string;
    category: string; inventoryNumber: string; allocations: Record<string, number>;
    status: string; unit?: string; failureDescription?: string;
}
interface Claim { id: string; siteId: string; inventoryName: string; status: string; penaltyAmount?: number; }
interface Protocol { id: string; protocolId: string; type: string; createdAt: string; createdByName?: string; items?: any[]; }
interface UserAccount { uid: string; firstName: string; lastName: string; email: string; assignedSites: string[]; }

type TabType = "TOOLS" | "SCAFFOLDING" | "OTHER" | "CLAIMS" | "DETECTIVE" | "HISTORY";

export default function ProjectCloseoutsPage() {
    const { user } = useAuth();
    const [sites, setSites] = useState<Site[]>([]);
    const [users, setUsers] = useState<UserAccount[]>([]);
    const [loading, setLoading] = useState(true);

    const [selectedSite, setSelectedSite] = useState<Site | null>(null);
    const [selectedManagerUid, setSelectedManagerUid] = useState("");
    const [activeTab, setActiveTab] = useState<TabType>("TOOLS");
    const [auditLoading, setAuditLoading] = useState(false);

    // Dane audytowe
    const [toolsItems, setToolsItems] = useState<InventoryItem[]>([]);
    const [scaffoldingItems, setScaffoldingItems] = useState<InventoryItem[]>([]);
    const [otherItems, setOtherItems] = useState<InventoryItem[]>([]);
    const [siteClaims, setSiteClaims] = useState<Claim[]>([]);
    const [suspiciousItems, setSuspiciousItems] = useState<any[]>([]);
    const [siteProtocols, setSiteProtocols] = useState<Protocol[]>([]);

    // Nowy stan przechowujący decyzje (LOSS lub CONSUMED) dla każdego przedmiotu masowego (id -> decyzja)
    const [resolutions, setResolutions] = useState<Record<string, "LOSS" | "CONSUMED">>({});

    const [isProcessing, setIsProcessing] = useState(false);

    useEffect(() => {
        fetchSitesAndUsers();
    }, []);

    const fetchSitesAndUsers = async () => {
        setLoading(true);
        try {
            const sitesSnap = await getDocs(collection(db, "sites"));
            const allSites = sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[];
            setSites(allSites.filter(s => s.status !== "ZAKOŃCZONA" && s.status !== "W_TRAKCIE_ROZLICZENIA" && s.location !== "Wpis ręczny"));

            const usersSnap = await getDocs(collection(db, "users"));
            const allUsers = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() })) as UserAccount[];
            setUsers(allUsers);
        } catch (error) {
            console.error("Błąd pobierania budów/kierowników:", error);
        } finally {
            setLoading(false);
        }
    };

    const runAudit = async (site: Site) => {
        setSelectedSite(site);
        setAuditLoading(true);
        setActiveTab("TOOLS");

        setToolsItems([]);
        setScaffoldingItems([]);
        setOtherItems([]);
        setSiteClaims([]);
        setSuspiciousItems([]);
        setSiteProtocols([]);
        setResolutions({}); // Czyszczenie starych decyzji

        // Autopodpowiedź kierownika
        const assignedManager = users.find(u => u.assignedSites?.includes(site.id) || u.assignedSites?.includes("ALL"));
        setSelectedManagerUid(assignedManager ? assignedManager.uid : "");

        try {
            const invSnap = await getDocs(collection(db, "inventory"));
            const allInventory = invSnap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[];
            const activeOnSite = allInventory.filter(item => item.allocations && item.allocations[site.id] > 0);

            setToolsItems(activeOnSite.filter(item => item.type === "UNIQUE"));
            setScaffoldingItems(activeOnSite.filter(item => item.type === "BULK" && item.subType !== "MANUAL" && item.category !== "Zaległości osprzętu"));
            setOtherItems(activeOnSite.filter(item => item.subType === "MANUAL" || item.category === "Zaległości osprzętu" || item.inventoryNumber === "OSPRZĘT"));

            // Sprawy sądowe
            const claimsQ = query(collection(db, "claims"), where("siteId", "==", site.id));
            const claimsSnap = await getDocs(claimsQ);
            setSiteClaims(claimsSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Claim[]);

            // Detektyw
            const protoQ = query(collection(db, "protocols"), where("sourceId", "==", site.id), where("type", "==", "ZWROT"));
            const protoSnap = await getDocs(protoQ);
            const returnedItemsIds = new Set<string>();

            protoSnap.docs.forEach(doc => {
                const data = doc.data();
                data.items?.forEach((item: any) => {
                    if (item.inventoryId && item.type === "UNIQUE") returnedItemsIds.add(item.inventoryId);
                });
            });

            const suspicious = allInventory.filter(item =>
                returnedItemsIds.has(item.id) &&
                (item.status === "uszkodzone" || item.status === "do przeglądu") &&
                (!item.allocations?.[site.id] || item.allocations?.[site.id] === 0)
            );

            const suspiciousWithDescriptions = [];
            for (const item of suspicious) {
                const historySnap = await getDocs(collection(db, "inventory", item.id, "history"));
                let failureText = "Brak szczegółowego opisu usterki w historii urządzenia.";

                if (!historySnap.empty) {
                    const sortedHistory = historySnap.docs
                        .map(d => d.data())
                        .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

                    const firstIncident = sortedHistory.find(h => h.type === "ZWROT" || h.type === "SERWIS" || h.status === "uszkodzone");
                    if (firstIncident) {
                        failureText = firstIncident.description || failureText;
                    }
                }

                suspiciousWithDescriptions.push({ ...item, failureDescription: failureText });
            }
            setSuspiciousItems(suspiciousWithDescriptions);

            // Historia protokołów
            const qIn = query(collection(db, "protocols"), where("destinationId", "==", site.id));
            const qOut = query(collection(db, "protocols"), where("sourceId", "==", site.id));
            const [snapIn, snapOut] = await Promise.all([getDocs(qIn), getDocs(qOut)]);
            const combined = [
                ...snapIn.docs.map(d => ({ id: d.id, ...d.data() })),
                ...snapOut.docs.map(d => ({ id: d.id, ...d.data() }))
            ] as Protocol[];
            combined.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
            setSiteProtocols(combined);

        } catch (error) {
            console.error("Błąd audytu:", error);
        } finally {
            setAuditLoading(false);
        }
    };

    const handleInitiateCloseout = async () => {
        if (!selectedSite || !user) return;
        if (!selectedManagerUid) return alert("Wybierz kierownika budowy odpowiedzialnego za rozliczenie!");
        setIsProcessing(true);

        try {
            const closeoutRef = doc(db, "closeouts", selectedSite.id);
            const chosenManager = users.find(u => u.uid === selectedManagerUid);

            // Mapowanie z uwzględnieniem podjętych decyzji (LOSS / CONSUMED)
            const debts = [...toolsItems, ...scaffoldingItems, ...otherItems].map(i => ({
                id: i.id, name: i.name, type: i.type, inventoryNumber: i.inventoryNumber || "-",
                quantity: i.allocations[selectedSite.id] || 0, unit: i.unit || "szt.",
                resolution: i.type === "UNIQUE" ? "LOSS" : (resolutions[i.id] || "LOSS") // Narzędzia UNIQUE to zawsze LOSS
            }));

            // Utwórz szkic rozliczenia
            await setDoc(closeoutRef, {
                siteId: selectedSite.id,
                siteName: selectedSite.name,
                status: "OCZEKUJE_NA_KIEROWNIKA",
                initiatedBy: user.uid,
                initiatedByName: `${user.firstName} ${user.lastName}`,
                initiatedAt: new Date().toISOString(),
                managerUid: chosenManager?.uid || "",
                managerName: chosenManager ? `${chosenManager.firstName} ${chosenManager.lastName}` : "Brak",
                managerEmail: chosenManager?.email || "",
                debtsList: debts,
                claimsList: siteClaims,
                detectiveList: suspiciousItems.map(i => ({ id: i.id, name: i.name, inventoryNumber: i.inventoryNumber, failureDescription: i.failureDescription })),
                managerSignedAt: null,
                directorSignedAt: null
            });

            // Blokuj budowę
            await updateDoc(doc(db, "sites", selectedSite.id), { status: "W_TRAKCIE_ROZLICZENIA" });

            // WYŚLIJ PIERWSZE POWIADOMIENIE DO KIEROWNIKA
            try {
                const response = await fetch("/api/closeout-email", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        type: "CLOSEOUT_INITIATED",
                        siteName: selectedSite.name,
                        managerName: chosenManager ? `${chosenManager.firstName} ${chosenManager.lastName}` : "Brak",
                        managerEmail: chosenManager?.email || "",
                        warehousemanName: `${user.firstName} ${user.lastName}`,
                        debtsList: debts,
                        detectiveList: suspiciousItems.map(i => ({ id: i.id, name: i.name, inventoryNumber: i.inventoryNumber, failureDescription: i.failureDescription }))
                    })
                });

                const result = await response.json();
                if (!response.ok || !result.success) {
                    console.error("Błąd API mailera:", result);
                    alert(`⚠️ ROZLICZENIE ZAPISANE, ALE BŁĄD WYSYŁKI E-MAILA!\n\nPowód błędu serwera: ${result.error || "Nieznany błąd poczty"}`);
                } else {
                    alert("✅ Obieg akceptacji utworzony i e-mail z powiadomieniem wysłany do kierownika!");
                }
            } catch (e) {
                console.error("Krytyczny błąd połączenia z API mailera:", e);
                alert("⚠️ Rozliczenie zostało zapisane w bazie, ale wystąpił błąd komunikacji z serwerem poczty. Mail nie wyszedł.");
            }
            setSelectedSite(null);
            fetchSitesAndUsers();
        } catch (error) {
            alert("Błąd inicjowania: " + error);
        } finally {
            setIsProcessing(false);
        }
    };

    if (loading) return <div className="p-10 text-center animate-pulse">Ładowanie modułu audytów...</div>;

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto animate-fade-in font-sans">
            <h1 className="text-3xl font-black text-slate-800 tracking-tight mb-1">Rozliczenia Projektów</h1>
            <p className="text-slate-500 text-sm mb-8">Inicjowanie audytów i przesyłanie spraw do podpisu Kierownikom.</p>

            <div className="flex flex-col md:flex-row gap-6">
                {/* LEWA KOLUMNA */}
                <div className="w-full md:w-1/3 space-y-3">
                    <div className="bg-slate-900 text-white p-4 rounded-xl shadow-md">
                        <h3 className="font-black text-xs uppercase tracking-wider">Rozpocznij nowy audyt</h3>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-3 h-[60vh] overflow-y-auto space-y-2 shadow-sm">
                        {sites.length === 0 ? <p className="text-slate-400 text-xs p-4 text-center">Brak aktywnych budów.</p> : sites.map(site => (
                            <button
                                key={site.id}
                                onClick={() => runAudit(site)}
                                className={`w-full text-left p-4 rounded-lg border transition ${selectedSite?.id === site.id ? 'bg-blue-600 border-blue-600 text-white shadow-md' : 'bg-white border-slate-100 hover:border-blue-200 hover:bg-slate-50'}`}
                            >
                                <p className={`font-bold text-sm ${selectedSite?.id === site.id ? 'text-white' : 'text-slate-800'}`}>{site.name}</p>
                                <p className={`text-[10px] uppercase mt-1 font-semibold ${selectedSite?.id === site.id ? 'text-blue-200' : 'text-slate-500'}`}>📍 {site.location || "Brak lokalizacji"}</p>
                            </button>
                        ))}
                    </div>
                </div>

                {/* PRAWA KOLUMNA */}
                <div className="w-full md:w-2/3">
                    {!selectedSite ? (
                        <div className="h-full flex flex-col items-center justify-center bg-slate-50 border-2 border-dashed border-slate-200 rounded-2xl p-12 text-slate-400">
                            <span className="text-5xl mb-4">📊</span>
                            <p className="font-black text-slate-700 text-center">Wybierz budowę z listy po lewej stronie, aby otworzyć system audytora.</p>
                        </div>
                    ) : auditLoading ? (
                        <div className="h-full flex flex-col items-center justify-center bg-white border border-slate-200 rounded-2xl p-12 animate-pulse text-slate-500">
                            <span className="text-3xl animate-spin mb-3">⚙️</span>
                            Pobieranie i szczegółowa analiza ubytków projektu...
                        </div>
                    ) : (
                        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col max-h-[85vh]">

                            <div className="p-6 bg-slate-900 border-b border-slate-800 flex justify-between items-center text-white">
                                <div>
                                    <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest">Generowanie szkicu rozliczenia</p>
                                    <h2 className="text-xl font-black">{selectedSite.name}</h2>
                                </div>
                                <span className="bg-blue-600 text-white font-black px-3.5 py-1.5 rounded-lg text-xs uppercase tracking-wider">Audytor PESAM</span>
                            </div>

                            <div className="bg-slate-100 p-2.5 border-b border-slate-200 flex flex-wrap gap-2">
                                <button onClick={() => setActiveTab("TOOLS")} className={`px-4 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "TOOLS" ? "bg-blue-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                    🛠️ Narzędzia <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "TOOLS" ? "bg-white text-blue-600" : "bg-slate-100 text-slate-600"}`}>{toolsItems.length}</span>
                                </button>
                                <button onClick={() => setActiveTab("SCAFFOLDING")} className={`px-4 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "SCAFFOLDING" ? "bg-blue-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                    🏗️ Rusztowania <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "SCAFFOLDING" ? "bg-white text-blue-600" : "bg-slate-100 text-slate-600"}`}>{scaffoldingItems.length}</span>
                                </button>
                                <button onClick={() => setActiveTab("OTHER")} className={`px-4 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "OTHER" ? "bg-blue-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                    ⚙️ Osprzęt i Inne <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "OTHER" ? "bg-white text-blue-600" : "bg-slate-100 text-slate-600"}`}>{otherItems.length}</span>
                                </button>
                                <button onClick={() => setActiveTab("CLAIMS")} className={`px-4 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "CLAIMS" ? "bg-blue-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                    ⚖️ Sąd PESAM <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "CLAIMS" ? "bg-white text-blue-600" : "bg-slate-100 text-slate-600"}`}>{siteClaims.length}</span>
                                </button>
                                <button onClick={() => setActiveTab("DETECTIVE")} className={`px-4 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "DETECTIVE" ? "bg-blue-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                    🕵️ Detektyw <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "DETECTIVE" ? "bg-white text-blue-600" : "bg-slate-100 text-slate-600"}`}>{suspiciousItems.length}</span>
                                </button>
                                <button onClick={() => setActiveTab("HISTORY")} className={`px-4 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "HISTORY" ? "bg-blue-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                    📋 Protokoły <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "HISTORY" ? "bg-white text-blue-600" : "bg-slate-100 text-slate-600"}`}>{siteProtocols.length}</span>
                                </button>
                            </div>

                            <div className="flex-1 overflow-y-auto p-6 bg-slate-50">
                                {activeTab === "TOOLS" && (
                                    <div className="space-y-3">
                                        <div className="border-b pb-2 mb-2"><h4 className="font-black text-sm text-slate-800">Narzędzia unikalne (UNIQUE) aktualnie na budowie:</h4></div>
                                        {toolsItems.length === 0 ? (
                                            <div className="p-6 bg-green-50 text-green-800 border border-green-200 rounded-xl font-bold flex items-center gap-2 text-sm"><span>✅</span> Brak zalegających narzędzi na placu budowy.</div>
                                        ) : (
                                            <div className="space-y-2">
                                                {toolsItems.map(item => (
                                                    <div key={item.id} className="flex justify-between items-center p-3 bg-white border rounded-xl shadow-sm text-sm">
                                                        <div><p className="font-bold text-slate-800">{item.name}</p><p className="text-[10px] text-slate-500 font-mono">Nr: {item.inventoryNumber}</p></div>
                                                        <span className="bg-red-50 text-red-700 border border-red-200 text-xs font-black px-3 py-1 rounded-lg">1 szt.</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {activeTab === "SCAFFOLDING" && (
                                    <div className="space-y-3">
                                        <div className="border-b pb-2 mb-2"><h4 className="font-black text-sm text-slate-800">Elementy masowe (BULK) rusztowań / szalunków:</h4></div>
                                        {scaffoldingItems.length === 0 ? (
                                            <div className="p-6 bg-green-50 text-green-800 border border-green-200 rounded-xl font-bold flex items-center gap-2 text-sm"><span>✅</span> Brak zalegających rusztowań/szalunków.</div>
                                        ) : (
                                            <div className="space-y-2">
                                                {scaffoldingItems.map(item => (
                                                    <div key={item.id} className="flex justify-between items-center p-3 bg-white border rounded-xl shadow-sm text-sm">
                                                        <span className="font-bold text-slate-700">{item.name}</span>
                                                        <div className="flex items-center gap-3">
                                                            <select
                                                                value={resolutions[item.id] || "LOSS"}
                                                                onChange={e => setResolutions({ ...resolutions, [item.id]: e.target.value as "LOSS" | "CONSUMED" })}
                                                                className="p-1 text-xs font-bold border rounded bg-white outline-none text-slate-700 cursor-pointer"
                                                            >
                                                                <option value="LOSS">❌ Strata / Dług</option>
                                                                <option value="CONSUMED">🧼 Zużycie normalne</option>
                                                            </select>
                                                            <span className="bg-red-50 text-red-700 border border-red-200 text-xs font-black px-3 py-1 rounded-lg">{item.allocations[selectedSite.id]} {item.unit || "szt."}</span>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {activeTab === "OTHER" && (
                                    <div className="space-y-3">
                                        <div className="border-b pb-2 mb-2"><h4 className="font-black text-sm text-slate-800">Zaległe brakujące elementy, osprzęt oraz wpisy z palca:</h4></div>
                                        {otherItems.length === 0 ? (
                                            <div className="p-6 bg-green-50 text-green-800 border border-green-200 rounded-xl font-bold flex items-center gap-2 text-sm"><span>✅</span> Brak zaległego osprzętu czy ubytków.</div>
                                        ) : (
                                            <div className="space-y-2">
                                                {otherItems.map(item => (
                                                    <div key={item.id} className="flex justify-between items-center p-3 bg-white border rounded-xl shadow-sm text-sm">
                                                        <div><p className="font-bold text-slate-800">{item.name}</p><p className="text-[10px] text-slate-400 font-bold uppercase">{item.category}</p></div>
                                                        <div className="flex items-center gap-3">
                                                            <select
                                                                value={resolutions[item.id] || "LOSS"}
                                                                onChange={e => setResolutions({ ...resolutions, [item.id]: e.target.value as "LOSS" | "CONSUMED" })}
                                                                className="p-1 text-xs font-bold border rounded bg-white outline-none text-slate-700 cursor-pointer"
                                                            >
                                                                <option value="LOSS">❌ Strata / Dług</option>
                                                                <option value="CONSUMED">🧼 Zużycie normalne</option>
                                                            </select>
                                                            <span className="bg-red-50 text-red-700 border border-red-200 text-xs font-black px-3 py-1 rounded-lg">{item.allocations[selectedSite.id]} {item.unit || "szt."}</span>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {activeTab === "CLAIMS" && (
                                    <div className="space-y-3">
                                        <div className="border-b pb-2 mb-2"><h4 className="font-black text-sm text-slate-800">Sprawy prowadzone przez Sąd PESAM (CLS):</h4></div>
                                        {siteClaims.length === 0 ? (
                                            <p className="text-sm text-slate-500 italic p-4 text-center">Brak spraw szkodowych przypisanych do tego projektu.</p>
                                        ) : (
                                            <div className="space-y-2">
                                                {siteClaims.map(claim => (
                                                    <div key={claim.id} className="flex justify-between items-center p-3 bg-white border rounded-xl shadow-sm text-sm">
                                                        <span className="font-semibold text-slate-800">{claim.inventoryName}</span>
                                                        <span className={`text-[10px] font-black px-2.5 py-1 rounded uppercase ${claim.status === "ZAMKNIETA" ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-800'}`}>
                                                            {claim.status} {claim.penaltyAmount ? `— Kara: ${claim.penaltyAmount} zł` : ""}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {activeTab === "DETECTIVE" && (
                                    <div className="space-y-3">
                                        <div className="border-b pb-2 mb-2"><h4 className="font-black text-sm text-slate-800">Ujawnione uszkodzenia urządzeń po powrocie z budowy:</h4></div>
                                        {suspiciousItems.length === 0 ? (
                                            <p className="text-sm text-slate-500 italic p-4 text-center">Brak urządzeń, które uległy awarii bezpośrednio po zwrocie z tej budowy.</p>
                                        ) : (
                                            <div className="space-y-3">
                                                {suspiciousItems.map(item => (
                                                    <div key={item.id} className="p-3 bg-orange-50 border border-orange-200 rounded-xl shadow-sm text-sm space-y-2.5">
                                                        <div className="flex justify-between items-center">
                                                            <div>
                                                                <p className="font-bold text-slate-800">{item.name}</p>
                                                                <p className="text-[10px] text-slate-500 font-mono">Nr Mag: {item.inventoryNumber}</p>
                                                            </div>
                                                            <span className="text-[10px] font-black text-orange-800 bg-orange-100 px-2.5 py-1 rounded-lg uppercase">Status w bazie: {item.status}</span>
                                                        </div>
                                                        <div className="p-3 bg-white border border-orange-100 rounded-lg text-xs leading-relaxed italic text-slate-600 shadow-inner">
                                                            <b>Opis zdarzenia / usterki z bazy:</b> {item.failureDescription}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {activeTab === "HISTORY" && (
                                    <div className="space-y-3">
                                        <div className="border-b pb-2 mb-2"><h4 className="font-black text-sm text-slate-800">Historia wydań, zwrotów i dostaw powiązanych z budową:</h4></div>
                                        {siteProtocols.length === 0 ? (
                                            <p className="text-sm text-slate-500 italic p-4 text-center">Brak zarejestrowanych protokołów.</p>
                                        ) : (
                                            <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                                                {siteProtocols.map(proto => (
                                                    <div key={proto.id} className="p-3 bg-white border rounded-xl shadow-sm text-xs flex justify-between items-center hover:border-blue-400 transition">
                                                        <div>
                                                            <p className="font-black text-slate-800">{proto.protocolId}</p>
                                                            <p className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">{proto.type} — {proto.createdAt.split('T')[0]}</p>
                                                        </div>
                                                        <span className="text-slate-500 font-medium">{proto.createdByName || "System"}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* DYNAMICZNY WYBÓR KIEROWNIKA BUDOWY I INICJOWANIE */}
                            <div className="p-5 border-t bg-slate-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                                <div className="flex items-center gap-2 w-full sm:w-auto">
                                    <span className="text-xs font-black text-slate-600 uppercase whitespace-nowrap">Odp. Kierownik:</span>
                                    <select
                                        value={selectedManagerUid}
                                        onChange={e => setSelectedManagerUid(e.target.value)}
                                        className="p-2 bg-white border border-slate-300 rounded-lg text-xs font-bold text-slate-700 outline-none cursor-pointer w-full sm:w-60"
                                    >
                                        <option value="">-- Wybierz Kierownika Budowy --</option>
                                        {users.filter(u => u.uid).map(u => (
                                            <option key={u.uid} value={u.uid}>{u.firstName} {u.lastName} ({u.email})</option>
                                        ))}
                                    </select>
                                </div>
                                <button
                                    onClick={handleInitiateCloseout}
                                    disabled={isProcessing || !selectedManagerUid}
                                    className="bg-red-600 hover:bg-red-700 text-white font-black px-6 py-3 rounded-xl shadow-lg transition disabled:bg-slate-400 flex items-center gap-2 text-sm uppercase tracking-wide w-full sm:w-auto justify-center"
                                >
                                    {isProcessing ? "Inicjowanie..." : "Zatwierdź Audyt i wyślij do podpisu ✍️"}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}