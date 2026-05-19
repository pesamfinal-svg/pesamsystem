"use client";

import { useState, useEffect } from "react";
import {
    collection, getDocs, doc, setDoc, updateDoc, deleteDoc, query, orderBy, addDoc
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";

// --- INTERFEJSY ---
interface Worker {
    id: string;
    firstName: string;
    lastName: string;
    phone: string;
    notes: string;
    lastAssignedSite?: string;
    createdAt: string;
}
// NOWY INTERFEJS DLA NARZĘDZI OSOBISTYCH
interface PersonalIssueItem {
    id: string;
    name: string;
    category: string;
    unit: string;
    createdAt: string;
}

const INITIAL_WORKER_STATE: Partial<Worker> = { firstName: "", lastName: "", phone: "", notes: "" };
const INITIAL_ITEM_STATE: Partial<PersonalIssueItem> = { name: "", category: "Narzędzia ręczne", unit: "szt." };

// KOMPONENT ZARZĄDZANIA SŁOWNIKIEM NARZĘDZI
function PersonalItemsManager() {
    const [items, setItems] = useState<PersonalIssueItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingItem, setEditingItem] = useState<PersonalIssueItem | null>(null);
    const [formData, setFormData] = useState<Partial<PersonalIssueItem>>(INITIAL_ITEM_STATE);

    const fetchItems = async () => {
        setLoading(true);
        const q = query(collection(db, "personalIssueItems"), orderBy("category"), orderBy("name"));
        const snap = await getDocs(q);
        setItems(snap.docs.map(d => ({ id: d.id, ...d.data() })) as PersonalIssueItem[]);
        setLoading(false);
    };

    useEffect(() => { fetchItems(); }, []);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formData.name) return alert("Nazwa jest wymagana!");

        try {
            if (editingItem) {
                await updateDoc(doc(db, "personalIssueItems", editingItem.id), { ...formData });
            } else {
                await addDoc(collection(db, "personalIssueItems"), { ...formData, createdAt: new Date().toISOString() });
            }
            setIsFormOpen(false);
            setEditingItem(null);
            setFormData(INITIAL_ITEM_STATE);
            fetchItems();
        } catch (error: any) { alert("Błąd zapisu: " + error.message); }
    };

    const handleDelete = async (item: PersonalIssueItem) => {
        if (confirm(`Czy na pewno chcesz usunąć "${item.name}" ze słownika?`)) {
            await deleteDoc(doc(db, "personalIssueItems", item.id));
            fetchItems();
        }
    };

    return (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 h-full flex flex-col">
            <div className="p-4 border-b flex justify-between items-center">
                <h2 className="font-bold text-slate-700">Słownik Narzędzi Osobistych</h2>
                <button onClick={() => { setEditingItem(null); setFormData(INITIAL_ITEM_STATE); setIsFormOpen(true); }} className="bg-orange-500 text-white px-4 py-1.5 rounded-lg font-bold text-xs shadow-md transition hover:bg-orange-600">+ Dodaj Narzędzie</button>
            </div>
            <div className="flex-1 overflow-y-auto">
                {loading ? <div className="p-4 text-center text-xs animate-pulse">Ładowanie...</div> : (
                    <table className="w-full text-sm">
                        <thead className="text-xs text-slate-500 bg-slate-50"><tr className="border-b"><th className="p-3">Nazwa</th><th className="p-3">Kategoria</th><th className="p-3">J.m.</th><th className="p-3"></th></tr></thead>
                        <tbody>
                            {items.map(item => (
                                <tr key={item.id} className="border-b last:border-0">
                                    <td className="p-3 font-bold">{item.name}</td>
                                    <td className="p-3 text-slate-500">{item.category}</td>
                                    <td className="p-3 text-slate-400">{item.unit}</td>
                                    <td className="p-3 text-right space-x-2">
                                        <button onClick={() => { setEditingItem(item); setFormData(item); setIsFormOpen(true); }} className="text-blue-600 text-xs font-bold">Edytuj</button>
                                        <button onClick={() => handleDelete(item)} className="text-red-500 text-xs font-bold">Usuń</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
            {isFormOpen && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
                        <h2 className="text-xl font-bold mb-6">{editingItem ? "Edytuj narzędzie" : "Nowe narzędzie"}</h2>
                        <form onSubmit={handleSave} className="space-y-4">
                            <div><label className="text-xs font-bold">Nazwa</label><input required value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} className="w-full p-2 border rounded-lg" /></div>
                            <div><label className="text-xs font-bold">Kategoria</label><input value={formData.category} onChange={e => setFormData({ ...formData, category: e.target.value })} className="w-full p-2 border rounded-lg" /></div>
                            <div><label className="text-xs font-bold">Jednostka miary</label>
                                <select value={formData.unit} onChange={e => setFormData({ ...formData, unit: e.target.value })} className="w-full p-2 border rounded-lg bg-white">
                                    <option>szt.</option><option>para</option><option>opak.</option><option>m</option>
                                </select>
                            </div>
                            <div className="flex gap-3 pt-4 border-t"><button type="button" onClick={() => setIsFormOpen(false)} className="flex-1 py-2 text-slate-500 border rounded-lg">Anuluj</button><button type="submit" className="flex-1 py-2 bg-orange-600 text-white font-bold rounded-lg">ZAPISZ</button></div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

// GŁÓWNY KOMPONENT STRONY
export default function WorkersPage() {
    const [workers, setWorkers] = useState<Worker[]>([]);
    const [loading, setLoading] = useState(true);

    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingWorker, setEditingWorker] = useState<Worker | null>(null);
    const [formData, setFormData] = useState<Partial<Worker>>(INITIAL_WORKER_STATE);

    const [selectedWorker, setSelectedWorker] = useState<Worker | null>(null);
    const [workerHistory, setWorkerHistory] = useState<any[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    const fetchWorkers = async () => {
        setLoading(true);
        const q = query(collection(db, "workers"), orderBy("lastName", "asc"));
        const snap = await getDocs(q);
        setWorkers(snap.docs.map(d => ({ id: d.id, ...d.data() })) as Worker[]);
        setLoading(false);
    };

    useEffect(() => { fetchWorkers(); }, []);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
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
            fetchWorkers();
        } catch (error: any) { alert("Błąd zapisu: " + error.message); }
    };

    const handleDelete = async (worker: Worker) => {
        if (confirm(`Czy na pewno chcesz usunąć pracownika "${worker.firstName} ${worker.lastName}" z bazy?`)) {
            await deleteDoc(doc(db, "workers", worker.id));
            fetchWorkers();
        }
    };

    const openWorkerCard = (worker: Worker) => {
        setSelectedWorker(worker);
        setHistoryLoading(true);
        setTimeout(() => { setWorkerHistory([]); setHistoryLoading(false); }, 500);
    };

    return (
        <div className="p-6 md:p-10 max-w-[1800px] mx-auto">
            <div className="flex justify-between items-center mb-8">
                <h1 className="text-3xl font-bold text-slate-800 tracking-tighter">Pracownicy Fizyczni</h1>
                <button onClick={() => { setEditingWorker(null); setFormData(INITIAL_WORKER_STATE); setIsFormOpen(true); }} className="bg-blue-600 text-white px-6 py-2 rounded-lg font-bold shadow-lg transition hover:bg-blue-700">+ Dodaj Pracownika</button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8" style={{ minHeight: '70vh' }}>
                {/* LEWA KOLUMNA - PRACOWNICY */}
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden h-full flex flex-col">
                    <div className="p-4 border-b"><h2 className="font-bold text-slate-700">Lista Pracowników</h2></div>
                    <div className="flex-1 overflow-y-auto">
                        {loading ? <div className="p-4 text-center text-xs animate-pulse">Ładowanie...</div> : (
                            <table className="w-full text-left">
                                <thead className="bg-slate-50 border-b text-xs uppercase font-black text-slate-500"><tr><th className="p-4">Imię i Nazwisko</th><th className="p-4">Nr telefonu</th><th className="p-4 text-right">Akcje</th></tr></thead>
                                <tbody className="text-sm">
                                    {workers.map(worker => (
                                        <tr key={worker.id} className="border-b last:border-0 hover:bg-slate-50 transition">
                                            <td className="p-4 cursor-pointer" onClick={() => openWorkerCard(worker)}><p className="font-bold text-slate-800">{worker.lastName} {worker.firstName}</p></td>
                                            <td className="p-4 text-slate-600">{worker.phone}</td>
                                            <td className="p-4 text-right space-x-3"><button onClick={() => { setEditingWorker(worker); setFormData(worker); setIsFormOpen(true); }} className="text-blue-600 hover:underline font-bold text-xs">Edytuj</button><button onClick={() => handleDelete(worker)} className="text-red-400 hover:underline font-bold text-xs">Usuń</button></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>

                {/* PRAWA KOLUMNA - SŁOWNIK NARZĘDZI */}
                <PersonalItemsManager />
            </div>

            {/* KARTA PRACOWNIKA */}
            {selectedWorker && (
                <div className="fixed inset-0 bg-black/60 z-40 flex justify-end" onClick={() => setSelectedWorker(null)}>
                    <div className="bg-white w-full max-w-xl h-full p-8 shadow-2xl animate-slide-in overflow-y-auto" onClick={e => e.stopPropagation()}>
                        <h2 className="text-2xl font-black text-slate-800">{selectedWorker.firstName} {selectedWorker.lastName}</h2>
                        <p className="text-sm text-slate-500">{selectedWorker.phone}</p>
                        <p className="text-xs text-slate-400 mt-4 bg-slate-50 p-2 rounded-lg">{selectedWorker.notes || "Brak notatek."}</p>
                        <h3 className="font-bold uppercase text-xs text-slate-500 mt-10 mb-4 border-b pb-2">Historia pobranego sprzętu</h3>
                        {historyLoading ? <div className="animate-pulse">Ładowanie...</div> : <div><p className="text-center text-slate-400 p-10">Brak historii pobrań.</p></div>}
                    </div>
                </div>
            )}

            {/* FORMULARZ PRACOWNIKA */}
            {isFormOpen && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
                        <h2 className="text-xl font-bold mb-6">{editingWorker ? "Edytuj dane" : "Nowy pracownik"}</h2>
                        <form onSubmit={handleSave} className="space-y-4">
                            <div><label className="text-xs font-bold">Imię</label><input required value={formData.firstName} onChange={e => setFormData({ ...formData, firstName: e.target.value })} className="w-full p-2 border rounded-lg" /></div>
                            <div><label className="text-xs font-bold">Nazwisko</label><input required value={formData.lastName} onChange={e => setFormData({ ...formData, lastName: e.target.value })} className="w-full p-2 border rounded-lg" /></div>
                            <div><label className="text-xs font-bold">Nr telefonu</label><input value={formData.phone} onChange={e => setFormData({ ...formData, phone: e.target.value })} className="w-full p-2 border rounded-lg" /></div>
                            <div><label className="text-xs font-bold">Notatki</label><textarea value={formData.notes} onChange={e => setFormData({ ...formData, notes: e.target.value })} className="w-full p-2 border rounded-lg h-20" /></div>
                            <div className="flex gap-3 pt-4 border-t"><button type="button" onClick={() => setIsFormOpen(false)} className="flex-1 py-2 text-slate-500 border rounded-lg">Anuluj</button><button type="submit" className="flex-1 py-2 bg-blue-600 text-white font-bold rounded-lg">ZAPISZ</button></div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}