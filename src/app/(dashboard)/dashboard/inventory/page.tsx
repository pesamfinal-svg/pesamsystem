// src/app/(dashboard)/inventory/page.tsx
"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, doc, setDoc, updateDoc, deleteDoc, query, orderBy, addDoc, writeBatch, runTransaction, where, limit } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import ClaimInvestigationModal from "@/components/claims/ClaimInvestigationModal";

// --- INTERFEJSY ---
interface HistoryEntry {
    date: string;
    type: string;
    description: string;
    status: string;
    user: string;
}

interface InventoryItem {
    id: string;
    name: string;
    type: "UNIQUE" | "BULK";
    subType?: "MAIN_CAT" | "SUB_ITEM";
    mainCategoryId?: string;
    inventoryNumber: string;
    category: string;
    subcategory: string;
    status: string;
    imageUrl: string;
    currentLocation: string;
    totalQuantity: number;
    availableQuantity: number;
    purchasePrice: number;
    purchaseDate: string;
    invoiceNumber: string;
    additionalInfo: string;
    allocations: Record<string, number>;
    createdAt: string;
}

const INITIAL_FORM_STATE: Partial<InventoryItem> = {
    name: "",
    type: "UNIQUE",
    subType: "SUB_ITEM",
    mainCategoryId: "",
    inventoryNumber: "",
    category: "",
    subcategory: "",
    currentLocation: "MAGAZYN PESAM",
    status: "sprawne",
    totalQuantity: 1,
    purchasePrice: 0,
    purchaseDate: "",
    invoiceNumber: "",
    imageUrl: "",
    additionalInfo: ""
};

export default function InventoryPage() {
    const { user } = useAuth();
    const [items, setItems] = useState<InventoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<"UNIQUE" | "BULK">("UNIQUE");

    // FILTRY
    const [searchTerm, setSearchTerm] = useState("");
    const [locFilter, setLocFilter] = useState("ALL");
    const [statusFilter, setStatusFilter] = useState("ALL");

    // MODALE I FORMULARZ GŁÓWNY
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
    const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
    const [showSpecs, setShowSpecs] = useState(false);

    // NOWE STANY DLA NADAWANIA NUMERU PRZEZ MAGAZYNIERA
    const [isAssignNumberOpen, setIsAssignNumberOpen] = useState(false);
    const [newInvNumber, setNewInvNumber] = useState("");

    // MODAL SERWISOWY
    const [isServiceModalOpen, setIsServiceModalOpen] = useState(false);
    const [serviceData, setServiceData] = useState({ newStatus: "sprawne", description: "", cost: "" });
    const [isServiceSubmitting, setIsServiceSubmitting] = useState(false);

    // MODAL ZGŁOSZENIA SZKODY - ClaimInvestigationModal
    const [investigationData, setInvestigationData] = useState<{
        inventoryId: string;
        inventoryName: string;
        inventoryNumber: string;
        siteName: string;
        warehouseNotes: string;
        declaredStatus: string;
    } | null>(null);

    const [imageFile, setImageFile] = useState<File | null>(null);
    const [isUploading, setIsUploading] = useState(false);

    const [itemHistory, setItemHistory] = useState<HistoryEntry[]>([]);
    const [historyLoading, setItemHistoryLoading] = useState(false);
    const [formData, setFormData] = useState<Partial<InventoryItem>>(INITIAL_FORM_STATE);
    const [hasOpenClaim, setHasOpenClaim] = useState<string | boolean>(false);

    const fetchItems = async () => {
        setLoading(true);
        const q = query(collection(db, "inventory"), orderBy("name", "asc"));
        const snap = await getDocs(q);
        setItems(snap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[]);
        setLoading(false);
    };

    useEffect(() => { fetchItems(); }, []);

    const uploadImage = async (file: File) => {
        const storageRef = ref(storage, `inventory/${Date.now()}_${file.name}`);
        const snapshot = await uploadBytes(storageRef, file);
        return await getDownloadURL(snapshot.ref);
    };

    const generateBulkId = (name: string, type: "MAIN_CAT" | "SUB_ITEM", parentId: string) => {
        if (type === "MAIN_CAT") {
            const prefix = name.split(" ").map(w => w.substring(0, 2)).join("").toLowerCase().substring(0, 4);
            const count = items.filter(i => i.subType === "MAIN_CAT" && i.inventoryNumber.startsWith(prefix)).length;
            return `${prefix}${String(count + 1).padStart(2, '0')}`;
        } else {
            const parent = items.find(i => i.id === parentId);
            const parentPrefix = parent ? parent.inventoryNumber : "item";
            const count = items.filter(i => i.mainCategoryId === parentId).length;
            return `${parentPrefix}-${String(count + 1).padStart(2, '0')}`;
        }
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsUploading(true);
        try {
            let finalImageUrl = formData.imageUrl || "";
            if (imageFile) finalImageUrl = await uploadImage(imageFile);

            let finalInvNumber = formData.inventoryNumber || "";
            let generatedDocId = "";

            if (formData.type === "BULK" && !finalInvNumber) {
                finalInvNumber = generateBulkId(formData.name || "", formData.subType as "MAIN_CAT" | "SUB_ITEM", formData.mainCategoryId || "");
                generatedDocId = finalInvNumber;
            }

            let finalCategory = formData.category;
            let finalSubcategory = formData.subcategory;

            if (formData.type === "BULK" && formData.subType === "SUB_ITEM") {
                const parent = items.find(i => i.id === formData.mainCategoryId);
                finalCategory = parent?.name || "Rusztowania i inne";
                finalSubcategory = formData.name;
            }

            const qty = formData.type === "UNIQUE" ? 1 : (formData.subType === "MAIN_CAT" ? 0 : Number(formData.totalQuantity));

            if (editingItem) {
                const { availableQuantity, allocations, createdAt } = editingItem;
                await updateDoc(doc(db, "inventory", editingItem.id), {
                    ...formData,
                    inventoryNumber: finalInvNumber || editingItem.inventoryNumber,
                    category: finalCategory,
                    subcategory: finalSubcategory,
                    imageUrl: finalImageUrl,
                    totalQuantity: qty,
                    availableQuantity,
                    allocations,
                    createdAt
                });
            } else {
                const newDocData = {
                    ...formData,
                    inventoryNumber: finalInvNumber,
                    category: finalCategory,
                    subcategory: finalSubcategory,
                    imageUrl: finalImageUrl,
                    totalQuantity: qty,
                    availableQuantity: qty,
                    allocations: {},
                    createdAt: new Date().toISOString()
                };

                if (generatedDocId) {
                    await setDoc(doc(db, "inventory", generatedDocId), newDocData);
                } else {
                    await addDoc(collection(db, "inventory"), newDocData);
                }
            }

            setIsFormOpen(false);
            setEditingItem(null);
            setImageFile(null);
            setFormData(INITIAL_FORM_STATE);
            fetchItems();
        } catch (error: any) {
            alert("Błąd zapisu: " + error.message);
        } finally {
            setIsUploading(false);
        }
    };

    const handleDelete = async (item: InventoryItem) => {
        if (item.type === "BULK" && item.subType === "MAIN_CAT") {
            if (confirm(`UWAGA! Usunięcie systemu "${item.name}" spowoduje bezpowrotne usunięcie wszystkich przypisanych do niego elementów.\n\nCzy na pewno chcesz kontynuować?`)) {
                try {
                    const batch = writeBatch(db);
                    batch.delete(doc(db, "inventory", item.id));
                    const subItems = items.filter(i => i.mainCategoryId === item.id);
                    subItems.forEach(sub => {
                        batch.delete(doc(db, "inventory", sub.id));
                    });
                    await batch.commit();
                    fetchItems();
                } catch (error: any) {
                    alert("Błąd podczas usuwania systemu: " + error.message);
                }
            }
        } else {
            if (confirm(`Czy na pewno usunąć "${item.name}" trwale z bazy?`)) {
                try {
                    await deleteDoc(doc(db, "inventory", item.id));
                    fetchItems();
                } catch (error: any) {
                    alert("Błąd podczas usuwania: " + error.message);
                }
            }
        }
    };

    const openItemCard = async (item: InventoryItem) => {
        setSelectedItem(item);
        setShowSpecs(false);
        setItemHistoryLoading(true);
        setHasOpenClaim(false);
        try {
            const historySnap = await getDocs(query(collection(db, `inventory/${item.id}/history`), orderBy("date", "desc")));
            const rawHistory = historySnap.docs.map(d => d.data() as HistoryEntry);

            // --- NOWE: Sortowanie chronologiczne po dacie z papieru (Malejąco: od najnowszej do najstarszej) ---
            const sortedHistory = rawHistory.sort((a: any, b: any) => {
                const dateA = new Date(a.documentDate || a.date).getTime();
                const dateB = new Date(b.documentDate || b.date).getTime();
                return dateB - dateA;
            });

            setItemHistory(sortedHistory);

            const claimsQ = query(
                collection(db, "claims"),
                where("inventoryId", "==", item.id),
                orderBy("createdAt", "desc"),
                limit(1)
            );
            const claimsSnap = await getDocs(claimsQ);

            if (!claimsSnap.empty) {
                const latestClaim = claimsSnap.docs[0].data();
                setHasOpenClaim(latestClaim.status);
            }

        } catch (e) {
            setItemHistory([]);
            console.error("Błąd podczas otwierania karty urządzenia:", e);
        } finally {
            setItemHistoryLoading(false);
        }
    };

    // =========================================================================
    // FUNKCJE DO KARTY URZĄDZENIA: SERWIS
    // =========================================================================

    const openServiceModal = () => {
        if (!selectedItem) return;
        setServiceData({
            newStatus: selectedItem.status || "sprawne",
            description: "",
            cost: ""
        });
        setIsServiceModalOpen(true);
    };

    const openClaimInvestigation = () => {
        if (!selectedItem) return;
        setInvestigationData({
            inventoryId: selectedItem.id,
            inventoryName: selectedItem.name,
            inventoryNumber: selectedItem.inventoryNumber,
            siteName: selectedItem.currentLocation || "Zgłoszenie z katalogu magazynu",
            warehouseNotes: selectedItem.additionalInfo || "",
            declaredStatus: selectedItem.status,
        });
    };

    const handleServiceSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedItem) return;

        setIsServiceSubmitting(true);
        try {
            await runTransaction(db, async (transaction) => {
                const itemRef = doc(db, "inventory", selectedItem.id);
                const historyRef = doc(collection(db, `inventory/${selectedItem.id}/history`));

                transaction.update(itemRef, { status: serviceData.newStatus.toLowerCase() });

                let desc = serviceData.description.trim() || "Zmiana statusu / Wpis serwisowy";
                if (serviceData.cost.trim()) {
                    desc += ` | Koszt naprawy: ${serviceData.cost} PLN`;
                }

                transaction.set(historyRef, {
                    date: new Date().toISOString(),
                    type: "SERWIS",
                    description: desc,
                    status: serviceData.newStatus.toLowerCase(),
                    user: `${user?.firstName} ${user?.lastName}`
                });
            });

            alert("Wpis serwisowy został dodany!");
            const updatedItem = { ...selectedItem, status: serviceData.newStatus.toLowerCase() };
            setSelectedItem(updatedItem);
            setIsServiceModalOpen(false);
            fetchItems();
            openItemCard(updatedItem);
        } catch (error) {
            alert("Błąd: " + error);
        } finally {
            setIsServiceSubmitting(false);
        }
    };

    // --- NOWA FUNKCJA: NADAWANIE NUMERU PRZEZ MAGAZYNIERA ---
    const handleAssignNumber = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedItem || !newInvNumber.trim()) return;

        // Sprawdzamy, czy ktoś inny nie używa już tego numeru w firmie
        const isTaken = items.some(i => i.inventoryNumber.toLowerCase() === newInvNumber.trim().toLowerCase() && i.id !== selectedItem.id);
        if (isTaken) return alert("⚠️ Ten numer magazynowy jest już zajęty przez inny sprzęt!");

        setIsUploading(true);
        try {
            await runTransaction(db, async (transaction) => {
                const itemRef = doc(db, "inventory", selectedItem.id);
                const historyRef = doc(collection(db, `inventory/${selectedItem.id}/history`));

                transaction.update(itemRef, {
                    inventoryNumber: newInvNumber.trim(),
                    status: "sprawne" // Zmieniamy status z "do nadania..." na "sprawne"
                });

                // Dodajemy wpis o nadaniu kodu do historii
                transaction.set(historyRef, {
                    date: new Date().toISOString(),
                    type: "NADAJ_KOD",
                    description: `Nadano właściwy numer magazynowy urządzenia: ${newInvNumber.trim()}. Stan zmieniony na: sprawne.`,
                    status: "sprawne",
                    user: `${user?.firstName} ${user?.lastName}`
                });
            });

            alert("✅ Nadano właściwy numer magazynowy!");
            setIsAssignNumberOpen(false);
            setSelectedItem(null); // Zamykamy kartę
            fetchItems(); // Odświeżamy tabelę
        } catch (error: any) {
            alert("Błąd: " + error.message);
        } finally {
            setIsUploading(false);
        }
    };

    // LOGIKA FILTROWANIA
    const filteredItems = items.filter(item => {
        if (item.type !== activeTab) return false;
        const matchesSearch = item.name.toLowerCase().includes(searchTerm.toLowerCase()) || item.inventoryNumber.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesLoc = locFilter === "ALL" || item.currentLocation === locFilter;
        const matchesStatus = statusFilter === "ALL" || item.status === statusFilter;
        return matchesSearch && matchesLoc && matchesStatus;
    });

    const uniqueLocations = Array.from(new Set(items.filter(i => i.type === activeTab).map(i => i.currentLocation))).sort();
    const mainSystems = items.filter(i => i.type === "BULK" && i.subType === "MAIN_CAT");

    const renderBulkGroups = () => {
        const mainCats = filteredItems.filter(i => i.subType === "MAIN_CAT");
        const subs = filteredItems.filter(i => i.subType === "SUB_ITEM");

        return mainCats.map(main => (
            <div key={main.id} className="mb-6 border rounded-2xl overflow-hidden shadow-sm bg-white animate-fade-in">
                <div className="bg-slate-800 text-white p-4 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <img src={main.imageUrl || 'https://via.placeholder.com/50'} className="w-12 h-12 object-cover rounded-lg border border-slate-600" alt="kat" />
                        <div>
                            <h2 className="text-lg font-black uppercase tracking-tight">{main.name}</h2>
                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">System / Kod: {main.inventoryNumber}</p>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <button onClick={() => { setEditingItem(main); setFormData({ ...main }); setIsFormOpen(true); }} className="text-xs bg-slate-700 text-white px-3 py-1 rounded hover:bg-slate-600 transition font-bold">Edytuj System</button>
                        <button onClick={() => handleDelete(main)} className="text-xs bg-red-900 text-red-100 px-3 py-1 rounded hover:bg-red-800 transition font-bold">Usuń System</button>
                    </div>
                </div>
                <table className="w-full text-left">
                    <thead className="bg-slate-50 border-b text-[10px] uppercase font-black text-slate-400">
                        <tr><th className="p-4 w-20">Zdjęcie</th><th className="p-4">Element / Podkategoria</th><th className="p-4 text-center">Kod</th><th className="p-4 text-center">Magazyn / Razem</th><th className="p-4 text-right">Akcje</th></tr>
                    </thead>
                    <tbody className="text-sm">
                        {subs.filter(s => s.mainCategoryId === main.id).map(sub => (
                            <tr key={sub.id} className="border-b last:border-0 hover:bg-slate-50 transition">
                                <td className="p-3"><img src={sub.imageUrl || 'https://via.placeholder.com/40'} className="w-12 h-12 object-cover rounded border" alt="item" /></td>
                                <td className="p-4 cursor-pointer" onClick={() => openItemCard(sub)}>
                                    <p className="font-bold text-slate-700">{sub.name}</p>
                                    <p className="text-[10px] text-slate-400">{sub.category} / {sub.subcategory}</p>
                                </td>
                                <td className="p-4 text-center font-mono text-xs text-blue-600 font-bold">{sub.inventoryNumber}</td>
                                <td className="p-4 text-center font-black">{sub.availableQuantity} / {sub.totalQuantity}</td>
                                <td className="p-4 text-right space-x-3">
                                    <button onClick={() => { setEditingItem(sub); setFormData({ ...sub }); setIsFormOpen(true); }} className="text-blue-600 hover:underline font-bold text-xs">Edytuj</button>
                                    <button onClick={() => handleDelete(sub)} className="text-red-400 hover:underline font-bold text-xs">Usuń</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        ));
    };

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto">
            <div className="flex justify-between items-center mb-8">
                <h1 className="text-3xl font-bold text-slate-800 tracking-tighter">Katalog Sprzętu PESAM</h1>
                <button onClick={() => { setEditingItem(null); setFormData(INITIAL_FORM_STATE); setIsFormOpen(true); }} className="bg-blue-600 text-white px-6 py-2 rounded-lg font-bold shadow-lg transition hover:bg-blue-700">
                    + Dodaj Sprzęt
                </button>
            </div>

            <div className="flex gap-2 mb-6 bg-slate-100 p-1 rounded-2xl w-fit border shadow-inner">
                <button onClick={() => setActiveTab("UNIQUE")} className={`px-10 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'UNIQUE' ? 'bg-white text-blue-600 shadow-xl scale-105' : 'text-slate-500 hover:text-slate-700'}`}>NARZĘDZIA</button>
                <button onClick={() => setActiveTab("BULK")} className={`px-10 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'BULK' ? 'bg-white text-orange-600 shadow-xl scale-105' : 'text-slate-500 hover:text-slate-700'}`}>RUSZTOWANIA</button>
            </div>

            <div className="bg-white p-4 rounded-xl mb-6 shadow-sm border border-slate-200 grid grid-cols-1 md:grid-cols-3 gap-4">
                <input type="text" placeholder="Szukaj..." className="p-2 border rounded-lg outline-none focus:ring-2 focus:ring-blue-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                <select className="p-2 border rounded-lg bg-white" value={locFilter} onChange={(e) => setLocFilter(e.target.value)}>
                    <option value="ALL">Wszystkie lokalizacje</option>
                    {uniqueLocations.map((loc, index) => (
                        <option key={loc ? String(loc) : `loc-${index}`} value={loc || ""}>
                            {loc || "Brak lokalizacji"}
                        </option>
                    ))}
                </select>
                <select className="p-2 border rounded-lg bg-white" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                    <option value="ALL">Wszystkie statusy</option>
                    <option value="sprawne">Sprawne</option>
                    <option value="do przeglądu">Do przeglądu</option>
                    <option value="uszkodzone">Uszkodzone</option>
                    <option value="złom">Złom</option>
                </select>
            </div>

            {loading ? <div className="p-20 text-center animate-pulse">Ładowanie bazy danych...</div> : (
                activeTab === "UNIQUE" ? (
                    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                        <table className="w-full text-left border-collapse">
                            <thead className="bg-slate-50 border-b text-[10px] uppercase font-black text-slate-400">
                                <tr><th className="p-4">Zdjęcie</th><th className="p-4">Nazwa Urządzenia</th><th className="p-4 text-center">Nr Mag.</th><th className="p-4">Status</th><th className="p-4">Lokalizacja</th><th className="p-4 text-center">Stan</th><th className="p-4 text-right">Akcje</th></tr>
                            </thead>
                            <tbody className="text-sm">
                                {filteredItems.map(item => (
                                    <tr key={item.id} className="border-b border-slate-100 hover:bg-slate-50 transition">
                                        <td className="p-4"><img src={item.imageUrl || 'https://via.placeholder.com/50'} className="w-12 h-12 object-cover rounded-md border" /></td>
                                        <td className="p-4 cursor-pointer font-bold text-slate-800" onClick={() => openItemCard(item)}>
                                            {item.name}
                                            <p className="text-[10px] text-slate-400 font-bold uppercase">{item.category} / {item.subcategory}</p>
                                        </td>
                                        <td className="p-4 text-center font-mono font-bold text-blue-600">{item.inventoryNumber}</td>
                                        <td className="p-4">
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase 
                                                ${item.status === 'sprawne' ? 'bg-green-100 text-green-700' :
                                                    item.status === 'uszkodzone' ? 'bg-red-100 text-red-700' :
                                                        item.status === 'do przeglądu' ? 'bg-yellow-100 text-yellow-800' : 'bg-slate-100 text-slate-700'}`}>
                                                {item.status}
                                            </span>
                                        </td>
                                        <td className="p-4 text-slate-600">{item.currentLocation}</td>
                                        <td className="p-4 text-center font-bold">{item.availableQuantity} / {item.totalQuantity}</td>
                                        <td className="p-4 text-right space-x-3">
                                            <button onClick={() => { setEditingItem(item); setFormData({ ...item }); setIsFormOpen(true); }} className="text-blue-600 hover:underline font-bold text-xs">Edytuj</button>
                                            <button onClick={() => handleDelete(item)} className="text-red-400 hover:underline text-xs font-bold">Usuń</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <div>{renderBulkGroups()}</div>
                )
            )}

            {/* KARTA URZĄDZENIA */}
            {selectedItem && (
                <div className="fixed inset-0 bg-black/60 z-40 flex justify-end" onClick={() => setSelectedItem(null)}>
                    <div className="bg-white w-full max-w-xl h-full p-8 shadow-2xl animate-slide-in overflow-y-auto" onClick={e => e.stopPropagation()}>
                        <div className="flex justify-between items-start mb-4">
                            <div className="flex-1">
                                <h2 className="text-2xl font-black text-slate-800">{selectedItem.name}</h2>
                                {selectedItem.status === "do nadania numeru" && (
                                    <span className="inline-block bg-red-100 text-red-800 text-[10px] font-black px-2.5 py-1 rounded-full uppercase tracking-wider mt-1 animate-pulse">
                                        ⚠️ Oczekuje na kod magazynowy
                                    </span>
                                )}
                            </div>
                            <button onClick={() => setSelectedItem(null)} className="text-3xl text-slate-400 hover:text-slate-900 leading-none">&times;</button>
                        </div>

                        {/* DUŻY ŻÓŁTY BANER OSTRZEGAWCZY DLA MAGAZYNIERA */}
                        {selectedItem.status === "do nadania numeru" && (
                            <div className="bg-yellow-50 border-2 border-yellow-200 rounded-2xl p-4 mb-6 flex flex-col sm:flex-row items-center justify-between gap-3 animate-fade-in shadow-sm">
                                <div className="text-xs text-yellow-800 font-bold text-center sm:text-left">
                                    <span className="text-lg">📢</span> Ten sprzęt został kupiony bezpośrednio na budowę. <br />
                                    Nie posiada jeszcze kodu kreskowego ani numeru!
                                </div>
                                <button
                                    onClick={() => { setNewInvNumber(""); setIsAssignNumberOpen(true); }}
                                    className="bg-yellow-500 hover:bg-yellow-600 text-white font-black text-xs px-4 py-2.5 rounded-xl shadow transition whitespace-nowrap"
                                >
                                    🏷️ Nadaj Numer Teraz
                                </button>
                            </div>
                        )}

                        {/* AKCJE SERWISOWE I SĄDOWE */}
                        <div className="flex flex-wrap gap-3 mb-8">
                            <button onClick={() => { setServiceData({ newStatus: selectedItem.status, description: "", cost: "" }); setIsServiceModalOpen(true); }} className="flex-1 py-3 bg-blue-50 text-blue-700 border border-blue-200 rounded-xl font-bold text-xs hover:bg-blue-100 transition flex items-center justify-center gap-2">🛠️ Dodaj wpis serwisowy / Zmień stan</button>

                            {selectedItem.status !== 'sprawne' && !hasOpenClaim && (
                                <button
                                    onClick={openClaimInvestigation}
                                    className="flex-1 py-3 bg-red-50 text-red-700 border border-red-200 rounded-xl font-bold text-xs hover:bg-red-100 transition flex items-center justify-center gap-2 font-black"
                                >
                                    ⚖️ Zgłoś do Sądu (Szkoda)
                                </button>
                            )}

                            {(hasOpenClaim === 'NOWA' || hasOpenClaim === 'W_TOKU') && (
                                <div className="flex-1 py-3 bg-orange-100 text-orange-800 border border-orange-200 rounded-xl font-bold text-xs flex items-center justify-center gap-2 shadow-inner">
                                    <span>⏳</span> Sprawa w Sądzie w toku
                                </div>
                            )}

                            {hasOpenClaim === 'ZAMKNIETA' && (
                                <div className="flex-1 py-3 bg-slate-100 text-slate-500 border border-slate-200 rounded-xl font-bold text-xs flex items-center justify-center gap-2 shadow-inner">
                                    <span>📁</span> Sprawa została zamknięta
                                </div>
                            )}
                        </div>

                        <div className="relative mb-8">
                            <img src={selectedItem.imageUrl || 'https://via.placeholder.com/400x300'} className="w-full h-64 object-cover rounded-2xl shadow-lg border" />
                            <button onClick={() => setShowSpecs(!showSpecs)} className="absolute bottom-4 right-4 bg-blue-600 text-white w-10 h-10 rounded-full flex items-center justify-center font-serif italic text-xl shadow-lg hover:scale-110 transition"> i </button>
                        </div>
                        {showSpecs && (
                            <div className="bg-blue-50 border border-blue-200 p-5 rounded-2xl mb-8 animate-fade-in">
                                <h4 className="text-xs font-bold text-blue-800 uppercase mb-2">Specyfikacja:</h4>
                                <p className="text-sm text-blue-900 whitespace-pre-wrap">{selectedItem.additionalInfo || "Brak informacji."}</p>
                            </div>
                        )}
                        <div className="grid grid-cols-2 gap-4 mb-10 bg-slate-50 p-6 rounded-2xl border text-sm">
                            <div><p className="text-[10px] font-bold text-slate-400 uppercase">Nr Magazynowy</p><p className="font-mono font-bold text-lg">{selectedItem.inventoryNumber}</p></div>
                            <div>
                                <p className="text-[10px] font-bold text-slate-400 uppercase">Status</p>
                                <p className={`font-black uppercase 
                                    ${selectedItem.status === 'sprawne' ? 'text-green-600' :
                                        selectedItem.status === 'uszkodzone' ? 'text-red-600' :
                                            selectedItem.status === 'do przeglądu' ? 'text-yellow-600' : 'text-slate-600'}`}>
                                    {selectedItem.status}
                                </p>
                            </div>
                            <div className="border-t pt-4"><p className="text-[10px] font-bold text-slate-400 uppercase">Cena / Faktura</p><p className="font-bold text-slate-800 text-xs">{selectedItem.purchasePrice} zł / {selectedItem.invoiceNumber || 'Brak'}</p></div>
                            <div className="border-t pt-4"><p className="text-[10px] font-bold text-slate-400 uppercase">Data zakupu</p><p className="font-bold text-slate-800">{selectedItem.purchaseDate || "---"}</p></div>
                        </div>
                        <h3 className="font-bold uppercase text-[10px] text-slate-400 mb-4 tracking-widest text-center border-b pb-2">Historia zdarzeń</h3>

                        {historyLoading ? (
                            <div className="text-center p-4 text-slate-400 animate-pulse">Ładowanie historii...</div>
                        ) : (
                            <div className="border rounded-xl overflow-hidden text-[11px]">
                                <table className="w-full text-left">
                                    <thead className="bg-slate-100 border-b"><tr><th className="p-3">Data</th><th className="p-3">Typ</th><th className="p-3">Opis</th><th className="p-3">Osoba</th></tr></thead>
                                    <tbody>
                                        {itemHistory.length === 0 ? (
                                            <tr><td colSpan={4} className="p-4 text-center text-slate-400">Brak historii operacji.</td></tr>
                                        ) : (
                                            itemHistory.map((h, i) => (
                                                <tr key={i} className="border-b last:border-0 hover:bg-slate-50">
                                                    <td className="p-3 whitespace-nowrap">
                                                        {new Date((h as any).documentDate || h.date).toLocaleDateString()}
                                                    </td>
                                                    <td className={`p-3 font-bold ${h.type.includes("SERWIS") ? 'text-blue-600' : ''}`}>{h.type}</td>
                                                    <td className="p-3">{h.description}</td>
                                                    <td className="p-3 text-slate-400">{h.user}</td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* FORMULARZ DODAWANIA/EDYCJI (GŁÓWNY) */}
            {isFormOpen && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl p-8 max-h-[90vh] overflow-y-auto animate-fade-in">
                        <h2 className="text-2xl font-bold mb-6 text-slate-800">{editingItem ? "Edytuj dane" : "Dodaj sprzęt"}</h2>
                        <form onSubmit={handleSave} className="grid grid-cols-1 md:grid-cols-2 gap-5">
                            <div className="md:col-span-2 flex bg-slate-100 p-1 rounded-xl mb-2">
                                <button type="button" disabled={!!editingItem} onClick={() => setFormData({ ...formData, type: "UNIQUE" })} className={`flex-1 py-2 rounded-lg font-bold text-xs transition ${formData.type === 'UNIQUE' ? 'bg-white shadow text-blue-600' : 'text-slate-400'}`}>NARZĘDZIE (UNIQUE)</button>
                                <button type="button" disabled={!!editingItem} onClick={() => setFormData({ ...formData, type: "BULK", subType: "SUB_ITEM" })} className={`flex-1 py-2 rounded-lg font-bold text-xs transition ${formData.type === 'BULK' ? 'bg-white shadow text-blue-600' : 'text-slate-400'}`}>RUSZTOWANIE (BULK)</button>
                            </div>

                            {formData.type === "BULK" && (
                                <div className="md:col-span-2 flex gap-4 p-4 bg-orange-50 border border-orange-100 rounded-xl mb-2 text-sm">
                                    <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="subType" checked={formData.subType === "MAIN_CAT"} onChange={() => setFormData({ ...formData, subType: "MAIN_CAT" })} /><span className="font-bold text-orange-800">To jest System (np. PR firmy)</span></label>
                                    <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="subType" checked={formData.subType === "SUB_ITEM"} onChange={() => setFormData({ ...formData, subType: "SUB_ITEM" })} /><span className="font-bold text-orange-800">To jest Element (np. Maszt)</span></label>
                                </div>
                            )}

                            {formData.type === "BULK" && formData.subType === "SUB_ITEM" && (
                                <div className="md:col-span-2">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase">Wybierz System (Rodzica)</label>
                                    <select required value={formData.mainCategoryId} onChange={e => setFormData({ ...formData, mainCategoryId: e.target.value })} className="w-full p-2 border rounded-xl bg-white outline-none">
                                        <option value="" disabled>-- Wybierz system z listy --</option>
                                        {mainSystems.map((sys, index) => (
                                            <option key={sys.id || `sys-${index}`} value={sys.id}>
                                                {sys.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            <div className="md:col-span-2"><label className="text-[10px] font-bold text-slate-400 uppercase">Wgraj zdjęcie (Plik)</label><input type="file" accept="image/*" onChange={(e) => setImageFile(e.target.files ? e.target.files[0] : null)} className="w-full p-2 border rounded-xl bg-slate-50 text-xs" /></div>

                            <div className="md:col-span-2">
                                <label className="text-[10px] font-bold text-slate-400 uppercase">
                                    {formData.subType === "MAIN_CAT" ? "Nazwa Systemu" : "Nazwa urządzenia / Elementu"}
                                </label>
                                <input required value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} className="w-full p-3 border rounded-xl outline-none focus:ring-2" />
                            </div>

                            {formData.type === "UNIQUE" && (
                                <>
                                    <div><label className="text-[10px] font-bold text-slate-400 uppercase">Kategoria</label><input value={formData.category} onChange={e => setFormData({ ...formData, category: e.target.value })} className="w-full p-2 border rounded-xl" /></div>
                                    <div><label className="text-[10px] font-bold text-slate-400 uppercase">Podkategoria</label><input value={formData.subcategory} onChange={e => setFormData({ ...formData, subcategory: e.target.value })} className="w-full p-2 border rounded-xl" /></div>
                                    <div><label className="text-[10px] font-bold text-slate-400 uppercase">Nr Mag.</label><input required value={formData.inventoryNumber} onChange={e => setFormData({ ...formData, inventoryNumber: e.target.value })} className="w-full p-2 border rounded-xl" /></div>
                                    <div><label className="text-[10px] font-bold text-slate-400 uppercase">Lokalizacja</label><input required value={formData.currentLocation} onChange={e => setFormData({ ...formData, currentLocation: e.target.value })} className="w-full p-2 border rounded-xl" /></div>
                                </>
                            )}

                            {formData.type === "BULK" && formData.subType === "SUB_ITEM" && (
                                <>
                                    <div>
                                        <label className="text-[10px] font-bold text-slate-400 uppercase">Kod Elementu (Opcjonalnie)</label>
                                        <input value={formData.inventoryNumber} onChange={e => setFormData({ ...formData, inventoryNumber: e.target.value })} placeholder="Automatyczny" className="w-full p-2 border rounded-xl bg-slate-50" />
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-bold text-slate-400 uppercase">Ilość całkowita</label>
                                        <input type="number" required value={formData.totalQuantity} onChange={e => setFormData({ ...formData, totalQuantity: Number(e.target.value) })} className="w-full p-2 border rounded-xl" />
                                    </div>
                                </>
                            )}

                            {formData.subType !== "MAIN_CAT" && (
                                <>
                                    <div className="md:col-span-2 mt-4 border-t pt-4"><h3 className="font-bold text-sm text-slate-800">Dane Finansowe & Info</h3></div>
                                    <div className="md:col-span-2"><label className="text-[10px] font-bold text-slate-400 uppercase">Specyfikacja (Pole "i")</label><textarea value={formData.additionalInfo} onChange={e => setFormData({ ...formData, additionalInfo: e.target.value })} className="w-full p-3 border rounded-xl text-sm h-16" /></div>
                                    <div><label className="text-[10px] font-bold text-slate-400 uppercase">Cena netto</label><input type="number" step="0.01" value={formData.purchasePrice} onChange={e => setFormData({ ...formData, purchasePrice: Number(e.target.value) })} className="w-full p-2 border rounded-xl" /></div>
                                    <div><label className="text-[10px] font-bold text-slate-400 uppercase">Numer Faktury</label><input value={formData.invoiceNumber} onChange={e => setFormData({ ...formData, invoiceNumber: e.target.value })} className="w-full p-2 border rounded-xl" /></div>
                                    <div className="md:col-span-2"><label className="text-[10px] font-bold text-slate-400 uppercase">Data zakupu</label><input type="date" value={formData.purchaseDate} onChange={e => setFormData({ ...formData, purchaseDate: e.target.value })} className="w-full p-2 border rounded-xl" /></div>
                                </>
                            )}

                            <div className="md:col-span-2 flex gap-3 pt-6 border-t mt-2">
                                <button type="button" onClick={() => setIsFormOpen(false)} className="flex-1 py-3 text-slate-500 border rounded-2xl font-bold">Anuluj</button>
                                <button type="submit" disabled={isUploading} className="flex-1 py-3 bg-blue-600 text-white font-black rounded-2xl shadow-lg hover:bg-blue-700">{isUploading ? "WGRYWANIE..." : "ZAPISZ"}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* MODAL SERWISOWY */}
            {isServiceModalOpen && selectedItem && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-xl font-black text-slate-800">🛠️ Wpis Serwisowy</h2>
                            <button onClick={() => setIsServiceModalOpen(false)} className="text-2xl text-slate-400 hover:text-slate-800">&times;</button>
                        </div>

                        <div className="mb-6 p-4 bg-slate-50 rounded-xl border border-slate-200">
                            <p className="text-xs text-slate-500 uppercase font-bold mb-1">Wybrane urządzenie:</p>
                            <p className="font-bold text-slate-800">{selectedItem.name} <span className="text-blue-600 font-mono text-sm">(Nr: {selectedItem.inventoryNumber})</span></p>
                        </div>

                        <form onSubmit={handleServiceSubmit} className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-600 uppercase mb-2">Nowy status urządzenia:</label>
                                <select
                                    value={serviceData.newStatus}
                                    onChange={(e) => setServiceData({ ...serviceData, newStatus: e.target.value })}
                                    className="w-full p-3 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 font-bold bg-white"
                                >
                                    <option value="sprawne">✅ Sprawne</option>
                                    <option value="do przeglądu">⚠️ Do przeglądu</option>
                                    <option value="uszkodzone">❌ Uszkodzone</option>
                                    <option value="złom">🗑️ Złom / Likwidacja</option>
                                </select>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-slate-600 uppercase mb-2">Opis operacji / Co zostało zrobione? (Opcjonalnie):</label>
                                <textarea
                                    rows={3}
                                    placeholder="np. Wymieniono szczotki, wyczyszczono filtry..."
                                    value={serviceData.description}
                                    onChange={(e) => setServiceData({ ...serviceData, description: e.target.value })}
                                    className="w-full p-3 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-slate-600 uppercase mb-2">Koszt naprawy w PLN (Opcjonalnie):</label>
                                <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    placeholder="np. 45.50"
                                    value={serviceData.cost}
                                    onChange={(e) => setServiceData({ ...serviceData, cost: e.target.value })}
                                    className="w-full p-3 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                                />
                            </div>

                            <div className="flex gap-3 pt-4 border-t border-slate-100">
                                <button type="button" onClick={() => setIsServiceModalOpen(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition">Anuluj</button>
                                <button type="submit" disabled={isServiceSubmitting} className="flex-1 py-3 bg-blue-600 text-white font-black rounded-xl hover:bg-blue-700 shadow-md transition disabled:opacity-50">
                                    {isServiceSubmitting ? "ZAPISYWANIE..." : "ZAPISZ WPIS"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* MODAL: NADAWANIE NUMERU MAGAZYNOWEGO (DLA URZĄDZEŃ OD KSIĘGOWOŚCI) */}
            {isAssignNumberOpen && selectedItem && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 animate-fade-in border-t-4 border-yellow-500">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-lg font-black text-slate-800">🏷️ Nadaj numer magazynowy</h2>
                            <button onClick={() => setIsAssignNumberOpen(false)} className="text-2xl text-slate-400 hover:text-slate-800">&times;</button>
                        </div>

                        <div className="bg-slate-50 border p-4 rounded-xl mb-4 text-xs">
                            <span className="font-bold text-slate-400 uppercase">Nazwa urządzenia:</span>
                            <p className="font-bold text-slate-800 text-sm mt-0.5">{selectedItem.name}</p>
                            <p className="text-[10px] text-slate-400 mt-2">Cena zakupu: {selectedItem.purchasePrice} zł • FV: {selectedItem.invoiceNumber}</p>
                        </div>

                        <form onSubmit={handleAssignNumber} className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-600 uppercase mb-1.5">Wpisz lub zeskanuj kod:</label>
                                <input
                                    required
                                    autoFocus
                                    type="text"
                                    placeholder="np. 254"
                                    value={newInvNumber}
                                    onChange={e => setNewInvNumber(e.target.value)}
                                    className="w-full p-3 border-2 rounded-xl text-center font-bold text-xl outline-none focus:border-yellow-500 bg-slate-50 uppercase"
                                />
                            </div>

                            <p className="text-[10px] text-slate-400 text-center leading-relaxed">
                                Zatwierdzenie zmieni status na <span className="text-green-600 font-bold">SPRAWNE</span> i trwale przypisze ten kod do karty urządzenia w systemie.
                            </p>

                            <div className="flex gap-3 pt-4 border-t">
                                <button type="button" onClick={() => setIsAssignNumberOpen(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition">Anuluj</button>
                                <button type="submit" disabled={isUploading || !newInvNumber.trim()} className="flex-1 py-3 bg-yellow-500 hover:bg-yellow-600 text-white font-black rounded-xl shadow-md transition disabled:opacity-50">
                                    {isUploading ? "Zapisywanie..." : "ZAPISZ KOD"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* MODAL ZGŁOSZENIA SZKODY - ClaimInvestigationModal */}
            {investigationData && (
                <ClaimInvestigationModal
                    isOpen={!!investigationData}
                    onClose={() => setInvestigationData(null)}
                    onClaimCreated={() => {
                        setInvestigationData(null);
                        setSelectedItem(null);
                        fetchItems();
                    }}
                    inventoryId={investigationData.inventoryId}
                    inventoryName={investigationData.inventoryName}
                    inventoryNumber={investigationData.inventoryNumber}
                    siteName={investigationData.siteName}
                    reportedByUid={user?.uid || ""}
                    reportedByName={`${user?.firstName} ${user?.lastName}`}
                    warehouseNotes={investigationData.warehouseNotes}
                    declaredStatus={investigationData.declaredStatus}
                />
            )}
        </div>
    );
} 