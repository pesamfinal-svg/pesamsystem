"use client";

import { useState, useEffect } from "react";
import { db } from "@/lib/firebase/config";
import { collection, writeBatch, doc, getDocs } from "firebase/firestore";
import { useAuth } from "@/lib/auth/AuthContext";
import { useRouter } from "next/navigation";
import { hasPermission } from "@/lib/auth/permissions";

export default function ImportPage() {
    const { user } = useAuth();
    const router = useRouter();

    const [inputText, setInputText] = useState("");
    const [loading, setLoading] = useState(false);
    const [importType, setImportType] = useState<"UNIQUE" | "BULK">("UNIQUE");
    const [sitesMap, setSitesMap] = useState<Record<string, string>>({});

    useEffect(() => {
        if (user && !hasPermission("manageImport", user.rolePermissions, user.permissionOverrides)) {
            alert("Brak uprawnień do importu danych.");
            router.push("/dashboard");
        }
    }, [user, router]);

    // Pobieramy mapę budów (Nazwa -> ID), aby automatycznie przypisać lokalizację
    useEffect(() => {
        const fetchSites = async () => {
            try {
                const snap = await getDocs(collection(db, "sites"));
                const mapping: Record<string, string> = {};
                snap.docs.forEach(d => {
                    const siteName = d.data().name;
                    if (siteName) {
                        mapping[siteName.toUpperCase().trim()] = d.id;
                    }
                });
                setSitesMap(mapping);
            } catch (error) {
                console.error("Błąd pobierania budów:", error);
            }
        };
        fetchSites();
    }, []);

    const handleImport = async () => {
        if (!inputText.trim()) return alert("Wklej najpierw dane z arkusza!");
        setLoading(true);

        try {
            const batch = writeBatch(db);
            const rows = inputText.split("\n").filter(row => row.trim() !== "");

            // Wykrywanie nagłówka i pomijanie go
            const firstRow = rows[0].toLowerCase();
            const dataRows = (firstRow.includes("id") || firstRow.includes("nazwa")) ? rows.slice(1) : rows;

            dataRows.forEach((row) => {
                const cols = row.split("\t");
                if (cols.length < 2) return;

                if (importType === "UNIQUE") {
                    // --- LOGIKA DLA NARZĘDZI (BEZ ZMIAN) ---
                    const name = cols[1]?.trim() || "Bez nazwy";
                    const inv = cols[2]?.trim() || "";
                    const rawLoc = cols[3]?.trim() || "MAGAZYN PESAM";
                    const status = cols[4]?.trim().toLowerCase() || "sprawne";
                    const category = cols[5]?.trim() || "Inne";
                    const subcategory = cols[7]?.trim() || "";
                    const imageUrl = cols[9]?.trim() || cols[8]?.trim() || cols[6]?.trim() || "";
                    const purchasePrice = parseFloat(cols[10]?.replace(",", ".")) || 0;

                    let availableQty = 1;
                    let currentLocation = "MAGAZYN PESAM";
                    let allocations: Record<string, number> = {};

                    if (!rawLoc.toUpperCase().includes("MAGAZYN")) {
                        const siteId = sitesMap[rawLoc.toUpperCase().trim()];
                        if (siteId) {
                            availableQty = 0;
                            currentLocation = rawLoc;
                            allocations[siteId] = 1;
                        }
                    }

                    const ref = doc(collection(db, "inventory"));
                    batch.set(ref, {
                        name,
                        inventoryNumber: inv,
                        type: "UNIQUE",
                        category,
                        subcategory,
                        imageUrl,
                        status,
                        currentLocation,
                        totalQuantity: 1,
                        availableQuantity: availableQty,
                        allocations,
                        purchasePrice,
                        purchaseDate: "",
                        invoiceNumber: "",
                        additionalInfo: "",
                        createdAt: new Date().toISOString()
                    });

                } else {
                    // --- NOWA LOGIKA DLA RUSZTOWAŃ (BULK) ---
                    // Kolumny: 0:ID, 1:Nazwa, 2:Typ, 3:ID_Głównej, 4:StanPocz, 5:Zdjęcie
                    const id = cols[0]?.trim();
                    const name = cols[1]?.trim();
                    const bulkType = cols[2]?.trim(); // "Główna kategoria" lub "Podpozycja"
                    const mainCategoryId = cols[3]?.trim() || "";
                    const qty = parseInt(cols[4]) || 0;
                    const imageUrl = cols[5]?.trim() || "";

                    if (!id || !name) return;

                    // Używamy ID z Excela (np. st01, ru01-01) jako ID dokumentu w Firestore
                    const ref = doc(db, "inventory", id);

                    batch.set(ref, {
                        name,
                        inventoryNumber: id,
                        type: "BULK",
                        // Rozróżniamy czy to folder (MAIN_CAT) czy przedmiot (SUB_ITEM)
                        subType: bulkType === "Główna kategoria" ? "MAIN_CAT" : "SUB_ITEM",
                        mainCategoryId: mainCategoryId,
                        category: "Rusztowania i inne",
                        subcategory: "",
                        imageUrl,
                        status: "sprawne",
                        currentLocation: "MAGAZYN PESAM",
                        totalQuantity: qty,
                        availableQuantity: qty,
                        allocations: {},
                        purchasePrice: 0,
                        additionalInfo: "",
                        createdAt: new Date().toISOString()
                    });
                }
            });

            await batch.commit();
            alert(`Pomyślnie zaimportowano ${dataRows.length} pozycji!`);
            setInputText("");
        } catch (error: any) {
            console.error("Błąd podczas importu:", error);
            alert("Błąd: " + error.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="p-6 md:p-10 max-w-5xl mx-auto animate-fade-in">
            <h1 className="text-3xl font-bold mb-2 text-slate-800">Pełna Migracja PESAM v3</h1>
            <p className="text-slate-500 mb-8 font-medium">Ujednolicony import Narzędzi i Rusztowań</p>

            <div className="bg-white p-8 rounded-3xl shadow-xl border border-slate-200">
                <div className="flex gap-4 mb-8">
                    <button
                        onClick={() => { setImportType("UNIQUE"); setInputText(""); }}
                        className={`flex-1 py-4 rounded-2xl font-black transition-all ${importType === 'UNIQUE' ? 'bg-indigo-600 text-white shadow-lg scale-105' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}
                    >
                        📦 NARZĘDZIA (UNIQUE)
                    </button>
                    <button
                        onClick={() => { setImportType("BULK"); setInputText(""); }}
                        className={`flex-1 py-4 rounded-2xl font-black transition-all ${importType === 'BULK' ? 'bg-orange-600 text-white shadow-lg scale-105' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}
                    >
                        🏗️ RUSZTOWANIA (BULK)
                    </button>
                </div>

                <div className="mb-6 p-4 bg-blue-50 border-l-4 border-blue-500 rounded-r-xl">
                    <p className="text-blue-800 text-sm leading-relaxed">
                        {importType === "UNIQUE" ? (
                            <span><b>Narzędzia:</b> Kopiuj kolumny od <b>ID</b> do <b>Cena zakupu</b>. System przypisze lokalizacje na podstawie bazy budów.</span>
                        ) : (
                            <span><b>Rusztowania:</b> Kopiuj kolumny od <b>ID</b> do <b>Zdjęcie</b>. System zachowa strukturę Główna Kategoria &rarr; Podpozycja.</span>
                        )}
                    </p>
                </div>

                <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder={importType === "UNIQUE" ? "Wklej dane narzędzi (kolumny A-K)..." : "Wklej dane rusztowań (kolumny A-F)..."}
                    className="w-full h-80 p-6 border-2 border-slate-100 rounded-3xl font-mono text-[10px] bg-slate-50 mb-8 focus:border-blue-500 focus:ring-0 outline-none transition-all"
                />

                <button
                    onClick={handleImport}
                    disabled={loading}
                    className={`w-full py-5 text-white font-black rounded-2xl text-xl shadow-2xl transition-all active:scale-95 ${loading ? 'bg-slate-400 cursor-not-allowed' : (importType === 'UNIQUE' ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-orange-600 hover:bg-orange-700')}`}
                >
                    {loading ? "TRWA PRZETWARZANIE..." : `ZAPISZ ${dataRowsCount(inputText)} POZYCJI W BAZIE`}
                </button>
            </div>
        </div>
    );
}

function dataRowsCount(text: string) {
    if (!text.trim()) return 0;
    const lines = text.split("\n").filter(l => l.trim() !== "");
    return (lines[0].toLowerCase().includes("id") || lines[0].toLowerCase().includes("nazwa")) ? lines.length - 1 : lines.length;
}