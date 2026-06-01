"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, doc, query, orderBy, runTransaction, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";
import { useRouter } from "next/navigation";

// --- INTERFEJSY ---
interface Site { id: string; name: string; status: string; }
interface InventoryItem {
    id: string; name: string; type: "UNIQUE" | "BULK"; subType?: string; inventoryNumber: string;
    category: string; availableQuantity: number; totalQuantity: number; unit?: string;
    allocations: Record<string, number>;
}

export default function AddToSitePage() {
    const { user } = useAuth();
    const router = useRouter();

    const [sites, setSites] = useState<Site[]>([]);
    const [inventory, setInventory] = useState<InventoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Formularz
    const [selectedSiteId, setSelectedSiteId] = useState("");
    const [itemType, setItemType] = useState<"UNIQUE" | "BULK">("BULK");
    const [itemName, setItemName] = useState("");
    const [quantity, setQuantity] = useState(1);
    const [unit, setUnit] = useState("szt.");

    // Dane finansowe (opcjonalne)
    const [purchasePrice, setPurchasePrice] = useState<number | "">("");
    const [invoiceNumber, setInvoiceNumber] = useState("");
    const [purchaseDate, setPurchaseDate] = useState("");
    const [notes, setNotes] = useState("");

    // Autocomplete / Podpowiedzi nazwy
    const [suggestions, setSuggestions] = useState<InventoryItem[]>([]);
    const [selectedSuggestionItem, setSelectedSuggestionItem] = useState<InventoryItem | null>(null);

    const canAddToSite = user ? hasPermission("workersAddToSite", user.rolePermissions, user.permissionOverrides) : false;

    useEffect(() => {
        if (user && !canAddToSite) {
            alert("Brak uprawnień do wprowadzania produktów bezpośrednio na stan budowy.");
            router.push("/dashboard");
        }
    }, [user, canAddToSite, router]);

    const fetchData = async () => {
        setLoading(true);
        try {
            const sitesSnap = await getDocs(query(collection(db, "sites"), orderBy("name", "asc")));
            setSites(sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[]);

            const invSnap = await getDocs(query(collection(db, "inventory"), orderBy("name", "asc")));
            setInventory(invSnap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[]);
        } catch (error) {
            console.error("Błąd pobierania danych:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (user && canAddToSite) fetchData();
    }, [user, canAddToSite]);

    // Pomocnicza funkcja oczyszczająca tekst z polskich znaków i znaków specjalnych
    const normalizeString = (str: string) => {
        return str
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "") // Usuwa polskie akcenty
            .replace(/[^a-z0-9\s]/g, ""); // Usuwa znaki specjalne
    };

    // Obsługa podpowiedzi nazwy podczas pisania (Wyszukiwanie Rozmyte)
    const handleNameChange = (val: string) => {
        setItemName(val);
        setSelectedSuggestionItem(null);

        const cleanQuery = normalizeString(val);

        if (cleanQuery.trim().length > 1) {
            const queryWords = cleanQuery.split(/\s+/).filter(w => w !== "");

            const matched = inventory.filter(item => {
                if (item.type !== itemType) return false;

                const cleanItemName = normalizeString(item.name);
                // Sprawdzamy czy KAŻDE słowo wpisane przez użytkownika istnieje w nazwie przedmiotu
                return queryWords.every(word => cleanItemName.includes(word));
            });

            // Sortujemy podpowiedzi: pierwszeństwo mają te przedmioty, które JUŻ są przypisane do tej budowy
            const sorted = matched.sort((a, b) => {
                const aOnSite = (a.allocations?.[selectedSiteId] || 0) > 0 ? 1 : 0;
                const bOnSite = (b.allocations?.[selectedSiteId] || 0) > 0 ? 1 : 0;
                return bOnSite - aOnSite; // 1 (obecny na budowie) idzie na górę listy
            });

            setSuggestions(sorted.slice(0, 5)); // Pokazujemy max 5 najlepiej dopasowanych
        } else {
            setSuggestions([]);
        }
    };

    const selectSuggestion = (item: InventoryItem) => {
        setItemName(item.name);
        setSelectedSuggestionItem(item);
        setUnit(item.unit || "szt.");
        setSuggestions([]);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedSiteId || !itemName.trim() || quantity <= 0) {
            return alert("Uzupełnij wymagane pola (Budowa, Nazwa, Ilość)!");
        }

        setIsSubmitting(true);
        try {
            const siteName = sites.find(s => s.id === selectedSiteId)?.name || "Budowa";

            await runTransaction(db, async (transaction) => {

                if (itemType === "BULK" && selectedSuggestionItem) {
                    // SCENARIUSZ 1: Zasilamy ISTNIEJĄCY produkt typu BULK (Metrówka, tarcze itp.)
                    const itemRef = doc(db, "inventory", selectedSuggestionItem.id);
                    const itemDoc = await transaction.get(itemRef);
                    if (!itemDoc.exists()) throw new Error("Wybrany produkt nie istnieje w bazie!");

                    const itemData = itemDoc.data() as InventoryItem;
                    const currentAlloc = itemData.allocations?.[selectedSiteId] || 0;

                    transaction.update(itemRef, {
                        totalQuantity: itemData.totalQuantity + quantity,
                        [`allocations.${selectedSiteId}`]: currentAlloc + quantity
                    });

                    // Zapis do historii tego przedmiotu
                    const historyRef = doc(collection(db, `inventory/${selectedSuggestionItem.id}/history`));
                    transaction.set(historyRef, {
                        date: new Date().toISOString(),
                        documentDate: purchaseDate || new Date().toISOString().split('T')[0],
                        type: "DOSTAWA_BEZP",
                        description: `Zakup bezpośredni na budowę: ${siteName}. FV: ${invoiceNumber || 'Brak'}. Ilość: ${quantity} szt.`,
                        status: "sprawne",
                        user: `${user?.firstName} ${user?.lastName}`
                    });

                } else if (itemType === "BULK" && !selectedSuggestionItem) {
                    // SCENARIUSZ 2: Nowy produkt typu BULK (Narzędzia ręczne, drobne BHP)
                    const newDocRef = doc(collection(db, "inventory"));

                    const codePrefix = "ZAKUP-B";
                    const count = inventory.filter(i => i.type === "BULK" && i.inventoryNumber.startsWith(codePrefix)).length;
                    const generatedCode = `${codePrefix}-${String(count + 1).padStart(4, '0')}`;

                    transaction.set(newDocRef, {
                        name: itemName.trim(),
                        type: "BULK",
                        subType: "SUB_ITEM",
                        inventoryNumber: generatedCode,
                        category: "Dostawy Bezpośrednie",
                        subcategory: "Inne",
                        unit: unit,
                        totalQuantity: quantity,
                        availableQuantity: 0, // omija magazyn główny, idzie od razu na budowę
                        allocations: { [selectedSiteId]: quantity },
                        currentLocation: siteName,
                        purchasePrice: purchasePrice !== "" ? purchasePrice : 0,
                        invoiceNumber,
                        purchaseDate,
                        additionalInfo: notes || "Zakup bezpośredni dla budowy.",
                        createdAt: new Date().toISOString()
                    });

                } else if (itemType === "UNIQUE") {
                    // SCENARIUSZ 3: Sprzęt typu UNIQUE (Wiertarka, Szlifierka, Młotek)
                    // Dla UNIQUE (nawet jeśli nazwa się pokrywa) tworzymy NOWY, indywidualny produkt w bazie
                    // dla każdej sztuki osobno, oznaczając go statusem "do nadania numeru".

                    const tempInvNumber = `DO_NADANIA-${invoiceNumber || Date.now()}`;

                    for (let step = 0; step < quantity; step++) {
                        const newDocRef = doc(collection(db, "inventory"));
                        transaction.set(newDocRef, {
                            name: itemName.trim(),
                            type: "UNIQUE",
                            inventoryNumber: tempInvNumber,
                            status: "do nadania numeru", // <--- TEN STATUS ALARMUJE MAGAZYNIERA PRZY ZWROCIE
                            category: "Dostawy Bezpośrednie (Unique)",
                            subcategory: "Narzędzia",
                            unit: "szt.",
                            totalQuantity: 1,
                            availableQuantity: 0, // fizycznie jest na budowie, nie w magazynie
                            allocations: { [selectedSiteId]: 1 },
                            currentLocation: siteName,
                            purchasePrice: purchasePrice !== "" ? purchasePrice : 0,
                            invoiceNumber,
                            purchaseDate,
                            additionalInfo: `${notes ? notes + ' | ' : ''}Zakup bezpośredni na budowę. Wymaga nadania numeru przy zwrocie.`,
                            createdAt: new Date().toISOString()
                        });

                        // Pierwszy wpis w historii dla nowego urządzenia
                        const historyRef = doc(collection(db, `inventory/${newDocRef.id}/history`));
                        transaction.set(historyRef, {
                            date: new Date().toISOString(),
                            documentDate: purchaseDate || new Date().toISOString().split('T')[0],
                            type: "ZAKUP",
                            description: `Zakup bezpośredni na budowę: ${siteName}. FV: ${invoiceNumber || 'Brak'}. Status: Oczekuje na nadanie numeru magazynowego.`,
                            status: "do nadania numeru",
                            user: `${user?.firstName} ${user?.lastName}`
                        });
                    }
                }

                // Generowanie protokołu zapisu dla ewidencji
                const protocolRef = doc(collection(db, "protocols"));
                const protocolId = `KST-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.floor(100 + Math.random() * 900)}`;

                transaction.set(protocolRef, {
                    protocolId,
                    type: "DOSTAWA_BEZP",
                    destinationId: selectedSiteId,
                    destinationName: siteName,
                    createdBy: user?.uid,
                    createdByName: `${user?.firstName} ${user?.lastName}`,
                    status: "ZAAKCEPTOWANY",
                    createdAt: new Date().toISOString(),
                    documentDate: purchaseDate || new Date().toISOString().split('T')[0],
                    invoiceNumber,
                    items: [{
                        name: itemName.trim(),
                        quantity: quantity,
                        unit: unit,
                        price: purchasePrice !== "" ? purchasePrice : 0
                    }]
                });
            });

            alert(`✅ Pomyślnie wprowadzono produkty bezpośrednio na stan budowy: ${siteName}!`);

            // Czyszczenie formularza
            setItemName("");
            setQuantity(1);
            setPurchasePrice("");
            setInvoiceNumber("");
            setPurchaseDate("");
            setNotes("");
            setSelectedSuggestionItem(null);
            fetchData();
        } catch (error: any) {
            alert("Błąd zapisu: " + error.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (!canAddToSite) return null;
    if (loading) return <div className="p-10 text-center animate-pulse">Ładowanie słowników i budów...</div>;

    return (
        <div className="p-6 md:p-10 max-w-3xl mx-auto">
            <div className="bg-white rounded-3xl shadow-xl border border-slate-200 overflow-hidden">
                <div className="p-6 bg-slate-900 text-white">
                    <h1 className="text-2xl font-black tracking-tight uppercase italic">Wprowadź dostawę bezpośrednio na stan budowy</h1>
                    <p className="text-xs text-slate-400 mt-1">Zasilenie stanów budowy na podstawie faktury / WZ, omijając Magazyn Główny.</p>
                </div>

                <form onSubmit={handleSubmit} className="p-8 space-y-6">
                    {/* WYBÓR BUDOWY */}
                    <div>
                        <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">1. Wybierz Budowę Docelową</label>
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
                        {/* TYP PRZEDMIOTU */}
                        <div className="md:col-span-2">
                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">2. Typ zakupu</label>
                            <div className="flex bg-slate-100 p-1 rounded-xl">
                                <button
                                    type="button"
                                    onClick={() => { setItemType("BULK"); setItemName(""); setSelectedSuggestionItem(null); }}
                                    className={`flex-1 py-3 rounded-lg font-bold text-xs transition ${itemType === 'BULK' ? 'bg-white shadow text-blue-600' : 'text-slate-400'}`}
                                >
                                    ⚖️ MATERIAŁY / DROBNICA (BULK - np. metrówki, poziomice)
                                </button>
                                <button
                                    type="button"
                                    onClick={() => { setItemType("UNIQUE"); setItemName(""); setSelectedSuggestionItem(null); }}
                                    className={`flex-1 py-3 rounded-lg font-bold text-xs transition ${itemType === 'UNIQUE' ? 'bg-white shadow text-blue-600' : 'text-slate-400'}`}
                                >
                                    ⚡ SPRZĘT Z NUMEREM INWENTARZOWYM (UNIQUE - np. elektronarzędzia, maszyny)
                                </button>
                            </div>

                            {/* Informacja pomocnicza dla użytkownika */}
                            <div className={`mt-3 p-4 rounded-xl border transition-all duration-300 ${
                                itemType === "BULK" 
                                    ? "bg-slate-50 border-slate-200 text-slate-600" 
                                    : "bg-amber-50 border-amber-200 text-amber-900"
                            }`}>
                                {itemType === "BULK" ? (
                                    <div className="flex items-start gap-3">
                                        <span className="text-lg">ℹ️</span>
                                        <div>
                                            <p className="text-xs font-bold text-slate-800">Materiały i drobnica (BULK)</p>
                                            <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                                                Przedmioty rozliczane wyłącznie ilościowo (np. metrówki, tarcze, taśmy, rękawice). Trafiają bezpośrednio na stan budowy i omijają magazyn główny. Nie wymagają nadawania indywidualnych numerów.
                                            </p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex items-start gap-3">
                                        <span className="text-lg">⚠️</span>
                                        <div>
                                            <p className="text-xs font-bold text-amber-950">Sprzęt z numerem inwentarzowym (UNIQUE)</p>
                                            <p className="text-[11px] text-amber-800 mt-0.5 leading-relaxed">
                                                Przedmioty traktowane jednostkowo (np. wiertarki, szlifierki, niwelatory). Każda sztuka zostanie dodana do bazy z tymczasowym kodem i statusem <span className="font-bold underline">"do nadania numeru"</span>. Przy zwrocie sprzętu magazynier będzie musiał nadać mu stały numer inwentarzowy.
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* NAZWA PRZEDMIOTU + PODPOWIEDZI */}
                        <div className="md:col-span-2 relative">
                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">3. Nazwa urządzenia / przedmiotu</label>
                            <input
                                required
                                type="text"
                                placeholder="Wpisz nazwę... (np. Metrówka)"
                                value={itemName}
                                onChange={e => handleNameChange(e.target.value)}
                                className={`w-full p-3.5 border-2 rounded-xl outline-none focus:border-blue-500 font-bold ${selectedSuggestionItem ? 'bg-green-50 border-green-300 text-green-900' : 'bg-white'}`}
                            />
                            {selectedSuggestionItem && (
                                <p className="text-[10px] text-green-600 font-bold mt-1.5 ml-1">✓ Powiązano z istniejącym produktem w katalogu firmowym.</p>
                            )}

                            {suggestions.length > 0 && (
                                <div className="absolute left-0 right-0 mt-1 bg-white border-2 border-slate-200 rounded-xl shadow-xl z-20 overflow-hidden divide-y">
                                    <div className="p-2.5 bg-slate-50 text-[10px] font-black text-slate-400 uppercase tracking-wider">Sugestie z katalogu (kliknij, aby powiązać):</div>
                                    {suggestions.map(s => {
                                        const siteQty = s.allocations?.[selectedSiteId] || 0;
                                        const isOnSite = siteQty > 0;

                                        return (
                                            <div
                                                key={s.id}
                                                onClick={() => selectSuggestion(s)}
                                                className="p-3 hover:bg-blue-50 cursor-pointer text-sm font-bold text-slate-700 flex justify-between items-center transition"
                                            >
                                                <div className="flex flex-col">
                                                    <span>{s.name}</span>
                                                    <span className="text-[10px] text-slate-400 font-mono">Kod: {s.inventoryNumber}</span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    {isOnSite ? (
                                                        <span className="bg-green-100 text-green-800 text-[9px] px-2.5 py-1 rounded-full font-black uppercase tracking-wide">
                                                            ✓ Obecny na tej budowie ({siteQty} {s.unit || 'szt.'})
                                                        </span>
                                                    ) : (
                                                        <span className="bg-blue-50 text-blue-700 text-[9px] px-2.5 py-1 rounded-full font-black uppercase tracking-wide border border-blue-200">
                                                            + Nowy dla tej budowy (Katalog)
                                                        </span>
                                                    )}
                                                    <span className="text-xs text-slate-400 font-mono">({s.type})</span>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* ILOŚĆ I JEDNOSTKA */}
                        <div>
                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">4. Ilość</label>
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
                            </select>
                        </div>
                    </div>

                    {/* METADANE FINANSOWE (FV / WZ) */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-6 border-t">
                        <div className="md:col-span-3">
                            <h3 className="font-bold text-sm text-slate-800">Dane Finansowe & Zakupowe (Opcjonalnie)</h3>
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
                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">Numer Faktury / FV</label>
                            <input
                                type="text"
                                placeholder="FV/..."
                                value={invoiceNumber}
                                onChange={e => setInvoiceNumber(e.target.value)}
                                className="w-full p-3 border-2 rounded-xl text-sm"
                            />
                        </div>

                        <div>
                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">Data Zakupu</label>
                            <input
                                type="date"
                                value={purchaseDate}
                                onChange={e => setPurchaseDate(e.target.value)}
                                className="w-full p-3 border-2 rounded-xl text-sm font-mono"
                            />
                        </div>

                        <div className="md:col-span-3">
                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">Dodatkowy opis / specyfikacja</label>
                            <textarea
                                value={notes}
                                onChange={e => setNotes(e.target.value)}
                                placeholder="np. Zakup dla ekipy tynkarzy, pilna dostawa..."
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
                            {isSubmitting ? "WPISYWANIE NA STAN..." : "ZATWIERDŹ DOSTAWĘ NA BUDOWĘ"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}