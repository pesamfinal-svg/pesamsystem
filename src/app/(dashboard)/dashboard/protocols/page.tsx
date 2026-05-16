// src/app/(dashboard)/protocols/page.tsx
"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, doc, setDoc, query, orderBy, runTransaction, where, limit } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";

// --- INTERFEJSY ---
interface Site { id: string; name: string; status: string; }
interface InventoryItem {
    id: string; name: string; type: "UNIQUE" | "BULK"; inventoryNumber: string;
    category: string; availableQuantity: number; totalQuantity: number;
    currentLocation: string; status: string; allocations: Record<string, number>;
}
interface Accessory { id: string; name: string; quantity: number; mustReturn: boolean; }
interface CartItem {
    cartItemId: string; isManual: boolean; dbId?: string; type?: "UNIQUE" | "BULK";
    inventoryNumber?: string; availableQuantity?: number; currentLocation?: string; status?: string;
    name: string; issueQty: number; accessories: Accessory[];
}

// Interfejsy dla ZWROTÓW
interface ReturnAccessory { name: string; mustReturn: boolean; isReturning: boolean; quantity: number; }
interface ReturnCartItem {
    dbId: string; name: string; type: "UNIQUE" | "BULK"; inventoryNumber: string;
    maxQty: number; returnQty: number;
    declaredStatus: string;
    accessories: ReturnAccessory[];
}

export default function ProtocolsHub() {
    const { user } = useAuth();
    const [sites, setSites] = useState<Site[]>([]);
    const [inventory, setInventory] = useState<InventoryItem[]>([]);
    const [loading, setLoading] = useState(true);

    // Stany dla WYDANIA
    const [isIssueModalOpen, setIsIssueModalOpen] = useState(false);
    const [issueSiteInput, setIssueSiteInput] = useState("");
    const [cart, setCart] = useState<CartItem[]>([]);

    // Stany dla ZWROTU
    const [isReturnModalOpen, setIsReturnModalOpen] = useState(false);
    const [returnSiteId, setReturnSiteId] = useState("");
    const [returnCart, setReturnCart] = useState<ReturnCartItem[]>([]);

    // Stany dla AKCEPTACJI ZWROTÓW
    const [isAcceptModalOpen, setIsAcceptModalOpen] = useState(false);
    const [pendingProtocols, setPendingProtocols] = useState<any[]>([]);
    const [selectedProtocol, setSelectedProtocol] = useState<any | null>(null);

    // ZMIANA: Dodano `verifiedAccessories` do stanu magazyniera
    const [acceptInputs, setAcceptInputs] = useState<Record<string, { receivedQty: number, finalStatus: string, notes: string, createClaim: boolean, verifiedAccessories: Record<number, boolean> }>>({});
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Filtry
    const [searchName, setSearchName] = useState("");
    const [searchInvNumber, setSearchInvNumber] = useState("");
    const [activeTab, setActiveTab] = useState<"UNIQUE" | "BULK">("UNIQUE");

    // Stany dla formularza osprzętu
    const [accessoryFormOpenFor, setAccessoryFormOpenFor] = useState<string | null>(null);
    const [accName, setAccName] = useState("");
    const [accQty, setAccQty] = useState(1);
    const [accMustReturn, setAccMustReturn] = useState(true);

    const fetchData = async () => {
        setLoading(true);
        try {
            const sitesSnap = await getDocs(query(collection(db, "sites"), orderBy("name", "asc")));
            setSites(sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[]);

            const invSnap = await getDocs(query(collection(db, "inventory"), orderBy("name", "asc")));
            setInventory(invSnap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[]);
        } catch (error) {
            console.error("Błąd podczas pobierania danych:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchData(); }, []);

    const fetchPendingProtocols = async () => {
        try {
            const q = query(collection(db, "protocols"), where("status", "==", "OCZEKUJACY"), where("type", "==", "ZWROT"));
            const snap = await getDocs(q);
            setPendingProtocols(snap.docs.map(d => ({ dbId: d.id, ...d.data() })));
        } catch (error) {
            console.error("Błąd pobierania oczekujących protokołów:", error);
        }
    };

    const closeModal = () => {
        setIsIssueModalOpen(false);
        setIsReturnModalOpen(false);
        setIsAcceptModalOpen(false);
        setCart([]);
        setReturnCart([]);
        setIssueSiteInput("");
        setReturnSiteId("");
        setSelectedProtocol(null);
        setAcceptInputs({});
        setAccessoryFormOpenFor(null);
    };

    const userSites = sites.filter(s => {
        const sitesArray = user?.assignedSites || [];
        return sitesArray.includes("ALL") || sitesArray.includes(s.id);
    });

    // -------------------------------------------------------------------------
    // LOGIKA KOSZYKA WYDANIA
    // -------------------------------------------------------------------------
    const addToCart = (item: InventoryItem) => {
        if (item.availableQuantity <= 0) return alert(`Przedmiot w lokalizacji: ${item.currentLocation}. Najpierw zrób zwrot!`);
        if (item.status !== "sprawne") return alert(`Przedmiot ma status: ${item.status.toUpperCase()}!`);
        if (cart.find(i => i.dbId === item.id)) return;

        setCart([...cart, {
            cartItemId: Date.now().toString(), isManual: false, dbId: item.id, type: item.type,
            inventoryNumber: item.inventoryNumber, availableQuantity: item.availableQuantity,
            currentLocation: item.currentLocation, status: item.status, name: item.name,
            issueQty: 1, accessories: []
        }]);
    };

    const addManualItemToCart = () => {
        const name = prompt("Wpisz nazwę przedmiotu (np. Drut fi 12):");
        if (!name) return;
        const qtyStr = prompt("Podaj ilość:");
        const qty = parseInt(qtyStr || "0");
        if (isNaN(qty) || qty <= 0) return alert("Nieprawidłowa ilość!");

        setCart([...cart, {
            cartItemId: Date.now().toString(), isManual: true, name: name, issueQty: qty, accessories: []
        }]);
    };

    const removeFromCart = (cartItemId: string) => setCart(cart.filter(i => i.cartItemId !== cartItemId));
    const updateCartQty = (cartItemId: string, qty: number) => setCart(cart.map(i => i.cartItemId === cartItemId ? { ...i, issueQty: qty } : i));

    const saveAccessory = (cartItemId: string) => {
        if (!accName.trim()) return;
        setCart(cart.map(item => {
            if (item.cartItemId === cartItemId) {
                return {
                    ...item,
                    accessories: [...item.accessories, { id: Date.now().toString(), name: accName, quantity: accQty, mustReturn: accMustReturn }]
                };
            }
            return item;
        }));
        setAccessoryFormOpenFor(null);
        setAccName(""); setAccQty(1); setAccMustReturn(true);
    };

    const removeAccessory = (cartItemId: string, accId: string) => {
        setCart(cart.map(item => item.cartItemId === cartItemId ? { ...item, accessories: item.accessories.filter(a => a.id !== accId) } : item));
    };

    const handleIssueSubmit = async () => {
        if (!issueSiteInput.trim() || cart.length === 0) return alert("Podaj budowę i wybierz przedmioty!");

        setIsSubmitting(true);
        try {
            await runTransaction(db, async (transaction) => {
                let siteId = "";
                let siteName = issueSiteInput.trim();
                const existingSite = sites.find(s => s.name.toLowerCase() === siteName.toLowerCase());

                if (existingSite) {
                    siteId = existingSite.id;
                    siteName = existingSite.name;
                } else {
                    const newSiteRef = doc(collection(db, "sites"));
                    siteId = newSiteRef.id;
                    transaction.set(newSiteRef, {
                        name: siteName, location: "Wpis ręczny", status: "aktywna", createdAt: new Date().toISOString()
                    });
                }

                const protocolRef = doc(collection(db, "protocols"));
                const protocolId = `WYD-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.floor(100 + Math.random() * 900)}`;

                for (const cartItem of cart) {
                    if (cartItem.isManual) continue;

                    const itemRef = doc(db, "inventory", cartItem.dbId!);
                    const itemDoc = await transaction.get(itemRef);

                    if (!itemDoc.exists()) throw `Przedmiot ${cartItem.name} nie istnieje!`;

                    const data = itemDoc.data();
                    const newAvailable = data.availableQuantity - cartItem.issueQty;
                    if (newAvailable < 0) throw `Brak wystarczającej ilości dla: ${data.name}`;

                    const currentAllocations = data.allocations || {};
                    const newAllocations = { ...currentAllocations, [siteId]: (currentAllocations[siteId] || 0) + cartItem.issueQty };

                    const updateData: any = { availableQuantity: newAvailable, allocations: newAllocations };
                    if (data.type === "UNIQUE") updateData.currentLocation = siteName;

                    transaction.update(itemRef, updateData);

                    if (data.type === "UNIQUE") {
                        const historyRef = doc(collection(db, `inventory/${cartItem.dbId}/history`));
                        transaction.set(historyRef, {
                            date: new Date().toISOString(), type: "WYDANIE", description: `Wydano na budowę: ${siteName}`,
                            status: data.status, user: `${user?.firstName} ${user?.lastName}`
                        });
                    }
                }

                transaction.set(protocolRef, {
                    protocolId, type: "WYDANIE", sourceId: "MAGAZYN", destinationId: siteId, destinationName: siteName,
                    createdBy: user?.uid, createdByName: `${user?.firstName} ${user?.lastName}`, status: "ZAAKCEPTOWANY",
                    createdAt: new Date().toISOString(),
                    items: cart.map(i => ({
                        inventoryId: i.isManual ? null : i.dbId,
                        isManual: i.isManual,
                        name: i.name,
                        inventoryNumber: i.inventoryNumber || "",
                        quantity: i.issueQty,
                        accessories: i.accessories
                    }))
                });
            });

            alert("Protokół wydania został utworzony!");
            closeModal();
            fetchData();
        } catch (error: any) {
            alert("Błąd: " + error);
        } finally {
            setIsSubmitting(false);
        }
    };

    // -------------------------------------------------------------------------
    // ZGŁASZANIE ZWROTU (Kierownik -> Magazyn)
    // -------------------------------------------------------------------------
    const openReturnModal = () => {
        if (userSites.length === 1) setReturnSiteId(userSites[0].id);
        setIsReturnModalOpen(true);
    };

    const fetchItemAccessoriesFromLastIssue = async (itemId: string, siteId: string) => {
        try {
            const q = query(collection(db, "protocols"), where("destinationId", "==", siteId), where("type", "==", "WYDANIE"), orderBy("createdAt", "desc"), limit(10));
            const snap = await getDocs(q);

            for (const docSnap of snap.docs) {
                const protocol = docSnap.data();
                const foundItem = protocol.items.find((i: any) => i.inventoryId === itemId);
                if (foundItem && foundItem.accessories && foundItem.accessories.length > 0) {
                    return foundItem.accessories
                        .filter((acc: any) => acc.mustReturn)
                        .map((acc: any) => ({ name: acc.name, mustReturn: true, isReturning: false, quantity: acc.quantity || 1 }));
                }
            }
        } catch (error) { console.error("Błąd podczas wyszukiwania osprzętu", error); }
        return [];
    };

    const addToReturnCart = async (item: InventoryItem) => {
        if (returnCart.find(i => i.dbId === item.id)) return;
        const expectedAccessories = await fetchItemAccessoriesFromLastIssue(item.id, returnSiteId);

        setReturnCart(prev => [...prev, {
            dbId: item.id, name: item.name, type: item.type, inventoryNumber: item.inventoryNumber,
            maxQty: item.allocations[returnSiteId], returnQty: 1, declaredStatus: "sprawne", accessories: expectedAccessories
        }]);
    };

    const handleReturnSubmit = async () => {
        if (!returnSiteId || returnCart.length === 0) return alert("Wybierz budowę i przedmioty do zwrotu!");
        setIsSubmitting(true);
        try {
            const siteName = sites.find(s => s.id === returnSiteId)?.name || "Nieznana budowa";
            const protocolRef = doc(collection(db, "protocols"));
            const protocolId = `ZWR-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.floor(100 + Math.random() * 900)}`;

            await setDoc(protocolRef, {
                protocolId, type: "ZWROT", documentSource: "APP_ELECTRONIC", sourceId: returnSiteId, sourceName: siteName, destinationId: "MAGAZYN",
                createdBy: user?.uid, createdByName: `${user?.firstName} ${user?.lastName}`, status: "OCZEKUJACY", createdAt: new Date().toISOString(),
                items: returnCart.map(i => ({
                    inventoryId: i.dbId, name: i.name, type: i.type, inventoryNumber: i.inventoryNumber,
                    declaredQty: i.returnQty, declaredStatus: i.type === "UNIQUE" ? i.declaredStatus : null, accessories: i.accessories
                }))
            });
            alert("Zgłoszenie zwrotu wysłane! Oczekuje na weryfikację przez magazyniera.");
            closeModal();
        } catch (error: any) { alert("Błąd: " + error.message); } finally { setIsSubmitting(false); }
    };

    // -------------------------------------------------------------------------
    // AKCEPTACJA ZWROTU PRZEZ MAGAZYNIERA (Magia tworzenia zaległości)
    // -------------------------------------------------------------------------
    const openAcceptModal = () => {
        fetchPendingProtocols();
        setIsAcceptModalOpen(true);
    };

    const openProtocolDetails = (protocol: any) => {
        // ZMIANA: Inicjalizacja verifiedAccessories na podstawie deklaracji kierownika
        const initialInputs: Record<string, { receivedQty: number, finalStatus: string, notes: string, createClaim: boolean, verifiedAccessories: Record<number, boolean> }> = {};

        protocol.items.forEach((i: any) => {
            const verAcc: Record<number, boolean> = {};
            if (i.accessories) {
                i.accessories.forEach((a: any, idx: number) => {
                    verAcc[idx] = a.isReturning; // Domyślnie bierzemy to co zgłosił kierownik
                });
            }

            initialInputs[i.inventoryId] = {
                receivedQty: i.declaredQty,
                finalStatus: i.declaredStatus || "sprawne",
                notes: "",
                createClaim: false,
                verifiedAccessories: verAcc
            };
        });

        setAcceptInputs(initialInputs);
        setSelectedProtocol(protocol);
    };

    const handleAcceptSubmit = async () => {
        if (!selectedProtocol) return;
        setIsSubmitting(true);
        try {
            await runTransaction(db, async (transaction) => {

                // ═══════════════════════════════════════════════════════════════
                // FAZA 1: WSZYSTKIE ODCZYTY (reads muszą być przed writes!)
                // ═══════════════════════════════════════════════════════════════

                const protocolRef = doc(db, "protocols", selectedProtocol.dbId);
                const protocolDoc = await transaction.get(protocolRef);

                if (!protocolDoc.exists() || protocolDoc.data().status !== "OCZEKUJACY") {
                    throw "Ten protokół został już przetworzony lub nie istnieje.";
                }

                // Pobieramy wszystkie dokumenty inventory na raz
                const itemDocs: Record<string, any> = {};
                for (const item of selectedProtocol.items) {
                    if (!item.inventoryId) continue;
                    const itemRef = doc(db, "inventory", item.inventoryId);
                    const itemDoc = await transaction.get(itemRef);
                    itemDocs[item.inventoryId] = { ref: itemRef, doc: itemDoc };
                }

                // ═══════════════════════════════════════════════════════════════
                // FAZA 2: WSZYSTKIE ZAPISY (writes po reads)
                // ═══════════════════════════════════════════════════════════════

                const updatedItemsForProtocol = [];

                for (const item of selectedProtocol.items) {
                    if (!item.inventoryId) continue;

                    const { ref: itemRef, doc: itemDoc } = itemDocs[item.inventoryId];
                    if (!itemDoc.exists()) continue;

                    const itemData = itemDoc.data();
                    const workerInput = acceptInputs[item.inventoryId];

                    // TWORZENIE ZALEGŁOŚCI OSPRZĘTU
                    let missingAccessoriesNote = "";
                    const finalizedAccessories = [];

                    if (item.accessories && item.accessories.length > 0) {
                        const missing = [];
                        for (let idx = 0; idx < item.accessories.length; idx++) {
                            const acc = item.accessories[idx];
                            const isVerifiedReturning = workerInput.verifiedAccessories[idx];
                            finalizedAccessories.push({ ...acc, verifiedReturning: isVerifiedReturning });
                            if (!isVerifiedReturning) missing.push(acc);
                        }

                        if (missing.length > 0) {
                            missingAccessoriesNote = ` | ZALEGŁOŚCI OSPRZĘTU: ${missing.map((a: any) => a.name).join(", ")}`;

                            for (const mAcc of missing) {
                                const debtRef = doc(collection(db, "inventory"));
                                transaction.set(debtRef, {
                                    name: `[Zaległy osprzęt] ${mAcc.name} (od: ${item.name} ${item.inventoryNumber ? 'nr ' + item.inventoryNumber : ''})`,
                                    type: "BULK",
                                    inventoryNumber: "",
                                    category: "Zaległości z budowy",
                                    availableQuantity: 0,
                                    totalQuantity: mAcc.quantity || 1,
                                    status: "sprawne",
                                    allocations: { [selectedProtocol.sourceId]: mAcc.quantity || 1 },
                                    createdAt: new Date().toISOString()
                                });
                            }
                        }
                    }

                    // TWORZENIE SPRAWY W CENTRUM LIKWIDACJI SZKÓD
                    if (itemData.type === "UNIQUE" && workerInput.finalStatus === "uszkodzone" && workerInput.createClaim) {
                        const claimRef = doc(collection(db, "claims"));
                        transaction.set(claimRef, {
                            claimId: `SZK-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.floor(1000 + Math.random() * 9000)}`,
                            inventoryId: item.inventoryId,
                            inventoryName: item.name,
                            inventoryNumber: item.inventoryNumber || "",
                            protocolId: selectedProtocol.protocolId,
                            siteId: selectedProtocol.sourceId,
                            siteName: selectedProtocol.sourceName,
                            reportedBy: user?.uid,
                            reportedByName: `${user?.firstName} ${user?.lastName}`,
                            description: workerInput.notes || "Zgłoszono uszkodzenie przy przyjęciu z budowy.",
                            status: "NOWA",
                            createdAt: new Date().toISOString()
                        });
                    }

                    // AKTUALIZACJA STANU MAGAZYNOWEGO
                    if (itemData.type === "BULK") {
                        const currentAllocations = itemData.allocations || {};
                        const currentSiteQty = currentAllocations[selectedProtocol.sourceId] || 0;
                        const newSiteQty = Math.max(0, currentSiteQty - workerInput.receivedQty);
                        const newAvailable = itemData.availableQuantity + workerInput.receivedQty;

                        transaction.update(itemRef, {
                            [`allocations.${selectedProtocol.sourceId}`]: newSiteQty,
                            availableQuantity: newAvailable
                        });
                    } else if (itemData.type === "UNIQUE") {
                        transaction.update(itemRef, {
                            currentLocation: "MAGAZYN",
                            status: workerInput.finalStatus,
                            availableQuantity: 1,
                            [`allocations.${selectedProtocol.sourceId}`]: 0
                        });

                        const historyRef = doc(collection(db, `inventory/${item.inventoryId}/history`));
                        transaction.set(historyRef, {
                            date: new Date().toISOString(),
                            type: "ZWROT",
                            description: `Zwrócono z: ${selectedProtocol.sourceName}. Zgłoszono stan: ${item.declaredStatus}, przyjęto jako: ${workerInput.finalStatus}. Uwagi: ${workerInput.notes}${missingAccessoriesNote}${workerInput.createClaim ? ' [Zgłoszono do Centrum Likwidacji Szkód]' : ''}`,
                            status: workerInput.finalStatus,
                            user: `${user?.firstName} ${user?.lastName}`
                        });
                    }

                    updatedItemsForProtocol.push({
                        ...item,
                        receivedQty: workerInput.receivedQty,
                        finalStatus: workerInput.finalStatus,
                        warehouseNotes: workerInput.notes + missingAccessoriesNote,
                        accessories: finalizedAccessories
                    });
                }

                // AKTUALIZACJA PROTOKOŁU
                transaction.update(protocolRef, {
                    status: "ZAAKCEPTOWANY",
                    acceptedBy: user?.uid,
                    acceptedByName: `${user?.firstName} ${user?.lastName}`,
                    acceptedAt: new Date().toISOString(),
                    items: updatedItemsForProtocol
                });
            });

            alert("Zwrot został pomyślnie przyjęty!");
            setSelectedProtocol(null);
            fetchPendingProtocols();
            fetchData();
        } catch (error: any) {
            alert("Błąd akceptacji: " + error);
        } finally {
            setIsSubmitting(false);
        }
    };


    if (loading) return <div className="p-10 text-center animate-pulse">Ładowanie modułu protokołów...</div>;

    const filteredInventory = inventory.filter(item => {
        if (item.type !== activeTab) return false;
        const matchesName = item.name.toLowerCase().includes(searchName.toLowerCase());
        let matchesInvNum = true;
        if (searchInvNumber) matchesInvNum = (item.inventoryNumber || "").toLowerCase().includes(searchInvNumber.toLowerCase());
        return matchesName && matchesInvNum;
    });

    const inventoryOnSelectedSite = inventory.filter(i => returnSiteId && i.allocations && i.allocations[returnSiteId] > 0);

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto animate-fade-in">
            <h1 className="text-3xl font-bold text-slate-800 tracking-tight mb-8">Centrum Protokołów</h1>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
                {user && hasPermission("issueProtocols", user.rolePermissions, user.permissionOverrides) && (
                    <div onClick={() => setIsIssueModalOpen(true)} className="bg-green-50 hover:bg-green-100 border border-green-200 p-6 rounded-2xl cursor-pointer transition shadow-sm group">
                        <div className="text-3xl mb-2 group-hover:scale-110 transition">📤</div><h3 className="font-bold text-green-900">Wystaw Wydanie</h3><p className="text-xs text-green-700 mt-1">Z magazynu na budowę</p>
                    </div>
                )}
                {user && hasPermission("issueProtocols", user.rolePermissions, user.permissionOverrides) && (
                    <div onClick={openReturnModal} className="bg-blue-50 hover:bg-blue-100 border border-blue-200 p-6 rounded-2xl cursor-pointer transition shadow-sm group">
                        <div className="text-3xl mb-2 group-hover:scale-110 transition">📲</div><h3 className="font-bold text-blue-900">Zgłoś Zwrot</h3><p className="text-xs text-blue-700 mt-1">Kierownik: z budowy do magazynu</p>
                    </div>
                )}
                {user && hasPermission("acceptReturns", user.rolePermissions, user.permissionOverrides) && (
                    <div onClick={() => alert("Moduł wkrótce będzie dostępny")} className="bg-orange-50 hover:bg-orange-100 border border-orange-200 p-6 rounded-2xl cursor-pointer transition shadow-sm group">
                        <div className="text-3xl mb-2 group-hover:scale-110 transition">📝</div><h3 className="font-bold text-orange-900">Wprowadź Zwrot</h3><p className="text-xs text-orange-700 mt-1">Przepisz z papieru</p>
                    </div>
                )}
                {user && hasPermission("acceptReturns", user.rolePermissions, user.permissionOverrides) && (
                    <div onClick={openAcceptModal} className="bg-purple-50 hover:bg-purple-100 border border-purple-200 p-6 rounded-2xl cursor-pointer transition shadow-sm group relative">
                        <div className="text-3xl mb-2 group-hover:scale-110 transition">✅</div><h3 className="font-bold text-purple-900">Akceptuj Zwroty</h3><p className="text-xs text-purple-700 mt-1">Magazyn: weryfikacja i przyjęcie</p>
                    </div>
                )}
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center text-slate-500">
                Lista ostatnio wystawionych protokołów pojawi się tutaj... (Faza 4)
            </div>

            {/* MODAL 1: WYDANIE */}
            {isIssueModalOpen && (
                <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-3xl shadow-2xl w-[95vw] h-[90vh] flex flex-col overflow-hidden animate-fade-in">
                        <div className="p-6 bg-slate-50 border-b flex justify-between items-center">
                            <h2 className="text-2xl font-black text-slate-800">Wystaw Protokół Wydania</h2>
                            <button onClick={closeModal} className="text-4xl text-slate-400 hover:text-slate-900 leading-none">&times;</button>
                        </div>
                        <div className="flex-1 flex overflow-hidden">
                            <div className="w-[55%] border-r flex flex-col bg-white">
                                <div className="p-6 border-b bg-slate-50">
                                    <div className="flex gap-2 mb-4 bg-slate-200 p-1 rounded-xl w-fit">
                                        <button onClick={() => setActiveTab("UNIQUE")} className={`px-6 py-2 rounded-lg text-sm font-black transition-all ${activeTab === 'UNIQUE' ? 'bg-white text-blue-600 shadow-md' : 'text-slate-500'}`}>NARZĘDZIA</button>
                                        <button onClick={() => setActiveTab("BULK")} className={`px-6 py-2 rounded-lg text-sm font-black transition-all ${activeTab === 'BULK' ? 'bg-white text-orange-600 shadow-md' : 'text-slate-500'}`}>RUSZTOWANIA</button>
                                    </div>
                                    <div className="flex gap-4">
                                        <div className="flex-1">
                                            <input type="text" placeholder="Szukaj po nazwie..." className="w-full p-3 border rounded-xl outline-none focus:ring-2 focus:ring-green-500 bg-white" value={searchName} onChange={(e) => setSearchName(e.target.value)} />
                                        </div>
                                        <div className="w-1/3">
                                            <input type="text" placeholder="Szukaj po Nr Mag..." className="w-full p-3 border rounded-xl outline-none focus:ring-2 focus:ring-blue-500 bg-white font-mono" value={searchInvNumber} onChange={(e) => setSearchInvNumber(e.target.value)} />
                                        </div>
                                    </div>
                                </div>
                                <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-slate-50">
                                    {filteredInventory.map(item => {
                                        const isAvailable = item.availableQuantity > 0;
                                        const isBroken = item.status !== "sprawne";
                                        return (
                                            <div key={item.id} className={`flex justify-between items-center p-3 border rounded-xl shadow-sm ${isAvailable ? 'bg-white' : 'bg-slate-100 opacity-60'} ${isBroken ? 'border-red-300 bg-red-50' : ''}`}>
                                                <div>
                                                    <p className="font-bold text-sm text-slate-800">{item.name}</p>
                                                    <p className="text-[11px] font-mono text-blue-600">Nr Mag: {item.inventoryNumber || "-"}</p>
                                                    {!isAvailable && <p className="text-[10px] text-red-600 font-bold uppercase">📍 Poza magazynem: {item.currentLocation}</p>}
                                                    {isAvailable && <p className="text-[10px] text-green-600 font-bold">Dostępne: {item.availableQuantity}</p>}
                                                </div>
                                                {isAvailable && !isBroken ? (
                                                    <button onClick={() => addToCart(item)} className="bg-slate-100 hover:bg-green-600 hover:text-white text-green-600 w-10 h-10 rounded-lg font-black text-xl transition">+</button>
                                                ) : <div className="text-[10px] text-red-500 font-bold text-center uppercase leading-tight">Zablokowane</div>}
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>
                            <div className="w-[45%] flex flex-col bg-white">
                                <div className="p-6 border-b bg-slate-50">
                                    <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">1. Wybierz lub wpisz budowę</label>
                                    <input list="sites-list" placeholder="Wybierz z listy lub wpisz nową usterkę..." value={issueSiteInput} onChange={(e) => setIssueSiteInput(e.target.value)} className="w-full p-4 border rounded-xl outline-none focus:ring-2 focus:ring-green-500 font-bold shadow-sm" />
                                    <datalist id="sites-list">{sites.map(s => <option key={s.id} value={s.name} />)}</datalist>
                                </div>
                                <div className="flex-1 p-6 overflow-y-auto">
                                    <div className="flex justify-between items-center mb-4">
                                        <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest">2. Koszyk wydania</label>
                                        <button onClick={addManualItemToCart} className="bg-orange-100 text-orange-800 px-3 py-1.5 rounded-lg text-xs font-bold">+ Wpis ręczny</button>
                                    </div>
                                    {cart.length === 0 ? (
                                        <div className="text-center p-10 text-slate-400 border-2 border-dashed rounded-xl">KOSZYK PUSTY</div>
                                    ) : (
                                        <div className="space-y-3">
                                            {cart.map(cItem => (
                                                <div key={cItem.cartItemId} className={`p-4 border rounded-xl shadow-sm ${cItem.isManual ? 'bg-orange-50 border-orange-200' : 'bg-slate-50'}`}>
                                                    <div className="flex items-center justify-between gap-4">
                                                        <div className="flex-1">
                                                            <p className="font-bold text-sm text-slate-800">{cItem.name} {cItem.isManual && <span className="ml-2 text-[9px] bg-orange-200 text-orange-800 px-2 rounded uppercase">Ręczny</span>}</p>
                                                            {!cItem.isManual && <p className="text-[10px] text-slate-500 font-mono">Nr Mag: {cItem.inventoryNumber || "-"}</p>}
                                                        </div>
                                                        <div className="flex items-center gap-3">
                                                            {cItem.type === "BULK" || cItem.isManual ? (
                                                                <input type="number" min="1" max={cItem.isManual ? 9999 : cItem.availableQuantity} value={cItem.issueQty} onChange={(e) => updateCartQty(cItem.cartItemId, Number(e.target.value))} className="w-16 p-2 border rounded-lg text-center font-bold outline-none" />
                                                            ) : <span className="font-bold text-sm bg-white px-3 py-2 rounded-lg border">1 szt.</span>}
                                                            <button onClick={() => removeFromCart(cItem.cartItemId)} className="bg-red-100 hover:bg-red-500 text-red-600 hover:text-white w-8 h-8 rounded-lg font-bold">&times;</button>
                                                        </div>
                                                    </div>
                                                    <div className="mt-3 pl-4 border-l-2 border-blue-200">
                                                        {cItem.accessories.map(acc => (
                                                            <div key={acc.id} className="flex justify-between items-center text-xs bg-white p-2 rounded border mb-1">
                                                                <span>↳ {acc.name} <b>({acc.quantity} szt.)</b></span>
                                                                <div className="flex gap-3">
                                                                    <span className={acc.mustReturn ? "text-red-600 font-bold" : "text-slate-400"}>{acc.mustReturn ? "Musi wrócić!" : "Zużywalny"}</span>
                                                                    <button onClick={() => removeAccessory(cItem.cartItemId, acc.id)} className="text-red-400 font-bold">X</button>
                                                                </div>
                                                            </div>
                                                        ))}
                                                        {accessoryFormOpenFor === cItem.cartItemId ? (
                                                            <div className="flex items-center gap-2 mt-2 bg-blue-50 p-2 rounded border border-blue-100">
                                                                <input type="text" placeholder="Nazwa (np. Klucz)" className="flex-1 p-1.5 text-xs border" value={accName} onChange={e => setAccName(e.target.value)} />
                                                                <input type="number" min="1" className="w-12 p-1.5 text-xs text-center border" value={accQty} onChange={e => setAccQty(Number(e.target.value))} />
                                                                <label className="text-[10px] font-bold flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={accMustReturn} onChange={e => setAccMustReturn(e.target.checked)} /> Ma wrócić?</label>
                                                                <button onClick={() => saveAccessory(cItem.cartItemId)} className="bg-blue-600 text-white text-xs font-bold px-3 py-1.5 rounded">OK</button>
                                                                <button onClick={() => setAccessoryFormOpenFor(null)} className="text-slate-500 text-xs">Anuluj</button>
                                                            </div>
                                                        ) : <button onClick={() => setAccessoryFormOpenFor(cItem.cartItemId)} className="text-[10px] font-bold text-blue-600 hover:underline mt-2">+ Dodaj osprzęt</button>}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div className="p-6 border-t bg-slate-50 flex gap-4">
                                    <button onClick={closeModal} className="w-1/3 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-xl">ANULUJ</button>
                                    <button onClick={handleIssueSubmit} disabled={isSubmitting || cart.length === 0 || !issueSiteInput.trim()} className="w-2/3 py-4 bg-green-600 hover:bg-green-700 text-white font-black rounded-xl shadow-xl disabled:bg-slate-300 disabled:shadow-none">
                                        {isSubmitting ? "ZAPISYWANIE..." : "ZATWIERDŹ I WYDAJ"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* MODAL 2: ZGŁOSZENIE ZWROTU */}
            {isReturnModalOpen && (
                <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-3xl shadow-2xl w-[95vw] h-[90vh] flex flex-col overflow-hidden animate-fade-in">
                        <div className="p-6 bg-slate-50 border-b flex justify-between items-center">
                            <div><h2 className="text-2xl font-black text-blue-600">Zgłoś Zwrot Sprzętu</h2><p className="text-sm text-slate-500">Wybierz co zjeżdża z budowy na magazyn.</p></div>
                            <button onClick={closeModal} className="text-4xl text-slate-400 hover:text-slate-900 leading-none">&times;</button>
                        </div>
                        <div className="flex-1 flex overflow-hidden">
                            <div className="w-[50%] border-r flex flex-col bg-white">
                                <div className="p-6 border-b bg-blue-50">
                                    <label className="block text-[11px] font-black text-blue-800 uppercase tracking-widest mb-2">1. Z jakiej budowy zwracasz?</label>
                                    <select value={returnSiteId} onChange={(e) => { setReturnSiteId(e.target.value); setReturnCart([]); }} className="w-full p-4 border-2 border-blue-200 rounded-xl outline-none focus:border-blue-500 font-bold bg-white">
                                        <option value="" disabled>-- Wybierz budowę --</option>
                                        {userSites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                    </select>
                                </div>
                                <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-slate-50">
                                    {!returnSiteId ? (
                                        <div className="text-center p-10 text-slate-400">Wybierz budowę z listy powyżej.</div>
                                    ) : inventoryOnSelectedSite.length === 0 ? (
                                        <div className="text-center p-10 text-slate-400">Brak sprzętu na tej budowie w bazie.</div>
                                    ) : inventoryOnSelectedSite.map(item => (
                                        <div key={item.id} className="flex justify-between items-center p-3 border rounded-xl bg-white hover:border-blue-300 transition shadow-sm">
                                            <div>
                                                <p className="font-bold text-sm text-slate-800">{item.name}</p>
                                                <p className="text-[11px] font-mono text-slate-500">Nr Mag: {item.inventoryNumber || "-"} | Na budowie: <b className="text-blue-600">{item.allocations[returnSiteId]}</b> szt.</p>
                                            </div>
                                            <button onClick={() => addToReturnCart(item)} className="bg-slate-100 hover:bg-blue-600 hover:text-white text-blue-600 w-10 h-10 rounded-lg font-black text-xl transition">+</button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="w-[50%] flex flex-col bg-white">
                                <div className="flex-1 p-6 overflow-y-auto">
                                    <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-4">2. Koszyk Zwrotu</label>
                                    {returnCart.length === 0 ? (
                                        <div className="text-center p-10 text-slate-400 border-2 border-dashed rounded-xl">Wybierz przedmioty z lewej strony</div>
                                    ) : (
                                        <div className="space-y-3">
                                            {returnCart.map(cItem => (
                                                <div key={cItem.dbId} className="bg-slate-50 p-4 border rounded-xl shadow-sm">
                                                    <div className="flex items-start justify-between gap-4 mb-2">
                                                        <div className="flex-1">
                                                            <p className="font-bold text-sm text-slate-800">{cItem.name}</p>
                                                            <p className="text-[10px] text-slate-500 font-mono mb-2">Nr Mag: {cItem.inventoryNumber || "-"}</p>
                                                            {cItem.type === "UNIQUE" && (
                                                                <select value={cItem.declaredStatus} onChange={(e) => setReturnCart(returnCart.map(i => i.dbId === cItem.dbId ? { ...i, declaredStatus: e.target.value } : i))} className="text-xs p-1 border rounded bg-white text-slate-700 outline-none">
                                                                    <option value="sprawne">✅ Sprawne</option>
                                                                    <option value="do przeglądu">⚠️ Do przeglądu</option>
                                                                    <option value="uszkodzone">❌ Uszkodzone</option>
                                                                </select>
                                                            )}
                                                        </div>
                                                        <div className="flex items-center gap-3">
                                                            {cItem.type === "BULK" ? (
                                                                <div className="flex items-center gap-1">
                                                                    <span className="text-[10px] text-slate-400">Szt:</span>
                                                                    <input type="number" min="1" max={cItem.maxQty} value={cItem.returnQty} onChange={(e) => setReturnCart(returnCart.map(i => i.dbId === cItem.dbId ? { ...i, returnQty: Number(e.target.value) } : i))} className="w-16 p-2 border rounded-lg text-center font-bold outline-none" />
                                                                </div>
                                                            ) : <span className="font-bold text-sm bg-white px-3 py-2 rounded-lg border">1 szt.</span>}
                                                            <button onClick={() => setReturnCart(returnCart.filter(i => i.dbId !== cItem.dbId))} className="bg-red-100 text-red-600 hover:bg-red-500 hover:text-white transition w-8 h-8 rounded-lg font-bold">&times;</button>
                                                        </div>
                                                    </div>
                                                    {cItem.accessories.length > 0 && (
                                                        <div className="mt-3 pl-4 border-l-2 border-orange-300 bg-orange-50 p-3 rounded-r-lg">
                                                            <p className="text-[10px] font-black text-orange-800 uppercase mb-2">⚠️ Pamiętaj o osprzęcie z wydania:</p>
                                                            {cItem.accessories.map((acc, idx) => (
                                                                <label key={idx} className="flex items-center gap-2 cursor-pointer mb-1">
                                                                    <input type="checkbox" checked={acc.isReturning} onChange={(e) => { const newCart = [...returnCart]; const targetItem = newCart.find(i => i.dbId === cItem.dbId); if (targetItem) targetItem.accessories[idx].isReturning = e.target.checked; setReturnCart(newCart); }} className="w-4 h-4" />
                                                                    <span className="text-sm">Zwracam: {acc.name} ({acc.quantity} szt.)</span>
                                                                </label>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div className="p-6 border-t bg-slate-50 flex gap-4">
                                    <button onClick={closeModal} className="w-1/3 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-xl">ANULUJ</button>
                                    <button onClick={handleReturnSubmit} disabled={isSubmitting || returnCart.length === 0} className="w-2/3 py-4 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-xl text-lg shadow-xl disabled:bg-slate-300">WYŚLIJ ZGŁOSZENIE ZWROTU</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* MODAL 3: AKCEPTACJA ZWROTU (Weryfikacja przez Magazyn) */}
            {isAcceptModalOpen && (
                <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-3xl shadow-2xl w-[95vw] h-[90vh] flex flex-col overflow-hidden animate-fade-in">
                        <div className="p-6 bg-purple-50 border-b flex justify-between items-center">
                            <div><h2 className="text-2xl font-black text-purple-900">Akceptacja Zwrotów</h2><p className="text-sm text-purple-700">Weryfikuj ilości i statusy tego, co zjechało z budowy.</p></div>
                            <button onClick={closeModal} className="text-4xl text-purple-400 hover:text-purple-900 leading-none">&times;</button>
                        </div>

                        <div className="flex-1 flex overflow-hidden">
                            <div className="w-[35%] border-r flex flex-col bg-slate-50 p-4 overflow-y-auto space-y-3">
                                {pendingProtocols.length === 0 ? (
                                    <div className="text-center p-10 text-slate-400">Brak oczekujących zwrotów.</div>
                                ) : (
                                    pendingProtocols.map(p => (
                                        <div key={p.dbId} onClick={() => openProtocolDetails(p)} className={`p-4 rounded-xl border cursor-pointer transition ${selectedProtocol?.dbId === p.dbId ? 'bg-purple-100 border-purple-400 shadow-md' : 'bg-white border-slate-200 hover:border-purple-300 shadow-sm'}`}>
                                            <div className="flex justify-between items-start mb-2">
                                                <span className="font-bold text-sm text-slate-800">{p.protocolId}</span>
                                                <span className="text-[10px] bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded font-bold uppercase">{p.status}</span>
                                            </div>
                                            <p className="text-xs text-slate-600 mb-1">Z budowy: <b className="text-slate-800">{p.sourceName}</b></p>
                                            <p className="text-[10px] text-slate-400">Zgłosił: {p.createdByName} • {new Date(p.createdAt).toLocaleDateString()}</p>
                                        </div>
                                    ))
                                )}
                            </div>

                            <div className="w-[65%] flex flex-col bg-white">
                                {!selectedProtocol ? (
                                    <div className="flex-1 flex items-center justify-center text-slate-400">Wybierz protokół z listy po lewej.</div>
                                ) : (
                                    <>
                                        <div className="flex-1 p-6 overflow-y-auto bg-white">
                                            <h3 className="font-black text-lg text-slate-800 mb-4 border-b pb-2">Pozycje w protokole: {selectedProtocol.protocolId}</h3>
                                            <div className="space-y-4">
                                                {selectedProtocol.items.map((item: any) => {
                                                    const inputState = acceptInputs[item.inventoryId] || { receivedQty: item.declaredQty, finalStatus: item.declaredStatus || "sprawne", notes: "", createClaim: false, verifiedAccessories: {} };
                                                    const isQtyDifferent = item.type === "BULK" && inputState.receivedQty !== item.declaredQty;
                                                    const isStatusDifferent = item.type === "UNIQUE" && inputState.finalStatus !== item.declaredStatus;

                                                    return (
                                                        <div key={item.inventoryId} className={`p-4 border rounded-xl shadow-sm ${isQtyDifferent || isStatusDifferent ? 'bg-orange-50 border-orange-300' : 'bg-slate-50'}`}>
                                                            <div className="flex justify-between items-start mb-3">
                                                                <div>
                                                                    <p className="font-bold text-slate-800">{item.name}</p>
                                                                    <p className="text-[10px] font-mono text-slate-500">Nr Mag: {item.inventoryNumber || "BRAK"}</p>
                                                                </div>
                                                                <div className="text-right">
                                                                    <p className="text-[10px] text-slate-500 uppercase">Kierownik Zgłosił:</p>
                                                                    {item.type === "BULK" ? (
                                                                        <p className="font-black text-slate-700">{item.declaredQty} szt.</p>
                                                                    ) : (
                                                                        <p className="font-bold text-sm">Status: {item.declaredStatus}</p>
                                                                    )}
                                                                </div>
                                                            </div>

                                                            <div className="bg-white p-3 rounded border border-slate-200 flex flex-wrap gap-4 items-center">
                                                                <div className="text-xs font-bold text-purple-800 uppercase w-full mb-1">Weryfikacja Magazynu:</div>

                                                                {item.type === "BULK" && (
                                                                    <div className="flex items-center gap-2">
                                                                        <label className="text-xs text-slate-600">Przyjęto szt:</label>
                                                                        <input
                                                                            type="number" min="0"
                                                                            value={inputState.receivedQty}
                                                                            onChange={(e) => setAcceptInputs({ ...acceptInputs, [item.inventoryId]: { ...inputState, receivedQty: Number(e.target.value) } })}
                                                                            className={`w-20 p-1.5 border rounded text-center font-bold outline-none ${isQtyDifferent ? 'bg-orange-100 text-orange-900 border-orange-400' : 'bg-slate-50'}`}
                                                                        />
                                                                    </div>
                                                                )}

                                                                {item.type === "UNIQUE" && (
                                                                    <div className="flex flex-col gap-2">
                                                                        <div className="flex items-center gap-2">
                                                                            <label className="text-xs text-slate-600">Ostateczny status:</label>
                                                                            <select
                                                                                value={inputState.finalStatus}
                                                                                onChange={(e) => setAcceptInputs({ ...acceptInputs, [item.inventoryId]: { ...inputState, finalStatus: e.target.value } })}
                                                                                className={`p-1.5 border rounded text-xs font-bold outline-none ${isStatusDifferent ? 'bg-orange-100 text-orange-900 border-orange-400' : 'bg-slate-50'}`}
                                                                            >
                                                                                <option value="sprawne">✅ Sprawne</option>
                                                                                <option value="do przeglądu">⚠️ Do przeglądu</option>
                                                                                <option value="uszkodzone">❌ Uszkodzone</option>
                                                                            </select>
                                                                        </div>
                                                                        {/* ZGŁOSZENIE SZKODY DO SĄDU */}
                                                                        {inputState.finalStatus === "uszkodzone" && (
                                                                            <label className="flex items-center gap-2 p-2 bg-red-50 border border-red-200 rounded cursor-pointer mt-1 animate-fade-in">
                                                                                <input
                                                                                    type="checkbox"
                                                                                    checked={inputState.createClaim || false}
                                                                                    onChange={(e) => setAcceptInputs({ ...acceptInputs, [item.inventoryId]: { ...inputState, createClaim: e.target.checked } })}
                                                                                    className="w-4 h-4 text-red-600 rounded border-red-300 focus:ring-red-500"
                                                                                />
                                                                                <span className="text-xs font-bold text-red-800">⚖️ Zgłoś od razu do Centrum Likwidacji Szkód</span>
                                                                            </label>
                                                                        )}
                                                                    </div>
                                                                )}

                                                                <div className="flex-1 min-w-[200px]">
                                                                    <input
                                                                        type="text" placeholder="Notatka magazyniera (np. brak wtyczki)..."
                                                                        value={inputState.notes}
                                                                        onChange={(e) => setAcceptInputs({ ...acceptInputs, [item.inventoryId]: { ...inputState, notes: e.target.value } })}
                                                                        className="w-full text-xs p-1.5 border rounded bg-slate-50 outline-none"
                                                                    />
                                                                </div>
                                                            </div>

                                                            {/* ZMIANA: Interaktywna lista osprzętu dla Magazyniera */}
                                                            {item.accessories && item.accessories.length > 0 && (
                                                                <div className="mt-3 p-3 bg-orange-50 border border-orange-200 rounded text-xs">
                                                                    <p className="font-bold text-orange-800 mb-2">Fizyczna weryfikacja osprzętu z wydania:</p>
                                                                    <div className="space-y-1">
                                                                        {item.accessories.map((acc: any, i: number) => (
                                                                            <label key={i} className="flex items-center gap-2 cursor-pointer p-1 hover:bg-orange-100 rounded transition">
                                                                                <input
                                                                                    type="checkbox"
                                                                                    checked={inputState.verifiedAccessories[i] !== undefined ? inputState.verifiedAccessories[i] : acc.isReturning}
                                                                                    onChange={(e) => {
                                                                                        const newVerified = { ...inputState.verifiedAccessories, [i]: e.target.checked };
                                                                                        setAcceptInputs({ ...acceptInputs, [item.inventoryId]: { ...inputState, verifiedAccessories: newVerified } });
                                                                                    }}
                                                                                    className="w-4 h-4 text-purple-600 rounded border-slate-300 focus:ring-purple-500"
                                                                                />
                                                                                <span className={`text-sm ${inputState.verifiedAccessories[i] !== undefined ? (inputState.verifiedAccessories[i] ? 'text-slate-800' : 'text-slate-500 line-through') : (acc.isReturning ? 'text-slate-800' : 'text-slate-500 line-through')}`}>
                                                                                    {acc.name} ({acc.quantity || 1} szt.)
                                                                                </span>
                                                                                <span className={`text-[10px] ml-auto px-1.5 py-0.5 rounded ${acc.isReturning ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                                                                    Kierownik: {acc.isReturning ? "✅ Zgłosił" : "❌ Brak"}
                                                                                </span>
                                                                            </label>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                        <div className="p-6 border-t bg-slate-50 flex gap-4 items-center">
                                            <p className="text-xs text-slate-400 flex-1">Kliknięcie "AKCEPTUJ" fizycznie zdejmie podane ilości z budowy i przywróci je na stan magazynu. Brakujący osprzęt zostanie na stanie budowy jako dług.</p>
                                            <button onClick={handleAcceptSubmit} disabled={isSubmitting} className="px-8 py-3 bg-purple-600 hover:bg-purple-700 text-white font-black rounded-xl shadow-xl disabled:bg-slate-300">
                                                {isSubmitting ? "ZAPISYWANIE..." : "AKCEPTUJ ZWROT"}
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}