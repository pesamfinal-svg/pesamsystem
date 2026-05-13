"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, doc, setDoc, query, orderBy, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";

interface InventoryItem {
    id: string;
    name: string;
    type: "UNIQUE" | "BULK"; // Narzędzia vs Rusztowania
    inventoryNumber: string;  // Dla UNIQUE: np. "120", dla BULK: np. "R-LAY-01"
    totalQuantity: number;    // Dla UNIQUE zawsze 1
    availableQuantity: number;
    allocations: Record<string, number>; // { "id_budowy": ilosc }
    status: "sprawne" | "w naprawie" | "zlom";
}

export default function InventoryPage() {
    const [items, setItems] = useState<InventoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [isModalOpen, setIsModalOpen] = useState(false);

    const [formData, setFormData] = useState({
        name: "",
        type: "UNIQUE" as "UNIQUE" | "BULK",
        inventoryNumber: "",
        totalQuantity: 1
    });

    const fetchInventory = async () => {
        setLoading(true);
        const q = query(collection(db, "inventory"), orderBy("name", "asc"));
        const snap = await getDocs(q);
        setItems(snap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[]);
        setLoading(false);
    };

    useEffect(() => { fetchInventory(); }, []);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        const qty = formData.type === "UNIQUE" ? 1 : Number(formData.totalQuantity);

        await addDoc(collection(db, "inventory"), {
            ...formData,
            totalQuantity: qty,
            availableQuantity: qty,
            allocations: {},
            status: "sprawne",
            createdAt: new Date().toISOString()
        });

        setIsModalOpen(false);
        fetchInventory();
    };

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Katalog Sprzętu</h1>
                    <p className="text-slate-500 text-sm">Narzędzia (UNIQUE) oraz Rusztowania (BULK)</p>
                </div>
                <div className="flex gap-2">
                    <button onClick={() => setIsModalOpen(true)} className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium">+ Dodaj Sprzęt</button>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-slate-50 border-b border-slate-200">
                            <th className="p-4 font-semibold text-slate-700">Nazwa urządzenia</th>
                            <th className="p-4 font-semibold text-slate-700">Nr Magazynowy</th>
                            <th className="p-4 font-semibold text-slate-700 text-center">Typ</th>
                            <th className="p-4 font-semibold text-slate-700 text-center">Łącznie</th>
                            <th className="p-4 font-semibold text-slate-700 text-center text-green-600">Magazyn</th>
                            <th className="p-4 font-semibold text-slate-700 text-center text-blue-600">Budowy</th>
                        </tr>
                    </thead>
                    <tbody>
                        {items.map(item => (
                            <tr key={item.id} className="border-b border-slate-100 hover:bg-slate-50 transition">
                                <td className="p-4 font-bold text-slate-800">{item.name}</td>
                                <td className="p-4 font-mono text-xs">{item.inventoryNumber}</td>
                                <td className="p-4 text-center">
                                    <span className={`px-2 py-1 rounded text-[10px] font-bold ${item.type === 'UNIQUE' ? 'bg-indigo-100 text-indigo-700' : 'bg-orange-100 text-orange-700'}`}>
                                        {item.type === 'UNIQUE' ? 'NARZĘDZIE' : 'MASOWY'}
                                    </span>
                                </td>
                                <td className="p-4 text-center font-medium">{item.totalQuantity}</td>
                                <td className="p-4 text-center font-bold text-green-600">{item.availableQuantity}</td>
                                <td className="p-4 text-center font-bold text-blue-600">{item.totalQuantity - item.availableQuantity}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Modal - Dodawanie */}
            {isModalOpen && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
                        <h2 className="text-xl font-bold mb-6">Dodaj nowy sprzęt</h2>
                        <form onSubmit={handleSave} className="space-y-4">
                            <div className="flex bg-slate-100 p-1 rounded-lg">
                                <button type="button" onClick={() => setFormData({ ...formData, type: 'UNIQUE' })} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition ${formData.type === 'UNIQUE' ? 'bg-white shadow text-blue-600' : 'text-slate-500'}`}>NARZĘDZIE</button>
                                <button type="button" onClick={() => setFormData({ ...formData, type: 'BULK' })} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition ${formData.type === 'BULK' ? 'bg-white shadow text-blue-600' : 'text-slate-500'}`}>RUSZTOWANIE / MASOWY</button>
                            </div>
                            <input placeholder="Nazwa przedmiotu" required value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} className="w-full p-2 border rounded-lg" />
                            <input placeholder="Numer Magazynowy" required value={formData.inventoryNumber} onChange={e => setFormData({ ...formData, inventoryNumber: e.target.value })} className="w-full p-2 border rounded-lg font-mono" />
                            {formData.type === "BULK" && (
                                <input type="number" placeholder="Ilość całkowita" required value={formData.totalQuantity} onChange={e => setFormData({ ...formData, totalQuantity: Number(e.target.value) })} className="w-full p-2 border rounded-lg" />
                            )}
                            <div className="flex gap-2 pt-4">
                                <button type="button" onClick={() => setIsModalOpen(false)} className="flex-1 py-2 text-slate-500">Anuluj</button>
                                <button type="submit" className="flex-1 py-2 bg-blue-600 text-white font-bold rounded-lg">Zapisz</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}