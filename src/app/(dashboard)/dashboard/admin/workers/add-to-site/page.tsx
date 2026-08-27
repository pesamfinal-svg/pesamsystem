"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, query, orderBy, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Site { id: string; name: string; status: string; }
interface ManagerUser {
    uid: string;
    firstName: string;
    lastName: string;
    email: string;
    roleId: string;
    assignedSites: string[];
}

interface WzLineItem {
    id: string;
    type: "UNIQUE" | "BULK";
    itemName: string;
    quantity: number;
    unit: string;
    purchasePrice: number | "";
    notes: string;
}

export default function AddToSitePage() {
    const { user } = useAuth();
    const router = useRouter();

    const [sites, setSites] = useState<Site[]>([]);
    const [managers, setManagers] = useState<ManagerUser[]>([]);
    const [selectedManagerUids, setSelectedManagerUids] = useState<string[]>([]);

    const [loading, setLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [successMsg, setSuccessMsg] = useState<string | null>(null);

    // Nagłówek Dokumentu WZ / Faktury
    const [selectedSiteId, setSelectedSiteId] = useState("");
    const [invoiceNumber, setInvoiceNumber] = useState("");
    const [purchaseDate, setPurchaseDate] = useState("");
    const [documentNotes, setDocumentNotes] = useState("");

    // Lista Pozycji na Dokumencie WZ
    const [lineItems, setLineItems] = useState<WzLineItem[]>([
        { id: "1", type: "BULK", itemName: "", quantity: 1, unit: "szt.", purchasePrice: "", notes: "" }
    ]);

    const canAddToSite = user ? hasPermission("wzCreateDelivery", user.rolePermissions, user.permissionOverrides) : false;

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

            const usersSnap = await getDocs(collection(db, "users"));
            const allUsers = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() })) as ManagerUser[];

            // Filtrujemy użytkowników o roli Kierownik lub mających dostęp do budów
            const managerList = allUsers.filter(u =>
                u.roleId === "kierownik" ||
                u.roleId === "manager" ||
                u.roleId === "admin" ||
                (u.assignedSites && u.assignedSites.length > 0)
            );
            setManagers(managerList);
        } catch (error) {
            console.error("Błąd pobierania danych:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (user && canAddToSite) fetchData();
    }, [user, canAddToSite]);

    // Czyszczenie wyboru kierowników przy zmianie budowy (księgowa sama wybierze właściwych)
    useEffect(() => {
        setSelectedManagerUids([]);
    }, [selectedSiteId]);

    const toggleManager = (uid: string) => {
        setSelectedManagerUids(prev =>
            prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid]
        );
    };

    // Obsługa dynamicznych pozycji WZ
    const addLineItem = () => {
        setLineItems(prev => [
            ...prev,
            {
                id: Math.random().toString(36).substring(2, 9),
                type: "BULK",
                itemName: "",
                quantity: 1,
                unit: "szt.",
                purchasePrice: "",
                notes: ""
            }
        ]);
    };

    const removeLineItem = (id: string) => {
        if (lineItems.length <= 1) return;
        setLineItems(prev => prev.filter(item => item.id !== id));
    };

    const updateLineItem = (id: string, field: keyof WzLineItem, value: any) => {
        setLineItems(prev => prev.map(item => item.id === id ? { ...item, [field]: value } : item));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSuccessMsg(null);

        if (!selectedSiteId) {
            return alert("Wybierz budowę docelową!");
        }

        // Walidacja pozycji WZ
        for (let i = 0; i < lineItems.length; i++) {
            const item = lineItems[i];
            if (!item.itemName.trim()) {
                return alert(`Uzupełnij nazwę pozycji nr ${i + 1}!`);
            }
            if (item.quantity <= 0) {
                return alert(`Ilość w pozycji nr ${i + 1} ("${item.itemName.trim()}") musi być większa od zera!`);
            }
        }

        if (selectedManagerUids.length === 0) {
            const confirmNoManager = window.confirm("Nie wybrano żadnego kierownika budowy. Czy na pewno chcesz opublikować WZ bez powiadomienia kierownika?");
            if (!confirmNoManager) return;
        }

        setIsSubmitting(true);
        try {
            const siteName = sites.find(s => s.id === selectedSiteId)?.name || "Budowa";
            const selectedManagerObjects = managers.filter(m => selectedManagerUids.includes(m.uid));
            const managerNamesStr = selectedManagerObjects.map(m => `${m.firstName} ${m.lastName}`.trim()).join(", ");
            const createdByName = `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || "Księgowość";
            const nowIso = new Date().toISOString();
            const defaultDate = purchaseDate || nowIso.split("T")[0];

            // 1. Zapisujemy każdą pozycję jako osobny wpis w 'pending_wz_items'
            for (const item of lineItems) {
                const combinedNotes = [documentNotes.trim(), item.notes.trim()].filter(Boolean).join(" | ");

                await addDoc(collection(db, "pending_wz_items"), {
                    siteId: selectedSiteId,
                    siteName: siteName,
                    assignedManagers: selectedManagerUids,
                    managerNames: managerNamesStr || "Brak",
                    rawItemName: item.itemName.trim(),
                    type: item.type,
                    quantity: Number(item.quantity),
                    unit: item.unit || "szt.",
                    purchasePrice: item.purchasePrice !== "" ? Number(item.purchasePrice) : 0,
                    invoiceNumber: invoiceNumber.trim() || "Brak",
                    purchaseDate: defaultDate,
                    notes: combinedNotes,
                    status: "OCZEKUJE_NA_PRZYPISANIE",
                    createdBy: user?.uid || "nieznany",
                    createdByName: createdByName,
                    createdAt: nowIso
                });
            }

            // 2. Wysyłka JEDNEGO zbiorczego e-maila ze wszystkimi pozycjami z tego dokumentu
            try {
                await fetch("/api/wz-delivery-email", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        siteName: siteName,
                        invoiceNumber: invoiceNumber.trim() || undefined,
                        purchaseDate: defaultDate,
                        notes: documentNotes.trim() || undefined,
                        createdByName: createdByName,
                        assignedManagerUids: selectedManagerUids,
                        items: lineItems.map(item => ({
                            rawItemName: item.itemName.trim(),
                            type: item.type,
                            quantity: Number(item.quantity),
                            unit: item.unit || "szt.",
                            purchasePrice: item.purchasePrice !== "" ? Number(item.purchasePrice) : undefined,
                            notes: item.notes.trim() || undefined
                        }))
                    })
                });
            } catch (emailErr) {
                console.error("Błąd wysyłki zbiorczego e-maila WZ:", emailErr);
            }

            setSuccessMsg(`Pomyślnie zapisano ${lineItems.length} poz. z dokumentu WZ (${invoiceNumber.trim() || 'Brak nr'}) dla budowy: ${siteName}. Powiadomiono kierowników oraz magazyn.`);

            // Reset formularza
            setLineItems([
                { id: Math.random().toString(36).substring(2, 9), type: "BULK", itemName: "", quantity: 1, unit: "szt.", purchasePrice: "", notes: "" }
            ]);
            setInvoiceNumber("");
            setPurchaseDate("");
            setDocumentNotes("");
        } catch (error: any) {
            console.error("Błąd zapisu WZ:", error);
            alert("Błąd zapisu do kolejki WZ: " + error.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (!canAddToSite) return null;
    if (loading) return <div className="p-10 text-center animate-pulse">Ładowanie formularza WZ...</div>;

    return (
        <div className="p-6 md:p-10 max-w-4xl mx-auto space-y-6">
            {/* POWIADOMIENIE SUKCESU */}
            {successMsg && (
                <div className="bg-emerald-50 border-2 border-emerald-300 p-6 rounded-3xl shadow-lg flex flex-col md:flex-row justify-between items-center gap-4 animate-fade-in">
                    <div className="flex items-center gap-4">
                        <span className="text-3xl">✅</span>
                        <div>
                            <h3 className="font-bold text-emerald-950 text-sm">Wprowadzono dokument WZ / Fakturę</h3>
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
                <div className="p-6 bg-slate-900 text-white flex justify-between items-center">
                    <div>
                        <h1 className="text-2xl font-black tracking-tight uppercase italic">Wprowadź pozycje z dokumentu WZ / Faktury</h1>
                        <p className="text-xs text-slate-400 mt-1">Rejestracja zakupów bezpośrednich na budowę (pojedynczo lub wielu pozycji na raz).</p>
                    </div>
                    <span className="bg-blue-600/30 text-blue-300 text-xs font-black px-3 py-1.5 rounded-xl border border-blue-500/30">
                        Pozycji: {lineItems.length}
                    </span>
                </div>

                <form onSubmit={handleSubmit} className="p-6 md:p-8 space-y-8">
                    {/* DANE NAGŁÓWKOWE DOKUMENTU */}
                    <div className="space-y-6 bg-slate-50 p-6 rounded-3xl border border-slate-200">
                        <h2 className="font-black text-xs uppercase tracking-widest text-slate-500 border-b pb-3">
                            📋 1. Nagłówek Dokumentu WZ & Wybór Budowy
                        </h2>

                        <div>
                            <label className="block text-[11px] font-black text-slate-700 uppercase tracking-widest mb-2">
                                Budowa Docelowa *
                            </label>
                            <select
                                required
                                value={selectedSiteId}
                                onChange={e => setSelectedSiteId(e.target.value)}
                                className="w-full p-4 border-2 rounded-2xl bg-white font-bold text-sm outline-none focus:border-blue-500 cursor-pointer shadow-sm"
                            >
                                <option value="" disabled>-- Wybierz budowę z listy --</option>
                                {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                        </div>

                        {/* SEKCJA WYBORU KIEROWNIKÓW */}
                        {selectedSiteId && (
                            <div className="bg-white p-5 rounded-2xl border border-slate-200 space-y-3 shadow-sm animate-fade-in">
                                <div className="flex justify-between items-center">
                                    <label className="block text-[11px] font-black text-slate-600 uppercase tracking-widest">
                                        👤 Wybierz Kierownika / Kierowników Budowy (Powiadomieni e-mailem) *
                                    </label>
                                    <span className="text-xs font-bold text-blue-600 bg-blue-100 px-2.5 py-0.5 rounded-full">
                                        Zaznaczono: {selectedManagerUids.length}
                                    </span>
                                </div>

                                <p className="text-[11px] text-slate-500">
                                    Zaznacz kierownika lub kierowników, do których ma zostać wysłane powiadomienie e-mail o dostawie WZ.
                                </p>

                                <div className="flex flex-wrap gap-2 pt-1">
                                    {managers.length === 0 ? (
                                        <p className="text-xs text-slate-400 italic">Brak zdefiniowanych kierowników w systemie.</p>
                                    ) : (
                                        managers.map(m => {
                                            const isSelected = selectedManagerUids.includes(m.uid);
                                            return (
                                                <button
                                                    type="button"
                                                    key={m.uid}
                                                    onClick={() => toggleManager(m.uid)}
                                                    className={`px-3.5 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 border ${
                                                        isSelected
                                                            ? 'bg-blue-600 text-white border-blue-700 shadow-md scale-[1.02]'
                                                            : 'bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100'
                                                    }`}
                                                >
                                                    <span>{isSelected ? '✓' : '+'}</span>
                                                    <span>{m.firstName} {m.lastName}</span>
                                                    {m.assignedSites?.includes(selectedSiteId) && (
                                                        <span className="text-[9px] opacity-75 bg-black/10 px-1.5 py-0.5 rounded font-mono">Dedykowany</span>
                                                    )}
                                                </button>
                                            );
                                        })
                                    )}
                                </div>
                            </div>
                        )}

                        {/* NUMER WZ / FAKTURY I DATA */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-[11px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                                    Numer Dokumentu WZ / Faktury
                                </label>
                                <input
                                    type="text"
                                    placeholder="np. WZ/123/2026 lub FV/998"
                                    value={invoiceNumber}
                                    onChange={e => setInvoiceNumber(e.target.value)}
                                    className="w-full p-3.5 border-2 rounded-xl text-sm font-bold bg-white outline-none focus:border-blue-500"
                                />
                            </div>

                            <div>
                                <label className="block text-[11px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                                    Data Dokumentu WZ
                                </label>
                                <input
                                    type="date"
                                    value={purchaseDate}
                                    onChange={e => setPurchaseDate(e.target.value)}
                                    className="w-full p-3.5 border-2 rounded-xl text-sm font-mono font-bold bg-white outline-none focus:border-blue-500"
                                />
                            </div>

                            <div className="md:col-span-2">
                                <label className="block text-[11px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                                    Uwagi ogólne do dokumentu (opcjonalnie)
                                </label>
                                <input
                                    type="text"
                                    value={documentNotes}
                                    onChange={e => setDocumentNotes(e.target.value)}
                                    placeholder="np. Dostarczono hurtowo z hurtowni BudMat..."
                                    className="w-full p-3.5 border-2 rounded-xl text-sm bg-white outline-none focus:border-blue-500"
                                />
                            </div>
                        </div>
                    </div>

                    {/* SEKCJA POZYCJI DOKUMENTU WZ */}
                    <div className="space-y-6">
                        <div className="flex justify-between items-center border-b pb-3">
                            <div>
                                <h2 className="font-black text-sm uppercase tracking-wider text-slate-900">
                                    📦 2. Pozycje na Dokumencie WZ ({lineItems.length})
                                </h2>
                                <p className="text-xs text-slate-500 mt-0.5">
                                    Wprowadź wszystkie pozycje zawarte na dokumencie WZ dla magazyniera.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={addLineItem}
                                className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl shadow transition flex items-center gap-2"
                            >
                                <span>➕</span> Dodaj kolejną pozycję
                            </button>
                        </div>

                        {/* LISTA KART POZYCJI WZ */}
                        <div className="space-y-6">
                            {lineItems.map((item, index) => (
                                <div
                                    key={item.id}
                                    className="p-6 bg-white rounded-3xl border-2 border-slate-200 shadow-sm relative space-y-4 hover:border-blue-300 transition"
                                >
                                    <div className="flex justify-between items-center border-b pb-3">
                                        <span className="bg-slate-900 text-white text-xs font-black px-3 py-1 rounded-xl">
                                            Pozycja #{index + 1}
                                        </span>

                                        {lineItems.length > 1 && (
                                            <button
                                                type="button"
                                                onClick={() => removeLineItem(item.id)}
                                                className="text-xs text-red-600 hover:text-red-800 font-bold bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-xl border border-red-200 transition"
                                            >
                                                🗑️ Usuń tę pozycję
                                            </button>
                                        )}
                                    </div>

                                    {/* TYP POZYCJI */}
                                    <div>
                                        <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                                            Typ pozycji z WZ *
                                        </label>
                                        <div className="flex bg-slate-100 p-1 rounded-xl">
                                            <button
                                                type="button"
                                                onClick={() => updateLineItem(item.id, "type", "BULK")}
                                                className={`flex-1 py-2.5 rounded-lg font-bold text-xs transition ${item.type === 'BULK' ? 'bg-white shadow text-blue-600' : 'text-slate-500'}`}
                                            >
                                                ⚖️ MATERIAŁY / DROBNICA (BULK - np. metrówki, tarcze)
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => updateLineItem(item.id, "type", "UNIQUE")}
                                                className={`flex-1 py-2.5 rounded-lg font-bold text-xs transition ${item.type === 'UNIQUE' ? 'bg-white shadow text-amber-700' : 'text-slate-500'}`}
                                            >
                                                ⚡ UNIKALNY SPRZĘT (UNIQUE - wiertarki, szlifierki)
                                            </button>
                                        </div>
                                    </div>

                                    {/* NAZWA I ILOŚĆ */}
                                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                                        <div className="md:col-span-2">
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                                                Nazwa pozycji z WZ / Faktury *
                                            </label>
                                            <input
                                                required
                                                type="text"
                                                placeholder="np. Nożyce dekarskie 250mm, Tarcza 125mm..."
                                                value={item.itemName}
                                                onChange={e => updateLineItem(item.id, "itemName", e.target.value)}
                                                className="w-full p-3 border-2 rounded-xl outline-none focus:border-blue-500 font-bold text-sm bg-white"
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                                                Ilość z WZ *
                                            </label>
                                            <input
                                                required
                                                type="number"
                                                min={1}
                                                value={item.quantity}
                                                onChange={e => updateLineItem(item.id, "quantity", Math.max(1, Number(e.target.value)))}
                                                className="w-full p-3 border-2 rounded-xl font-bold text-sm"
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                                                Jednostka miary
                                            </label>
                                            <select
                                                value={item.unit}
                                                onChange={e => updateLineItem(item.id, "unit", e.target.value)}
                                                className="w-full p-3 border-2 rounded-xl bg-white font-bold text-sm outline-none"
                                            >
                                                <option value="szt.">szt. (sztuka)</option>
                                                <option value="para">para</option>
                                                <option value="opak.">opak. (opakowanie)</option>
                                                <option value="m">m (metr)</option>
                                                <option value="kg">kg (kilogram)</option>
                                            </select>
                                        </div>
                                    </div>

                                    {/* CENA NETTO I UWAGI */}
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
                                        <div>
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                                                Cena netto (szt.) PLN
                                            </label>
                                            <input
                                                type="number"
                                                step="0.01"
                                                placeholder="0.00"
                                                value={item.purchasePrice}
                                                onChange={e => updateLineItem(item.id, "purchasePrice", e.target.value === "" ? "" : Number(e.target.value))}
                                                className="w-full p-3 border-2 rounded-xl font-mono text-sm"
                                            />
                                        </div>

                                        <div className="md:col-span-2">
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-1.5">
                                                Uwagi do pozycji
                                            </label>
                                            <input
                                                type="text"
                                                placeholder="np. Model z dłuższą gwarancją..."
                                                value={item.notes}
                                                onChange={e => updateLineItem(item.id, "notes", e.target.value)}
                                                className="w-full p-3 border-2 rounded-xl text-sm bg-white outline-none focus:border-blue-500"
                                            />
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="flex justify-center pt-2">
                            <button
                                type="button"
                                onClick={addLineItem}
                                className="w-full py-4 bg-slate-100 hover:bg-slate-200 border-2 border-dashed border-slate-300 hover:border-slate-400 text-slate-700 font-bold text-xs rounded-2xl transition flex items-center justify-center gap-2"
                            >
                                <span>➕</span> Kliknij, aby dodać kolejną pozycję do tego dokumentu WZ
                            </button>
                        </div>
                    </div>

                    {/* PRZYCISK ZAPISU */}
                    <div className="pt-6 border-t flex gap-4">
                        <button
                            type="button"
                            onClick={() => router.push("/dashboard")}
                            className="w-1/3 py-4 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold rounded-2xl transition text-xs uppercase tracking-wider"
                        >
                            ANULUJ
                        </button>
                        <button
                            type="submit"
                            disabled={isSubmitting}
                            className="w-2/3 py-4 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-2xl shadow-xl transition disabled:opacity-50 text-xs uppercase tracking-wider"
                        >
                            {isSubmitting
                                ? "ZAPISYWANIE I WYSYŁANIE E-MAILA..."
                                : `ZAPISZ WSZYSTKIE POZYCJE Z WZ (${lineItems.length}) I POWIADOM KIEROWNIKÓW 🚀`}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}