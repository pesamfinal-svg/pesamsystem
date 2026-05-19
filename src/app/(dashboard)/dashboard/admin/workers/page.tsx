"use client";

import { useState, useEffect, useCallback } from "react";
import {
    collection, getDocs, doc, updateDoc, deleteDoc,
    query, orderBy, addDoc, runTransaction
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";

import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";

// --- INTERFEJSY ---
interface Worker {
    id: string;
    firstName: string;
    lastName: string;
    phone: string;
    notes: string;
    createdAt: string;
}

interface InventoryItem {
    id: string;
    name: string;
    inventoryNumber: string;
    type: "UNIQUE" | "BULK";
    subType?: string;
    availableQuantity: number;
    totalQuantity: number;
    allocations: Record<string, number>;
    unit?: string;
}

interface Site {
    id: string;
    name: string;
    location?: string;
    status?: string;
}

interface WorkerIssueHistory {
    id: string;
    itemId: string;
    itemName: string;
    qty: number;
    date: string;
    issuedBy: string;
    notes: string;
    source: string; // "MAGAZYN" lub "BUDOWA"
    sourceSiteId?: string; // Dokładne ID budowy, jeśli source === "BUDOWA"
    sourceSiteName?: string; // Nazwa budowy do wyświetlenia
    type: "ISSUE" | "RETURN";
}

const INITIAL_WORKER_STATE: Partial<Worker> = { firstName: "", lastName: "", phone: "", notes: "" };

// ---------------------------------------------------------------------------
// KOMPONENT: MODAL WYDANIE PRACOWNIKOWI
// ---------------------------------------------------------------------------
interface IssueToWorkerModalProps {
    worker: Worker;
    inventory: InventoryItem[];
    sites: Site[];
    user: any;
    canIssueWarehouse: boolean;
    canIssueSite: boolean;
    onClose: () => void;
    onSave: (itemId: string, qty: number, notes: string, source: "MAGAZYN" | "BUDOWA", sourceSiteId: string) => Promise<void>;
}

function IssueToWorkerModal({ worker, inventory, sites, user, canIssueWarehouse, canIssueSite, onClose, onSave }: IssueToWorkerModalProps) {
    const [itemId, setItemId] = useState("");
    const [qty, setQty] = useState(1);
    const [notes, setNotes] = useState("");
    const [saving, setSaving] = useState(false);

    const [activeTab, setActiveTab] = useState<"UNIQUE" | "BULK">("UNIQUE");
    const [searchTerm, setSearchTerm] = useState("");

    const [issueSource, setIssueSource] = useState<"MAGAZYN" | "BUDOWA">(canIssueWarehouse ? "MAGAZYN" : "BUDOWA");

    // Określamy budowy, do których user ma dostęp
    const userSites = user?.assignedSites?.includes("ALL")
        ? sites.filter(s => s.location !== "Wpis ręczny" && s.status !== "ZAKOŃCZONA")
        : sites.filter(s => user?.assignedSites?.includes(s.id));

    // Stan do wyboru konkretnej budowy (domyślnie pierwsza z dostępnych)
    const [selectedSiteId, setSelectedSiteId] = useState<string>(userSites.length > 0 ? userSites[0].id : "");

    const selectedItem = inventory.find(i => i.id === itemId);

    // Dostępna ilość zależy od wybranego źródła i ewentualnie wybranej budowy
    const availableQty = selectedItem
        ? issueSource === "MAGAZYN"
            ? selectedItem.availableQuantity
            : (selectedItem.allocations?.[selectedSiteId] || 0)
        : 0;

    const filteredInventory = inventory.filter(i => {
        const dostepne = issueSource === "MAGAZYN" ? i.availableQuantity : (i.allocations?.[selectedSiteId] || 0);
        if (dostepne <= 0) return false;

        if (i.type !== activeTab) return false;
        if (i.subType === "MAIN_CAT") return false;

        const term = searchTerm.toLowerCase();
        const matchName = i.name.toLowerCase().includes(term);
        const matchInv = (i.inventoryNumber || "").toLowerCase().includes(term);
        return matchName || matchInv;
    });

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!itemId || qty <= 0) return alert("Wybierz przedmiot i podaj ilość!");
        if (qty > availableQty) return alert("Niewystarczający stan!");
        if (issueSource === "BUDOWA" && !selectedSiteId) return alert("Wybierz budowę źródłową!");

        setSaving(true);
        // Przekazujemy selectedSiteId, żeby główna funkcja wiedziała skąd zdjąć
        await onSave(itemId, qty, notes, issueSource, selectedSiteId);
        setSaving(false);
    };

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl p-6 flex flex-col max-h-[90vh] animate-fade-in">
                <div className="flex justify-between items-center mb-6 border-b pb-4">
                    <div>
                        <h2 className="text-xl font-bold text-green-700">➕ Wydaj sprzęt pracownikowi</h2>
                        <p className="text-sm text-slate-500">
                            Wydajesz dla: <span className="font-bold text-slate-700">{worker.firstName} {worker.lastName}</span>
                        </p>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-3xl leading-none">&times;</button>
                </div>

                {/* PRZEŁĄCZNIK ŹRÓDŁA WYDANIA */}
                <div className="mb-4 flex flex-col md:flex-row gap-4 items-end">
                    <div className="flex-1">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Skąd zdejmujemy sprzęt?</label>
                        <div className="flex gap-2 bg-slate-100 p-1 rounded-xl w-fit border">
                            {canIssueWarehouse && (
                                <button
                                    type="button"
                                    onClick={() => { setIssueSource("MAGAZYN"); setItemId(""); }}
                                    className={`px-4 py-2 rounded-lg text-xs font-black transition-all flex items-center gap-2 ${issueSource === 'MAGAZYN' ? 'bg-white text-blue-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                >
                                    📦 GŁÓWNY MAGAZYN
                                </button>
                            )}
                            {canIssueSite && (
                                <button
                                    type="button"
                                    onClick={() => { setIssueSource("BUDOWA"); setItemId(""); }}
                                    className={`px-4 py-2 rounded-lg text-xs font-black transition-all flex items-center gap-2 ${issueSource === 'BUDOWA' ? 'bg-white text-green-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                >
                                    🏗️ STAN BUDOWY
                                </button>
                            )}
                        </div>
                    </div>

                    {/* WYBÓR KONKRETNEJ BUDOWY (jeśli wybrano BUDOWĘ) */}
                    {issueSource === "BUDOWA" && (
                        <div className="w-full md:w-1/2">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Z której budowy?</label>
                            <select
                                value={selectedSiteId}
                                onChange={e => { setSelectedSiteId(e.target.value); setItemId(""); }}
                                className="w-full p-2.5 border-2 rounded-xl bg-green-50 outline-none focus:border-green-500 font-bold text-green-900 text-sm"
                            >
                                {userSites.length === 0 && <option value="" disabled>Brak przypisanych budów</option>}
                                {userSites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                        </div>
                    )}
                </div>

                <div className="flex-1 flex flex-col md:flex-row gap-6 overflow-hidden mt-2">
                    <div className="w-full md:w-1/2 flex flex-col border border-slate-200 rounded-xl overflow-hidden bg-slate-50">
                        <div className="p-3 bg-white border-b">
                            <div className="flex gap-2 mb-3 bg-slate-100 p-1 rounded-lg w-fit">
                                <button type="button" onClick={() => { setActiveTab("UNIQUE"); setItemId(""); }} className={`px-4 py-1.5 rounded-md text-xs font-black transition-all ${activeTab === 'UNIQUE' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>NARZĘDZIA</button>
                                <button type="button" onClick={() => { setActiveTab("BULK"); setItemId(""); }} className={`px-4 py-1.5 rounded-md text-xs font-black transition-all ${activeTab === 'BULK' ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>MATERIAŁY/INNE</button>
                            </div>
                            <input
                                type="text"
                                placeholder="Szukaj nazwy lub nr..."
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                className="w-full p-2 border rounded-lg text-sm outline-none focus:border-green-500 bg-white"
                            />
                        </div>
                        <div className="flex-1 overflow-y-auto p-2 space-y-1">
                            {filteredInventory.length === 0 ? (
                                <p className="text-xs text-center p-4 text-slate-400">
                                    {issueSource === "MAGAZYN"
                                        ? "Brak przedmiotów w magazynie."
                                        : "Brak sprzętu na wybranej budowie. Upewnij się, że dostałeś go z magazynu (WZ)."}
                                </p>
                            ) : (
                                filteredInventory.map(i => {
                                    const dostepne = issueSource === "MAGAZYN" ? i.availableQuantity : (i.allocations?.[selectedSiteId] || 0);
                                    const isSelected = itemId === i.id;
                                    return (
                                        <div
                                            key={i.id}
                                            onClick={() => { setItemId(i.id); setQty(1); }}
                                            className={`p-2 rounded-lg cursor-pointer border transition-all text-sm ${isSelected ? 'bg-green-100 border-green-400 shadow-sm' : 'bg-white border-transparent hover:border-slate-300'}`}
                                        >
                                            <p className="font-bold text-slate-800 leading-tight">{i.name}</p>
                                            <div className="flex justify-between items-center mt-1">
                                                <span className="text-[10px] font-mono text-slate-500">{i.inventoryNumber || "-"}</span>
                                                <span className="text-[10px] font-bold text-green-600">Dostępne: {dostepne} {i.unit || "szt."}</span>
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>

                    <div className="w-full md:w-1/2 flex flex-col">
                        <form onSubmit={handleSubmit} className="flex flex-col h-full space-y-4">
                            <div className="flex-1">
                                {!selectedItem ? (
                                    <div className="h-full flex items-center justify-center border-2 border-dashed border-slate-200 rounded-xl p-6 text-center text-slate-400 text-sm font-bold bg-slate-50">
                                        Wybierz przedmiot z listy obok, aby kontynuować.
                                    </div>
                                ) : (
                                    <div className="bg-green-50 border border-green-200 rounded-xl p-4 animate-fade-in flex flex-col h-full">
                                        <p className="text-[10px] font-black text-green-800 uppercase mb-1">Wybrano do wydania:</p>
                                        <p className="font-bold text-slate-800 mb-1">{selectedItem.name}</p>
                                        <p className="text-xs font-mono text-slate-500 mb-6">Nr Mag: {selectedItem.inventoryNumber || "BRAK"}</p>

                                        <div className="mb-6">
                                            <label className="text-xs font-bold text-slate-600 block mb-2">Ilość do wydania</label>
                                            <div className="flex items-center gap-3">
                                                <input
                                                    required
                                                    type="number"
                                                    min={1}
                                                    max={availableQty || 9999}
                                                    value={qty}
                                                    onChange={e => setQty(Number(e.target.value))}
                                                    className="w-24 p-3 border-2 rounded-xl text-center font-bold text-lg outline-none focus:border-green-500"
                                                />
                                                <span className="text-xs font-bold text-slate-500">z {availableQty} dostępnych</span>
                                            </div>
                                            {qty > availableQty && (
                                                <p className="text-red-500 text-xs mt-2 font-bold">⚠️ Przekracza dostępną ilość!</p>
                                            )}
                                        </div>

                                        <div className="mt-auto">
                                            <label className="text-xs font-bold text-slate-600 block mb-2">Notatki (opcjonalnie)</label>
                                            <textarea
                                                value={notes}
                                                onChange={e => setNotes(e.target.value)}
                                                className="w-full p-3 border-2 rounded-xl text-sm h-20 resize-none outline-none focus:border-green-500"
                                                placeholder="np. wymiana za zużyty, nowa osoba..."
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="flex gap-3 pt-4 border-t">
                                <button type="button" onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition">Anuluj</button>
                                <button
                                    type="submit"
                                    disabled={saving || !selectedItem || qty > availableQty || (issueSource === "BUDOWA" && !selectedSiteId)}
                                    className="flex-1 py-3 bg-green-600 text-white font-black rounded-xl hover:bg-green-700 shadow-md transition disabled:opacity-50 disabled:bg-slate-400"
                                >
                                    {saving ? "Zapisywanie..." : "ZATWIERDŹ WYDANIE"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// KOMPONENT GŁÓWNY
// ---------------------------------------------------------------------------
export default function WorkersPage() {
    const [workers, setWorkers] = useState<Worker[]>([]);
    const [workersLoading, setWorkersLoading] = useState(true);
    const [inventoryLoading, setInventoryLoading] = useState(true);

    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingWorker, setEditingWorker] = useState<Worker | null>(null);
    const [formData, setFormData] = useState<Partial<Worker>>(INITIAL_WORKER_STATE);

    const [selectedWorker, setSelectedWorker] = useState<Worker | null>(null);
    const [workerHistory, setWorkerHistory] = useState<WorkerIssueHistory[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    const [isIssueToWorkerOpen, setIsIssueToWorkerOpen] = useState(false);
    const [inventory, setInventory] = useState<InventoryItem[]>([]);
    const [sites, setSites] = useState<Site[]>([]);

    // --- PRAWDZIWA AUTORYZACJA ---
    const { user } = useAuth();

    const canManageWorkers = user ? hasPermission("workersManage", user.rolePermissions, user.permissionOverrides) : false;
    const canIssueWarehouse = user ? hasPermission("workersIssueWarehouse", user.rolePermissions, user.permissionOverrides) : false;
    const canIssueSite = user ? hasPermission("workersIssueSite", user.rolePermissions, user.permissionOverrides) : false;

    const canIssueAny = canIssueWarehouse || canIssueSite;

    const fetchWorkersList = useCallback(async () => {
        setWorkersLoading(true);
        try {
            const q = query(collection(db, "workers"), orderBy("lastName", "asc"));
            const snap = await getDocs(q);
            setWorkers(snap.docs.map(d => ({ id: d.id, ...d.data() })) as Worker[]);
        } catch (e) { console.error(e); }
        setWorkersLoading(false);
    }, []);

    const fetchDependencies = useCallback(async () => {
        setInventoryLoading(true);
        try {
            const invSnap = await getDocs(collection(db, "inventory"));
            setInventory(invSnap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[]);

            const sitesSnap = await getDocs(query(collection(db, "sites"), orderBy("name", "asc")));
            setSites(sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[]);
        } catch (e) { console.error(e); }
        setInventoryLoading(false);
    }, []);

    useEffect(() => {
        fetchWorkersList();
        fetchDependencies();
    }, [fetchWorkersList, fetchDependencies]);

    const openWorkerCard = async (worker: Worker) => {
        setSelectedWorker(worker);
        setHistoryLoading(true);
        try {
            const issuesSnap = await getDocs(
                query(collection(db, `workers/${worker.id}/issues`), orderBy("date", "desc"))
            );
            setWorkerHistory(issuesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as WorkerIssueHistory[]);
        } catch (e) {
            console.error(e);
            setWorkerHistory([]);
        }
        setHistoryLoading(false);
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canManageWorkers) return alert("Brak uprawnień do edycji kartoteki!");
        if (!formData.firstName || !formData.lastName) return alert("Imię i nazwisko są wymagane!");
        try {
            if (editingWorker) {
                await updateDoc(doc(db, "workers", editingWorker.id), { ...formData });
            } else {
                await addDoc(collection(db, "workers"), { ...formData, createdAt: new Date().toISOString() });
            }
            setIsFormOpen(false);
            setEditingWorker(null);
            setFormData(INITIAL_WORKER_STATE);
            fetchWorkersList();
        } catch (error: any) { alert("Błąd zapisu: " + error.message); }
    };

    const handleDelete = async (worker: Worker) => {
        if (!canManageWorkers) return alert("Brak uprawnień do usuwania pracowników!");
        if (confirm(`Czy na pewno chcesz usunąć pracownika "${worker.firstName} ${worker.lastName}" z bazy?`)) {
            await deleteDoc(doc(db, "workers", worker.id));
            fetchWorkersList();
        }
    };

    // -----------------------------------------------------------------------
    // FUNKCJA: WYDANIE PRACOWNIKOWI
    // -----------------------------------------------------------------------
    const handleIssueToWorker = async (itemId: string, qty: number, notes: string, source: "MAGAZYN" | "BUDOWA", sourceSiteId: string) => {
        if (!selectedWorker) return;

        try {
            await runTransaction(db, async (transaction) => {
                const itemRef = doc(db, "inventory", itemId);
                const itemDoc = await transaction.get(itemRef);
                if (!itemDoc.exists()) throw new Error("Przedmiot nie istnieje!");

                const itemData = itemDoc.data() as InventoryItem;

                if (source === "MAGAZYN") {
                    if (itemData.availableQuantity < qty) throw new Error("Brak wystarczającej ilości w magazynie!");
                    transaction.update(itemRef, { availableQuantity: itemData.availableQuantity - qty });
                } else {
                    const siteQty = itemData.allocations?.[sourceSiteId] || 0;
                    if (siteQty < qty) throw new Error("Nie masz wystarczającej ilości na wybranej budowie!");
                    transaction.update(itemRef, { [`allocations.${sourceSiteId}`]: siteQty - qty });
                }

                // Szukamy nazwy budowy do zapisania w historii
                const siteName = source === "BUDOWA" ? (sites.find(s => s.id === sourceSiteId)?.name || "Budowa") : "Magazyn";

                const issueRef = doc(collection(db, `workers/${selectedWorker.id}/issues`));
                transaction.set(issueRef, {
                    itemId,
                    itemName: itemData.name,
                    qty,
                    date: new Date().toISOString(),
                    issuedBy: `${user?.firstName} ${user?.lastName}`,
                    notes,
                    source,
                    sourceSiteId: source === "BUDOWA" ? sourceSiteId : null,
                    sourceSiteName: source === "BUDOWA" ? siteName : null,
                    type: "ISSUE"
                });

                const globalTxRef = doc(collection(db, "transactions"));
                transaction.set(globalTxRef, {
                    type: "ISSUE",
                    workerId: selectedWorker.id,
                    workerName: `${selectedWorker.firstName} ${selectedWorker.lastName}`,
                    itemId,
                    itemName: itemData.name,
                    qty,
                    date: new Date().toISOString(),
                    userId: user?.uid || "unknown",
                    siteId: source === "MAGAZYN" ? "MAGAZYN" : sourceSiteId,
                    notes
                });
            });

            alert("✅ Wydano sprzęt pracownikowi!");
            setIsIssueToWorkerOpen(false);
            openWorkerCard(selectedWorker);
            fetchDependencies();
        } catch (e: any) {
            alert("Błąd: " + e.message);
        }
    };

    // -----------------------------------------------------------------------
    // FUNKCJA: ZWROT SPRZĘTU OD PRACOWNIKA
    // -----------------------------------------------------------------------
    const handleReturnItem = async (historyItem: WorkerIssueHistory) => {
        if (!selectedWorker) return;

        const returnedToSource = historyItem.source;
        if (returnedToSource === "MAGAZYN" && !canIssueWarehouse) return alert("Ten sprzęt został pobrany z Magazynu. Tylko magazynier może go zwrócić na stan Magazynu.");
        if (returnedToSource === "BUDOWA" && !canIssueSite) return alert("Ten sprzęt został pobrany z Budowy. Tylko kierownik może go zwrócić na stan Budowy.");

        const returnInput = prompt(`Ile sztuk "${historyItem.itemName}" pracownik zwraca na stan?`, historyItem.qty.toString());
        if (returnInput === null) return;

        const returnQty = parseInt(returnInput);
        if (isNaN(returnQty) || returnQty <= 0 || returnQty > historyItem.qty) {
            return alert("Wprowadzono nieprawidłową ilość do zwrotu!");
        }

        try {
            await runTransaction(db, async (transaction) => {
                const itemRef = doc(db, "inventory", historyItem.itemId);
                const itemDoc = await transaction.get(itemRef);

                // Odczytujemy dokładną budowę z której zeszło (zapisanej w historii)
                // Fallback dla starszych wpisów (bez sourceSiteId) = pierwsza budowa usera
                const targetSiteId = historyItem.sourceSiteId || (user?.assignedSites?.find((id: string) => id !== "ALL") || user?.assignedSites?.[0]);

                if (itemDoc.exists()) {
                    const itemData = itemDoc.data() as InventoryItem;

                    if (returnedToSource === "MAGAZYN") {
                        transaction.update(itemRef, { availableQuantity: itemData.availableQuantity + returnQty });
                    } else {
                        const siteQty = itemData.allocations?.[targetSiteId!] || 0;
                        transaction.update(itemRef, { [`allocations.${targetSiteId}`]: siteQty + returnQty });
                    }
                }

                const returnLogRef = doc(collection(db, `workers/${selectedWorker.id}/issues`));
                transaction.set(returnLogRef, {
                    itemId: historyItem.itemId,
                    itemName: historyItem.itemName,
                    qty: returnQty,
                    date: new Date().toISOString(),
                    issuedBy: `${user?.firstName} ${user?.lastName}`,
                    notes: "Zwrot sprzętu",
                    source: returnedToSource,
                    sourceSiteId: returnedToSource === "BUDOWA" ? targetSiteId : null,
                    sourceSiteName: historyItem.sourceSiteName || null,
                    type: "RETURN"
                });

                const globalTxRef = doc(collection(db, "transactions"));
                transaction.set(globalTxRef, {
                    type: "RETURN",
                    workerId: selectedWorker.id,
                    workerName: `${selectedWorker.firstName} ${selectedWorker.lastName}`,
                    itemId: historyItem.itemId,
                    itemName: historyItem.itemName,
                    qty: returnQty,
                    date: new Date().toISOString(),
                    userId: user?.uid || "unknown",
                    siteId: returnedToSource === "MAGAZYN" ? "MAGAZYN" : targetSiteId,
                    notes: "Zwrot sprzętu"
                });
            });

            alert("✅ Zwrócono sprzęt na stan!");
            openWorkerCard(selectedWorker);
            fetchDependencies();
        } catch (e: any) {
            alert("Błąd zwrotu: " + e.message);
        }
    };

    if (!user) return <div className="p-10 text-center animate-pulse">Ładowanie profilu użytkownika...</div>;

    return (
        <div className="p-6 md:p-10 max-w-5xl mx-auto animate-fade-in">
            {/* NAGŁÓWEK */}
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-3xl font-bold text-slate-800 tracking-tighter">Pracownicy Fizyczni</h1>
                    <p className="text-slate-500 text-sm">Zarządzanie kadrą i narzędziami osobistymi</p>
                </div>
                <div className="flex gap-3">
                    {canManageWorkers && (
                        <button
                            onClick={() => { setEditingWorker(null); setFormData(INITIAL_WORKER_STATE); setIsFormOpen(true); }}
                            className="bg-blue-600 text-white px-6 py-2 rounded-lg font-bold shadow-lg transition hover:bg-blue-700"
                        >
                            + Dodaj Pracownika
                        </button>
                    )}
                </div>
            </div>

            {/* LISTA PRACOWNIKÓW */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden h-[75vh] flex flex-col">
                <div className="p-5 border-b bg-slate-50"><h2 className="font-bold text-slate-700 uppercase tracking-widest text-xs">Katalog Pracowników</h2></div>
                <div className="flex-1 overflow-y-auto">
                    {workersLoading ? (
                        <div className="p-10 text-center text-sm text-slate-400 animate-pulse">Ładowanie pracowników...</div>
                    ) : (
                        <table className="w-full text-left">
                            <thead className="bg-white border-b text-[10px] uppercase font-black text-slate-400 sticky top-0 shadow-sm">
                                <tr>
                                    <th className="p-4 pl-6">Imię i Nazwisko</th>
                                    <th className="p-4">Nr telefonu</th>
                                    <th className="p-4">Ostatnie notatki</th>
                                    <th className="p-4 text-right pr-6">Akcje</th>
                                </tr>
                            </thead>
                            <tbody className="text-sm">
                                {workers.map(worker => (
                                    <tr key={worker.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition group">
                                        <td className="p-4 pl-6 cursor-pointer" onClick={() => openWorkerCard(worker)}>
                                            <p className="font-bold text-slate-800 text-base group-hover:text-blue-600 transition">{worker.lastName} {worker.firstName}</p>
                                        </td>
                                        <td className="p-4 text-slate-500 font-mono text-xs">{worker.phone || "-"}</td>
                                        <td className="p-4 text-slate-400 text-xs truncate max-w-[200px]">{worker.notes || "-"}</td>
                                        <td className="p-4 text-right pr-6 space-x-3">
                                            {canManageWorkers ? (
                                                <>
                                                    <button
                                                        onClick={() => { setEditingWorker(worker); setFormData(worker); setIsFormOpen(true); }}
                                                        className="text-blue-600 hover:text-blue-800 font-bold text-xs bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition"
                                                    >
                                                        Edytuj
                                                    </button>
                                                    <button
                                                        onClick={() => handleDelete(worker)}
                                                        className="text-red-500 hover:text-red-700 font-bold text-xs bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-lg transition"
                                                    >
                                                        Usuń
                                                    </button>
                                                </>
                                            ) : (
                                                <span className="text-xs text-slate-300">Brak uprawnień edycji</span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>

            {/* KARTA PRACOWNIKA (panel boczny) */}
            {selectedWorker && (
                <div
                    className="fixed inset-0 bg-black/60 z-40 flex justify-end"
                    onClick={() => setSelectedWorker(null)}
                >
                    <div
                        className="bg-white w-full max-w-2xl h-full p-8 shadow-2xl overflow-y-auto animate-slide-in"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex justify-between items-start mb-2">
                            <div>
                                <h2 className="text-3xl font-black text-slate-800">
                                    {selectedWorker.firstName} {selectedWorker.lastName}
                                </h2>
                                <p className="text-sm text-slate-500 font-mono mt-1">{selectedWorker.phone}</p>
                            </div>
                            <button onClick={() => setSelectedWorker(null)} className="text-3xl text-slate-400 hover:text-slate-900 leading-none">&times;</button>
                        </div>

                        <p className="text-xs text-slate-500 mt-4 bg-slate-50 p-3 rounded-xl border border-slate-200">
                            <span className="font-bold uppercase block mb-1">Notatki z profilu:</span>
                            {selectedWorker.notes || "Brak notatek w profilu."}
                        </p>

                        <div className="flex justify-between items-center mt-10 mb-4 border-b pb-4">
                            <h3 className="font-black uppercase text-sm text-slate-800 tracking-wider">Historia pobranego sprzętu</h3>

                            {canIssueAny && (
                                <button
                                    onClick={() => setIsIssueToWorkerOpen(true)}
                                    disabled={inventoryLoading}
                                    className="bg-green-600 text-white px-5 py-2 rounded-xl font-black text-xs shadow-md hover:bg-green-700 transition disabled:opacity-50"
                                >
                                    ➕ Wydaj sprzęt
                                </button>
                            )}
                        </div>

                        {historyLoading ? (
                            <div className="animate-pulse text-xs text-slate-400 text-center py-10">Pobieranie historii z bazy...</div>
                        ) : workerHistory.length === 0 ? (
                            <div className="text-center text-slate-400 p-10 text-sm border-2 border-dashed rounded-xl bg-slate-50">Brak historii pobrań na koncie tego pracownika.</div>
                        ) : (
                            <table className="w-full text-sm">
                                <thead className="text-[10px] text-slate-400 bg-slate-50 uppercase tracking-widest font-black">
                                    <tr className="border-b">
                                        <th className="p-3 text-left">Przedmiot</th>
                                        <th className="p-3 text-center">Ilość</th>
                                        <th className="p-3 text-left">Źródło</th>
                                        <th className="p-3 text-left">Data</th>
                                        <th className="p-3 text-right">Akcje</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {workerHistory.map((h) => (
                                        <tr key={h.id} className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 transition ${h.type === "RETURN" ? "bg-slate-50/50 opacity-70" : ""}`}>
                                            <td className={`p-3 font-bold text-slate-800 ${h.type === "RETURN" ? "line-through text-slate-500" : ""}`}>
                                                {h.itemName}
                                                {h.notes && <p className="text-[10px] text-slate-400 font-normal no-underline mt-0.5">{h.notes}</p>}
                                            </td>
                                            <td className={`p-3 text-center font-black ${h.type === "RETURN" ? "text-orange-600" : "text-green-600"}`}>
                                                {h.type === "RETURN" ? `+${h.qty} (zwrot)` : `${h.qty} szt.`}
                                            </td>
                                            <td className="p-3">
                                                <span className={`px-2 py-1 rounded-md text-[9px] font-black uppercase ${h.source === "MAGAZYN" ? "bg-blue-100 text-blue-800 border border-blue-200" : "bg-green-100 text-green-800 border border-green-200"}`}>
                                                    {h.source === "MAGAZYN" ? "MAGAZYN" : `BUDOWA: ${h.sourceSiteName || "Nieznana"}`}
                                                </span>
                                            </td>
                                            <td className="p-3 text-xs text-slate-500 font-mono">
                                                {new Date(h.date).toLocaleDateString("pl-PL")}
                                            </td>
                                            <td className="p-3 text-right">
                                                {h.type !== "RETURN" && (h.source === "MAGAZYN" ? canIssueWarehouse : canIssueSite) && (
                                                    <button
                                                        onClick={() => handleReturnItem(h)}
                                                        className="text-orange-600 hover:text-white hover:bg-orange-500 px-3 py-1 rounded-lg border border-orange-200 text-[10px] uppercase font-black tracking-wider transition-colors shadow-sm"
                                                    >
                                                        Zwróć
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            )}

            {/* MODAL: FORMULARZ PRACOWNIKA */}
            {isFormOpen && canManageWorkers && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-3xl shadow-xl w-full max-w-md p-8 animate-fade-in">
                        <h2 className="text-2xl font-black mb-6 text-slate-800">{editingWorker ? "Edytuj pracownika" : "Nowy pracownik"}</h2>
                        <form onSubmit={handleSave} className="space-y-4">
                            <div>
                                <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-1">Imię</label>
                                <input required value={formData.firstName} onChange={e => setFormData({ ...formData, firstName: e.target.value })} className="w-full p-3 border-2 rounded-xl outline-none focus:border-blue-500 font-bold text-slate-800" />
                            </div>
                            <div>
                                <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-1">Nazwisko</label>
                                <input required value={formData.lastName} onChange={e => setFormData({ ...formData, lastName: e.target.value })} className="w-full p-3 border-2 rounded-xl outline-none focus:border-blue-500 font-bold text-slate-800" />
                            </div>
                            <div>
                                <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-1">Nr telefonu</label>
                                <input value={formData.phone} onChange={e => setFormData({ ...formData, phone: e.target.value })} className="w-full p-3 border-2 rounded-xl outline-none focus:border-blue-500 font-bold text-slate-800" />
                            </div>
                            <div>
                                <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-1">Notatki / Przypisanie</label>
                                <textarea value={formData.notes} onChange={e => setFormData({ ...formData, notes: e.target.value })} className="w-full p-3 border-2 rounded-xl h-24 resize-none outline-none focus:border-blue-500 text-sm" />
                            </div>
                            <div className="flex gap-3 pt-6 border-t mt-4">
                                <button type="button" onClick={() => setIsFormOpen(false)} className="flex-1 py-3 text-slate-600 bg-slate-100 hover:bg-slate-200 font-bold rounded-xl transition">Anuluj</button>
                                <button type="submit" className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-xl shadow-md transition">ZAPISZ</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* MODAL: WYDAWANIE */}
            {isIssueToWorkerOpen && selectedWorker && (
                <IssueToWorkerModal
                    worker={selectedWorker}
                    inventory={inventory}
                    sites={sites}
                    user={user}
                    canIssueWarehouse={canIssueWarehouse}
                    canIssueSite={canIssueSite}
                    onClose={() => setIsIssueToWorkerOpen(false)}
                    onSave={handleIssueToWorker}
                />
            )}
        </div>
    );
}