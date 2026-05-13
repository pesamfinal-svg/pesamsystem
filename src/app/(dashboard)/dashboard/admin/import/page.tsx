"use client";

import { useState } from "react";
import { db } from "@/lib/firebase/config";
import { collection, writeBatch, doc } from "firebase/firestore";

export default function ImportPage() {
    const [inputText, setInputText] = useState("");
    const [loading, setLoading] = useState(false);
    const [importType, setImportType] = useState<"UNIQUE" | "BULK">("UNIQUE");

    const handleImport = async () => {
        if (!inputText.trim()) return alert("Wklej najpierw dane z arkusza!");
        setLoading(true);

        try {
            const batch = writeBatch(db);
            const rows = inputText.split("\n").filter(row => row.trim() !== "");

            // Pomijamy nagłówek (jeśli wkleiłeś go razem z danymi)
            const dataRows = rows[0].toLowerCase().includes("id") ? rows.slice(1) : rows;

            dataRows.forEach((row) => {
                const columns = row.split("\t"); // Dane z Google Sheets są oddzielone tabulatorami

                if (importType === "UNIQUE") {
                    // Parsowanie arkusza NARZĘDZIA
                    // Struktura: ID(0) | Nazwa(1) | NrMag(2) | Lokalizacja(3) | Stan(4) | Kategoria(5)
                    const name = columns[1]?.trim();
                    const inv = columns[2]?.trim();
                    if (!name) return;

                    const ref = doc(collection(db, "inventory"));
                    batch.set(ref, {
                        name: name,
                        inventoryNumber: inv || "",
                        type: "UNIQUE",
                        category: columns[5]?.trim() || "Inne",
                        status: columns[4]?.trim().toLowerCase() || "sprawne",
                        totalQuantity: 1,
                        availableQuantity: 1,
                        allocations: {},
                        createdAt: new Date().toISOString()
                    });
                } else {
                    // Parsowanie arkusza RUSZTOWANIA
                    // Struktura: ID(0) | Nazwa(1) | Typ(2) | ID_Gl(3) | StanPocz(4)
                    const name = columns[1]?.trim();
                    const qty = parseInt(columns[4]) || 0;
                    if (!name || isNaN(qty)) return;

                    const ref = doc(collection(db, "inventory"));
                    batch.set(ref, {
                        name: name,
                        inventoryNumber: columns[0]?.trim() || "",
                        type: "BULK",
                        category: "Rusztowania",
                        status: "sprawne",
                        totalQuantity: qty,
                        availableQuantity: qty,
                        allocations: {},
                        createdAt: new Date().toISOString()
                    });
                }
            });

            await batch.commit();
            alert(`Pomyślnie zaimportowano ${dataRows.length} pozycji!`);
            setInputText("");
        } catch (error: any) {
            console.error(error);
            alert("Błąd importu: " + error.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="p-10 max-w-4xl mx-auto">
            <h1 className="text-3xl font-bold mb-2 text-slate-800">Magiczna Migracja PESAM</h1>
            <p className="text-slate-500 mb-8">Wklej dane bezpośrednio z Google Sheets, aby wypełnić bazę Firestore.</p>

            <div className="bg-white rounded-2xl shadow-xl p-8 border border-slate-200">
                <div className="flex gap-4 mb-6">
                    <button
                        onClick={() => setImportType("UNIQUE")}
                        className={`flex-1 py-3 rounded-xl font-bold transition ${importType === 'UNIQUE' ? 'bg-indigo-600 text-white shadow-lg' : 'bg-slate-100 text-slate-500'}`}
                    >
                        Importuj NARZĘDZIA
                    </button>
                    <button
                        onClick={() => setImportType("BULK")}
                        className={`flex-1 py-3 rounded-xl font-bold transition ${importType === 'BULK' ? 'bg-orange-600 text-white shadow-lg' : 'bg-slate-100 text-slate-500'}`}
                    >
                        Importuj RUSZTOWANIA
                    </button>
                </div>

                <label className="block text-sm font-bold text-slate-700 mb-2">
                    Wklej tutaj wiersze z arkusza (razem z nagłówkami lub bez):
                </label>
                <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder={importType === "UNIQUE" ? "ID \t NAZWA \t NR_MAG..." : "ID \t NAZWA \t TYP \t ID_GL \t STAN_POCZ..."}
                    className="w-full h-64 p-4 border rounded-xl font-mono text-xs mb-6 focus:ring-2 outline-none bg-slate-50"
                />

                <button
                    disabled={loading}
                    onClick={handleImport}
                    className="w-full py-4 bg-green-600 hover:bg-green-700 text-white font-black rounded-xl text-lg shadow-xl transition-all disabled:bg-slate-300"
                >
                    {loading ? "Trwa przesyłanie do chmury..." : `🚀 ROZPOCZNIJ IMPORT (${importType})`}
                </button>
            </div>
        </div>
    );
}