"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, query, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { useRouter } from "next/navigation";

// --- INTERFEJSY ---
interface InventoryItem {
    id: string;
    name: string;
    type: "UNIQUE" | "BULK";
    subType?: "MAIN_CAT" | "SUB_ITEM";
    mainCategoryId?: string;
    inventoryNumber: string;
    imageUrl: string;
    availableQuantity: number;
    status: string;
    category: string;
}
interface Site { id: string; name: string; }
interface CartItem {
    cartId: string;
    isManual: boolean;
    dbId?: string;
    name: string;
    type?: "UNIQUE" | "BULK";
    inventoryNumber?: string;
    quantity: number;
    imageUrl?: string;
    maxQty?: number;
}

// ─── KOMPONENT: Edytor pozycji ręcznych ───────────────────────────────────────
function ManualEntryModal({
    initialText,
    onSave,
    onCancel,
}: {
    initialText: string;
    onSave: (text: string) => void;
    onCancel: () => void;
}) {
    // Każda pozycja to osobny string (może mieć wiele linii wizualnych)
    const parse = (raw: string) =>
        raw.split("\n").length > 0 ? raw.split("\n") : [""];

    const [entries, setEntries] = useState<string[]>(() => {
        const parsed = initialText.split("\n");
        return parsed.length > 0 ? parsed : [""];
    });

    const refs = useState<(HTMLTextAreaElement | null)[]>([])[0];

    const updateEntry = (i: number, val: string) => {
        setEntries(prev => {
            const next = [...prev];
            next[i] = val;
            return next;
        });
    };

    const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            // Nowa pozycja po aktualnej
            setEntries(prev => {
                const next = [...prev];
                next.splice(i + 1, 0, "");
                return next;
            });
            // Focus na nową pozycję po re-renderze
            setTimeout(() => refs[i + 1]?.focus(), 30);
        }
        if (e.key === "Backspace" && entries[i] === "" && entries.length > 1) {
            e.preventDefault();
            setEntries(prev => {
                const next = [...prev];
                next.splice(i, 1);
                return next;
            });
            setTimeout(() => refs[Math.max(0, i - 1)]?.focus(), 30);
        }
    };

    const nonEmpty = entries.filter(e => e.trim() !== "").length;
    const handleSave = () => {
        const joined = entries.filter(e => e.trim() !== "").join("\n");
        onSave(joined);
    };

    return (
        <div
            className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 backdrop-blur-sm"
            style={{ zIndex: 9999999 }}
        >
            <div
                className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden border-t-4 border-orange-500 flex flex-col"
                style={{ height: "80vh" }}
            >
                {/* NAGŁÓWEK */}
                <div className="p-5 bg-orange-50 border-b border-orange-100 flex justify-between items-center flex-shrink-0">
                    <div>
                        <h3 className="font-black text-orange-800 uppercase tracking-tight text-xl">📝 Wpis ręczny</h3>
                        <p className="text-xs text-orange-600 mt-0.5">
                            <b>Enter</b> = nowa pozycja &nbsp;·&nbsp; Każda pozycja może zajmować wiele wierszy
                        </p>
                    </div>
                    <button onClick={onCancel} className="text-3xl text-slate-400 hover:text-red-500 w-10 h-10 flex items-center justify-center rounded-full hover:bg-red-50 transition leading-none">&times;</button>
                </div>

                {/* LICZNIK */}
                <div className="px-5 py-2 bg-slate-800 flex items-center gap-3 flex-shrink-0">
                    <span className="text-[11px] text-slate-400 uppercase tracking-widest font-mono">Pozycje:</span>
                    <div className="flex gap-1.5 flex-wrap flex-1">
                        {entries.map((e, i) => e.trim() !== "" && (
                            <span key={i} className="bg-orange-500/20 text-orange-300 text-[10px] font-bold px-2 py-0.5 rounded border border-orange-500/30">
                                {i + 1}. {e.length > 20 ? e.slice(0, 20) + "…" : e}
                            </span>
                        ))}
                        {nonEmpty === 0 && <span className="text-slate-500 text-[11px] italic">Zacznij pisać poniżej...</span>}
                    </div>
                    <span className="text-orange-400 font-black text-sm flex-shrink-0">{nonEmpty} poz.</span>
                </div>

                {/* LISTA POZYCJI */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-slate-50">
                    {entries.map((entry, i) => (
                        <div key={i} className="flex gap-3 items-start group">
                            {/* Numer pozycji */}
                            <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-xs font-black mt-1 transition-colors ${entry.trim() !== ""
                                    ? "bg-orange-500 text-white shadow-sm"
                                    : "bg-slate-200 text-slate-400"
                                }`}>
                                {i + 1}
                            </div>

                            {/* Textarea dla tej pozycji */}
                            <textarea
                                ref={el => { refs[i] = el; }}
                                value={entry}
                                onChange={e => updateEntry(i, e.target.value)}
                                onKeyDown={e => handleKeyDown(i, e)}
                                rows={1}
                                autoFocus={i === entries.length - 1 && i > 0}
                                placeholder={i === 0 ? "np. 10 par rękawic roboczych, rozmiar L..." : `Pozycja ${i + 1}...`}
                                className="flex-1 p-2.5 border-2 border-slate-200 rounded-xl text-sm bg-white outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20 resize-none leading-relaxed transition-all placeholder-slate-300"
                                style={{
                                    minHeight: "40px",
                                    height: "auto",
                                    overflow: "hidden",
                                }}
                                onInput={e => {
                                    const t = e.currentTarget;
                                    t.style.height = "auto";
                                    t.style.height = t.scrollHeight + "px";
                                }}
                            />

                            {/* Usuń pozycję */}
                            {entries.length > 1 && (
                                <button
                                    onClick={() => setEntries(prev => prev.filter((_, j) => j !== i))}
                                    className="flex-shrink-0 w-8 h-8 mt-1 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 flex items-center justify-center text-lg font-bold transition opacity-0 group-hover:opacity-100"
                                >
                                    &times;
                                </button>
                            )}
                        </div>
                    ))}

                    {/* Dodaj kolejną pozycję */}
                    <button
                        onClick={() => setEntries(prev => [...prev, ""])}
                        className="w-full py-3 border-2 border-dashed border-slate-200 rounded-xl text-[11px] font-black text-slate-400 hover:border-orange-400 hover:text-orange-500 transition uppercase tracking-widest mt-2"
                    >
                        + Dodaj kolejną pozycję
                    </button>
                </div>

                {/* STOPKA */}
                <div className="p-4 border-t border-slate-200 bg-white flex items-center gap-3 flex-shrink-0">
                    <p className="text-[10px] text-slate-400 flex-1">
                        💡 <b>Backspace</b> na pustej pozycji usuwa ją · <b>Enter</b> tworzy nową
                    </p>
                    <button onClick={onCancel} className="px-6 py-3 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition text-sm">
                        Anuluj
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={nonEmpty === 0}
                        className="px-8 py-3 bg-orange-600 text-white font-black rounded-xl shadow-lg hover:bg-orange-700 transition active:scale-95 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        ZAPISZ DO KOSZYKA ({nonEmpty} poz.)
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function ShopPage() {
    const { user } = useAuth();
    const router = useRouter();
    const [items, setItems] = useState<InventoryItem[]>([]);
    const [sites, setSites] = useState<Site[]>([]);
    const [loading, setLoading] = useState(true);

    const [searchTerm, setSearchTerm] = useState("");
    const [activeTab, setActiveTab] = useState<"UNIQUE" | "BULK">("UNIQUE");
    const [selectedSystemId, setSelectedSystemId] = useState<string | null>(null);
    const [selectedCategory, setSelectedCategory] = useState<string>("ALL");

    const [cart, setCart] = useState<CartItem[]>([]);
    const [isCartOpen, setIsCartOpen] = useState(false);
    const [selectedSiteId, setSelectedSiteId] = useState("");
    const [orderNotes, setOrderNotes] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [enlargedImage, setEnlargedImage] = useState<string | null>(null);

    // Stany dla Modala Wpisów Ręcznych
    const [isManualModalOpen, setIsManualModalOpen] = useState(false);
    const [manualText, setManualText] = useState("");

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            const invSnap = await getDocs(query(collection(db, "inventory"), orderBy("name", "asc")));
            setItems(invSnap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[]);

            const sitesSnap = await getDocs(query(collection(db, "sites"), orderBy("name", "asc")));
            const allSites = sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[];
            const userAssigned = user?.assignedSites || [];
            setSites(allSites.filter(s => userAssigned.includes("ALL") || userAssigned.includes(s.id)));
            setLoading(false);
        };
        fetchData();
    }, [user]);

    const addToCart = (item: InventoryItem) => {
        if (item.availableQuantity <= 0) return alert("Brak na magazynie głównym.");
        if (cart.find(i => i.dbId === item.id)) return;

        setCart([...cart, {
            cartId: Date.now().toString(), isManual: false, dbId: item.id, name: item.name,
            type: item.type, inventoryNumber: item.inventoryNumber, quantity: 1, imageUrl: item.imageUrl, maxQty: item.availableQuantity
        }]);
    };

    // --- LOGIKA Wpisu Ręcznego ---
    const openManualModal = () => {
        const existing = cart.find(item => item.isManual);
        setManualText(existing ? existing.name : "");
        setIsManualModalOpen(true);
    };

    const saveManualEntry = (text?: string) => {
        const finalText = text ?? manualText;
        if (!finalText.trim()) {
            setIsManualModalOpen(false);
            return;
        }

        const existingManual = cart.find(item => item.isManual);

        if (existingManual) {
            setCart(prevCart =>
                prevCart.map(item =>
                    item.cartId === existingManual.cartId
                        ? { ...item, name: finalText }
                        : item
                )
            );
        } else {
            setCart(prevCart => [
                ...prevCart,
                {
                    cartId: crypto.randomUUID(),
                    isManual: true,
                    name: finalText,
                    quantity: 1
                }
            ]);
        }

        setIsManualModalOpen(false);
    };

    const removeFromCart = (cartId: string) => {
        setCart(cart.filter(i => i.cartId !== cartId));
    };

    const updateQty = (cartId: string, qty: number) => {
        const safeQty = Math.max(1, qty);
        setCart(cart.map(i =>
            i.cartId === cartId
                ? { ...i, quantity: safeQty }
                : i
        ));
    };

    const updateManualName = (cartId: string, newName: string) => {
        setCart(cart.map(item =>
            item.cartId === cartId
                ? { ...item, name: newName }
                : item
        ));
    };

    const handleSubmitOrder = async () => {
        if (!selectedSiteId) return alert("Wybierz budowę!");
        if (cart.length === 0) return alert("Koszyk jest pusty!");

        const emptyManuals = cart.filter(i => i.isManual && !i.name.trim());
        if (emptyManuals.length > 0) return alert("Uzupełnij wpisy ręczne lub je usuń z koszyka!");

        setIsSubmitting(true);

        const orderId = `ZAM-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.floor(1000 + Math.random() * 9000)}`;

        try {
            // Grupujemy pozycje w 3 sekcje dla dokumentu PDF
            const narzedzia = cart
                .filter(i => !i.isManual && i.type === "UNIQUE")
                .map(i => ({ name: i.name, inventoryNumber: i.inventoryNumber, quantity: 1, section: "NARZĘDZIA" }));

            const rusztowania = cart
                .filter(i => !i.isManual && i.type === "BULK")
                .map(i => ({ name: i.name, inventoryNumber: i.inventoryNumber, quantity: i.quantity, section: "RUSZTOWANIA" }));

            // Wpis ręczny rozbijamy na osobne linie → sekcja MATERIAŁY DODATKOWE
            const materialyDodatkowe = cart
                .filter(i => i.isManual)
                .flatMap(i =>
                    i.name.split("\n")
                        .filter(l => l.trim() !== "")
                        .map(l => ({ name: l.trim(), quantity: 1, section: "MATERIAŁY DODATKOWE" }))
                );

            const processedCart = [...narzedzia, ...rusztowania, ...materialyDodatkowe];

            const res = await fetch("/api/orders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    orderId,
                    siteId: selectedSiteId,
                    siteName: sites.find(s => s.id === selectedSiteId)?.name,
                    user: { uid: user?.uid, firstName: user?.firstName, lastName: user?.lastName },
                    cart: processedCart,
                    // Sekcje osobno dla łatwiejszego generowania PDF
                    sections: {
                        narzedzia,
                        rusztowania,
                        materialyDodatkowe,
                    },
                    notes: orderNotes
                })
            });

            if (res.ok) {
                alert(`Zamówienie ${orderId} wysłane!`);
                setCart([]);
                setIsCartOpen(false);
            } else {
                alert("Błąd wysyłki zamówienia.");
            }
        } catch (error) {
            console.error(error);
            alert("Błąd wysyłki.");
        } finally {
            setIsSubmitting(false);
        }
    };

    const uniqueCategories = Array.from(new Set(items.filter(i => i.type === "UNIQUE").map(i => i.category).filter(Boolean))).sort();

    const getVisibleItems = () => {
        let filtered = items.filter(i => i.status === "sprawne" && i.name.toLowerCase().includes(searchTerm.toLowerCase()));

        if (activeTab === "UNIQUE") {
            let uniqueItems = filtered.filter(i => i.type === "UNIQUE" && i.availableQuantity > 0);
            if (selectedCategory !== "ALL") {
                uniqueItems = uniqueItems.filter(i => i.category === selectedCategory);
            }
            return uniqueItems;
        } else {
            if (selectedSystemId) {
                return filtered.filter(i => i.type === "BULK" && i.subType === "SUB_ITEM" && i.mainCategoryId === selectedSystemId);
            } else {
                return filtered.filter(i => i.type === "BULK" && i.subType === "MAIN_CAT");
            }
        }
    };

    return (
        <div className="p-4 md:p-6 max-w-[1600px] mx-auto h-[90vh] flex flex-col relative animate-fade-in overflow-hidden">
            <div className="flex justify-between items-center mb-4 border-b pb-4">
                <div>
                    <h1 className="text-2xl font-black text-slate-800 tracking-tighter uppercase italic">Sklep PESAM</h1>
                </div>
                <button onClick={() => setIsCartOpen(true)} className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-xl font-bold shadow-md flex items-center gap-2 transition-all">
                    🛒 KOSZYK <span className="bg-white text-blue-600 px-1.5 rounded-md text-[10px]">{cart.length}</span>
                </button>
            </div>

            <div className="flex flex-col md:flex-row gap-3 mb-6 items-center">
                <input
                    type="text"
                    placeholder="Szukaj (np. zak...)"
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    className="p-2.5 border rounded-xl flex-1 max-w-sm text-sm outline-none focus:border-blue-500 shadow-sm"
                />

                {activeTab === "UNIQUE" && (
                    <select
                        value={selectedCategory}
                        onChange={(e) => setSelectedCategory(e.target.value)}
                        className="p-2.5 border rounded-xl bg-white text-sm text-slate-700 outline-none focus:border-blue-500 shadow-sm cursor-pointer"
                    >
                        <option value="ALL">Wszystkie kategorie</option>
                        {uniqueCategories.map(cat => (
                            <option key={cat} value={cat}>{cat}</option>
                        ))}
                    </select>
                )}

                <div className="flex bg-slate-100 p-1 rounded-lg shadow-inner border border-slate-200">
                    <button onClick={() => { setActiveTab("UNIQUE"); setSelectedSystemId(null); setSelectedCategory("ALL"); }} className={`px-4 py-1.5 rounded-md text-[11px] font-black transition-all ${activeTab === 'UNIQUE' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>NARZĘDZIA</button>
                    <button onClick={() => { setActiveTab("BULK"); setSelectedSystemId(null); }} className={`px-4 py-1.5 rounded-md text-[11px] font-black transition-all ${activeTab === 'BULK' ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>RUSZTOWANIA</button>
                </div>

                {selectedSystemId && (
                    <button onClick={() => setSelectedSystemId(null)} className="text-[11px] font-black text-blue-600 bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-200">← WRÓĆ DO SYSTEMÓW</button>
                )}
            </div>

            <div className="flex-1 overflow-y-auto pr-2 pb-10">
                {loading ? <div className="text-center p-10 text-slate-400 font-bold uppercase text-xs">Ładowanie asortymentu...</div> : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
                        {getVisibleItems().map(item => {
                            const isSystem = activeTab === "BULK" && item.subType === "MAIN_CAT";
                            const isInCart = cart.some(c => c.dbId === item.id);

                            if (isSystem) {
                                return (
                                    <div key={item.id} onClick={() => setSelectedSystemId(item.id)} className="bg-slate-800 text-white rounded-xl border border-slate-700 flex items-center h-[120px] cursor-pointer hover:bg-slate-700 hover:shadow-xl transition-all relative overflow-hidden group">
                                        <div className="absolute -right-4 -bottom-4 opacity-10 text-8xl transition-transform group-hover:scale-110">📁</div>
                                        <div className="w-28 h-full bg-white/10 flex items-center justify-center p-2 border-r border-white/10 flex-shrink-0">
                                            {item.imageUrl ? <img src={item.imageUrl} className="max-w-full max-h-full object-contain rounded" alt="" /> : <span className="text-3xl">🏗️</span>}
                                        </div>
                                        <div className="p-4 flex-1 flex flex-col justify-center">
                                            <h3 className="font-black text-sm leading-tight uppercase line-clamp-2">{item.name}</h3>
                                            <p className="text-[10px] text-blue-300 font-mono tracking-widest uppercase mt-2">KOD: {item.inventoryNumber}</p>
                                            <p className="text-[10px] font-bold text-orange-400 mt-2 uppercase">Otwórz folder ➡️</p>
                                        </div>
                                    </div>
                                );
                            }

                            return (
                                <div
                                    key={item.id}
                                    className={`border rounded-xl flex items-center h-[110px] overflow-hidden transition-all shadow-sm group relative ${isInCart
                                            ? 'border-green-500 shadow-md'
                                            : 'bg-white border-slate-200 hover:shadow-lg hover:border-blue-300'
                                        }`}
                                    style={isInCart ? {
                                        backgroundColor: '#f0fdf4',
                                        backgroundImage: 'repeating-linear-gradient(45deg, rgba(34, 197, 94, 0.05) 0, rgba(34, 197, 94, 0.05) 10px, rgba(34, 197, 94, 0.1) 10px, rgba(34, 197, 94, 0.1) 20px)'
                                    } : {}}
                                >
                                    {/* Miniaturka (Lewa strona) */}
                                    <div className="w-24 h-full bg-slate-50 flex items-center justify-center border-r border-slate-100 p-2 cursor-zoom-in relative group/img z-10 flex-shrink-0" onClick={() => item.imageUrl && setEnlargedImage(item.imageUrl)}>
                                        <img src={item.imageUrl || 'https://via.placeholder.com/100?text=Brak'} alt={item.name} className="max-w-full max-h-full object-contain group-hover/img:scale-110 transition-transform duration-300" />
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center text-white text-xl font-bold">🔍</div>
                                    </div>

                                    {/* Informacje (Prawa strona) */}
                                    <div className="p-3 flex-1 flex flex-col justify-between h-full z-10">
                                        <div>
                                            <h3 className="font-bold text-slate-800 text-[11px] leading-tight line-clamp-2 uppercase" title={item.name}>{item.name}</h3>
                                            {item.type === "UNIQUE" && <p className="text-[10px] font-black text-blue-600 mt-0.5">NR MAG: {item.inventoryNumber}</p>}
                                        </div>

                                        <div className="flex items-center justify-between mt-auto">
                                            <div className="flex flex-col">
                                                <span className="text-[8px] font-bold text-slate-400 uppercase leading-none mb-0.5">Na stanie</span>
                                                <span className="text-xs font-black text-green-600 leading-none">{item.availableQuantity} szt.</span>
                                            </div>

                                            {isInCart ? (
                                                <div className="text-[10px] font-black text-green-700 bg-white border border-green-300 px-3 py-1.5 rounded-lg flex items-center gap-1 shadow-sm">
                                                    <span>✓</span> W KOSZYKU
                                                </div>
                                            ) : (
                                                <button onClick={() => addToCart(item)} className="bg-slate-100 hover:bg-green-600 text-slate-600 hover:text-white border border-slate-200 hover:border-green-600 px-3 py-1.5 rounded-lg text-[10px] font-black transition-all active:scale-95 uppercase shadow-sm">
                                                    Do koszyka
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* LIGHTBOX POWIĘKSZENIA ZDJĘCIA */}
            {enlargedImage && (
                <div className="fixed inset-0 bg-black/90 z-[9999999] flex items-center justify-center p-4 cursor-zoom-out" onClick={() => setEnlargedImage(null)}>
                    <img src={enlargedImage} className="max-w-full max-h-[85vh] object-contain rounded-xl shadow-2xl border-2 border-white/20" alt="Powiększenie" />
                    <button className="absolute top-6 right-6 text-white text-4xl font-bold opacity-70 hover:opacity-100 transition-opacity">&times;</button>
                </div>
            )}

            {/* ✅ MODAL WPISU RĘCZNEGO - edytor pozycji */}
            {isManualModalOpen && (
                <ManualEntryModal
                    initialText={manualText}
                    onSave={(text) => saveManualEntry(text)}
                    onCancel={() => setIsManualModalOpen(false)}
                />
            )}

            {/* KOSZYK (Drawer) - pointer-events-none na overlay, żeby modal był klikalny */}
            {isCartOpen && (
                <div
                    className="fixed inset-0 flex justify-end animate-fade-in"
                    style={{ zIndex: 99999 }}
                >
                    {/* Ciemne tło - pointer-events-none gdy modal otwarty */}
                    <div
                        className="absolute inset-0 bg-black/60"
                        style={{ pointerEvents: isManualModalOpen ? 'none' : 'auto' }}
                        onClick={() => !isManualModalOpen && setIsCartOpen(false)}
                    />

                    {/* Drawer - zawsze klikalny */}
                    <div className="relative bg-white w-full max-w-md h-full shadow-2xl flex flex-col animate-slide-in" style={{ pointerEvents: 'auto' }}>
                        <div className="p-4 border-b flex justify-between items-center bg-slate-50">
                            <h2 className="text-lg font-black uppercase">Koszyk</h2>
                            <button onClick={() => setIsCartOpen(false)} className="text-2xl text-slate-400 hover:text-red-500">&times;</button>
                        </div>
                        <div className="p-4 bg-blue-600 text-white shadow-inner">
                            <label className="text-[10px] font-black uppercase block mb-1">Cel: Budowa</label>
                            <select value={selectedSiteId} onChange={e => setSelectedSiteId(e.target.value)} className="w-full p-2 rounded-lg bg-white text-slate-800 text-sm font-bold shadow-sm">
                                <option value="">-- Wybierz budowę --</option>
                                {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/50">
                            <div className="flex justify-between items-center border-b border-slate-200 pb-2 mb-4">
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Twoje przedmioty</span>
                                <button onClick={openManualModal} className="text-[10px] font-black text-orange-600 bg-orange-100 border border-orange-200 px-3 py-1.5 rounded-lg hover:bg-orange-200 transition-all shadow-sm">+ WPIS RĘCZNY</button>
                            </div>

                            {cart.length === 0 ? (
                                <div className="text-center py-20 text-slate-300 font-bold uppercase text-xs italic">Koszyk jest pusty</div>
                            ) : cart.map(c => (
                                <div key={c.cartId} className={`border rounded-xl shadow-sm bg-white overflow-hidden ${c.isManual ? 'border-orange-300' : 'border-slate-200'}`}>

                                    {c.isManual ? (
                                        /* WPIS RĘCZNY - klikalny, otwiera modal */
                                        <div
                                            className="cursor-pointer hover:bg-orange-50 transition-colors"
                                            onClick={openManualModal}
                                        >
                                            <div className="flex items-center justify-between px-3 pt-3 pb-2">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-base">📝</span>
                                                    <div>
                                                        <p className="text-[10px] font-black text-orange-600 uppercase tracking-tight">Materiały dodatkowe</p>
                                                        <p className="text-[9px] text-orange-400">
                                                            {c.name.split("\n").filter(l => l.trim()).length} pozycji · kliknij aby edytować
                                                        </p>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] text-orange-500 font-bold bg-orange-100 px-2 py-1 rounded-lg">✏️ Edytuj</span>
                                                    <button
                                                        onClick={e => { e.stopPropagation(); removeFromCart(c.cartId); }}
                                                        className="text-red-400 hover:text-red-600 hover:bg-red-50 w-6 h-6 rounded flex items-center justify-center text-lg font-bold transition"
                                                    >&times;</button>
                                                </div>
                                            </div>
                                            {/* Podgląd pozycji - max 3 */}
                                            <div className="px-3 pb-3 space-y-1">
                                                {c.name.split("\n").filter(l => l.trim()).slice(0, 3).map((line, i) => (
                                                    <div key={i} className="flex items-start gap-2">
                                                        <span className="text-[9px] font-black text-orange-400 bg-orange-100 rounded px-1 flex-shrink-0 mt-0.5">{i + 1}</span>
                                                        <p className="text-[11px] text-slate-700 leading-snug line-clamp-1">{line}</p>
                                                    </div>
                                                ))}
                                                {c.name.split("\n").filter(l => l.trim()).length > 3 && (
                                                    <div className="flex items-center gap-2 pt-1">
                                                        <span className="text-[9px] font-black text-orange-300 bg-orange-50 border border-orange-200 border-dashed rounded px-2 py-0.5">
                                                            + {c.name.split("\n").filter(l => l.trim()).length - 3} więcej pozycji — kliknij aby zobaczyć
                                                        </span>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    ) : (
                                        /* PRODUKT Z KATALOGU */
                                        <div className="flex items-center gap-3 p-3">
                                            <img src={c.imageUrl || 'https://via.placeholder.com/40'} className="w-10 h-10 rounded-lg object-cover border flex-shrink-0" />
                                            <div className="flex-1 min-w-0">
                                                <p className="font-bold truncate text-xs uppercase leading-tight">{c.name}</p>
                                                <p className="text-[9px] text-blue-500 font-bold mt-0.5">NR: {c.inventoryNumber || "-"}</p>
                                            </div>
                                            <div className="flex items-center gap-2 flex-shrink-0">
                                                {c.type === "BULK" ? (
                                                    <input type="number" min="1" max={c.maxQty || 9999} value={c.quantity} onChange={(e) => updateQty(c.cartId, Number(e.target.value))} className="w-12 p-1 border rounded text-center text-xs font-bold outline-none focus:border-blue-500" />
                                                ) : (
                                                    <span className="font-black text-xs bg-slate-100 px-3 py-2 rounded-xl border">1</span>
                                                )}
                                                <button onClick={() => removeFromCart(c.cartId)} className="text-red-500 bg-red-50 hover:bg-red-500 hover:text-white transition-colors w-7 h-7 rounded flex items-center justify-center font-bold text-lg leading-none">&times;</button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                        <div className="p-4 border-t border-slate-200 bg-white">
                            <textarea value={orderNotes} onChange={e => setOrderNotes(e.target.value)} placeholder="Uwagi do zamówienia..." className="w-full p-3 border border-slate-200 rounded-xl text-xs h-20 outline-none focus:border-blue-500 mb-4 bg-slate-50" />
                            <button onClick={handleSubmitOrder} disabled={isSubmitting || cart.length === 0} className="w-full py-4 bg-green-600 hover:bg-green-700 text-white font-black rounded-2xl shadow-lg disabled:opacity-50 transition-all uppercase tracking-widest text-sm">
                                {isSubmitting ? "Wysyłanie..." : "Wyślij zamówienie"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}