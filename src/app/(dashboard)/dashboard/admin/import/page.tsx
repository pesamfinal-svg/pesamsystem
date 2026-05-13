"use client";

import { useState, useEffect } from "react";
import { db } from "@/lib/firebase/config";
import { collection, writeBatch, doc, getDocs } from "firebase/firestore";

export default function ImportPage() {
    const [inputText, setInputText] = useState("");
    const [loading, setLoading] = useState(false);
    const [importType, setImportType] = useState<"UNIQUE" | "BULK">("UNIQUE");
    const [sitesMap, setSitesMap] = useState<Record<string, string>>({});

    // Pobranie budów do mapowania lokalizacji (Nazwa -> ID)
    useEffect(() => {
        const fetchSites = async () => {
            const snap = await getDocs(collection(db, "sites"));
            const mapping: Record<string, string> = {};
            snap.docs.forEach(d => {
                mapping[d.data().name.toUpperCase().trim()] = d.id;
            });
            setSitesMap(mapping);
        };
        fetchSites();
    }, []);

    const handleImport = async () => {
        if (!inputText.trim()) return alert("Wklej dane z arkusza!");
        setLoading(true);

        try {
            const batch = writeBatch(db);
            const rows = inputText.split("\n").filter(row => row.trim() !== "");
            // Pomijamy nagłówek jeśli jest
            const dataRows = (rows[0].toLowerCase().includes("id") || rows[0].toLowerCase().includes("nazwa")) ? rows.slice(1) : rows;

            dataRows.forEach((row) => {
                const columns = row.split("\t");
                if (columns.length < 2) return;

                if (importType === "UNIQUE") {
                    // --- LOGIKA NARZĘDZIA (UNIQUE) ---
                    const name = columns[1]?.trim();
                    const inv = columns[2]?.trim();
                    const rawLoc = columns[3]?.trim() || "MAGAZYN PESAM";
                    const status = columns[4]?.trim().toLowerCase() || "sprawne";
                    const category = columns[5]?.trim() || "Inne";

                    let availableQty = 1;
                    let allocations: Record<string, number> = {};

                    // Jeśli lokalizacja to NIE magazyn, szukamy budowy
                    if (!rawLoc.toUpperCase().includes("MAGAZYN")) {
                        const siteId = sitesMap[rawLoc.toUpperCase().trim()];
                        if (siteId) {
                            availableQty = 0; // Nie ma na magazynie
                            allocations[siteId] = 1; // Jest na budowie
                        }
                    }

                    const ref = doc(collection(db, "inventory"));
                    batch.set(ref, {
                        name,
                        inventoryNumber: inv,
                        type: "UNIQUE",
                        category,
                        status,
                        totalQuantity: 1,
                        availableQuantity: availableQty,
                        allocations,
                        createdAt: new Date().toISOString()
                    });

                } else {
                    // --- LOGIKA RUSZTOWANIA (BULK) ---
                    // ID(0) | Nazwa(1) | Typ(2) | ID_Gl(3) | StanPocz(4) | Zdjęcie(5)
                    const name = columns[1]?.trim();
                    const inv = columns[0]?.trim(); // Używamy ID (np. ru01-01) jako nr magazynowego
                    const qty = parseInt(columns[4]) || 0;
                    const imageUrl = columns[5]?.trim() || "";

                    if (!name || isNaN(qty)) return;

                    const ref = doc(collection(db, "inventory"));
                    batch.set(ref, {
                        name,
                        inventoryNumber: inv,
                        type: "BULK",
                        category: "Rusztowania",
                        status: "sprawne",
                        totalQuantity: qty,
                        availableQuantity: qty, // Rusztowania domyślnie na magazyn
                        allocations: {},
                        imageUrl,
                        createdAt: new Date().toISOString()
                    });
                }
            });

            await batch.commit();
            alert(`Pomyślnie zaimportowano ${dataRows.length} pozycji!`);
            setInputText("");
        } catch (error: any) {
            console.error(error);
            alert("Błąd: " + error.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="p-10 max-w-5xl mx-auto">
            <h1 className="text-3xl font-bold mb-2 text-slate-800">Magiczna Migracja PESAM v2</h1>
            <p className="text-slate-500 mb-8">Wklej dane z odpowiedniego arkusza. System sam rozpozna lokalizację narzędzi.</p>

            <div className="bg-white rounded-2xl shadow-xl p-8 border border-slate-200">
                <div className="flex gap-4 mb-6">
                    <button
                        onClick={() => { setImportType("UNIQUE"); setInputText(""); }}
                        className={`flex-1 py-4 rounded-xl font-bold transition-all ${importType === 'UNIQUE' ? 'bg-indigo-600 text-white shadow-lg scale-105' : 'bg-slate-100 text-slate-500'}`}
                    >
                        📦 Importuj NARZĘDZIA
                    </button>
                    <button
                        onClick={() => { setImportType("BULK"); setInputText(""); }}
                        className={`flex-1 py-4 rounded-xl font-bold transition-all ${importType === 'BULK' ? 'bg-orange-600 text-white shadow-lg scale-105' : 'bg-slate-100 text-slate-500'}`}
                    >
                        🏗️ Importuj RUSZTOWANIA
                    </button>
                </div>

                <div className="mb-4 p-4 bg-blue-50 border-l-4 border-blue-400 text-blue-700 text-sm">
                    {importType === "UNIQUE"
                        ? "Wskazówka: Kopiuj kolumny od ID do Category. System sprawdzi kolumnę LOKALIZACJA."
                        : "Wskazówka: Kopiuj kolumny od ID do Zdjęcia. Stan początkowy trafi na magazyn."}
                </div>

                <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder="Wklej tutaj dane skopiowane z arkusza..."
                    className="w-full h-80 p-4 border rounded-xl font-mono text-[10px] mb-6 focus:ring-2 outline-none bg-slate-50"
                />

                <button
                    disabled={loading}
                    onClick={handleImport}
                    className={`w-full py-4 text-white font-black rounded-xl text-lg shadow-xl transition-all ${loading ? 'bg-slate-400' : (importType === 'UNIQUE' ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-orange-600 hover:bg-orange-700')}`}
                >
                    {loading ? "PROSZĘ CZEKAĆ, TRWA ZAPIS W CHMURZE..." : `🚀 IMPORTUJ DANE (${importType === 'UNIQUE' ? 'NARZĘDZIA' : 'RUSZTOWANIA'})`}
                </button>
            </div>
        </div>
    );
}