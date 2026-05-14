"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, query, orderBy, where } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";

// --- INTERFEJSY ---
interface InventoryItem {
    id: string; name: string; inventoryNumber: string;
    imageUrl: string; allocations: Record<string, number>;
}
interface Site { id: string; name: string; location: string; }
interface Protocol {
    protocolId: string; type: string; createdAt: string;
    status: string; createdByName: string; items: any[];
    sourceId?: string; destinationId?: string;
}

export default function MySiteHub() {
    const { user } = useAuth();
    const [mySites, setMySites] = useState<Site[]>([]);
    const [selectedSiteId, setSelectedSiteId] = useState("");
    const [loading, setLoading] = useState(true);

    // Nawigacja wewnątrz hub-a
    const [activeView, setActiveView] = useState<"HUB" | "INVENTORY" | "HISTORY" | "DAMAGES" | "CLAIMS">("HUB");

    // Dane dla modułów
    const [itemsOnSite, setItemsOnSite] = useState<InventoryItem[]>([]);
    const [siteProtocols, setSiteProtocols] = useState<Protocol[]>([]);
    const [damages, setDamages] = useState<any[]>([]);

    useEffect(() => {
        const fetchInitialData = async () => {
            setLoading(true);
            try {
                const sitesSnap = await getDocs(query(collection(db, "sites"), orderBy("name", "asc")));
                const allSites = sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[];
                const userAssigned = user?.assignedSites || [];

                // Jeśli "ALL", pokazujemy wszystkie. Jeśli nie, tylko przypisane.
                const filteredSites = allSites.filter(s => userAssigned.includes("ALL") || userAssigned.includes(s.id));
                setMySites(filteredSites);
                if (filteredSites.length === 1) setSelectedSiteId(filteredSites[0].id);
            } catch (error) { console.error(error); } finally { setLoading(false); }
        };
        if (user) fetchInitialData();
    }, [user]);

    // Pobieranie danych po wybraniu budowy
    useEffect(() => {
        const fetchDataForSite = async () => {
            if (!selectedSiteId) return;

            // 1. Pobierz sprzęt (dla INVENTORY i HUB)
            const invSnap = await getDocs(collection(db, "inventory"));
            const allItems = invSnap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[];
            setItemsOnSite(allItems.filter(item => item.allocations && item.allocations[selectedSiteId] > 0));

            // 2. Pobierz protokoły dla tej budowy
            const protoSnap = await getDocs(query(collection(db, "protocols"), where("destinationId", "==", selectedSiteId)));
            const protoSourceSnap = await getDocs(query(collection(db, "protocols"), where("sourceId", "==", selectedSiteId)));

            const combinedProtos = [
                ...protoSnap.docs.map(d => d.data() as Protocol),
                ...protoSourceSnap.docs.map(d => d.data() as Protocol)
            ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

            setSiteProtocols(combinedProtos);

            // 3. Wyodrębnij szkody (Z protokołów ZWROTU, gdzie sprzęt oznaczono jako uszkodzony)
            const damagesList: any[] = [];
            combinedProtos.forEach(p => {
                if (p.type === "ZWROT" && p.sourceId === selectedSiteId) {
                    p.items.forEach(item => {
                        // Bierzemy pod uwagę to co ocenił magazynier (finalStatus) lub to co zgłosił kierownik (declaredStatus)
                        if (item.finalStatus === "uszkodzone" || item.declaredStatus === "uszkodzone") {
                            damagesList.push({
                                protocolId: p.protocolId,
                                date: p.createdAt,
                                status: p.status, // ZAAKCEPTOWANY czy OCZEKUJACY
                                ...item
                            });
                        }
                    });
                }
            });
            setDamages(damagesList);
        };
        fetchDataForSite();
    }, [selectedSiteId]);

    if (loading && mySites.length === 0) return <div className="p-10 text-center text-slate-500 animate-pulse">Analizowanie przypisanych budów...</div>;

    // --- RENDERER WIDOKÓW ---
    const renderContent = () => {
        switch (activeView) {
            case "INVENTORY":
                return (
                    <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden animate-fade-in">
                        <div className="bg-slate-800 text-white p-6 flex justify-between items-center">
                            <div>
                                <h3 className="font-bold text-xl">Wykaz sprzętu na budowie</h3>
                                <p className="text-slate-400 text-xs mt-1">To wszystko masz fizycznie u siebie na placu.</p>
                            </div>
                            <button onClick={() => setActiveView("HUB")} className="bg-slate-700 hover:bg-slate-600 text-white font-bold px-4 py-2 rounded-lg transition">Powrót</button>
                        </div>
                        <table className="w-full text-left border-collapse">
                            <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase font-black text-slate-400 tracking-wider">
                                <tr>
                                    <th className="p-4 pl-6">Zdjęcie</th>
                                    <th className="p-4">Przedmiot</th>
                                    <th className="p-4 text-center">Nr Mag.</th>
                                    <th className="p-4 text-right pr-6">Ilość na budowie</th>
                                </tr>
                            </thead>
                            <tbody>
                                {itemsOnSite.length === 0 ? (
                                    <tr><td colSpan={4} className="p-10 text-center text-slate-400">Brak sprzętu na tej budowie.</td></tr>
                                ) : (
                                    itemsOnSite.map(item => (
                                        <tr key={item.id} className="border-b last:border-0 hover:bg-slate-50 transition">
                                            <td className="p-4 pl-6 w-32"><img src={item.imageUrl || 'https://via.placeholder.com/60'} alt="" className="w-16 h-16 object-cover rounded-xl border border-slate-200" /></td>
                                            <td className="p-4 font-bold text-slate-800">{item.name}</td>
                                            <td className="p-4 text-center font-mono text-slate-500">{item.inventoryNumber || "-"}</td>
                                            <td className="p-4 pr-6 text-right font-black text-2xl text-blue-600">{item.allocations[selectedSiteId]}</td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                );
            case "HISTORY":
                return (
                    <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden animate-fade-in">
                        <div className="bg-slate-800 text-white p-6 flex justify-between items-center">
                            <div>
                                <h3 className="font-bold text-xl">Historia Operacji</h3>
                                <p className="text-slate-400 text-xs mt-1">Wszystkie wydania i zwroty powiązane z tą budową.</p>
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
                                    return (
                                        <div key={idx} className={`p-4 border rounded-2xl transition shadow-sm ${isPending ? 'bg-yellow-50 border-yellow-200' : 'bg-white hover:border-slate-300'}`}>
                                            <div className="flex justify-between items-center border-b pb-3 mb-3 border-slate-100">
                                                <div className="flex items-center gap-3">
                                                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xl ${isIssue ? 'bg-green-100' : 'bg-blue-100'}`}>
                                                        {isIssue ? '📥' : '📤'}
                                                    </div>
                                                    <div>
                                                        <p className="font-black text-slate-800">{p.protocolId}</p>
                                                        <p className="text-[10px] text-slate-500">{new Date(p.createdAt).toLocaleString()} • Wystawił: {p.createdByName}</p>
                                                    </div>
                                                </div>
                                                <span className={`px-3 py-1 rounded-lg text-xs font-black uppercase tracking-wider ${isPending ? 'bg-yellow-200 text-yellow-800' : 'bg-green-100 text-green-700'}`}>
                                                    {isPending ? '⏳ Weryfikacja Magazynu' : '✅ Zrealizowany'}
                                                </span>
                                            </div>
                                            <div className="text-xs text-slate-600 pl-14">
                                                <span className="font-bold text-slate-800">Przedmioty: </span>
                                                {p.items.map((i: any) => `${i.name} (${i.quantity || i.declaredQty || 1} szt)`).join(", ")}
                                            </div>
                                        </div>
                                    )
                                })
                            )}
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

                        <div className="w-full max-w-2xl bg-white border border-purple-200 rounded-2xl shadow-sm overflow-hidden mb-8">
                            <div className="bg-purple-100 p-3 text-xs font-black text-purple-800 uppercase tracking-widest text-center border-b border-purple-200">
                                Przykładowy obieg sprawy
                            </div>
                            <div className="p-6 space-y-4 relative">
                                {/* Linia łącząca */}
                                <div className="absolute left-[39px] top-10 bottom-10 w-0.5 bg-purple-100 z-0"></div>

                                <div className="flex gap-4 relative z-10">
                                    <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-sm shadow-sm">1</div>
                                    <div>
                                        <p className="font-bold text-slate-800">Magazynier zgłasza sprawę</p>
                                        <p className="text-xs text-slate-500">"Szlifierka wróciła w kawałkach, kabel ucięty celowo."</p>
                                    </div>
                                </div>
                                <div className="flex gap-4 relative z-10">
                                    <div className="w-8 h-8 rounded-full bg-blue-200 flex items-center justify-center text-sm shadow-sm">2</div>
                                    <div>
                                        <p className="font-bold text-blue-900">Kierownik Budowy składa wyjaśnienia</p>
                                        <p className="text-xs text-blue-700">Oczekuje na Twoją reakcję.</p>
                                    </div>
                                </div>
                                <div className="flex gap-4 relative z-10">
                                    <div className="w-8 h-8 rounded-full bg-purple-200 flex items-center justify-center text-sm shadow-sm">3</div>
                                    <div>
                                        <p className="font-bold text-purple-900">Decyzja Dyrektora</p>
                                        <p className="text-xs text-purple-700">Dyrektor ocenia sytuację i proponuje karę finansową.</p>
                                    </div>
                                </div>
                                <div className="flex gap-4 relative z-10">
                                    <div className="w-8 h-8 rounded-full bg-red-200 flex items-center justify-center text-sm shadow-sm">4</div>
                                    <div>
                                        <p className="font-bold text-red-900">Zatwierdzenie Szefa</p>
                                        <p className="text-xs text-red-700">Ostateczna pieczątka prezesa zamykająca sprawę.</p>
                                    </div>
                                </div>
                            </div>
                        </div>

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
        <div className="p-6 md:p-10 max-w-7xl mx-auto min-h-screen">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                <div>
                    <h1 className="text-3xl font-black text-slate-800 tracking-tighter">Twoja Budowa</h1>
                    <p className="text-slate-500 text-sm">Centrum operacyjne dla kierownika budowy</p>
                </div>

                {mySites.length > 0 && (
                    <select
                        value={selectedSiteId}
                        onChange={(e) => { setSelectedSiteId(e.target.value); setActiveView("HUB"); }}
                        className="p-3 bg-white border border-slate-300 rounded-xl font-bold text-blue-700 shadow-sm outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer transition hover:bg-slate-50"
                    >
                        <option value="" disabled>-- Zmień budowę --</option>
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
                    {/* Baner budowy */}
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
                        {/* Tło graficzne w banerze */}
                        <div className="absolute right-[-5%] top-[-30%] text-[12rem] opacity-5 select-none pointer-events-none transform -rotate-12">🏗️</div>
                    </div>

                    {/* DYNAMICZNA TREŚĆ MODUŁÓW */}
                    {renderContent()}
                </>
            )}
        </div>
    );
}