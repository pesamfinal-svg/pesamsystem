"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, doc, query, orderBy, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Site { id: string; name: string; status: string; }

export default function AddToSitePage() {
    const { user } = useAuth();
    const router = useRouter();

    const [sites, setSites] = useState<Site[]>([]);
    const [loading, setLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [successMsg, setSuccessMsg] = useState<string | null>(null);

    // Formularz WZ
    const [selectedSiteId, setSelectedSiteId] = useState("");
    const [itemType, setItemType] = useState<"UNIQUE" | "BULK">("BULK");
    const [itemName, setItemName] = useState("");
    const [quantity, setQuantity] = useState(1);
    const [unit, setUnit] = useState("szt.");

    // Dane finansowe & WZ
    const [purchasePrice, setPurchasePrice] = useState<number | "">("");
    const [invoiceNumber, setInvoiceNumber] = useState("");
    const [purchaseDate, setPurchaseDate] = useState("");
    const [notes, setNotes] = useState("");

    const canAddToSite = user ? (
        hasPermission("wzCreateDelivery", user.rolePermissions, user.permissionOverrides) ||
        hasPermission("workersAddToSite", user.rolePermissions, user.permissionOverrides)
    ) : false;

    useEffect(() => {
        if (user && !canAddToSite) {
            alert("Brak uprawnień do wprowadzania pozycji z WZ / Faktur.");
            router.push("/dashboard");
        }
    }, [user, canAddToSite, router]);

    const fetchData = async () => {
        setLoading(true);
        try {
            const sitesSnap = await getDocs(query(collection(db, "sites"), orderBy("name", "asc")));
            setSites(sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[]);
        } catch (error) {
            console.error("Błąd pobierania budów:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (user && canAddToSite) fetchData();
    }, [user, canAddToSite]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSuccessMsg(null);

        if (!selectedSiteId || !itemName.trim() || quantity <= 0) {
            return alert("Uzupełnij wymagane pola (Budowa, Nazwa z WZ, Ilość)!");
        }

        setIsSubmitting(true);
        try {
            const siteName = sites.find(s => s.id === selectedSiteId)?.name || "Budowa";

            // Tworzenie wpisu w nowej kolejce WZ: 'pending_wz_items'
            await addDoc(collection(db, "pending_wz_items"), {
                siteId: selectedSiteId,
                siteName: siteName,
                rawItemName: itemName.trim(),
                type: itemType,
                quantity: Number(quantity),
                unit: unit || "szt.",
                purchasePrice: purchasePrice !== "" ? Number(purchasePrice) : 0,
                invoiceNumber: invoiceNumber.trim() || "Brak",
                purchaseDate: purchaseDate || new Date().toISOString().split("T")[0],
                notes: notes.trim(),
                status: "OCZEKUJE_NA_PRZYPISANIE",
                createdBy: user?.uid || "nieznany",
                createdByName: `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || "Księgowość",
                createdAt: new Date().toISOString()
            });

            setSuccessMsg(`Zapisano pozycję z WZ („${itemName.trim()}”) w kolejce dla budowy: ${siteName}. Magazynier otrzymał pozycję do zweryfikowania i przypisania na stan budowy.`);

            // Resettowanie formularza
            setItemName("");
            setQuantity(1);
            setPurchasePrice("");
            setInvoiceNumber("");
            setPurchaseDate("");
            setNotes("");
        } catch (error: any) {
            console.error("Błąd zapisu WZ:", error);
            alert("Błąd zapisu do kolejki WZ: " + error.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (!canAddToSite) return null;
    if (loading) return <div className="p-10 text-center animate-pulse">Ładowanie budów...</div>;

    return (
        <div className="p-6 md:p-10 max-w-3xl mx-auto space-y-6">
            {/* POWIADOMIENIE SUKCESU */}
            {successMsg && (
                <div className="bg-emerald-50 border-2 border-emerald-300 p-6 rounded-3xl shadow-lg flex flex-col md:flex-row justify-between items-center gap-4 animate-fade-in">
                    <div className="flex items-center gap-4">
                        <span className="text-3xl">✅</span>
                        <div>
                            <h3 className="font-bold text-emerald-950 text-sm">Wprowadzono pozycję z dokumentu WZ</h3>
                            <p className="text-xs text-emerald-800 mt-1 leading-relaxed">{successMsg}</p>
                        </div>
                    </div>
                    <Link
                        href="/dashboard/wz-approvals"
                        className="bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-black px-4 py-3 rounded-xl shadow transition whitespace-nowrap"
                    >
                        Przejdź do akceptacji WZ ➡️
                    </Link>
                </div>
            )}

            <div className="bg-white rounded-3xl shadow-xl border border-slate-200 overflow-hidden">
                <div className="p-6 bg-slate-900 text-white">
                    <h1 className="text-2xl font-black tracking-tight uppercase italic">Wprowadź pozycję z dokumentu WZ / Faktury</h1>
                    <p className="text-xs text-slate-400 mt-1">Rejestracja zakupów bezpośrednich na budowę. Magazynier dopasuje nazwę i zatwierdzi stan na budowie.</p>
                </div>

                <form onSubmit={handleSubmit} className="p-8 space-y-6">
                    {/* 1. WYBÓR BUDOWY */}
                    <div>
                        <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">1. Wybierz Budowę Docelową *</label>
                        <select
                            required
                            value={selectedSiteId}
                            onChange={e => setSelectedSiteId(e.target.value)}
                            className="w-full p-4 border-2 rounded-xl bg-slate-50 font-bold outline-none focus:border-blue-500 cursor-pointer"
                        >
                            <option value="" disabled>-- Wybierz budowę z listy --</option>
                            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t">
                        {/* 2. TYP PRZEDMIOTU */}
                        <div className="md:col-span-2">
                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">2. Typ pozycji z WZ *</label>
                            <div className="flex bg-slate-100 p-1 rounded-xl">
                                <button
                                    type="button"
                                    onClick={() => setItemType("BULK")}
                                    className={`flex-1 py-3 rounded-lg font-bold text-xs transition ${itemType === 'BULK' ? 'bg-white shadow text-blue-600' : 'text-slate-400'}`}
                                >
                                    ⚖️ MATERIAŁY / DROBNICA (BULK - np. metrówki, tarcze, poziomice)
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setItemType("UNIQUE")}
                                    className={`flex-1 py-3 rounded-lg font-bold text-xs transition ${itemType === 'UNIQUE' ? 'bg-white shadow text-blue-600' : 'text-slate-400'}`}
                                >
                                    ⚡ SPRZĘT Z NUMEREM INWENTARZOWYM (UNIQUE - np. wiertarki, szlifierki)
                                </button>
                            </div>

                            <div className={`mt-3 p-4 rounded-xl border transition-all duration-300 ${
                                itemType === "BULK" 
                                    ? "bg-blue-50 border-blue-200 text-blue-900" 
                                    : "bg-amber-50 border-amber-200 text-amber-900"
                            }`}>
                                {itemType === "BULK" ? (
                                    <div className="flex items-start gap-3">
                                        <span className="text-lg">ℹ️</span>
                                        <div>
                                            <p className="text-xs font-bold text-blue-950">Materiały i drobnica (BULK)</p>
                                            <p className="text-[11px] text-blue-800 mt-0.5 leading-relaxed">
                                                Pozycja trafia do kolejki WZ. Magazynier po stronie budowy przypisze ją do istniejącej pozycji ilościowej (np. nożyce do blachy) lub utworzy nową.
                                            </p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex items-start gap-3">
                                        <span className="text-lg">⚠️</span>
                                        <div>
                                            <p className="text-xs font-bold text-amber-950">Sprzęt z numerem inwentarzowym (UNIQUE)</p>
                                            <p className="text-[11px] text-amber-800 mt-0.5 leading-relaxed">
                                                Magazynier po zatwierdzeniu wpisu utworzy w bazie jednostkowy sprzęt ze statusem <span className="font-bold underline">"do nadania numeru"</span>, pozwalający nadać kod inwentarzowy przy zwrocie na magazyn.
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* 3. NAZWA PRZEDMIOTU Z WZ */}
                        <div className="md:col-span-2">
                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">3. Nazwa pozycji wpisana na WZ / Fakturze *</label>
                            <input
                                required
                                type="text"
                                placeholder="Wpisz dokłądną nazwę z dokumentu WZ... (np. Nożyce dekarskie 250mm)"
                                value={itemName}
                                onChange={e => setItemName(e.target.value)}
                                className="w-full p-3.5 border-2 rounded-xl outline-none focus:border-blue-500 font-bold bg-white"
                            />
                            <p className="text-[11px] text-slate-400 mt-1">
                                Wpisz oryginalną nazwę z dokumentu WZ – magazynier powiąże ją z nazewnictwem w magazynie.
                            </p>
                        </div>

                        {/* 4. ILOŚĆ I JEDNOSTKA */}
                        <div>
                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">4. Ilość z WZ *</label>
                            <input
                                required
                                type="number"
                                min={1}
                                value={quantity}
                                onChange={e => setQuantity(Math.max(1, Number(e.target.value)))}
                                className="w-full p-3 border-2 rounded-xl font-bold"
                            />
                        </div>

                        <div>
                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">Jednostka miary</label>
                            <select
                                value={unit}
                                onChange={e => setUnit(e.target.value)}
                                className="w-full p-3 border-2 rounded-xl bg-white font-bold outline-none"
                            >
                                <option value="szt.">szt. (sztuka)</option>
                                <option value="para">para</option>
                                <option value="opak.">opak. (opakowanie)</option>
                                <option value="m">m (metr)</option>
                                <option value="kg">kg (kilogram)</option>
                            </select>
                        </div>
                    </div>

                    {/* METADANE FINANSOWE (FV / WZ) */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-6 border-t">
                        <div className="md:col-span-3">
                            <h3 className="font-bold text-sm text-slate-800">Dane Finansowe & Dokumentu (WZ / Faktura)</h3>
                        </div>

                        <div>
                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">Cena netto (szt.)</label>
                            <input
                                type="number"
                                step="0.01"
                                placeholder="0.00"
                                value={purchasePrice}
                                onChange={e => setPurchasePrice(e.target.value === "" ? "" : Number(e.target.value))}
                                className="w-full p-3 border-2 rounded-xl font-mono text-sm"
                            />
                        </div>

                        <div>
                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">Numer Dokumentu WZ / Faktury</label>
                            <input
                                type="text"
                                placeholder="WZ/123/2026 lub FV/..."
                                value={invoiceNumber}
                                onChange={e => setInvoiceNumber(e.target.value)}
                                className="w-full p-3 border-2 rounded-xl text-sm"
                            />
                        </div>

                        <div>
                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">Data Dokumentu</label>
                            <input
                                type="date"
                                value={purchaseDate}
                                onChange={e => setPurchaseDate(e.target.value)}
                                className="w-full p-3 border-2 rounded-xl text-sm font-mono"
                            />
                        </div>

                        <div className="md:col-span-3">
                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">Dodatkowe uwagi / specyfikacja</label>
                            <textarea
                                value={notes}
                                onChange={e => setNotes(e.target.value)}
                                placeholder="np. Zakup dla ekipy dekarskiej, faktura zapłacona..."
                                className="w-full p-3 border-2 rounded-xl text-sm h-20 resize-none outline-none focus:border-blue-500"
                            />
                        </div>
                    </div>

                    {/* PRZYCISK ZAPISU */}
                    <div className="pt-6 border-t flex gap-4">
                        <button
                            type="button"
                            onClick={() => router.push("/dashboard")}
                            className="w-1/3 py-4 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold rounded-xl transition"
                        >
                            ANULUJ
                        </button>
                        <button
                            type="submit"
                            disabled={isSubmitting}
                            className="w-2/3 py-4 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-xl shadow-lg transition disabled:opacity-50"
                        >
                            {isSubmitting ? "ZAPISYWANIE W KOLEJCE WZ..." : "ZAPISZ POZYCJĘ Z WZ DLA MAGAZYNIERA"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}