"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
    collection, getDocs, query, orderBy,
    doc, setDoc, getDoc, deleteDoc, where,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { useRouter } from "next/navigation";
import { getStorage, ref, deleteObject } from "firebase/storage";
import { hasPermission } from "@/lib/auth/permissions";

// ─── TYPY ────────────────────────────────────────────────────────────────────

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
interface Site {
    id: string;
    name: string;
    status?: string;
    location?: string;
}
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

// Draft zapisywany do Firestore (wszystko co potrzeba do przywrócenia koszyka)
interface CartDraft {
    cart: CartItem[];
    selectedSiteId: string;
    orderNotes: string;
    updatedAt: string;
}

// ─── KOMPONENT: Edytor pozycji ręcznych ──────────────────────────────────────

function ManualEntryModal({
    initialText,
    onSave,
    onCancel,
}: {
    initialText: string;
    onSave: (text: string) => void;
    onCancel: () => void;
}) {
    const [entries, setEntries] = useState<string[]>(() => {
        const parsed = initialText.split("\n").filter(l => l.trim() !== "");
        return parsed.length > 0 ? parsed : [""];
    });

    // Tablica ref-ów dla textarea-ów
    const textareaRefs = useRef<(HTMLTextAreaElement | null)[]>([]);

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
            setEntries(prev => {
                const next = [...prev];
                next.splice(i + 1, 0, "");
                return next;
            });
            setTimeout(() => textareaRefs.current[i + 1]?.focus(), 30);
        }
        if (e.key === "Backspace" && entries[i] === "" && entries.length > 1) {
            e.preventDefault();
            setEntries(prev => {
                const next = [...prev];
                next.splice(i, 1);
                return next;
            });
            setTimeout(() => textareaRefs.current[Math.max(0, i - 1)]?.focus(), 30);
        }
    };

    const nonEmpty = entries.filter(e => e.trim() !== "").length;

    const handleSave = () => {
        const joined = entries.filter(e => e.trim() !== "").join("\n");
        onSave(joined);
    };

    return (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 backdrop-blur-sm" style={{ zIndex: 9999999 }}>
            <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden border-t-4 border-orange-500 flex flex-col" style={{ height: "80vh" }}>

                {/* Nagłówek */}
                <div className="p-5 bg-orange-50 border-b border-orange-100 flex justify-between items-center flex-shrink-0">
                    <div>
                        <h3 className="font-black text-orange-800 uppercase tracking-tight text-xl">📝 Wpis ręczny</h3>
                        <p className="text-xs text-orange-600 mt-0.5">
                            <b>Enter</b> = nowa pozycja · Każda pozycja może zajmować wiele wierszy
                        </p>
                    </div>
                    <button onClick={onCancel} className="text-3xl text-slate-400 hover:text-red-500 w-10 h-10 flex items-center justify-center rounded-full hover:bg-red-50 transition leading-none">&times;</button>
                </div>

                {/* Licznik */}
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

                {/* Lista pozycji */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-slate-50">
                    {entries.map((entry, i) => (
                        <div key={i} className="flex gap-3 items-start group">
                            <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-xs font-black mt-1 transition-colors ${entry.trim() !== "" ? "bg-orange-500 text-white shadow-sm" : "bg-slate-200 text-slate-400"}`}>
                                {i + 1}
                            </div>
                            <textarea
                                ref={el => { textareaRefs.current[i] = el; }}
                                value={entry}
                                onChange={e => updateEntry(i, e.target.value)}
                                onKeyDown={e => handleKeyDown(i, e)}
                                rows={1}
                                autoFocus={i === entries.length - 1 && i > 0}
                                placeholder={i === 0 ? "np. 10 par rękawic roboczych, rozmiar L..." : `Pozycja ${i + 1}...`}
                                className="flex-1 p-2.5 border-2 border-slate-200 rounded-xl text-sm bg-white outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20 resize-none leading-relaxed transition-all placeholder-slate-300"
                                style={{ minHeight: "40px", height: "auto", overflow: "hidden" }}
                                onInput={e => {
                                    const t = e.currentTarget;
                                    t.style.height = "auto";
                                    t.style.height = t.scrollHeight + "px";
                                }}
                            />
                            {entries.length > 1 && (
                                <button
                                    onClick={() => setEntries(prev => prev.filter((_, j) => j !== i))}
                                    className="flex-shrink-0 w-8 h-8 mt-1 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 flex items-center justify-center text-lg font-bold transition opacity-0 group-hover:opacity-100"
                                >&times;</button>
                            )}
                        </div>
                    ))}
                    <button
                        onClick={() => setEntries(prev => [...prev, ""])}
                        className="w-full py-3 border-2 border-dashed border-slate-200 rounded-xl text-[11px] font-black text-slate-400 hover:border-orange-400 hover:text-orange-500 transition uppercase tracking-widest mt-2"
                    >
                        + Dodaj kolejną pozycję
                    </button>
                </div>

                {/* Stopka */}
                <div className="p-4 border-t border-slate-200 bg-white flex items-center gap-3 flex-shrink-0">
                    <p className="text-[10px] text-slate-400 flex-1">
                        💡 <b>Backspace</b> na pustej pozycji usuwa ją · <b>Enter</b> tworzy nową
                    </p>
                    <button onClick={onCancel} className="px-6 py-3 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition text-sm">Anuluj</button>
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

// ─── STRONA GŁÓWNA: SKLEP ─────────────────────────────────────────────────────

export default function ShopPage() {
    const { user } = useAuth();
    const router = useRouter();

    const [items, setItems] = useState<InventoryItem[]>([]);
    const [sites, setSites] = useState<Site[]>([]);
    const [loading, setLoading] = useState(true);

    // Stany dla zamówień głosowych i Kreatora AI (Wizard)
    const [voiceOrders, setVoiceOrders] = useState<any[]>([]);
    const [isVoiceModalOpen, setIsVoiceModalOpen] = useState(false);
    const [isParsingVoice, setIsParsingVoice] = useState<string | null>(null);

    // Dane aktywnego kreatora dla materiałów zakupowych (PURCHASE)
    const [wizardItems, setWizardItems] = useState<any[]>([]);
    const [wizardStep, setWizardStep] = useState<number>(-1); // -1 = zamknięty kreator
    const [wizardSelections, setWizardSelections] = useState<Record<number, string>>({});

    // Masowa synchronizacja - przechowujemy ID notatek do automatycznego usunięcia po sukcesie
    const [activeVoiceOrderIds, setActiveVoiceOrderIds] = useState<string[]>([]);

    // Obiekt do śledzenia, które notatki są zaznaczone checkboxem w modalu
    const [selectedVoiceOrderIds, setSelectedVoiceOrderIds] = useState<Record<string, boolean>>({});

    // Notatki referencyjne o sprzęcie z magazynu (WAREHOUSE)
    const [warehouseNotes, setWarehouseNotes] = useState<string[]>([]);

    // Filtrowanie katalogu
    const [searchTerm, setSearchTerm] = useState("");
    const [activeTab, setActiveTab] = useState<"UNIQUE" | "BULK">("UNIQUE");
    const [selectedSystemId, setSelectedSystemId] = useState<string | null>(null);
    const [selectedCategory, setSelectedCategory] = useState<string>("ALL");

    // Koszyk i zamówienie
    const [cart, setCart] = useState<CartItem[]>([]);
    const [isCartOpen, setIsCartOpen] = useState(false);
    const [selectedSiteId, setSelectedSiteId] = useState("");
    const [orderNotes, setOrderNotes] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [draftSaving, setDraftSaving] = useState(false);

    // UI
    const [enlargedImage, setEnlargedImage] = useState<string | null>(null);
    const [isManualModalOpen, setIsManualModalOpen] = useState(false);
    const [manualText, setManualText] = useState("");
    const [bulkPickModal, setBulkPickModal] = useState<{ item: InventoryItem; qty: number } | null>(null);

    // 🤖 AI States (Weryfikacja koszyka)
    const [isVerifyingCart, setIsVerifyingCart] = useState(false);
    const [cartSuggestions, setCartSuggestions] = useState<{ 
        analysis: string, 
        systemsIdentified: string[], 
        suggestedItems: { name: string, unit: string }[],
        normalizedItems: { original: string, professional: string }[]
    } | null>(null);
    const [suggestionQtys, setSuggestionQtys] = useState<Record<number, number>>({}); 
    const [suggestionNames, setSuggestionNames] = useState<Record<number, string>>({}); // Przechowuje zedytowane przez usera nazwy

    // 💬 AI States (Czat Kosztorysant)
    const canUseAiText = hasPermission("useAiOrderText", user?.rolePermissions, user?.permissionOverrides);
    const canUseAiVoice = hasPermission("useAiOrderVoice", user?.rolePermissions, user?.permissionOverrides);
    
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [chatHistory, setChatHistory] = useState<{ 
    role: 'user'|'ai', 
    content: string, 
    generatedItems?: any[],
    materialOptions?: { category: string, options: string[] }[], // Nowe: Opcje od Doradcy
    originalRequest?: string, // Nowe: Zapamiętanie wymiarów do kalkulatora
    reasoning?: string[],    // <--- DODANE: Tok myślenia / Obliczenia
    asciiDrawing?: string    // <--- DODANE: Rysunek ASCII
}[]>([]);

// Stan do przechowywania zaznaczonych opcji w czacie
const [chatSelections, setChatSelections] = useState<Record<number, Record<string, string>>>({});
    const [chatInputText, setChatInputText] = useState("");
    const [isChatLoading, setIsChatLoading] = useState(false);
    const [isChatRecording, setIsChatRecording] = useState(false);
    const chatMediaRecorder = useRef<MediaRecorder | null>(null);
    const chatAudioChunks = useRef<BlobPart[]>([]);
    const chatEndRef = useRef<HTMLDivElement | null>(null);

    // Scroll czatu na dół przy nowej wiadomości
    useEffect(() => {
        if (chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }, [chatHistory, isChatLoading]);
    // Debounce ref dla zapisu draftu
    const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    
    // ── Pobieranie danych + wczytanie draftu ──────────────────────────────────
    useEffect(() => {
        if (!user) return;
        const fetchData = async () => {
            setLoading(true);
            try {
                // Katalog
                const invSnap = await getDocs(query(collection(db, "inventory"), orderBy("name", "asc")));
                setItems(invSnap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[]);

                // Budowy filtrowane wg uprawnień
                const sitesSnap = await getDocs(query(collection(db, "sites"), orderBy("name", "asc")));
                const allSites = sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[];
                const userAssigned = user?.assignedSites || [];

                // Blokujemy możliwość zamawiania na wpisy ręczne i budowy zakończone
                const filteredSites = allSites.filter(s =>
                    (userAssigned.includes("ALL") || userAssigned.includes(s.id)) &&
                    s.location !== "Wpis ręczny" &&
                    s.status !== "ZAKOŃCZONA"
                );

                setSites(filteredSites);

                // Wczytaj draft koszyka z Firestore
                const draftRef = doc(db, "cartDrafts", user.uid);
                const draftSnap = await getDoc(draftRef);
                if (draftSnap.exists()) {
                    const draft = draftSnap.data() as CartDraft;
                    setCart(draft.cart || []);
                    setOrderNotes(draft.orderNotes || "");

                    // Przywróć zapisaną budowę tylko jeśli nadal jest dostępna
                    if (draft.selectedSiteId) {
                        const stillAssigned = filteredSites.some(s => s.id === draft.selectedSiteId);
                        if (stillAssigned) setSelectedSiteId(draft.selectedSiteId);
                    }
                }

                // Jeśli kierownik ma tylko 1 budowę — wybierz ją automatycznie
                if (filteredSites.length === 1) {
                    setSelectedSiteId(filteredSites[0].id);
                }
            } catch (error) {
                console.error("Błąd pobierania danych sklepu:", error);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [user]);

    // ── Zapis draftu do Firestore (debounced 1.2s) ────────────────────────────
    const saveDraft = useCallback((
        cartData: CartItem[],
        siteId: string,
        notes: string,
    ) => {
        if (!user) return;
        if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
        setDraftSaving(true);
        draftTimerRef.current = setTimeout(async () => {
            try {
                const draft: CartDraft = {
                    cart: cartData,
                    selectedSiteId: siteId,
                    orderNotes: notes,
                    updatedAt: new Date().toISOString(),
                };
                await setDoc(doc(db, "cartDrafts", user.uid), draft);
            } catch (err) {
                console.error("Błąd zapisu draftu:", err);
            } finally {
                setDraftSaving(false);
            }
        }, 1200);
    }, [user]);

    // ── Helpery koszyka (każda zmiana → zapis draftu) ─────────────────────────

    const addToCart = (item: InventoryItem) => {
        if (item.availableQuantity <= 0) return alert("Brak na magazynie głównym.");
        if (cart.find(i => i.dbId === item.id)) return;

        // Jeśli to sprzęt ilościowy (BULK), pokaż modal z pytaniem o ilość
        if (item.type === "BULK") {
            setBulkPickModal({ item, qty: 1 });
            return;
        }

        const newCart: CartItem[] = [...cart, {
            cartId: Date.now().toString(),
            isManual: false,
            dbId: item.id,
            name: item.name,
            type: item.type,
            inventoryNumber: item.inventoryNumber,
            quantity: 1,
            imageUrl: item.imageUrl,
            maxQty: item.availableQuantity,
        }];
        setCart(newCart);
        saveDraft(newCart, selectedSiteId, orderNotes);
    };

    const confirmBulkAdd = () => {
        if (!bulkPickModal) return;
        const { item, qty } = bulkPickModal;

        if (qty <= 0 || qty > item.availableQuantity) {
            return alert(`Podaj ilość od 1 do ${item.availableQuantity}`);
        }

        const newCart: CartItem[] = [...cart, {
            cartId: Date.now().toString(),
            isManual: false,
            dbId: item.id,
            name: item.name,
            type: item.type,
            inventoryNumber: item.inventoryNumber,
            quantity: qty,
            imageUrl: item.imageUrl,
            maxQty: item.availableQuantity,
        }];

        setCart(newCart);
        saveDraft(newCart, selectedSiteId, orderNotes);
        setBulkPickModal(null); // Zamknij modal
    };

    const removeFromCart = (cartId: string) => {
        const newCart = cart.filter(i => i.cartId !== cartId);
        setCart(newCart);
        saveDraft(newCart, selectedSiteId, orderNotes);
    };

    const updateQty = (cartId: string, qty: number) => {
        const safeQty = Math.max(1, qty);
        const newCart = cart.map(i => i.cartId === cartId ? { ...i, quantity: safeQty } : i);
        setCart(newCart);
        saveDraft(newCart, selectedSiteId, orderNotes);
    };

    const handleSiteChange = (siteId: string) => {
        setSelectedSiteId(siteId);
        saveDraft(cart, siteId, orderNotes);
    };

    const handleNotesChange = (notes: string) => {
        setOrderNotes(notes);
        saveDraft(cart, selectedSiteId, notes);
    };

    // ── Wpis ręczny ───────────────────────────────────────────────────────────

    const openManualModal = () => {
        const existing = cart.find(item => item.isManual);
        setManualText(existing ? existing.name : "");
        setIsManualModalOpen(true);
    };

    const saveManualEntry = (text: string) => {
        if (!text.trim()) {
            setIsManualModalOpen(false);
            return;
        }
        const existingManual = cart.find(item => item.isManual);
        let newCart: CartItem[];
        if (existingManual) {
            newCart = cart.map(item =>
                item.cartId === existingManual.cartId ? { ...item, name: text } : item
            );
        } else {
            newCart = [...cart, {
                cartId: crypto.randomUUID(),
                isManual: true,
                name: text,
                quantity: 1,
            }];
        }
        setCart(newCart);
        saveDraft(newCart, selectedSiteId, orderNotes);
        setIsManualModalOpen(false);
    };

    // 🤖 Weryfikacja koszyka przez AI
    const verifyCartWithAI = async () => {
        if (cart.length === 0) return alert("Twój koszyk jest pusty!");
        setIsVerifyingCart(true);
        setCartSuggestions(null);
        setSuggestionQtys({});
        setSuggestionNames({});

        // Przygotowujemy płaską listę tego, co jest w koszyku, dla AI
        const itemsToAnalyze = cart.flatMap(item => {
            if (item.isManual) {
                return item.name.split("\n").filter(l => l.trim() !== "");
            }
            return [`${item.quantity}x ${item.name}`];
        });

        try {
            const res = await fetch("/api/verify-cart", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ items: itemsToAnalyze })
            });

            if (!res.ok) throw new Error("Błąd sieci");
            const data = await res.json();
            setCartSuggestions(data);
        } catch (err) {
            alert("Błąd połączenia z AI. Spróbuj ponownie.");
        } finally {
            setIsVerifyingCart(false);
        }
    };

    // Dodanie sugestii AI do wpisu ręcznego (z ilością, j.m. i edytowalną nazwą)
    const addSuggestionToCart = (originalName: string, unit: string, idx: number) => {
        const qty = suggestionQtys[idx] || 1; 
        const finalName = suggestionNames[idx] !== undefined ? suggestionNames[idx] : originalName;
        const textToAdd = `${qty}x ${finalName} (j.m. ${unit})`;

        const existingManual = cart.find(item => item.isManual);
        let newCart: CartItem[];
        
        if (existingManual) {
            const mergedText = [existingManual.name, textToAdd].filter(Boolean).join("\n");
            newCart = cart.map(item =>
                item.cartId === existingManual.cartId ? { ...item, name: mergedText } : item
            );
        } else {
            newCart = [...cart, {
                cartId: crypto.randomUUID(),
                isManual: true,
                name: textToAdd,
                quantity: 1
            }];
        }
        setCart(newCart);
        saveDraft(newCart, selectedSiteId, orderNotes);
        
        // Usuwamy dodaną sugestię z widoku
        if (cartSuggestions) {
            setCartSuggestions({
                ...cartSuggestions,
                suggestedItems: cartSuggestions.suggestedItems.filter(s => s.name !== originalName)
            });
        }
        // Czyścimy stan ilości dla tego indexu
        setSuggestionQtys(prev => {
            const next = { ...prev };
            delete next[idx];
            return next;
        });
    };

    // Podmiana potocznej nazwy z koszyka na profesjonalną zasugerowaną przez AI
    const applyNormalization = (original: string, professional: string) => {
        const newCart = cart.map(c => {
            if (c.isManual && c.name.includes(original)) {
                // Podmiana stringa wewnątrz wieloliniowego tekstu wpisu ręcznego
                return { ...c, name: c.name.replace(original, professional) };
            }
            return c;
        });
        
        setCart(newCart);
        saveDraft(newCart, selectedSiteId, orderNotes);
        
        // Ukryj wykorzystaną sugestię
        if (cartSuggestions) {
            setCartSuggestions({
                ...cartSuggestions,
                normalizedItems: cartSuggestions.normalizedItems.filter(n => n.original !== original)
            });
        }
    };

    // 💬 Funkcje Czatu Kosztorysanta
    const sendChatMessage = async (text: string, audioBase64: string | null = null) => {
        if (!text && !audioBase64) return;
        
        // Dodaj wiadomość usera do historii wizualnej
        const userDisplay = text ? text : "🎤 [Wiadomość głosowa]";
        const newHistory = [...chatHistory, { role: 'user' as const, content: userDisplay }];
        setChatHistory(newHistory);
        setChatInputText("");
        setIsChatLoading(true);

        try {
            const res = await fetch("/api/ai-chat-order", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ 
                    history: chatHistory.filter(h => !h.generatedItems), // Nie wysyłamy JSONów przedmiotów z powrotem, tylko tekst
                    currentText: text,
                    currentAudioBase64: audioBase64 
                })
            });

            if (!res.ok) throw new Error("Błąd AI");
            const data = await res.json();
            
            // Dodaj odpowiedź AI do historii
            setChatHistory(prev => [...prev, { 
                role: 'ai', 
                content: data.reply,
                generatedItems: data.generatedItems && data.generatedItems.length > 0 ? data.generatedItems : undefined,
                materialOptions: data.materialOptions, // <--- TO WYŚWIETLI PRZYCISKI
                originalRequest: data.originalRequest  // <--- TO ZAPAMIĘTA WYMIARY DLA KALKULATORA
            }]);

        } catch (err) {
            alert("Błąd połączenia z Kosztorysantem.");
        } finally {
            setIsChatLoading(false);
        }
    };

    // Funkcja wywołująca AI nr 2 (Kalkulator)
    const sendToCalculator = async (msgIndex: number, originalRequest: string) => {
        const selections = chatSelections[msgIndex];
        if (!selections) return alert("Wybierz najpierw parametry materiałów!");

        const selectionText = Object.entries(selections).map(([cat, opt]) => `${cat}: ${opt}`).join(", ");
        const promptForCalculator = `Wymiary/Zadanie: ${originalRequest}\nWybrane materiały: ${selectionText}`;

        // Dodajemy info do czatu
        setChatHistory(prev => [...prev, { role: 'user', content: `Oblicz dla: ${selectionText}` }]);
        setIsChatLoading(true);

        try {
            const res = await fetch("/api/ai-calculator", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ request: promptForCalculator })
            });

            if (!res.ok) throw new Error("Błąd Kalkulatora AI");
            const data = await res.json();
            
            setChatHistory(prev => [...prev, { 
                role: 'ai', 
                content: data.reply,
                generatedItems: data.generatedItems,
                reasoning: data.reasoning,      // <--- ZAPIS TOKU OBLICZEŃ
                asciiDrawing: data.asciiDrawing // <--- ZAPIS RYSUNKU ASCII
            }]);
        } catch (err) {
            alert("Błąd połączenia z Kalkulatorem.");
        } finally {
            setIsChatLoading(false);
        }
    };

    const startChatRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const recorder = new MediaRecorder(stream);
            chatAudioChunks.current = [];
            
            recorder.ondataavailable = e => { if (e.data.size > 0) chatAudioChunks.current.push(e.data); };
            recorder.onstop = async () => {
                const blob = new Blob(chatAudioChunks.current, { type: 'audio/mp3' });
                stream.getTracks().forEach(t => t.stop());
                
                // Konwersja na Base64
                const reader = new FileReader();
                reader.readAsDataURL(blob);
                reader.onloadend = () => {
                    const base64 = (reader.result as string).split(',')[1];
                    sendChatMessage("", base64); // Wysyłamy tylko audio
                };
            };
            
            chatMediaRecorder.current = recorder;
            recorder.start();
            setIsChatRecording(true);
        } catch (err) {
            alert("Brak dostępu do mikrofonu.");
        }
    };

    const stopChatRecording = () => {
        if (chatMediaRecorder.current && isChatRecording) {
            chatMediaRecorder.current.stop();
            setIsChatRecording(false);
        }
    };

    const applyGeneratedItemsToCart = (items: any[]) => {
        const textLines = items.map(i => `${i.quantity}x ${i.name} (j.m. ${i.unit})`).join("\n");
        const existingManual = cart.find(item => item.isManual);
        let newCart: CartItem[];
        
        if (existingManual) {
            newCart = cart.map(item =>
                item.cartId === existingManual.cartId 
                ? { ...item, name: [existingManual.name, textLines].filter(Boolean).join("\n") } 
                : item
            );
        } else {
            newCart = [...cart, { cartId: crypto.randomUUID(), isManual: true, name: textLines, quantity: 1 }];
        }
        setCart(newCart);
        saveDraft(newCart, selectedSiteId, orderNotes);
        setIsChatOpen(false); // Zamykamy czat po dodaniu
    };

    // --- Funkcje do edycji wyliczonych materiałów w czacie ---
    const updateGeneratedItemQty = (msgIndex: number, itemIndex: number, newQty: number) => {
        setChatHistory(prev => {
            const next = [...prev];
            const msg = { ...next[msgIndex] };
            if (msg.generatedItems) {
                const items = [...msg.generatedItems];
                items[itemIndex] = { ...items[itemIndex], quantity: Math.max(1, newQty) };
                msg.generatedItems = items;
            }
            next[msgIndex] = msg;
            return next;
        });
    };

    const removeGeneratedItem = (msgIndex: number, itemIndex: number) => {
        setChatHistory(prev => {
            const next = [...prev];
            const msg = { ...next[msgIndex] };
            if (msg.generatedItems) {
                const items = [...msg.generatedItems];
                items.splice(itemIndex, 1);
                msg.generatedItems = items;
            }
            next[msgIndex] = msg;
            return next;
        });
    };

    // Pobieranie oczekujących notatek głosowych i automatyczne zaznaczenie ich do procesu
    const openVoiceModal = async () => {
        if (!selectedSiteId) return alert("Najpierw wybierz budowę, aby pobrać przypisane do niej notatki!");
        setIsVoiceModalOpen(true);
        try {
            const q = query(
                collection(db, "voiceOrders"),
                where("siteId", "==", selectedSiteId),
                where("status", "==", "PENDING")
            );
            const snap = await getDocs(q);
            const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            setVoiceOrders(docs);

            // Domyślnie zaznaczamy wszystkie notatki checkboxem
            const initialSelected: Record<string, boolean> = {};
            docs.forEach(vo => { initialSelected[vo.id] = true; });
            setSelectedVoiceOrderIds(initialSelected);
        } catch (err) {
            console.error("Błąd pobierania notatek głosowych:", err);
        }
    };

    // Ręczne usuwanie notatki głosowej z bazy Firestore i chmury Storage
    const handleDeleteVoiceOrder = async (orderId: string) => {
        if (!confirm("⚠️ Czy na pewno chcesz trwale usunąć to nagranie z bazy danych? Tej operacji nie można cofnąć.")) return;
        const storage = getStorage();
        try {
            // 1. Usuń plik dźwiękowy (.mp3) ze Storage
            if (user) {
                try {
                    const audioRef = ref(storage, `voice_orders/${user.uid}/${orderId}.mp3`);
                    await deleteObject(audioRef);
                } catch (storageErr) {
                    console.warn("Plik audio nie istniał w Storage lub błąd uprawnień:", storageErr);
                }
            }
            // 2. Usuń dokument z Firestore
            await deleteDoc(doc(db, "voiceOrders", orderId));

            setVoiceOrders(prev => prev.filter(vo => vo.id !== orderId));
            alert("Nagranie zostało pomyślnie skasowane.");
        } catch (err) {
            alert("Błąd usuwania nagrania: " + err);
        }
    };

    // Masowe przetwarzanie zaznaczonych notatek przez AI
    const handleProcessSelectedVoiceOrders = async () => {
        const targetOrders = voiceOrders.filter(vo => selectedVoiceOrderIds[vo.id]);
        if (targetOrders.length === 0) return alert("Wybierz przynajmniej jedno nagranie do przetworzenia!");

        setIsParsingVoice("BULK"); // Włącza ekran ładowania
        try {
            let combinedWarehouse: string[] = [];
            let combinedWizardItems: any[] = [];
            let processedIds: string[] = [];

            // Odpytujemy API dla każdego zaznaczonego pliku równolegle (bardzo szybko!)
            const results = await Promise.all(
                targetOrders.map(async (vo) => {
                    try {
                        const res = await fetch("/api/parse-audio", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ audioUrl: vo.audioUrl })
                        });
                        if (!res.ok) throw new Error("Błąd sieci");
                        const data = await res.json();
                        return { vo, data };
                    } catch (err) {
                        console.error(`Błąd nagrania ${vo.id}:`, err);
                        return { vo, data: null };
                    }
                })
            );

            results.forEach(({ vo, data }) => {
                if (data && data.items) {
                    processedIds.push(vo.id);

                    // 1. Zbiór narzędzi z magazynu
                    const wh = data.items
                        .filter((i: any) => i.type === "WAREHOUSE")
                        .map((i: any) => `${i.quantity}x ${i.roughName}`);
                    combinedWarehouse = [...combinedWarehouse, ...wh];

                    // 2. Zbiór materiałów budowlanych (Zapisujemy audioUrl pod pozycję!)
                    const pur = data.items
                        .filter((i: any) => i.type === "PURCHASE")
                        .map((i: any) => ({ ...i, audioUrl: vo.audioUrl }));
                    combinedWizardItems = [...combinedWizardItems, ...pur];
                }
            });

            if (combinedWarehouse.length > 0 || combinedWizardItems.length > 0) {
                setWarehouseNotes(prev => [...prev, ...combinedWarehouse]);
                setWizardItems(combinedWizardItems);
                setWizardSelections({});
                setActiveVoiceOrderIds(processedIds);
                setIsVoiceModalOpen(false); // Zamykamy listę, przechodzimy do kreatora

                if (combinedWizardItems.length > 0) {
                    setWizardStep(0); // Otwieramy krok 1 kreatora dla materiałów
                } else {
                    // Jeśli były tylko narzędzia, od razu usuwamy przetworzone notatki z bazy!
                    await Promise.all(processedIds.map(id => deleteDoc(doc(db, "voiceOrders", id))));
                    alert(`📋 Zaimportowano zapotrzebowanie na sprzęt z magazynu: ${combinedWarehouse.join(", ")}.\nNagrania zostały pomyślnie oczyszczone z bazy.`);
                }
            } else {
                alert("AI nie wykryło żadnych konkretnych pozycji w zaznaczonych nagraniach.");
            }
        } catch (err: any) {
            alert("Błąd masowego przetwarzania AI: " + err.message);
        } finally {
            setIsParsingVoice(null);
        }
    };

    // Zapisanie dookreślonych w kreatorze materiałów do koszyka + automatyczne czyszczenie bazy
    const handleFinishWizard = async () => {
        const materialsToAppend: string[] = [];

        for (let i = 0; i < wizardItems.length; i++) {
            const item = wizardItems[i];
            const selection = wizardSelections[i];
            if (selection) {
                materialsToAppend.push(`${item.quantity}x ${selection} (j.m. ${item.unit})`);
            }
        }

        if (materialsToAppend.length > 0) {
            const formattedLines = materialsToAppend.join("\n");
            const existingManual = cart.find(item => item.isManual);
            let newCart: CartItem[];

            if (existingManual) {
                const mergedText = [existingManual.name, formattedLines].filter(Boolean).join("\n");
                newCart = cart.map(item =>
                    item.cartId === existingManual.cartId ? { ...item, name: mergedText } : item
                );
            } else {
                newCart = [...cart, {
                    cartId: crypto.randomUUID(),
                    isManual: true,
                    name: formattedLines,
                    quantity: 1
                }];
            }

            setCart(newCart);
            saveDraft(newCart, selectedSiteId, orderNotes);
        }

        // AUTOMATYCZNE BEZPIECZNE CZYSZCZENIE FIRESTORE I STORAGE PO POMYŚLNYM ZAPISIE
        if (activeVoiceOrderIds.length > 0 && user) {
            const storage = getStorage();
            try {
                await Promise.all(activeVoiceOrderIds.map(async (id) => {
                    // 1. Spróbuj usunąć fizyczny plik .mp3 z Storage
                    try {
                        const audioRef = ref(storage, `voice_orders/${user.uid}/${id}.mp3`);
                        await deleteObject(audioRef);
                    } catch (storageErr) {
                        console.error(`Błąd usuwania pliku audio ${id} z Storage:`, storageErr);
                    }
                    // 2. Usuń dokument tekstowy z Firestore
                    await deleteDoc(doc(db, "voiceOrders", id));
                }));
            } catch (err) {
                console.error("Błąd czyszczenia przetworzonych notatek z bazy:", err);
            }
        }

        alert("🎉 Wszystkie materiały zostały doprecyzowane i zapisane w Twoim koszyku. Zużyte nagrania usunięto z chmury.");
        setWizardStep(-1);
        setWizardItems([]);
        setActiveVoiceOrderIds([]);
    };

    // ── Wysyłka zamówienia ────────────────────────────────────────────────────

    const handleSubmitOrder = async () => {
        if (!selectedSiteId) return alert("Wybierz budowę!");
        if (cart.length === 0) return alert("Koszyk jest pusty!");
        const emptyManuals = cart.filter(i => i.isManual && !i.name.trim());
        if (emptyManuals.length > 0) return alert("Uzupełnij wpisy ręczne lub je usuń z koszyka!");

        setIsSubmitting(true);
        const orderId = `ZAM-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.floor(1000 + Math.random() * 9000)}`;

        try {
            const narzedzia = cart
                .filter(i => !i.isManual && i.type === "UNIQUE")
                .map(i => ({ name: i.name, inventoryNumber: i.inventoryNumber, quantity: 1, section: "NARZĘDZIA" }));
            const rusztowania = cart
                .filter(i => !i.isManual && i.type === "BULK")
                .map(i => ({ name: i.name, inventoryNumber: i.inventoryNumber, quantity: i.quantity, section: "RUSZTOWANIA" }));
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
                    // Dane zamawiającego — z kontekstu sesji, nie z formularza
                    user: {
                        uid: user?.uid,
                        firstName: user?.firstName,
                        lastName: user?.lastName,
                        email: user?.email,
                    },
                    cart: processedCart,
                    sections: { narzedzia, rusztowania, materialyDodatkowe },
                    notes: orderNotes,
                }),
            });

            if (res.ok) {
                // Wyczyść lokalny stan (draft usuwa serwer)
                setCart([]);
                setOrderNotes("");
                setIsCartOpen(false);
                alert(`✅ Zamówienie ${orderId} zostało złożone!\nPDF wysłano na e-mail.`);
            } else {
                const errData = await res.json();
                alert("Błąd wysyłki: " + (errData.error || "Nieznany błąd"));
            }
        } catch (error) {
            console.error(error);
            alert("Błąd wysyłki zamówienia.");
        } finally {
            setIsSubmitting(false);
        }
    };

    // ── Filtrowanie katalogu ───────────────────────────────────────────────────

    const uniqueCategories = Array.from(
        new Set(items.filter(i => i.type === "UNIQUE").map(i => i.category).filter(Boolean))
    ).sort();

    const getVisibleItems = (): InventoryItem[] => {
        const filtered = items.filter(i =>
            i.status === "sprawne" &&
            i.name.toLowerCase().includes(searchTerm.toLowerCase())
        );
        if (activeTab === "UNIQUE") {
            let uniqueItems = filtered.filter(i => i.type === "UNIQUE" && i.availableQuantity > 0);
            if (selectedCategory !== "ALL") {
                uniqueItems = uniqueItems.filter(i => i.category === selectedCategory);
            }
            return uniqueItems;
        } else {
            if (selectedSystemId) {
                return filtered.filter(i => i.type === "BULK" && i.subType === "SUB_ITEM" && i.mainCategoryId === selectedSystemId);
            }
            return filtered.filter(i => i.type === "BULK" && i.subType === "MAIN_CAT");
        }
    };

    // ─── RENDER ───────────────────────────────────────────────────────────────

    return (
        <div className="p-4 md:p-6 max-w-[1600px] mx-auto h-[90vh] flex flex-col relative animate-fade-in overflow-hidden">

            {/* ── Nagłówek ── */}
            <div className="flex justify-between items-center mb-4 border-b pb-4">
                <div>
                    <h1 className="text-2xl font-black text-slate-800 tracking-tighter uppercase italic">Sklep PESAM</h1>
                    {/* Informacja o kierowniku */}
                    <p className="text-xs text-slate-500 mt-0.5 font-medium">
                        Zalogowany: <span className="font-bold text-slate-700">{user?.firstName} {user?.lastName}</span>
                        {sites.length === 1 && (
                            <> · Budowa: <span className="font-bold text-blue-600">{sites[0].name}</span></>
                        )}
                    </p>
                </div>
                <button
                    onClick={() => setIsCartOpen(true)}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-xl font-bold shadow-md flex items-center gap-2 transition-all relative"
                >
                    🛒 KOSZYK
                    <span className="bg-white text-blue-600 px-1.5 rounded-md text-[10px] font-black">{cart.length}</span>
                    {/* Wskaźnik niewyslaneog draftu */}
                    {cart.length > 0 && (
                        <span className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-green-400 rounded-full border-2 border-white" title="Koszyk zapisany" />
                    )}
                </button>
            </div>

            {/* Pasek informacyjny o niezapisanym koszyku */}
            {cart.length > 0 && (
                <div className="mb-3 px-4 py-2 bg-green-50 border border-green-200 rounded-xl flex items-center gap-3 text-xs">
                    <span className="text-green-600">💾</span>
                    <span className="text-green-700 font-medium">
                        Twój koszyk ({cart.length} poz.) jest automatycznie zapisywany — możesz go bezpiecznie zamknąć i wrócić później.
                    </span>
                    {draftSaving && <span className="text-green-500 italic">Zapisuję...</span>}
                </div>
            )}

            {/* ── Filtry ── */}
            <div className="flex flex-col md:flex-row gap-3 mb-6 items-center">
                <input
                    type="text"
                    placeholder="Szukaj (np. szlifierka...)"
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    className="p-2.5 border rounded-xl flex-1 max-w-sm text-sm outline-none focus:border-blue-500 shadow-sm"
                />
                {activeTab === "UNIQUE" && (
                    <select
                        value={selectedCategory}
                        onChange={e => setSelectedCategory(e.target.value)}
                        className="p-2.5 border rounded-xl bg-white text-sm text-slate-700 outline-none focus:border-blue-500 shadow-sm cursor-pointer"
                    >
                        <option value="ALL">Wszystkie kategorie</option>
                        {uniqueCategories.map(cat => (
                            <option key={cat} value={cat}>{cat}</option>
                        ))}
                    </select>
                )}
                <div className="flex bg-slate-100 p-1 rounded-lg shadow-inner border border-slate-200">
                    <button
                        onClick={() => { setActiveTab("UNIQUE"); setSelectedSystemId(null); setSelectedCategory("ALL"); }}
                        className={`px-4 py-1.5 rounded-md text-[11px] font-black transition-all ${activeTab === "UNIQUE" ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                    >NARZĘDZIA</button>
                    <button
                        onClick={() => { setActiveTab("BULK"); setSelectedSystemId(null); }}
                        className={`px-4 py-1.5 rounded-md text-[11px] font-black transition-all ${activeTab === "BULK" ? "bg-white text-orange-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                    >RUSZTOWANIA</button>
                </div>
                {selectedSystemId && (
                    <button
                        onClick={() => setSelectedSystemId(null)}
                        className="text-[11px] font-black text-blue-600 bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-200"
                    >← WRÓĆ DO SYSTEMÓW</button>
                )}
            </div>

            {/* ── Katalog ── */}
            <div className="flex-1 overflow-y-auto pr-2 pb-10">
                {/* Żółta ramka referencyjna dla narzędzi z nagrania głosowego */}
                {warehouseNotes.length > 0 && (
                    <div className="mb-4 p-4 bg-yellow-50 border-2 border-dashed border-yellow-300 rounded-2xl flex items-start gap-3 shadow-sm animate-fade-in relative">
                        <span className="text-2xl mt-0.5">📋</span>
                        <div className="flex-1 pr-10">
                            <h4 className="font-black text-yellow-800 text-xs uppercase tracking-wider">Kierownik zgłosił zapotrzebowanie na sprzęt z magazynu:</h4>
                            <div className="flex flex-wrap gap-2 mt-2">
                                {warehouseNotes.map((note, idx) => (
                                    <span key={idx} className="bg-white border border-yellow-300 text-yellow-900 font-bold px-2.5 py-1 rounded-lg text-xs shadow-sm">
                                        🛠️ {note}
                                    </span>
                                ))}
                            </div>
                            <p className="text-[10px] text-yellow-600 mt-2 font-medium">Wyszukaj powyższy sprzęt w katalogu poniżej i dodaj do koszyka odpowiednie, sprawne egzemplarze.</p>
                        </div>
                        <button
                            onClick={() => setWarehouseNotes([])}
                            className="absolute right-3 top-3 text-yellow-600 hover:text-red-500 font-bold text-lg leading-none"
                            title="Ukryj notatki"
                        >&times;</button>
                    </div>
                )}

                {loading ? (
                    <div className="text-center p-10 text-slate-400 font-bold uppercase text-xs">Ładowanie asortymentu...</div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
                        {getVisibleItems().map(item => {
                            const isSystem = activeTab === "BULK" && item.subType === "MAIN_CAT";
                            const isInCart = cart.some(c => c.dbId === item.id);

                            if (isSystem) {
                                return (
                                    <div
                                        key={item.id}
                                        onClick={() => setSelectedSystemId(item.id)}
                                        className="bg-slate-800 text-white rounded-xl border border-slate-700 flex items-center h-[120px] cursor-pointer hover:bg-slate-700 hover:shadow-xl transition-all relative overflow-hidden group"
                                    >
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
                                        ? "border-green-500 shadow-md"
                                        : "bg-white border-slate-200 hover:shadow-lg hover:border-blue-300"
                                        }`}
                                    style={isInCart ? {
                                        backgroundColor: "#f0fdf4",
                                        backgroundImage: "repeating-linear-gradient(45deg, rgba(34,197,94,0.05) 0, rgba(34,197,94,0.05) 10px, rgba(34,197,94,0.1) 10px, rgba(34,197,94,0.1) 20px)",
                                    } : {}}
                                >
                                    {/* Miniaturka */}
                                    <div
                                        className="w-24 h-full bg-slate-50 flex items-center justify-center border-r border-slate-100 p-2 cursor-zoom-in relative group/img z-10 flex-shrink-0"
                                        onClick={() => item.imageUrl && setEnlargedImage(item.imageUrl)}
                                    >
                                        <img
                                            src={item.imageUrl || "https://via.placeholder.com/100?text=Brak"}
                                            alt={item.name}
                                            className="max-w-full max-h-full object-contain group-hover/img:scale-110 transition-transform duration-300"
                                        />
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center text-white text-xl font-bold">🔍</div>
                                    </div>

                                    {/* Info */}
                                    <div className="p-3 flex-1 flex flex-col justify-between h-full z-10">
                                        <div>
                                            <h3 className="font-bold text-slate-800 text-[11px] leading-tight line-clamp-2 uppercase" title={item.name}>{item.name}</h3>
                                            {item.type === "UNIQUE" && (
                                                <p className="text-[10px] font-black text-blue-600 mt-0.5">NR MAG: {item.inventoryNumber}</p>
                                            )}
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
                                                <button
                                                    onClick={() => addToCart(item)}
                                                    className="bg-slate-100 hover:bg-green-600 text-slate-600 hover:text-white border border-slate-200 hover:border-green-600 px-3 py-1.5 rounded-lg text-[10px] font-black transition-all active:scale-95 uppercase shadow-sm"
                                                >
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

            {/* ── Modal wyboru ilości (BULK) ── */}
            {bulkPickModal && (
                <div className="fixed inset-0 bg-black/60 z-[9999999] flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 animate-fade-in border-t-4 border-blue-500">
                        <h3 className="text-xl font-black text-slate-800 mb-1">Podaj ilość</h3>
                        <p className="text-sm text-slate-500 mb-5 line-clamp-2">
                            <span className="font-bold text-slate-700">{bulkPickModal.item.name}</span>
                        </p>
                        <div className="flex items-center gap-3 mb-2">
                            <button
                                onClick={() => setBulkPickModal(p => p && p.qty > 1 ? { ...p, qty: p.qty - 1 } : p)}
                                className="w-14 h-14 rounded-2xl bg-slate-100 hover:bg-slate-200 text-3xl font-black text-slate-700 transition flex items-center justify-center"
                            >−</button>
                            <input
                                type="number" min="1" max={bulkPickModal.item.availableQuantity}
                                value={bulkPickModal.qty}
                                onChange={e => setBulkPickModal(p => p ? { ...p, qty: Math.max(1, Math.min(Number(e.target.value), p.item.availableQuantity)) } : p)}
                                className="flex-1 text-center text-3xl font-black p-2 border-2 rounded-2xl outline-none focus:border-blue-500 bg-slate-50"
                            />
                            <button
                                onClick={() => setBulkPickModal(p => p && p.qty < p.item.availableQuantity ? { ...p, qty: p.qty + 1 } : p)}
                                className="w-14 h-14 rounded-2xl bg-slate-100 hover:bg-slate-200 text-3xl font-black text-slate-700 transition flex items-center justify-center"
                            >+</button>
                        </div>
                        <p className="text-[11px] text-slate-400 text-center mb-6">
                            Maksymalnie na stanie: <span className="font-bold text-slate-600">{bulkPickModal.item.availableQuantity} szt.</span>
                        </p>
                        <div className="flex gap-3">
                            <button onClick={() => setBulkPickModal(null)} className="flex-1 py-4 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition">Anuluj</button>
                            <button onClick={confirmBulkAdd} className="flex-1 py-4 bg-blue-600 text-white font-black rounded-xl hover:bg-blue-700 shadow-md transition">Dodaj do koszyka</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Modal wpisu ręcznego ── */}
            {isManualModalOpen && (
                <ManualEntryModal
                    initialText={manualText}
                    onSave={saveManualEntry}
                    onCancel={() => setIsManualModalOpen(false)}
                />
            )}

            {/* ── KOSZYK (Drawer) ── */}
            {isCartOpen && (
                <div className="fixed inset-0 flex justify-end animate-fade-in" style={{ zIndex: 99999 }}>
                    <div
                        className="absolute inset-0 bg-black/60"
                        style={{ pointerEvents: isManualModalOpen ? "none" : "auto" }}
                        onClick={() => !isManualModalOpen && setIsCartOpen(false)}
                    />
                    <div className="relative bg-white w-full max-w-md h-full shadow-2xl flex flex-col animate-slide-in" style={{ pointerEvents: "auto" }}>

                        {/* Nagłówek koszyka z przyciskami AI */}
                        <div className="p-3 border-b flex flex-col gap-3 bg-slate-50">
                            <div className="flex justify-between items-start">
                                <div>
                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">
                                        Twój koszyk ({cart.length} poz.)
                                        {draftSaving && <span className="ml-2 text-green-500 italic lowercase normal-case">Zapisuję...</span>}
                                        {!draftSaving && cart.length > 0 && <span className="ml-2 text-green-600 lowercase normal-case">💾 Zapisano</span>}
                                    </p>
                                </div>
                                <button onClick={() => setIsCartOpen(false)} className="text-2xl leading-none text-slate-400 hover:text-red-500">&times;</button>
                            </div>
                            
                            <div className="flex gap-2">
                                <button
                                    onClick={verifyCartWithAI}
                                    disabled={isVerifyingCart || cart.length === 0}
                                    className="flex-1 bg-slate-800 text-blue-100 py-2.5 rounded-xl text-[10px] font-black shadow-sm flex items-center justify-center gap-1.5 hover:bg-slate-700 transition-colors disabled:opacity-50 border border-slate-700"
                                >
                                    {isVerifyingCart ? <span className="animate-spin">⏳</span> : <span className="text-sm">🤖</span>}
                                    SPRAWDŹ BRAKI
                                </button>
                                <button
                                    onClick={() => setIsChatOpen(true)}
                                    className="flex-1 bg-blue-600 text-white py-2.5 rounded-xl text-[10px] font-black shadow-sm flex items-center justify-center gap-1.5 hover:bg-blue-700 transition-colors border border-blue-600"
                                >
                                    <span className="text-sm">💬</span> ZAMÓW Z AI
                                </button>
                            </div>
                        </div>

                        {/* Wybór budowy */}
                        <div className="p-4 bg-blue-600 text-white shadow-inner">
                            <label className="text-[10px] font-black uppercase block mb-1">
                                Cel: Budowa
                                {sites.length === 1 && <span className="ml-2 font-normal italic">(automatycznie przypisana)</span>}
                            </label>
                            {sites.length === 0 ? (
                                <div className="bg-red-500/30 text-red-100 p-2 rounded-lg text-xs font-bold">
                                    ⚠️ Nie jesteś przypisany do żadnej budowy. Skontaktuj się z administratorem.
                                </div>
                            ) : sites.length === 1 ? (
                                <div className="w-full p-2 rounded-lg bg-white/20 text-white text-sm font-bold">
                                    {sites[0].name}
                                </div>
                            ) : (
                                <select
                                    value={selectedSiteId}
                                    onChange={e => handleSiteChange(e.target.value)}
                                    className="w-full p-2 rounded-lg bg-white text-slate-800 text-sm font-bold shadow-sm"
                                >
                                    <option value="">-- Wybierz budowę --</option>
                                    {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                            )}
                        </div>

                        {/* Lista pozycji */}
                        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/50">
                            <div className="flex justify-between items-center border-b border-slate-200 pb-2 mb-4">
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Twoje przedmioty</span>
                                <div className="flex gap-2">
                                    <button
                                        onClick={openVoiceModal}
                                        className="text-[10px] font-black text-purple-600 bg-purple-100 border border-purple-200 px-3 py-1.5 rounded-lg hover:bg-purple-200 transition-all shadow-sm"
                                    >
                                        🎙️ WCZYTAJ GŁOS
                                    </button>
                                    <button
                                        onClick={openManualModal}
                                        className="text-[10px] font-black text-orange-600 bg-orange-100 border border-orange-200 px-3 py-1.5 rounded-lg hover:bg-orange-200 transition-all shadow-sm"
                                    >
                                        + WPIS RĘCZNY
                                    </button>
                                </div>
                            </div>

                            {/* 🤖 Wyniki Inspektora AI */}
                            {cartSuggestions && (
                                <div className="bg-[#1e2330] text-white p-4 rounded-xl shadow-md mb-4 animate-fade-in relative border border-slate-700">
                                    <button 
                                        onClick={() => setCartSuggestions(null)} 
                                        className="absolute top-2 right-3 text-slate-400 hover:text-white font-bold text-lg"
                                    >&times;</button>
                                    
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-lg">🤖</span>
                                        <h4 className="font-black text-[11px] uppercase tracking-wider text-blue-400">Analiza Koszyka</h4>
                                    </div>
                                    <p className="text-[11px] leading-relaxed text-slate-300 font-medium mb-3">
                                        {cartSuggestions.analysis}
                                    </p>
                                    
                                    <div className="flex gap-1.5 flex-wrap mb-4">
                                        {cartSuggestions.systemsIdentified?.map((sys, idx) => (
                                            <span key={idx} className="text-[9px] font-bold bg-slate-700 text-slate-300 px-2 py-0.5 rounded border border-slate-600">
                                                {sys}
                                            </span>
                                        ))}
                                    </div>

                                    {/* SEKCJA: Normalizacja wpisów */}
                                    {cartSuggestions.normalizedItems && cartSuggestions.normalizedItems.length > 0 && (
                                        <div className="mb-4">
                                            <p className="text-[10px] font-black uppercase text-orange-400 mb-2 flex items-center gap-1">
                                                <span>✨</span> Doprecyzuj wpisy ręczne:
                                            </p>
                                            <div className="space-y-1.5">
                                                {cartSuggestions.normalizedItems.map((item, idx) => (
                                                    <div key={idx} className="flex flex-col bg-slate-900/50 p-2.5 rounded-lg border border-slate-600/50 gap-2">
                                                        <div className="text-xs text-slate-300">
                                                            Zmień <span className="line-through text-red-400">{item.original}</span> na:
                                                            <br/><span className="font-bold text-green-400">{item.professional}</span>
                                                        </div>
                                                        <button 
                                                            onClick={() => applyNormalization(item.original, item.professional)}
                                                            className="text-[10px] font-black bg-orange-600 text-white px-3 py-1.5 rounded shadow-sm hover:bg-orange-500 w-full transition-colors"
                                                        >✓ ZASTĄP W KOSZYKU</button>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    
                                    {/* SEKCJA: Sugerowane braki (Z ILOŚCIĄ) */}
                                    {cartSuggestions.suggestedItems && cartSuggestions.suggestedItems.length > 0 && (
                                        <div>
                                            <p className="text-[10px] font-black uppercase text-blue-300 mb-2 flex items-center gap-1">
                                                <span>🛒</span> Sugerowane domówienia (możesz edytować nazwy):
                                            </p>
                                            <div className="space-y-2">
                                                {cartSuggestions.suggestedItems.map((item, idx) => (
                                                    <div key={idx} className="flex flex-col gap-2 bg-[#181d29] p-3 rounded-lg border border-blue-500/30 focus-within:border-blue-400 transition-colors">
                                                        <div className="flex items-start gap-1">
                                                            <span className="text-blue-400 font-bold mt-0.5">•</span>
                                                            <input 
                                                                type="text"
                                                                value={suggestionNames[idx] !== undefined ? suggestionNames[idx] : item.name}
                                                                onChange={e => setSuggestionNames(prev => ({...prev, [idx]: e.target.value}))}
                                                                className="flex-1 bg-transparent text-xs font-bold text-blue-100 leading-tight outline-none border-b border-dashed border-slate-600 focus:border-blue-400 pb-0.5"
                                                            />
                                                        </div>
                                                        <div className="flex items-center gap-2 justify-between mt-1">
                                                            <div className="flex items-center gap-1.5 bg-slate-900 px-2 py-1.5 rounded-md border border-slate-700">
                                                                <input 
                                                                    type="number" 
                                                                    min="1"
                                                                    value={suggestionQtys[idx] || 1}
                                                                    onChange={e => setSuggestionQtys(prev => ({...prev, [idx]: Math.max(1, parseInt(e.target.value)||1)}))}
                                                                    className="w-12 bg-transparent text-white text-center text-xs font-bold outline-none"
                                                                />
                                                                <span className="text-[10px] text-slate-400 border-l border-slate-700 pl-1.5">{item.unit}</span>
                                                            </div>
                                                            <button 
                                                                onClick={() => addSuggestionToCart(item.name, item.unit, idx)}
                                                                className="text-[10px] font-black bg-blue-600 text-white px-4 py-2 rounded-lg shadow-sm hover:bg-blue-500 transition-colors"
                                                            >+ DODAJ</button>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {cart.length === 0 ? (
                                <div className="text-center py-20 text-slate-300 font-bold uppercase text-xs italic">Koszyk jest pusty</div>
                            ) : (
                                cart.map(c => (
                                    <div key={c.cartId} className={`border rounded-xl shadow-sm bg-white overflow-hidden ${c.isManual ? "border-orange-300" : "border-slate-200"}`}>
                                        {c.isManual ? (
                                            <div className="cursor-pointer hover:bg-orange-50 transition-colors" onClick={openManualModal}>
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
                                                <div className="px-3 pb-3 space-y-1">
                                                    {c.name.split("\n").filter(l => l.trim()).slice(0, 3).map((line, i) => (
                                                        <div key={i} className="flex items-start gap-2">
                                                            <span className="text-[9px] font-black text-orange-400 bg-orange-100 rounded px-1 flex-shrink-0 mt-0.5">{i + 1}</span>
                                                            <p className="text-[11px] text-slate-700 leading-snug line-clamp-1">{line}</p>
                                                        </div>
                                                    ))}
                                                    {c.name.split("\n").filter(l => l.trim()).length > 3 && (
                                                        <span className="text-[9px] font-black text-orange-300 bg-orange-50 border border-orange-200 border-dashed rounded px-2 py-0.5">
                                                            + {c.name.split("\n").filter(l => l.trim()).length - 3} więcej pozycji — kliknij aby zobaczyć
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-3 p-3">
                                                <img
                                                    src={c.imageUrl || "https://via.placeholder.com/40"}
                                                    className="w-10 h-10 rounded-lg object-cover border flex-shrink-0"
                                                    alt=""
                                                />
                                                <div className="flex-1 min-w-0">
                                                    <p className="font-bold truncate text-xs uppercase leading-tight">{c.name}</p>
                                                    <p className="text-[9px] text-blue-500 font-bold mt-0.5">NR: {c.inventoryNumber || "-"}</p>
                                                </div>
                                                <div className="flex items-center gap-2 flex-shrink-0">
                                                    {c.type === "BULK" ? (
                                                        <input
                                                            type="number"
                                                            min="1"
                                                            max={c.maxQty || 9999}
                                                            value={c.quantity}
                                                            onChange={e => updateQty(c.cartId, Number(e.target.value))}
                                                            className="w-12 p-1 border rounded text-center text-xs font-bold outline-none focus:border-blue-500"
                                                        />
                                                    ) : (
                                                        <span className="font-black text-xs bg-slate-100 px-3 py-2 rounded-xl border">1</span>
                                                    )}
                                                    <button
                                                        onClick={() => removeFromCart(c.cartId)}
                                                        className="text-red-500 bg-red-50 hover:bg-red-500 hover:text-white transition-colors w-7 h-7 rounded flex items-center justify-center font-bold text-lg leading-none"
                                                    >&times;</button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>

                        {/* Stopka koszyka */}
                        <div className="p-4 border-t border-slate-200 bg-white">
                            <textarea
                                value={orderNotes}
                                onChange={e => handleNotesChange(e.target.value)}
                                placeholder="Uwagi do zamówienia (pilność, szczegóły dostawy...)..."
                                className="w-full p-3 border border-slate-200 rounded-xl text-xs h-20 outline-none focus:border-blue-500 mb-4 bg-slate-50 resize-none"
                            />
                            <button
                                onClick={handleSubmitOrder}
                                disabled={isSubmitting || cart.length === 0 || !selectedSiteId}
                                className="w-full py-4 bg-green-600 hover:bg-green-700 text-white font-black rounded-2xl shadow-lg disabled:opacity-50 transition-all uppercase tracking-widest text-sm"
                            >
                                {isSubmitting ? "Wysyłanie..." : `Wyślij zamówienie (${cart.length} poz.)`}
                            </button>
                            {!selectedSiteId && cart.length > 0 && (
                                <p className="text-center text-xs text-red-500 mt-2 font-bold">
                                    ⚠️ Wybierz budowę przed wysłaniem
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ── Modal pobierania zamówień głosowych (Zaznaczanie + Ręczne usuwanie) ── */}
            {isVoiceModalOpen && (
                <div className="fixed inset-0 bg-black/60 z-[9999999] flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden animate-fade-in border-t-4 border-purple-600 flex flex-col max-h-[80vh]">

                        <div className="p-5 bg-purple-50 border-b border-purple-100 flex justify-between items-center flex-shrink-0">
                            <div>
                                <h3 className="font-black text-purple-800 uppercase tracking-tight text-lg">🎙️ Notatki głosowe z budowy</h3>
                                <p className="text-xs text-purple-600 mt-0.5">Zaznacz nagrania i prześlij je masowo do przetworzenia.</p>
                            </div>
                            <button onClick={() => setIsVoiceModalOpen(false)} className="text-2xl text-slate-400 hover:text-red-500 w-10 h-10 flex items-center justify-center rounded-full hover:bg-red-50 transition leading-none">&times;</button>
                        </div>

                        {isParsingVoice === "BULK" && (
                            <div className="p-8 flex flex-col items-center justify-center text-center bg-white border-b">
                                <div className="w-10 h-10 border-4 border-purple-600 border-t-transparent rounded-full animate-spin mb-3"></div>
                                <span className="text-xs font-black text-purple-800 uppercase tracking-wider animate-pulse">Sztuczna Inteligencja analizuje wszystkie nagrania...</span>
                                <p className="text-[10px] text-slate-400 mt-1">To może zająć kilkanaście sekund. Proszę czekać.</p>
                            </div>
                        )}

                        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50">
                            {voiceOrders.length === 0 ? (
                                <p className="text-center py-12 text-sm text-slate-400 italic">Brak nowych, nieprzetworzonych notatek dla wybranej budowy.</p>
                            ) : (
                                voiceOrders.map(vo => (
                                    <div key={vo.id} className="bg-white border-2 p-4 rounded-2xl shadow-sm flex flex-col gap-3 relative overflow-hidden border-slate-100">
                                        <div className="flex items-start gap-3">
                                            {/* Checkbox wyboru */}
                                            <input
                                                type="checkbox"
                                                checked={!!selectedVoiceOrderIds[vo.id]}
                                                onChange={e => setSelectedVoiceOrderIds(prev => ({ ...prev, [vo.id]: e.target.checked }))}
                                                className="w-5 h-5 mt-1 rounded text-purple-600 focus:ring-purple-500 border-slate-300 cursor-pointer"
                                            />
                                            <div className="flex-1 min-w-0">
                                                <div className="flex justify-between items-start">
                                                    <div>
                                                        <p className="text-xs font-black text-slate-800 uppercase">Nagranie: {vo.id}</p>
                                                        <p className="text-[10px] text-slate-400 mt-0.5">Nagrał: <b>{vo.userName}</b> · {new Date(vo.createdAt).toLocaleString()}</p>
                                                    </div>
                                                    <button
                                                        onClick={() => handleDeleteVoiceOrder(vo.id)}
                                                        className="text-red-400 hover:text-red-600 hover:bg-red-50 p-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 border border-transparent hover:border-red-100"
                                                        title="Usuń trwale z bazy"
                                                    >
                                                        🗑️ Usuń
                                                    </button>
                                                </div>
                                                <audio src={vo.audioUrl} controls className="w-full h-8 outline-none mt-3" />
                                            </div>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>

                        <div className="p-4 border-t border-slate-200 bg-white flex justify-between items-center flex-shrink-0">
                            <p className="text-[10px] text-slate-400">
                                💡 Zaznacz wybrane nagrania i przetwórz je za jednym razem.
                            </p>
                            <div className="flex gap-2">
                                <button onClick={() => setIsVoiceModalOpen(false)} className="px-5 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold rounded-xl text-xs transition">
                                    Zamknij
                                </button>
                                {voiceOrders.length > 0 && (
                                    <button
                                        onClick={handleProcessSelectedVoiceOrders}
                                        disabled={isParsingVoice !== null}
                                        className="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white font-black rounded-xl text-xs uppercase tracking-widest transition shadow-md disabled:opacity-40"
                                    >
                                        🤖 Procesuj zaznaczone ({voiceOrders.filter(vo => selectedVoiceOrderIds[vo.id]).length})
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {/* ── KREATOR AI (WIZARD DLA MATERIAŁÓW ZAKUPOWYCH) ── */}
            {wizardStep >= 0 && wizardItems.length > 0 && (
                <div className="fixed inset-0 bg-black/70 z-[9999999] flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-xl overflow-hidden animate-fade-in border-t-4 border-blue-600 flex flex-col max-h-[85vh]">

                        <div className="bg-slate-50 border-b p-5 flex justify-between items-center">
                            <div>
                                <span className="text-[10px] font-black text-blue-600 uppercase tracking-widest bg-blue-50 border border-blue-200 px-2 py-1 rounded">
                                    Materiał {wizardStep + 1} z {wizardItems.length}
                                </span>
                                <h3 className="font-black text-slate-800 text-lg mt-2 uppercase">Doprecyzowanie zakupu materiałów</h3>
                            </div>
                            <span className="text-sm font-bold text-slate-400">
                                {Math.round(((wizardStep + 1) / wizardItems.length) * 100)}%
                            </span>
                        </div>

                        <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-slate-50/50">
                            {(() => {
                                const currentItem = wizardItems[wizardStep];
                                return (
                                    <div className="space-y-4">

                                        {/* Głos i Odczyt kierownika */}
                                        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-3">
                                            <div>
                                                <span className="text-[9px] font-black text-slate-400 uppercase">Kierownik powiedział:</span>
                                                <p className="text-xl font-black text-slate-800 mt-0.5 uppercase">
                                                    👉 "{currentItem.roughName}"
                                                </p>
                                            </div>

                                            {/* Odtwarzacz oryginalnego pliku audio powiązanego z tym konkretnym przedmiotem */}
                                            {currentItem.audioUrl && (
                                                <div className="bg-purple-50/40 p-2.5 rounded-xl border border-purple-100 flex flex-col gap-1">
                                                    <span className="text-[9px] font-black text-purple-700 uppercase flex items-center gap-1">
                                                        🔊 Odsłuchaj oryginalne nagranie tej pozycji:
                                                    </span>
                                                    <audio src={currentItem.audioUrl} controls className="w-full h-8 outline-none" />
                                                </div>
                                            )}

                                            {/* Interaktywny korektor ilości plus/minus */}
                                            <div className="flex items-center gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200">
                                                <span className="text-[10px] font-black text-slate-500 uppercase">Koryguj Ilość:</span>
                                                <div className="flex items-center gap-1.5">
                                                    <button
                                                        onClick={() => {
                                                            const val = Math.max(1, currentItem.quantity - 1);
                                                            setWizardItems(prev => prev.map((item, idx) => idx === wizardStep ? { ...item, quantity: val } : item));
                                                        }}
                                                        className="w-8 h-8 rounded-lg bg-white hover:bg-slate-200 font-bold border flex items-center justify-center shadow-sm transition"
                                                    >−</button>
                                                    <input
                                                        type="number"
                                                        min="1"
                                                        value={currentItem.quantity}
                                                        onChange={e => {
                                                            const val = Math.max(1, Number(e.target.value));
                                                            setWizardItems(prev => prev.map((item, idx) => idx === wizardStep ? { ...item, quantity: val } : item));
                                                        }}
                                                        className="w-16 p-1 text-center font-black text-sm border rounded-lg bg-white outline-none focus:border-blue-500"
                                                    />
                                                    <button
                                                        onClick={() => {
                                                            const val = currentItem.quantity + 1;
                                                            setWizardItems(prev => prev.map((item, idx) => idx === wizardStep ? { ...item, quantity: val } : item));
                                                        }}
                                                        className="w-8 h-8 rounded-lg bg-white hover:bg-slate-200 font-bold border flex items-center justify-center shadow-sm transition"
                                                    >+</button>
                                                </div>
                                                <span className="text-xs font-bold text-slate-600 bg-white px-2.5 py-1 rounded border shadow-sm">
                                                    {currentItem.unit}
                                                </span>
                                            </div>
                                        </div>

                                        <div className="space-y-3">
                                            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider">Wybierz dokładną specyfikację rynkową (Sugestia AI)</label>
                                            <div className="space-y-2">
                                                {currentItem.suggestions?.map((suggestion: string, idx: number) => (
                                                    <label
                                                        key={idx}
                                                        className={`flex items-start gap-3 p-3.5 rounded-xl border bg-white cursor-pointer hover:border-orange-400 transition-all ${wizardSelections[wizardStep] === suggestion ? "border-orange-500 bg-orange-50/30 ring-2 ring-orange-500/10" : "border-slate-200"
                                                            }`}
                                                    >
                                                        <input
                                                            type="radio"
                                                            name={`wizard-step-${wizardStep}`}
                                                            value={suggestion}
                                                            checked={wizardSelections[wizardStep] === suggestion}
                                                            onChange={() => setWizardSelections(prev => ({ ...prev, [wizardStep]: suggestion }))}
                                                            className="text-orange-600 focus:ring-orange-500"
                                                        />
                                                        <span className="text-xs font-semibold text-slate-700 leading-snug">{suggestion}</span>
                                                    </label>
                                                ))}
                                            </div>
                                            <div className="pt-2">
                                                <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">Lub wpisz własną nazwę ręcznie:</label>
                                                <input
                                                    type="text"
                                                    placeholder="Wpisz niestandardowe parametry..."
                                                    value={wizardSelections[wizardStep] || ""}
                                                    onChange={e => setWizardSelections(prev => ({ ...prev, [wizardStep]: e.target.value }))}
                                                    className="w-full p-3 border rounded-xl text-xs bg-white outline-none focus:border-orange-500 font-medium"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                );
                            })()}
                        </div>

                        <div className="p-4 border-t bg-white flex justify-between items-center">
                            <button
                                onClick={() => setWizardStep(prev => Math.max(0, prev - 1))}
                                disabled={wizardStep === 0}
                                className="px-5 py-3 bg-slate-100 text-slate-500 font-bold rounded-xl text-xs hover:bg-slate-200 transition disabled:opacity-40"
                            >
                                ◀ Wstecz
                            </button>

                            <div className="flex gap-2">
                                <button
                                    onClick={() => {
                                        if (confirm("Czy na pewno chcesz anulować kreatora?")) {
                                            setWizardStep(-1);
                                            setWizardItems([]);
                                        }
                                    }}
                                    className="px-5 py-3 bg-red-50 text-red-600 font-bold rounded-xl text-xs hover:bg-red-100 transition"
                                >
                                    Anuluj
                                </button>

                                {wizardStep < wizardItems.length - 1 ? (
                                    <button
                                        onClick={() => setWizardStep(prev => prev + 1)}
                                        disabled={!wizardSelections[wizardStep]}
                                        className="px-6 py-3 bg-blue-600 text-white font-black rounded-xl text-xs hover:bg-blue-700 shadow-md transition disabled:opacity-40"
                                    >
                                        Dalej ▶
                                    </button>
                                ) : (
                                    <button
                                        onClick={handleFinishWizard}
                                        disabled={!wizardSelections[wizardStep]}
                                        className="px-8 py-3 bg-green-600 text-white font-black rounded-xl text-xs hover:bg-green-700 shadow-md transition disabled:opacity-40"
                                    >
                                        ZAKOŃCZ I IMPORTUJ ({wizardItems.length} poz.)
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ── CZAT AI KOSZTORYSANT ── */}
            {isChatOpen && (
                <div className="fixed inset-0 bg-black/70 z-[9999999] flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-[#1e2330] rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden animate-fade-in border-t-4 border-blue-500 flex flex-col h-[85vh]">
                        
                        {/* Nagłówek Czatu */}
                        <div className="p-5 bg-slate-900 border-b border-slate-700 flex justify-between items-center flex-shrink-0">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center text-xl shadow-lg border border-blue-400">🤖</div>
                                <div>
                                    <h3 className="font-black text-white uppercase tracking-tight text-lg">AI Kosztorysant</h3>
                                    <p className="text-[10px] text-blue-400 font-bold">Wspierany przez Python Code Execution</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-4">
                                {chatHistory.length > 0 && (
                                    <button 
                                        onClick={() => {
                                            if (confirm("Czy chcesz wyczyścić historię czatu i zacząć nowe wyliczenia z czystą kartą?")) {
                                                setChatHistory([]);
                                            }
                                        }}
                                        className="text-[10px] font-black uppercase text-red-400 hover:text-red-300 border border-red-500/30 px-3 py-1.5 rounded-lg bg-red-500/10 transition-colors"
                                    >
                                        🧹 Wyczyść czat
                                    </button>
                                )}
                                <button onClick={() => setIsChatOpen(false)} className="text-2xl leading-none text-slate-400 hover:text-red-500 transition">&times;</button>
                            </div>
                        </div>

                        {/* Obszar Wiadomości */}
                        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-[#141822]">
                            {chatHistory.length === 0 && (
                                <div className="text-center mt-10">
                                    <p className="text-5xl mb-4">👷</p>
                                    <p className="text-slate-400 text-sm font-medium">Cześć! Powiedz mi lub napisz, co chcesz zbudować.<br/>Wyliczę dla Ciebie materiały co do sztuki.</p>
                                </div>
                            )}

                            {chatHistory.map((msg, idx) => (
                                <div key={idx} className={`flex flex-col max-w-[85%] ${msg.role === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'}`}>
                                    <div className={`p-3.5 rounded-2xl text-sm ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-slate-800 text-slate-200 border border-slate-700 rounded-bl-sm'}`}>
                                        {msg.content}
                                    </div>

                                    {/* TOK OBLICZEŃ AI */}
                                    {msg.reasoning && msg.reasoning.length > 0 && (
                                        <div className="mt-2 w-full bg-slate-800 border border-slate-700 p-4 rounded-xl shadow-lg">
                                            <p className="text-[10px] font-black text-slate-400 uppercase mb-2 tracking-wider flex items-center gap-1.5">
                                                <span>🧮</span> Założenia i obliczenia:
                                            </p>
                                            <ul className="space-y-1.5 pl-4 list-decimal text-xs text-slate-300 font-medium leading-relaxed marker:text-slate-500">
                                                {msg.reasoning.map((step, i) => (
                                                    <li key={i} className="pl-1">{step}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}

                                    {/* RYSUNEK POGLĄDOWY ASCII */}
                                    {msg.asciiDrawing && (
                                        <div className="mt-2 w-full bg-[#0d1117] border border-slate-700 p-4 rounded-xl shadow-lg overflow-x-auto">
                                            <p className="text-[10px] font-black text-slate-400 uppercase mb-2 tracking-wider flex items-center gap-1.5">
                                                <span>📐</span> Schemat poglądowy:
                                            </p>
                                            <pre className="text-[11px] text-blue-300 font-mono leading-tight whitespace-pre bg-[#0d1117]">
                                                {msg.asciiDrawing}
                                            </pre>
                                        </div>
                                    )}

                                    {/* Jeśli AI 1 (Doradca) wygenerowało opcje do wyboru */}
                                    {msg.materialOptions && msg.materialOptions.length > 0 && (
                                        <div className="mt-2 w-full bg-slate-800 border border-orange-500/50 p-4 rounded-xl shadow-lg">
                                            <p className="text-[10px] font-black text-orange-400 uppercase mb-3">Doprecyzuj parametry przed obliczeniami:</p>
                                            <div className="space-y-4 mb-4">
                                                {msg.materialOptions.map((optionGroup, groupIdx) => (
                                                    <div key={groupIdx} className="bg-slate-900/50 p-3 rounded-lg border border-slate-700">
                                                        <p className="text-xs font-bold text-slate-300 mb-2">{optionGroup.category}:</p>
                                                        <div className="flex flex-wrap gap-2">
                                                            {optionGroup.options.map((opt, optIdx) => {
                                                                const isSelected = chatSelections[idx]?.[optionGroup.category] === opt;
                                                                return (
                                                                    <button
                                                                        key={optIdx}
                                                                        onClick={() => setChatSelections(prev => ({
                                                                            ...prev,
                                                                            [idx]: { ...(prev[idx] || {}), [optionGroup.category]: opt }
                                                                        }))}
                                                                        className={`px-3 py-1.5 text-[11px] font-bold rounded-lg border transition-colors ${isSelected ? 'bg-orange-600 text-white border-orange-500' : 'bg-slate-800 text-slate-400 border-slate-600 hover:border-orange-500/50 hover:text-slate-200'}`}
                                                                    >
                                                                        {opt}
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                            <button 
                                                onClick={() => sendToCalculator(idx, msg.originalRequest || msg.content)}
                                                disabled={Object.keys(chatSelections[idx] || {}).length !== msg.materialOptions.length}
                                                className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-xs font-black shadow-md hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                🧮 OBLICZ ILOŚCI MATERIAŁÓW
                                            </button>
                                        </div>
                                    )}
                                    
                                    {/* Jeśli AI wygenerowało listę materiałów do dodania */}
                                    {msg.generatedItems && msg.generatedItems.length > 0 && (
                                        <div className="mt-2 w-full bg-slate-800 border border-blue-500/50 p-4 rounded-xl shadow-lg">
                                            <p className="text-[10px] font-black text-blue-400 uppercase mb-3">Wyliczone Materiały (możesz edytować):</p>
                                            <ul className="space-y-2 mb-4">
                                                {msg.generatedItems.map((item: any, i: number) => (
                                                    <li key={i} className="text-xs text-white flex flex-col gap-1.5 border-b border-slate-700 pb-2">
                                                        <div className="flex justify-between items-start gap-2">
                                                            <span className="font-medium leading-tight">{item.name}</span>
                                                            <button 
                                                                onClick={() => removeGeneratedItem(idx, i)} 
                                                                className="text-red-400 hover:text-red-300 hover:bg-red-400/10 w-6 h-6 rounded flex items-center justify-center font-bold text-lg leading-none transition-colors flex-shrink-0"
                                                                title="Usuń pozycję"
                                                            >&times;</button>
                                                        </div>
                                                        <div className="flex justify-end items-center gap-2">
                                                            <div className="flex items-center bg-slate-900 rounded-lg border border-slate-600 overflow-hidden">
                                                                <button onClick={() => updateGeneratedItemQty(idx, i, item.quantity - 1)} className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-white font-bold transition-colors">-</button>
                                                                <input 
                                                                    type="number" 
                                                                    min="1" 
                                                                    value={item.quantity} 
                                                                    onChange={e => updateGeneratedItemQty(idx, i, parseInt(e.target.value) || 1)} 
                                                                    className="w-12 bg-transparent text-center text-xs font-bold outline-none" 
                                                                />
                                                                <button onClick={() => updateGeneratedItemQty(idx, i, item.quantity + 1)} className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-white font-bold transition-colors">+</button>
                                                            </div>
                                                            <span className="text-slate-400 text-[10px] w-6">{item.unit}</span>
                                                        </div>
                                                    </li>
                                                ))}
                                            </ul>
                                            <button 
                                                onClick={() => applyGeneratedItemsToCart(msg.generatedItems!)}
                                                className="w-full bg-green-600 text-white py-2.5 rounded-lg text-xs font-black shadow-md hover:bg-green-500 transition-colors"
                                            >
                                                🛒 DODAJ DO KOSZYKA ({msg.generatedItems.length} poz.)
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ))}
                            {isChatLoading && (
                                <div className="flex items-center gap-2 text-slate-400 bg-slate-800 p-3 rounded-2xl w-fit rounded-bl-sm">
                                    <span className="animate-spin text-lg">⏳</span> <span className="text-xs font-medium">AI myśli i liczy...</span>
                                </div>
                            )}
                            <div ref={chatEndRef} />
                        </div>

                        {/* Obszar Wejścia (Input) */}
                        <div className="p-4 bg-slate-900 border-t border-slate-700 flex gap-2 items-end">
                            {canUseAiText && (
                                <textarea
                                    value={chatInputText}
                                    onChange={e => setChatInputText(e.target.value)}
                                    placeholder="Napisz wymiary, np. ściana 10m x 2.5m..."
                                    className="flex-1 bg-slate-800 text-white border border-slate-700 rounded-xl p-3 text-sm outline-none focus:border-blue-500 resize-none max-h-32"
                                    rows={chatInputText.split('\n').length > 1 ? 3 : 1}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            sendChatMessage(chatInputText);
                                        }
                                    }}
                                />
                            )}
                            
                            {canUseAiVoice && (
                                <button
                                    onPointerDown={startChatRecording}
                                    onPointerUp={stopChatRecording}
                                    onPointerLeave={stopChatRecording}
                                    className={`flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center text-xl transition-all shadow-lg select-none touch-none ${isChatRecording ? 'bg-red-500 text-white animate-pulse' : 'bg-slate-700 text-white hover:bg-slate-600'}`}
                                >
                                    {isChatRecording ? '🔴' : '🎙️'}
                                </button>
                            )}

                            {canUseAiText && (
                                <button
                                    onClick={() => sendChatMessage(chatInputText)}
                                    disabled={!chatInputText.trim() || isChatLoading}
                                    className="flex-shrink-0 bg-blue-600 text-white px-5 py-3 rounded-xl font-black text-xs hover:bg-blue-500 disabled:opacity-50 transition-colors h-12 flex items-center"
                                >
                                    WYŚLIJ
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
}