"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, doc, setDoc, query, orderBy, runTransaction, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";

// --- INTERFEJSY ---
interface Site { id: string; name: string; status: string; }
interface InventoryItem {
    id: string; name: string; type: "UNIQUE" | "BULK"; inventoryNumber: string;
    category: string; availableQuantity: number; totalQuantity: number;
}
interface CartItem extends InventoryItem { issueQty: number; }

export default function ProtocolsHub() {
    const { user } = useAuth();
    const [sites, setSites] = useState<Site[]>([]);
    const [inventory, setInventory] = useState<InventoryItem[]>([]);
    const [loading, setLoading] = useState(true);

    // Stany dla Modala WYDANIA
    const [isIssueModalOpen, setIsIssueModalOpen] = useState(false);
    const [issueSiteInput, setIssueSiteInput] = useState(""); // Dla datalist (wybór lub wpis ręczny)
    const [cart, setCart] = useState<CartItem[]>([]);
    const [searchItem, setSearchItem] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            const sitesSnap = await getDocs(query(collection(db, "sites"), orderBy("name", "asc")));
            setSites(sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[]);

            const invSnap = await getDocs(query(collection(db, "inventory"), orderBy("name", "asc")));
            setInventory(invSnap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[]);
            setLoading(false);
        };
        fetchData();
    }, []);

    // --- LOGIKA KOSZYKA WYDANIA ---
    const addToCart = (item: InventoryItem) => {
        if (cart.find(i => i.id === item.id)) return;
        setCart([...cart, { ...item, issueQty: 1 }]);
    };

    const removeFromCart = (id: string) => setCart(cart.filter(i => i.id !== id));

    const updateCartQty = (id: string, qty: number) => {
        setCart(cart.map(i => i.id === id ? { ...i, issueQty: qty } : i));
    };

    // --- TRANSAKCJA WYDANIA SPRZĘTU ---
    const handleIssueSubmit = async () => {
        if (!issueSiteInput.trim() || cart.length === 0) {
            return alert("Podaj budowę i wybierz co najmniej jeden przedmiot!");
        }

        setIsSubmitting(true);
        try {
            await runTransaction(db, async (transaction) => {
                // 1. Sprawdzenie / Tworzenie Budowy (Logika "Usterki")
                let siteId = "";
                let siteName = issueSiteInput.trim();
                const existingSite = sites.find(s => s.name.toLowerCase() === siteName.toLowerCase());

                if (existingSite) {
                    siteId = existingSite.id;
                    siteName = existingSite.name; // Normalizacja nazwy
                } else {
                    // Budowa nie istnieje - tworzymy nową ze statusem "usterka"
                    const newSiteRef = doc(collection(db, "sites"));
                    siteId = newSiteRef.id;
                    transaction.set(newSiteRef, {
                        name: siteName,
                        location: "Dodano z protokołu",
                        status: "usterka",
                        createdAt: new Date().toISOString()
                    });
                }

                // 2. Generowanie ID Protokołu
                const protocolRef = doc(collection(db, "protocols"));
                const protocolId = `WYD-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.floor(100 + Math.random() * 900)}`;

                // 3. Aktualizacja Stanów Magazynowych (Inventory)
                for (const cartItem of cart) {
                    const itemRef = doc(db, "inventory", cartItem.id);
                    const itemDoc = await transaction.get(itemRef);

                    if (!itemDoc.exists()) throw `Przedmiot ${cartItem.name} nie istnieje!`;

                    const data = itemDoc.data();
                    const newAvailable = data.availableQuantity - cartItem.issueQty;

                    if (newAvailable < 0) throw `Brak wystarczającej ilości dla: ${data.name}`;

                    // Aktualizacja przypisań (allocations)
                    const currentAllocations = data.allocations || {};
                    const newAllocations = {
                        ...currentAllocations,
                        [siteId]: (currentAllocations[siteId] || 0) + cartItem.issueQty
                    };

                    transaction.update(itemRef, {
                        availableQuantity: newAvailable,
                        allocations: newAllocations
                    });

                    // Dodanie historii dla narzędzi UNIQUE
                    if (data.type === "UNIQUE") {
                        const historyRef = doc(collection(db, `inventory/${cartItem.id}/history`));
                        transaction.set(historyRef, {
                            date: new Date().toISOString(),
                            type: "WYDANIE",
                            description: `Wydano na budowę: ${siteName}`,
                            status: data.status,
                            user: `${user?.firstName} ${user?.lastName}`
                        });
                    }
                }

                // 4. Zapisanie Protokołu
                transaction.set(protocolRef, {
                    protocolId,
                    type: "WYDANIE",
                    sourceId: "MAGAZYN",
                    destinationId: siteId,
                    destinationName: siteName,
                    createdBy: user?.uid,
                    createdByName: `${user?.firstName} ${user?.lastName}`,
                    status: "ZAAKCEPTOWANY", // Wydanie z magazynu od razu jest wiążące
                    createdAt: new Date().toISOString(),
                    items: cart.map(i => ({
                        inventoryId: i.id,
                        name: i.name,
                        inventoryNumber: i.inventoryNumber,
                        quantity: i.issueQty
                    }))
                });
            });

            alert("Protokół wydania został pomyślnie utworzony!");
            setIsIssueModalOpen(false);
            setCart([]);
            setIssueSiteInput("");

            // Opcjonalnie: Tutaj wywołamy funkcję generującą PDF
            // generatePDF(); 

            window.location.reload(); // Odśwież, by pobrać nowe stany
        } catch (error: any) {
            alert("Błąd wystawiania protokołu: " + error);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (loading) return <div className="p-10 text-center animate-pulse">Ładowanie modułu protokołów...</div>;

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto animate-fade-in">
            <h1 className="text-3xl font-bold text-slate-800 tracking-tight mb-8">Centrum Protokołów</h1>

            {/* KAFELKI AKCJI ZALEŻNE OD ROLI */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
                {/* Wszyscy uprawnieni mogą wydawać */}
                <div
                    onClick={() => setIsIssueModalOpen(true)}
                    className="bg-green-50 hover:bg-green-100 border border-green-200 p-6 rounded-2xl cursor-pointer transition shadow-sm group"
                >
                    <div className="text-3xl mb-2 group-hover:scale-110 transition">📤</div>
                    <h3 className="font-bold text-green-900">Wystaw Wydanie</h3>
                    <p className="text-xs text-green-700 mt-1">Z magazynu na budowę</p>
                </div>

                {/* Kierownik (i Admin) - Wystawia zwrot elektroniczny */}
                <div className="bg-blue-50 hover:bg-blue-100 border border-blue-200 p-6 rounded-2xl cursor-pointer transition shadow-sm group">
                    <div className="text-3xl mb-2 group-hover:scale-110 transition">📲</div>
                    <h3 className="font-bold text-blue-900">Wystaw Zwrot</h3>
                    <p className="text-xs text-blue-700 mt-1">Zgłoś zwrot z budowy</p>
                </div>

                {/* Magazynier (i Admin) - Wprowadza papierowy lub z zewnątrz */}
                <div className="bg-orange-50 hover:bg-orange-100 border border-orange-200 p-6 rounded-2xl cursor-pointer transition shadow-sm group">
                    <div className="text-3xl mb-2 group-hover:scale-110 transition">📝</div>
                    <h3 className="font-bold text-orange-900">Wprowadź Zwrot</h3>
                    <p className="text-xs text-orange-700 mt-1">Przepisz z papieru</p>
                </div>

                {/* Magazynier (i Admin) - Akceptuje elektroniczne */}
                <div className="bg-purple-50 hover:bg-purple-100 border border-purple-200 p-6 rounded-2xl cursor-pointer transition shadow-sm group relative">
                    <div className="absolute top-4 right-4 bg-red-500 text-white text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full shadow-lg">3</div>
                    <div className="text-3xl mb-2 group-hover:scale-110 transition">✅</div>
                    <h3 className="font-bold text-purple-900">Akceptuj Zwroty</h3>
                    <p className="text-xs text-purple-700 mt-1">Weryfikuj zgłoszenia</p>
                </div>
            </div>

            {/* HISTORIA OSTATNICH PROTOKOŁÓW (W kolejnym etapie dodamy tu tabelę) */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center text-slate-500">
                Tabela historii protokołów pojawi się tutaj...
            </div>

            {/* ======================================================== */}
            {/* MODAL WYDANIA NA BUDOWĘ */}
            {/* ======================================================== */}
            {isIssueModalOpen && (
                <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden animate-fade-in">
                        <div className="p-6 bg-slate-50 border-b flex justify-between items-center">
                            <h2 className="text-2xl font-black text-slate-800">Wystaw Protokół Wydania</h2>
                            <button onClick={() => setIsIssueModalOpen(false)} className="text-3xl text-slate-400 hover:text-slate-900">&times;</button>
                        </div>

                        <div className="flex-1 flex overflow-hidden">
                            {/* LEWA STRONA: WYBÓR SPRZĘTU */}
                            <div className="w-1/2 border-r flex flex-col bg-white">
                                <div className="p-4 border-b">
                                    <input
                                        type="text"
                                        placeholder="Szukaj w magazynie (nazwa lub kod)..."
                                        className="w-full p-3 border rounded-xl outline-none focus:ring-2 focus:ring-green-500 bg-slate-50"
                                        value={searchItem}
                                        onChange={(e) => setSearchItem(e.target.value)}
                                    />
                                </div>
                                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                                    {inventory.filter(i => i.availableQuantity > 0 && (i.name.toLowerCase().includes(searchItem.toLowerCase()) || i.inventoryNumber.toLowerCase().includes(searchItem.toLowerCase()))).map(item => (
                                        <div key={item.id} className="flex justify-between items-center p-3 border rounded-xl hover:bg-slate-50 transition shadow-sm">
                                            <div>
                                                <p className="font-bold text-sm text-slate-800">{item.name}</p>
                                                <p className="text-[10px] text-slate-500 font-mono">Kod: {item.inventoryNumber} | Dostępne: <b className="text-green-600">{item.availableQuantity}</b></p>
                                            </div>
                                            <button onClick={() => addToCart(item)} className="bg-slate-100 hover:bg-green-100 text-green-700 p-2 rounded-lg font-bold text-xl leading-none transition">
                                                +
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* PRAWA STRONA: KOSZYK I BUDOWA */}
                            <div className="w-1/2 flex flex-col bg-slate-50">
                                <div className="p-6 border-b">
                                    <label className="block text-xs font-black text-slate-400 uppercase mb-2">1. Wybierz lub wpisz budowę</label>
                                    {/* DATALIST - Rozwiązuje problem listy vs wpisywania ręcznego */}
                                    <input
                                        list="sites-list"
                                        placeholder="Wybierz z listy lub wpisz nową usterkę..."
                                        value={issueSiteInput}
                                        onChange={(e) => setIssueSiteInput(e.target.value)}
                                        className="w-full p-3 border rounded-xl outline-none focus:ring-2 focus:ring-green-500 font-bold"
                                    />
                                    <datalist id="sites-list">
                                        {sites.map(s => <option key={s.id} value={s.name} />)}
                                    </datalist>
                                    <p className="text-[10px] text-slate-400 mt-2">Jeśli wpiszesz nazwę spoza listy, system utworzy ją automatycznie ze statusem "usterka".</p>
                                </div>

                                <div className="flex-1 p-6 overflow-y-auto">
                                    <label className="block text-xs font-black text-slate-400 uppercase mb-4">2. Lista wydawanych przedmiotów</label>
                                    {cart.length === 0 ? (
                                        <div className="text-center p-10 text-slate-400 border-2 border-dashed rounded-xl">Wybierz przedmioty z lewej strony</div>
                                    ) : (
                                        <div className="space-y-3">
                                            {cart.map(cItem => (
                                                <div key={cItem.id} className="bg-white p-3 border rounded-xl shadow-sm flex items-center justify-between gap-4">
                                                    <div className="flex-1">
                                                        <p className="font-bold text-sm text-slate-800 leading-tight">{cItem.name}</p>
                                                        <p className="text-[10px] text-slate-400 font-mono">{cItem.inventoryNumber}</p>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        {cItem.type === "BULK" ? (
                                                            <input
                                                                type="number" min="1" max={cItem.availableQuantity}
                                                                value={cItem.issueQty}
                                                                onChange={(e) => updateCartQty(cItem.id, Number(e.target.value))}
                                                                className="w-16 p-2 border rounded text-center font-bold"
                                                            />
                                                        ) : (
                                                            <span className="font-bold px-3">1 szt.</span>
                                                        )}
                                                        <button onClick={() => removeFromCart(cItem.id)} className="text-red-400 hover:text-red-600 text-xl font-bold ml-2">&times;</button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div className="p-6 border-t bg-white">
                                    <button
                                        onClick={handleIssueSubmit}
                                        disabled={isSubmitting || cart.length === 0 || !issueSiteInput.trim()}
                                        className="w-full py-4 bg-green-600 hover:bg-green-700 text-white font-black rounded-xl text-lg shadow-xl transition disabled:bg-slate-300"
                                    >
                                        {isSubmitting ? "ZAPISYWANIE..." : "ZAPISZ I WYGENERUJ PROTOKÓŁ"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}