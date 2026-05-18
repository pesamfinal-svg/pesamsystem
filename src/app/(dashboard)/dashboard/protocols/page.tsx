// src/app/(dashboard)/protocols/page.tsx
"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, doc, setDoc, query, orderBy, runTransaction, where, limit } from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import ClaimInvestigationModal from "@/components/claims/ClaimInvestigationModal";
import { hasPermission } from "@/lib/auth/permissions";

// --- INTERFEJSY ---
interface Site { id: string; name: string; status: string; }
interface InventoryItem {
    id: string; name: string; type: "UNIQUE" | "BULK"; subType?: "MAIN_CAT" | "SUB_ITEM" | "MANUAL"; inventoryNumber: string;
    category: string; availableQuantity: number; totalQuantity: number; unit?: string;
    currentLocation: string; status: string; allocations: Record<string, number>;
}
interface Accessory { id: string; name: string; quantity: number; mustReturn: boolean; }
interface CartItem {
    cartItemId: string; isManual: boolean; dbId?: string; type?: "UNIQUE" | "BULK";
    inventoryNumber?: string; availableQuantity?: number; currentLocation?: string; status?: string;
    name: string; issueQty: number; unit?: string; accessories: Accessory[];
}

// Interfejsy dla ZWROTÓW APLIKACYJNYCH
interface ReturnAccessory { name: string; mustReturn: boolean; isReturning: boolean; quantity: number; }
interface ReturnCartItem {
    dbId: string; isManual?: boolean; name: string; type: "UNIQUE" | "BULK"; inventoryNumber: string;
    maxQty: number; returnQty: number; unit?: string;
    declaredStatus: string;
    accessories: ReturnAccessory[];
}

// Interfejsy dla ZWROTÓW PAPIEROWYCH
interface PaperReturnCartItem {
    cartItemId: string; dbId?: string; isManual: boolean; name: string; type: "UNIQUE" | "BULK";
    inventoryNumber: string; unit: string; maxQty: number; receivedQty: number;
    finalStatus: string; notes: string;
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
    const [bulkPickModal, setBulkPickModal] = useState<{ item: InventoryItem; qty: number } | null>(null);

    // Stany dla WPISU RĘCZNEGO (Wydania)
    const [isManualModalOpen, setIsManualModalOpen] = useState(false);
    const [manualName, setManualName] = useState("");
    const [manualQty, setManualQty] = useState<number | "">("");
    const [manualUnit, setManualUnit] = useState("szt.");

    // Stany dla ZWROTU APLIKACYJNEGO
    const [isReturnModalOpen, setIsReturnModalOpen] = useState(false);
    const [returnSiteId, setReturnSiteId] = useState("");
    const [returnCart, setReturnCart] = useState<ReturnCartItem[]>([]);
    const [returnActiveTab, setReturnActiveTab] = useState<"UNIQUE" | "BULK" | "MANUAL">("UNIQUE");
    const [isReturnManualModalOpen, setIsReturnManualModalOpen] = useState(false);

    // Stany dla AKCEPTACJI ZWROTÓW
    const [isAcceptModalOpen, setIsAcceptModalOpen] = useState(false);
    const [pendingProtocols, setPendingProtocols] = useState<any[]>([]);
    const [selectedProtocol, setSelectedProtocol] = useState<any | null>(null);

    const [acceptInputs, setAcceptInputs] = useState<Record<string, { receivedQty: number, finalStatus: string, notes: string, createClaim: boolean, verifiedAccessories: Record<number, boolean> }>>({});
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Stany dla Zdjęć i Dopisywania w Akceptacji
    const [returnPhotos, setReturnPhotos] = useState<File[]>([]);
    const [isAddFromSiteOpen, setIsAddFromSiteOpen] = useState(false);
    const [acceptSiteTab, setAcceptSiteTab] = useState<"UNIQUE" | "BULK" | "MANUAL">("UNIQUE");
    const [isAddManualToAcceptOpen, setIsAddManualToAcceptOpen] = useState(false);

    // Stany dla ZWROTU PAPIEROWEGO
    const [isPaperReturnModalOpen, setIsPaperReturnModalOpen] = useState(false);
    const [paperReturnSiteId, setPaperReturnSiteId] = useState("");
    const [paperDocReference, setPaperDocReference] = useState("");
    const [paperReturnCart, setPaperReturnCart] = useState<PaperReturnCartItem[]>([]);
    const [paperReturnActiveTab, setPaperReturnActiveTab] = useState<"UNIQUE" | "BULK" | "MANUAL">("UNIQUE");
    const [isPaperManualModalOpen, setIsPaperManualModalOpen] = useState(false);

    const [investigationData, setInvestigationData] = useState<{
        inventoryId: string;
        inventoryName: string;
        inventoryNumber: string;
        siteName: string;
        warehouseNotes: string;
        declaredStatus: string;
    } | null>(null);

    const [investigationDone, setInvestigationDone] = useState(false);

    // Filtry (Wydania)
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

    // Obliczamy zablokowane ilości na podstawie oczekujących protokołów zwrotu
    const lockedInPending: Record<string, number> = {};
    pendingProtocols.forEach(p => {
        p.items.forEach((i: any) => {
            if (i.inventoryId && !i.isNewManual) {
                lockedInPending[i.inventoryId] = (lockedInPending[i.inventoryId] || 0) + (i.declaredQty || 1);
            }
        });
    });

    const closeModal = () => {
        setIsIssueModalOpen(false);
        setIsReturnModalOpen(false);
        setIsAcceptModalOpen(false);
        setIsPaperReturnModalOpen(false);
        setCart([]);
        setReturnCart([]);
        setPaperReturnCart([]);
        setIssueSiteInput("");
        setReturnSiteId("");
        setPaperReturnSiteId("");
        setPaperDocReference("");
        setSelectedProtocol(null);
        setAcceptInputs({});
        setAccessoryFormOpenFor(null);
        setBulkPickModal(null);
        setIsManualModalOpen(false);
        setIsReturnManualModalOpen(false);
        setIsPaperManualModalOpen(false);
        setReturnActiveTab("UNIQUE");
        setPaperReturnActiveTab("UNIQUE");
        setReturnPhotos([]);
        setIsAddFromSiteOpen(false);
        setIsAddManualToAcceptOpen(false);
    };

    const userSites = sites.filter(s => {
        const sitesArray = user?.assignedSites || [];
        return sitesArray.includes("ALL") || sitesArray.includes(s.id);
    });

    // -------------------------------------------------------------------------
    // LOGIKA KOSZYKA WYDANIA
    // -------------------------------------------------------------------------

    const filteredInventory = inventory.filter(item => {
        if (item.type !== activeTab) return false;
        if (item.subType === "MAIN_CAT") return false;
        if (item.subType === "MANUAL") return false;
        const matchesName = item.name.toLowerCase().includes(searchName.toLowerCase());
        let matchesInvNum = true;
        if (searchInvNumber) matchesInvNum = (item.inventoryNumber || "").toLowerCase().includes(searchInvNumber.toLowerCase());
        return matchesName && matchesInvNum;
    });

    const addToCart = (item: InventoryItem) => {
        if (item.availableQuantity <= 0) return alert(`Przedmiot w lokalizacji: ${item.currentLocation}. Najpierw zrób zwrot!`);
        if (item.status !== "sprawne") return alert(`Przedmiot ma status: ${item.status.toUpperCase()}!`);
        if (cart.find(i => i.dbId === item.id)) return alert("Ten przedmiot jest już w koszyku!");

        if (item.type === "BULK") {
            setBulkPickModal({ item, qty: 1 });
            return;
        }

        setCart(prev => [...prev, {
            cartItemId: Date.now().toString(), isManual: false, dbId: item.id, type: item.type,
            inventoryNumber: item.inventoryNumber, availableQuantity: item.availableQuantity,
            currentLocation: item.currentLocation, status: item.status, name: item.name,
            issueQty: 1, unit: item.unit || "szt.", accessories: []
        }]);
    };

    const confirmBulkAdd = () => {
        if (!bulkPickModal) return;
        const { item, qty } = bulkPickModal;
        if (qty <= 0 || qty > item.availableQuantity) {
            return alert(`Podaj ilość od 1 do ${item.availableQuantity}`);
        }
        setCart(prev => [...prev, {
            cartItemId: Date.now().toString(), isManual: false, dbId: item.id, type: item.type,
            inventoryNumber: item.inventoryNumber, availableQuantity: item.availableQuantity,
            currentLocation: item.currentLocation, status: item.status, name: item.name,
            issueQty: qty, unit: item.unit || "szt.", accessories: []
        }]);
        setBulkPickModal(null);
    };

    const confirmManualAdd = () => {
        if (!manualName.trim() || !manualQty || Number(manualQty) <= 0) {
            return alert("Podaj prawidłową nazwę oraz ilość większą od 0!");
        }
        setCart(prev => [...prev, {
            cartItemId: Date.now().toString(), isManual: true, name: manualName.trim(),
            issueQty: Number(manualQty), unit: manualUnit, accessories: []
        }]);
        setIsManualModalOpen(false);
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
                const itemDocs: Record<string, any> = {};
                for (const cartItem of cart) {
                    if (cartItem.isManual || !cartItem.dbId) continue;
                    const itemRef = doc(db, "inventory", cartItem.dbId);
                    const itemDoc = await transaction.get(itemRef);

                    if (!itemDoc.exists()) throw `Przedmiot ${cartItem.name} nie istnieje w bazie!`;
                    itemDocs[cartItem.dbId] = { ref: itemRef, doc: itemDoc };
                }

                let siteId = "";
                let siteName = issueSiteInput.trim();
                const existingSite = sites.find(s => s.name.toLowerCase() === siteName.toLowerCase());

                let newSiteRef = null;
                if (existingSite) {
                    siteId = existingSite.id;
                    siteName = existingSite.name;
                } else {
                    newSiteRef = doc(collection(db, "sites"));
                    siteId = newSiteRef.id;
                }

                if (newSiteRef) {
                    transaction.set(newSiteRef, {
                        name: siteName, location: "Wpis ręczny", status: "aktywna", createdAt: new Date().toISOString()
                    });
                }

                const protocolRef = doc(collection(db, "protocols"));
                const protocolId = `WYD-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.floor(100 + Math.random() * 900)}`;

                const finalProtocolItems = [];

                for (const cartItem of cart) {
                    if (cartItem.isManual) {
                        const newDocRef = doc(collection(db, "inventory"));
                        transaction.set(newDocRef, {
                            name: cartItem.name,
                            type: "BULK",
                            subType: "MANUAL",
                            inventoryNumber: "RĘCZNY",
                            category: "Wpis ręczny",
                            unit: cartItem.unit || "szt.",
                            availableQuantity: 0,
                            totalQuantity: cartItem.issueQty,
                            status: "sprawne",
                            allocations: { [siteId]: cartItem.issueQty },
                            createdAt: new Date().toISOString()
                        });

                        finalProtocolItems.push({
                            inventoryId: newDocRef.id,
                            isManual: true,
                            name: cartItem.name,
                            inventoryNumber: "RĘCZNY",
                            quantity: cartItem.issueQty,
                            unit: cartItem.unit || "szt.",
                            accessories: cartItem.accessories
                        });
                    } else {
                        const { ref: itemRef, doc: itemDoc } = itemDocs[cartItem.dbId!];
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

                        finalProtocolItems.push({
                            inventoryId: cartItem.dbId,
                            isManual: false,
                            name: cartItem.name,
                            inventoryNumber: cartItem.inventoryNumber || "",
                            quantity: cartItem.issueQty,
                            unit: cartItem.unit || "szt.",
                            accessories: cartItem.accessories
                        });
                    }
                }

                transaction.set(protocolRef, {
                    protocolId, type: "WYDANIE", sourceId: "MAGAZYN", destinationId: siteId, destinationName: siteName,
                    createdBy: user?.uid, createdByName: `${user?.firstName} ${user?.lastName}`, status: "ZAAKCEPTOWANY",
                    createdAt: new Date().toISOString(),
                    items: finalProtocolItems
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
    // ZGŁASZANIE ZWROTU APLIKACYJNEGO
    // -------------------------------------------------------------------------
    const openReturnModal = async () => {
        await fetchPendingProtocols(); // Odświeżamy blokady
        if (userSites.length === 1) setReturnSiteId(userSites[0].id);
        setReturnActiveTab("UNIQUE");
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

    const addToReturnCart = async (item: InventoryItem & { availableToReturn: number }) => {
        if (returnCart.find(i => i.dbId === item.id)) return;
        const expectedAccessories = await fetchItemAccessoriesFromLastIssue(item.id, returnSiteId);

        setReturnCart(prev => [...prev, {
            dbId: item.id, isManual: false, name: item.name, type: item.type, inventoryNumber: item.inventoryNumber,
            maxQty: item.availableToReturn, returnQty: 1, unit: item.unit || "szt.", declaredStatus: "sprawne", accessories: expectedAccessories
        }]);
    };

    const confirmReturnManualAdd = () => {
        if (!manualName.trim() || !manualQty || Number(manualQty) <= 0) return alert("Podaj prawidłową nazwę oraz ilość większą od 0!");
        setReturnCart(prev => [...prev, {
            dbId: `temp-manual-${Date.now()}`, isManual: true, name: manualName.trim(), type: "BULK",
            inventoryNumber: "RĘCZNY ZWROT", unit: manualUnit, maxQty: 999999, returnQty: Number(manualQty),
            declaredStatus: "sprawne", accessories: []
        }]);
        setIsReturnManualModalOpen(false);
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
                    inventoryId: i.dbId, isNewManual: i.isManual, name: i.name, type: i.type, inventoryNumber: i.inventoryNumber, unit: i.unit || "szt.",
                    declaredQty: i.returnQty, declaredStatus: i.type === "UNIQUE" ? i.declaredStatus : null, accessories: i.accessories
                }))
            });
            alert("Zgłoszenie zwrotu wysłane! Oczekuje na weryfikację przez magazyniera.");
            closeModal();
            fetchPendingProtocols();
        } catch (error: any) { alert("Błąd: " + error.message); } finally { setIsSubmitting(false); }
    };

    // Filtrowanie sprzętu uwzględniające to, co już zablokowane w innych protokołach
    const inventoryOnSelectedSite = inventory
        .map(i => {
            const siteQty = i.allocations?.[returnSiteId] || 0;
            const lockedQty = lockedInPending[i.id] || 0;
            const availableToReturn = siteQty - lockedQty;
            return { ...i, availableToReturn };
        })
        .filter(i => returnSiteId && i.availableToReturn > 0);

    const filteredReturnInventory = inventoryOnSelectedSite.filter(item => {
        if (returnActiveTab === "UNIQUE") return item.type === "UNIQUE";
        if (returnActiveTab === "BULK") return item.type === "BULK" && item.subType !== "MANUAL";
        if (returnActiveTab === "MANUAL") return item.subType === "MANUAL";
        return true;
    });

    // -------------------------------------------------------------------------
    // WPROWADŹ ZWROT Z PAPIERU (NOWE)
    // -------------------------------------------------------------------------
    const openPaperReturnModal = async () => {
        await fetchPendingProtocols(); // Odświeżamy blokady
        setPaperReturnActiveTab("UNIQUE");
        setIsPaperReturnModalOpen(true);
    };

    const inventoryOnPaperSite = inventory
        .map(i => {
            const siteQty = i.allocations?.[paperReturnSiteId] || 0;
            const lockedQty = lockedInPending[i.id] || 0;
            const availableToReturn = siteQty - lockedQty;
            return { ...i, availableToReturn };
        })
        .filter(i => paperReturnSiteId && i.availableToReturn > 0);

    const filteredPaperInventory = inventoryOnPaperSite.filter(item => {
        if (paperReturnActiveTab === "UNIQUE") return item.type === "UNIQUE";
        if (paperReturnActiveTab === "BULK") return item.type === "BULK" && item.subType !== "MANUAL";
        if (paperReturnActiveTab === "MANUAL") return item.subType === "MANUAL";
        return true;
    });

    const addToPaperReturnCart = (item: InventoryItem & { availableToReturn: number }) => {
        if (paperReturnCart.find(i => i.dbId === item.id)) return;
        setPaperReturnCart(prev => [...prev, {
            cartItemId: Date.now().toString(), dbId: item.id, isManual: false, name: item.name, type: item.type,
            inventoryNumber: item.inventoryNumber || "", unit: item.unit || "szt.", maxQty: item.availableToReturn,
            receivedQty: 1, finalStatus: "sprawne", notes: ""
        }]);
    };

    const updatePaperReturnItem = (cartItemId: string, field: keyof PaperReturnCartItem, value: any) => {
        setPaperReturnCart(prev => prev.map(item => item.cartItemId === cartItemId ? { ...item, [field]: value } : item));
    };

    const removePaperReturnItem = (cartItemId: string) => {
        setPaperReturnCart(prev => prev.filter(item => item.cartItemId !== cartItemId));
    };

    const confirmPaperManualAdd = () => {
        if (!manualName.trim() || !manualQty || Number(manualQty) <= 0) return alert("Podaj prawidłową nazwę oraz ilość większą od 0!");
        setPaperReturnCart(prev => [...prev, {
            cartItemId: Date.now().toString(), isManual: true, name: manualName.trim(), type: "BULK",
            inventoryNumber: "RĘCZNY PAPIER", unit: manualUnit, maxQty: 999999, receivedQty: Number(manualQty),
            finalStatus: "sprawne", notes: "Dopisane z papieru"
        }]);
        setIsPaperManualModalOpen(false);
    };

    const handlePaperReturnSubmit = async () => {
        if (!paperReturnSiteId || paperReturnCart.length === 0) return alert("Wybierz budowę i dodaj przynajmniej jeden przedmiot!");

        setIsSubmitting(true);
        try {
            await runTransaction(db, async (transaction) => {
                const siteName = sites.find(s => s.id === paperReturnSiteId)?.name || "Nieznana budowa";
                const protocolRef = doc(collection(db, "protocols"));
                const protocolId = `PAP-ZWR-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.floor(100 + Math.random() * 900)}`;

                const itemDocs: Record<string, any> = {};
                for (const item of paperReturnCart) {
                    if (!item.isManual && item.dbId) {
                        const itemRef = doc(db, "inventory", item.dbId);
                        const itemDoc = await transaction.get(itemRef);
                        if (!itemDoc.exists()) throw `Przedmiot ${item.name} nie istnieje!`;
                        itemDocs[item.dbId] = { ref: itemRef, doc: itemDoc };
                    }
                }

                const finalProtocolItems = [];

                for (const cartItem of paperReturnCart) {
                    if (cartItem.isManual) {
                        const newDocRef = doc(collection(db, "inventory"));
                        transaction.set(newDocRef, {
                            name: cartItem.name, type: "BULK", subType: "MANUAL", inventoryNumber: "RĘCZNY ZWROT", category: "Wpis ręczny z papieru",
                            unit: cartItem.unit || "szt.", availableQuantity: cartItem.receivedQty, totalQuantity: cartItem.receivedQty,
                            status: "sprawne", allocations: {}, createdAt: new Date().toISOString()
                        });
                        finalProtocolItems.push({
                            inventoryId: newDocRef.id, isNewManual: true, name: cartItem.name, type: "BULK",
                            inventoryNumber: "RĘCZNY ZWROT", unit: cartItem.unit, receivedQty: cartItem.receivedQty,
                            finalStatus: "sprawne", warehouseNotes: cartItem.notes, accessories: []
                        });
                    } else {
                        const { ref: itemRef, doc: itemDoc } = itemDocs[cartItem.dbId!];
                        const itemData = itemDoc.data();

                        if (itemData.type === "BULK") {
                            const currentSiteQty = itemData.allocations?.[paperReturnSiteId] || 0;
                            const newSiteQty = Math.max(0, currentSiteQty - cartItem.receivedQty);
                            const newAvailable = itemData.availableQuantity + cartItem.receivedQty;

                            transaction.update(itemRef, {
                                [`allocations.${paperReturnSiteId}`]: newSiteQty,
                                availableQuantity: newAvailable
                            });
                        } else if (itemData.type === "UNIQUE") {
                            transaction.update(itemRef, {
                                currentLocation: "MAGAZYN", status: cartItem.finalStatus, availableQuantity: 1,
                                [`allocations.${paperReturnSiteId}`]: 0
                            });

                            const historyRef = doc(collection(db, `inventory/${cartItem.dbId}/history`));
                            transaction.set(historyRef, {
                                date: new Date().toISOString(), type: "ZWROT",
                                description: `Zwrot papierowy z: ${siteName}. Nr Dok: ${paperDocReference || 'Brak'}. Przyjęto jako: ${cartItem.finalStatus}. Uwagi: ${cartItem.notes}`,
                                status: cartItem.finalStatus, user: `${user?.firstName} ${user?.lastName}`
                            });
                        }

                        finalProtocolItems.push({
                            inventoryId: cartItem.dbId, name: cartItem.name, type: cartItem.type,
                            inventoryNumber: cartItem.inventoryNumber, unit: cartItem.unit,
                            receivedQty: cartItem.receivedQty, finalStatus: cartItem.finalStatus,
                            warehouseNotes: cartItem.notes, accessories: []
                        });
                    }
                }

                transaction.set(protocolRef, {
                    protocolId, type: "ZWROT", documentSource: "PAPER", paperReference: paperDocReference,
                    sourceId: paperReturnSiteId, sourceName: siteName, destinationId: "MAGAZYN",
                    createdBy: user?.uid, createdByName: `${user?.firstName} ${user?.lastName}`,
                    acceptedBy: user?.uid, acceptedByName: `${user?.firstName} ${user?.lastName}`,
                    status: "ZAAKCEPTOWANY", createdAt: new Date().toISOString(), acceptedAt: new Date().toISOString(),
                    items: finalProtocolItems
                });
            });

            alert("Papierowy protokół zwrotu został wprowadzony i zaakceptowany!");
            closeModal();
            fetchData();
        } catch (error: any) {
            alert("Błąd: " + error);
        } finally {
            setIsSubmitting(false);
        }
    };


    // -------------------------------------------------------------------------
    // AKCEPTACJA ZWROTU PRZEZ MAGAZYNIERA (Aplikacyjna)
    // -------------------------------------------------------------------------
    const openAcceptModal = () => {
        fetchPendingProtocols();
        setIsAcceptModalOpen(true);
    };

    const openProtocolDetails = (protocol: any) => {
        const initialInputs: Record<string, { receivedQty: number, finalStatus: string, notes: string, createClaim: boolean, verifiedAccessories: Record<number, boolean> }> = {};

        protocol.items.forEach((i: any) => {
            const verAcc: Record<number, boolean> = {};
            if (i.accessories) {
                i.accessories.forEach((a: any, idx: number) => { verAcc[idx] = a.isReturning; });
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
        setReturnPhotos([]);
    };

    const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) setReturnPhotos(prev => [...prev, ...Array.from(e.target.files!)]);
    };
    const removePhoto = (index: number) => setReturnPhotos(prev => prev.filter((_, i) => i !== index));

    const inventoryOnSelectedProtocolSite = inventory.filter(i =>
        selectedProtocol && i.allocations && i.allocations[selectedProtocol.sourceId] > 0 && !selectedProtocol.items.some((pi: any) => pi.inventoryId === i.id)
    );
    const filteredAcceptAddInventory = inventoryOnSelectedProtocolSite.filter(item => {
        if (acceptSiteTab === "UNIQUE") return item.type === "UNIQUE";
        if (acceptSiteTab === "BULK") return item.type === "BULK" && item.subType !== "MANUAL";
        if (acceptSiteTab === "MANUAL") return item.subType === "MANUAL";
        return true;
    });

    const addItemToAcceptProtocol = (item: InventoryItem) => {
        const newItem = {
            inventoryId: item.id, name: item.name, type: item.type, inventoryNumber: item.inventoryNumber, unit: item.unit || "szt.",
            declaredQty: 0,
            declaredStatus: item.type === "UNIQUE" ? "sprawne" : null, accessories: []
        };
        setSelectedProtocol((prev: any) => ({ ...prev, items: [...prev.items, newItem] }));
        setAcceptInputs(prev => ({
            ...prev,
            [item.id]: { receivedQty: 1, finalStatus: "sprawne", notes: "Dodano przez magazyn (Zapomniane)", createClaim: false, verifiedAccessories: {} }
        }));
        setIsAddFromSiteOpen(false);
    };

    const openAddManualToAccept = () => { setManualName(""); setManualQty(""); setManualUnit("szt."); setIsAddManualToAcceptOpen(true); };
    const confirmAddManualToAccept = () => {
        if (!manualName.trim() || !manualQty || Number(manualQty) <= 0) return alert("Podaj prawidłową nazwę oraz ilość większą od 0!");
        const tempId = `temp-${Date.now()}`;
        const newItem = {
            inventoryId: tempId, isNewManual: true, isManual: true, name: manualName.trim(), type: "BULK", unit: manualUnit,
            declaredQty: 0, declaredStatus: null, accessories: []
        };
        setSelectedProtocol((prev: any) => ({ ...prev, items: [...prev.items, newItem] }));
        setAcceptInputs(prev => ({
            ...prev,
            [tempId]: { receivedQty: Number(manualQty), finalStatus: "sprawne", notes: "Wpis ręczny (Dopisane przez magazyn)", createClaim: false, verifiedAccessories: {} }
        }));
        setIsAddManualToAcceptOpen(false);
    };

    const removeItemFromAcceptProtocol = (inventoryIdToRemove: string) => {
        setSelectedProtocol((prev: any) => ({
            ...prev,
            items: prev.items.filter((item: any) => item.inventoryId !== inventoryIdToRemove)
        }));
    };

    const handleAcceptSubmit = async (skipInvestigationCheck = false) => {
        if (!selectedProtocol) return;

        if (!investigationDone && !skipInvestigationCheck) {
            const itemNeedingInvestigation = selectedProtocol.items.find((item: any) => {
                const input = acceptInputs[item.inventoryId];
                return item.type === "UNIQUE" && input?.finalStatus === "uszkodzone" && input?.createClaim;
            });

            if (itemNeedingInvestigation) {
                setInvestigationData({
                    inventoryId: itemNeedingInvestigation.inventoryId,
                    inventoryName: itemNeedingInvestigation.name,
                    inventoryNumber: itemNeedingInvestigation.inventoryNumber || "",
                    siteName: selectedProtocol.sourceName,
                    warehouseNotes: acceptInputs[itemNeedingInvestigation.inventoryId]?.notes || "",
                    declaredStatus: acceptInputs[itemNeedingInvestigation.inventoryId]?.finalStatus || "uszkodzone",
                });
                return;
            }
        }

        setIsSubmitting(true);
        try {
            const photoURLs: string[] = [];
            if (returnPhotos.length > 0) {
                const storage = getStorage();
                for (let i = 0; i < returnPhotos.length; i++) {
                    const file = returnPhotos[i];
                    const fileRef = ref(storage, `protocols/${selectedProtocol.protocolId}/${Date.now()}_${file.name}`);
                    await uploadBytes(fileRef, file);
                    const url = await getDownloadURL(fileRef);
                    photoURLs.push(url);
                }
            }

            await runTransaction(db, async (transaction) => {
                const protocolRef = doc(db, "protocols", selectedProtocol.dbId);
                const protocolDoc = await transaction.get(protocolRef);

                if (!protocolDoc.exists() || protocolDoc.data().status !== "OCZEKUJACY") {
                    throw "Ten protokół został już przetworzony lub nie istnieje.";
                }

                const itemDocs: Record<string, any> = {};
                for (const item of selectedProtocol.items) {
                    if (!item.inventoryId || item.isNewManual) continue;
                    const itemRef = doc(db, "inventory", item.inventoryId);
                    const itemDoc = await transaction.get(itemRef);
                    itemDocs[item.inventoryId] = { ref: itemRef, doc: itemDoc };
                }

                const updatedItemsForProtocol = [];

                for (const item of selectedProtocol.items) {
                    const workerInput = acceptInputs[item.inventoryId];

                    if (item.isNewManual) {
                        const newDocRef = doc(collection(db, "inventory"));
                        transaction.set(newDocRef, {
                            name: item.name, type: "BULK", subType: "MANUAL", inventoryNumber: "RĘCZNY ZWROT", category: "Wpis ręczny",
                            unit: item.unit || "szt.", availableQuantity: workerInput.receivedQty, totalQuantity: workerInput.receivedQty,
                            status: "sprawne", allocations: {}, createdAt: new Date().toISOString()
                        });
                        updatedItemsForProtocol.push({ ...item, inventoryId: newDocRef.id, receivedQty: workerInput.receivedQty, finalStatus: workerInput.finalStatus, warehouseNotes: workerInput.notes, accessories: [] });
                        continue;
                    }

                    if (!item.inventoryId) continue;

                    const { ref: itemRef, doc: itemDoc } = itemDocs[item.inventoryId];
                    if (!itemDoc.exists()) continue;

                    const itemData = itemDoc.data();

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
                                    subType: "MANUAL",
                                    inventoryNumber: "OSPRZĘT",
                                    category: "Zaległości osprzętu",
                                    subcategory: item.type === "UNIQUE" ? "Osprzęt narzędzi" : "Osprzęt rusztowań",
                                    unit: "szt.",
                                    availableQuantity: 0,
                                    totalQuantity: mAcc.quantity || 1,
                                    status: "sprawne",
                                    allocations: { [selectedProtocol.sourceId]: mAcc.quantity || 1 },
                                    createdAt: new Date().toISOString()
                                });
                            }
                        }
                    }

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

                transaction.update(protocolRef, {
                    status: "ZAAKCEPTOWANY",
                    acceptedBy: user?.uid,
                    acceptedByName: `${user?.firstName} ${user?.lastName}`,
                    acceptedAt: new Date().toISOString(),
                    items: updatedItemsForProtocol,
                    ...(photoURLs.length > 0 && { photos: photoURLs })
                });
            });

            alert("Zwrot został pomyślnie przyjęty!");
            setSelectedProtocol(null);
            setInvestigationDone(false);
            setReturnPhotos([]);
            fetchPendingProtocols();
            fetchData();
        } catch (error: any) {
            alert("Błąd akceptacji: " + error);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (loading) return <div className="p-10 text-center animate-pulse">Ładowanie modułu protokołów...</div>;

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
                    <div onClick={openPaperReturnModal} className="bg-orange-50 hover:bg-orange-100 border border-orange-200 p-6 rounded-2xl cursor-pointer transition shadow-sm group">
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
                            {/* LEWA — lista sprzętu */}
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
                                        const isInCart = !!cart.find(i => i.dbId === item.id);
                                        return (
                                            <div key={item.id} className={`flex justify-between items-center p-3 border rounded-xl shadow-sm transition
                                                ${isInCart ? 'bg-green-50 border-green-300' : isAvailable ? 'bg-white' : 'bg-slate-100 opacity-60'}
                                                ${isBroken ? 'border-red-300 bg-red-50' : ''}`}>
                                                <div>
                                                    <p className="font-bold text-sm text-slate-800">{item.name}</p>
                                                    <p className="text-[11px] font-mono text-blue-600">Nr Mag: {item.inventoryNumber || "-"}</p>
                                                    {!isAvailable && <p className="text-[10px] text-red-600 font-bold uppercase">📍 Poza magazynem: {item.currentLocation}</p>}
                                                    {isAvailable && <p className="text-[10px] text-green-600 font-bold">Dostępne: {item.availableQuantity} {item.unit || "szt."}</p>}
                                                </div>
                                                {isInCart ? (
                                                    <span className="text-[10px] bg-green-100 text-green-700 font-black px-2 py-1 rounded-lg uppercase">W koszyku</span>
                                                ) : isAvailable && !isBroken ? (
                                                    <button onClick={() => addToCart(item)} className="bg-slate-100 hover:bg-green-600 hover:text-white text-green-600 w-10 h-10 rounded-lg font-black text-xl transition">+</button>
                                                ) : (
                                                    <div className="text-[10px] text-red-500 font-bold text-center uppercase leading-tight">Zablokowane</div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* PRAWA — budowa + koszyk */}
                            <div className="w-[45%] flex flex-col bg-white">
                                <div className="p-6 border-b bg-slate-50">
                                    <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">1. Wybierz lub wpisz budowę</label>
                                    <input list="sites-list" placeholder="Wybierz z listy lub wpisz nową budowę..." value={issueSiteInput} onChange={(e) => setIssueSiteInput(e.target.value)} className="w-full p-4 border rounded-xl outline-none focus:ring-2 focus:ring-green-500 font-bold shadow-sm" />
                                    <datalist id="sites-list">{sites.map(s => <option key={s.id} value={s.name} />)}</datalist>
                                </div>
                                <div className="flex-1 p-6 overflow-y-auto">
                                    <div className="flex justify-between items-center mb-4">
                                        <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest">2. Koszyk wydania</label>
                                        <button onClick={() => setIsManualModalOpen(true)} className="bg-orange-100 hover:bg-orange-200 text-orange-800 px-3 py-1.5 rounded-lg text-xs font-bold transition shadow-sm">+ Wpis ręczny</button>
                                    </div>
                                    {cart.length === 0 ? (
                                        <div className="text-center p-10 text-slate-400 border-2 border-dashed rounded-xl">KOSZYK PUSTY</div>
                                    ) : (
                                        <div className="space-y-3">
                                            {cart.map(cItem => (
                                                <div key={cItem.cartItemId} className={`p-4 border rounded-xl shadow-sm ${cItem.isManual ? 'bg-orange-50 border-orange-200' : 'bg-slate-50'}`}>
                                                    <div className="flex items-center justify-between gap-4">
                                                        <div className="flex-1">
                                                            <p className="font-bold text-sm text-slate-800">
                                                                {cItem.name}
                                                                {cItem.isManual && <span className="ml-2 text-[9px] bg-orange-200 text-orange-800 px-2 rounded uppercase">Ręczny</span>}
                                                            </p>
                                                            {!cItem.isManual && <p className="text-[10px] text-slate-500 font-mono">Nr Mag: {cItem.inventoryNumber || "-"}</p>}
                                                        </div>
                                                        <div className="flex items-center gap-3">
                                                            {cItem.type === "BULK" || cItem.isManual ? (
                                                                <div className="flex items-center gap-1">
                                                                    <input
                                                                        type="number" min="0.01" step="any"
                                                                        max={cItem.isManual ? 999999 : cItem.availableQuantity}
                                                                        value={cItem.issueQty}
                                                                        onChange={(e) => updateCartQty(cItem.cartItemId, Number(e.target.value))}
                                                                        className="w-16 p-2 border rounded-lg text-center font-bold outline-none"
                                                                    />
                                                                    <span className="text-xs font-bold text-slate-500">{cItem.unit || "szt."}</span>
                                                                </div>
                                                            ) : (
                                                                <span className="font-bold text-sm bg-white px-3 py-2 rounded-lg border">1 szt.</span>
                                                            )}
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
                                                                <label className="text-[10px] font-bold flex items-center gap-1 cursor-pointer">
                                                                    <input type="checkbox" checked={accMustReturn} onChange={e => setAccMustReturn(e.target.checked)} /> Ma wrócić?
                                                                </label>
                                                                <button onClick={() => saveAccessory(cItem.cartItemId)} className="bg-blue-600 text-white text-xs font-bold px-3 py-1.5 rounded">OK</button>
                                                                <button onClick={() => setAccessoryFormOpenFor(null)} className="text-slate-500 text-xs">Anuluj</button>
                                                            </div>
                                                        ) : (
                                                            <button onClick={() => setAccessoryFormOpenFor(cItem.cartItemId)} className="text-[10px] font-bold text-blue-600 hover:underline mt-2">+ Dodaj osprzęt</button>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div className="p-6 border-t bg-slate-50 flex gap-4">
                                    <button onClick={closeModal} className="w-1/3 py-4 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-xl">ANULUJ</button>
                                    <button
                                        onClick={handleIssueSubmit}
                                        disabled={isSubmitting || cart.length === 0 || !issueSiteInput.trim() || accessoryFormOpenFor !== null}
                                        className="w-2/3 py-4 bg-green-600 hover:bg-green-700 text-white font-black rounded-xl shadow-xl disabled:bg-slate-300 disabled:shadow-none"
                                        title={accessoryFormOpenFor !== null ? "Najpierw zatwierdź lub anuluj dodawanie osprzętu!" : ""}
                                    >
                                        {isSubmitting ? "ZAPISYWANIE..." : accessoryFormOpenFor !== null ? "⚠️ DOKOŃCZ DODAWANIE OSPRZĘTU" : "ZATWIERDŹ I WYDAJ"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* MINI-MODAL: Wybór ilości dla BULK (ze stanów magazynowych) */}
            {bulkPickModal && (
                <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-fade-in">
                        <h3 className="text-lg font-black text-slate-800 mb-1">Podaj ilość</h3>
                        <p className="text-sm text-slate-500 mb-1">
                            <span className="font-bold text-slate-700">{bulkPickModal.item.name}</span>
                        </p>
                        <p className="text-[11px] font-mono text-blue-600 mb-5">
                            Nr Mag: {bulkPickModal.item.inventoryNumber}
                        </p>
                        <div className="flex items-center gap-3 mb-2">
                            <button
                                onClick={() => setBulkPickModal(p => p && p.qty > 1 ? { ...p, qty: p.qty - 1 } : p)}
                                className="w-12 h-12 rounded-xl bg-slate-100 hover:bg-slate-200 text-2xl font-black text-slate-700 transition flex items-center justify-center"
                            >−</button>
                            <input
                                type="number" min="1" max={bulkPickModal.item.availableQuantity}
                                value={bulkPickModal.qty}
                                onChange={e => setBulkPickModal(p => p ? { ...p, qty: Math.max(1, Math.min(Number(e.target.value), p.item.availableQuantity)) } : p)}
                                className="flex-1 text-center text-2xl font-black p-2 border-2 rounded-xl outline-none focus:border-green-500"
                            />
                            <button
                                onClick={() => setBulkPickModal(p => p && p.qty < p.item.availableQuantity ? { ...p, qty: p.qty + 1 } : p)}
                                className="w-12 h-12 rounded-xl bg-slate-100 hover:bg-slate-200 text-2xl font-black text-slate-700 transition flex items-center justify-center"
                            >+</button>
                        </div>
                        <p className="text-[11px] text-slate-400 text-center mb-6">
                            Dostępne na magazynie: <span className="font-bold text-slate-600">{bulkPickModal.item.availableQuantity} {bulkPickModal.item.unit || "szt."}</span>
                        </p>
                        <div className="flex gap-3">
                            <button
                                onClick={() => setBulkPickModal(null)}
                                className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition"
                            >Anuluj</button>
                            <button
                                onClick={confirmBulkAdd}
                                className="flex-1 py-3 bg-green-600 text-white font-black rounded-xl hover:bg-green-700 shadow-md transition"
                            >Dodaj do koszyka</button>
                        </div>
                    </div>
                </div>
            )}

            {/* MINI-MODAL: Wpis ręczny (Wydania) */}
            {isManualModalOpen && (
                <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-fade-in">
                        <h3 className="text-lg font-black text-orange-600 mb-4 flex items-center gap-2">
                            <span>📝</span> Wpis ręczny (poza bazą)
                        </h3>
                        <div className="space-y-4 mb-6">
                            <div>
                                <label className="block text-[11px] font-black text-slate-400 uppercase mb-1">Nazwa przedmiotu / materiału</label>
                                <input type="text" value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="np. Drut wiązałkowy fi 1.2" className="w-full p-3 border-2 rounded-xl outline-none focus:border-orange-500 font-bold" />
                            </div>
                            <div className="flex gap-3">
                                <div className="flex-1">
                                    <label className="block text-[11px] font-black text-slate-400 uppercase mb-1">Ilość</label>
                                    <input type="number" min="0.01" step="any" value={manualQty} onChange={(e) => setManualQty(e.target.value === "" ? "" : Number(e.target.value))} placeholder="0" className="w-full p-3 border-2 rounded-xl outline-none focus:border-orange-500 font-bold text-center" />
                                </div>
                                <div className="w-[45%]">
                                    <label className="block text-[11px] font-black text-slate-400 uppercase mb-1">Jednostka</label>
                                    <select value={manualUnit} onChange={(e) => setManualUnit(e.target.value)} className="w-full p-3 border-2 rounded-xl outline-none focus:border-orange-500 font-bold bg-white text-center cursor-pointer">
                                        <option value="szt.">szt.</option><option value="kg">kg</option><option value="mb">mb</option><option value="m²">m²</option><option value="m³">m³</option><option value="kpl.">kpl.</option><option value="opak.">opak.</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <button onClick={() => setIsManualModalOpen(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition">Anuluj</button>
                            <button onClick={confirmManualAdd} className="flex-1 py-3 bg-orange-500 text-white font-black rounded-xl hover:bg-orange-600 shadow-md transition">Zatwierdź</button>
                        </div>
                    </div>
                </div>
            )}

            {/* MODAL 2: ZGŁOSZENIE ZWROTU APLIKACYJNEGO */}
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
                                    <div className="mt-4 flex gap-2 bg-blue-100/50 p-1 rounded-xl w-fit border border-blue-200">
                                        <button onClick={() => setReturnActiveTab("UNIQUE")} className={`px-4 py-2 rounded-lg text-xs font-black transition-all ${returnActiveTab === 'UNIQUE' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500'}`}>NARZĘDZIA</button>
                                        <button onClick={() => setReturnActiveTab("BULK")} className={`px-4 py-2 rounded-lg text-xs font-black transition-all ${returnActiveTab === 'BULK' ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-500'}`}>RUSZTOWANIA</button>
                                        <button onClick={() => setReturnActiveTab("MANUAL")} className={`px-4 py-2 rounded-lg text-xs font-black transition-all ${returnActiveTab === 'MANUAL' ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-500'}`}>INNE (WPIS RĘCZNY)</button>
                                    </div>
                                </div>
                                <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-slate-50">
                                    {!returnSiteId ? (
                                        <div className="text-center p-10 text-slate-400">Wybierz budowę z listy powyżej.</div>
                                    ) : filteredReturnInventory.length === 0 ? (
                                        <div className="text-center p-10 text-slate-400">Brak dostępnego sprzętu w tej kategorii (lub cały jest już zgłoszony i oczekuje na magazynie).</div>
                                    ) : filteredReturnInventory.map(item => (
                                        <div key={item.id} className="flex justify-between items-center p-3 border rounded-xl bg-white hover:border-blue-300 transition shadow-sm">
                                            <div>
                                                <p className="font-bold text-sm text-slate-800">{item.name}</p>
                                                <p className="text-[11px] font-mono text-slate-500">
                                                    Nr Mag: {item.inventoryNumber || "-"} | Na budowie (Dostępne): <b className="text-blue-600">{item.availableToReturn}</b> {item.unit || "szt."}
                                                </p>
                                            </div>
                                            <button onClick={() => addToReturnCart(item)} className="bg-slate-100 hover:bg-blue-600 hover:text-white text-blue-600 w-10 h-10 rounded-lg font-black text-xl transition">+</button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="w-[50%] flex flex-col bg-white">
                                <div className="p-6 border-b bg-white flex justify-between items-center">
                                    <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest">2. Koszyk Zwrotu</label>
                                    <button onClick={() => { setManualName(""); setManualQty(""); setIsReturnManualModalOpen(true); }} className="bg-blue-50 hover:bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg text-xs font-bold transition shadow-sm border border-blue-200">
                                        + Dodaj z palca (Wpis Ręczny)
                                    </button>
                                </div>
                                <div className="flex-1 p-6 overflow-y-auto">
                                    {returnCart.length === 0 ? (
                                        <div className="text-center p-10 text-slate-400 border-2 border-dashed rounded-xl">Wybierz przedmioty z lewej strony lub dodaj ręcznie</div>
                                    ) : (
                                        <div className="space-y-3">
                                            {returnCart.map(cItem => (
                                                <div key={cItem.dbId} className={`p-4 border rounded-xl shadow-sm ${cItem.isManual ? 'bg-blue-50 border-blue-200' : 'bg-slate-50'}`}>
                                                    <div className="flex items-start justify-between gap-4 mb-2">
                                                        <div className="flex-1">
                                                            <p className="font-bold text-sm text-slate-800">
                                                                {cItem.name}
                                                                {cItem.isManual && <span className="ml-2 text-[9px] bg-blue-200 text-blue-800 px-2 rounded uppercase border border-blue-300">Ręczny</span>}
                                                            </p>
                                                            {!cItem.isManual && <p className="text-[10px] text-slate-500 font-mono mb-2">Nr Mag: {cItem.inventoryNumber || "-"}</p>}
                                                            {cItem.type === "UNIQUE" && (
                                                                <select value={cItem.declaredStatus} onChange={(e) => setReturnCart(returnCart.map(i => i.dbId === cItem.dbId ? { ...i, declaredStatus: e.target.value } : i))} className="text-xs p-1 border rounded bg-white text-slate-700 outline-none">
                                                                    <option value="sprawne">✅ Sprawne</option>
                                                                    <option value="do przeglądu">⚠️ Do przeglądu</option>
                                                                    <option value="uszkodzone">❌ Uszkodzone</option>
                                                                </select>
                                                            )}
                                                        </div>
                                                        <div className="flex items-center gap-3">
                                                            {cItem.type === "BULK" || cItem.isManual ? (
                                                                <div className="flex items-center gap-1">
                                                                    <input type="number" min="0.01" step="any" max={cItem.isManual ? undefined : cItem.maxQty} value={cItem.returnQty} onChange={(e) => setReturnCart(returnCart.map(i => i.dbId === cItem.dbId ? { ...i, returnQty: Number(e.target.value) } : i))} className="w-16 p-2 border rounded-lg text-center font-bold outline-none" />
                                                                    <span className="text-[10px] text-slate-500 font-bold">{cItem.unit || "szt."}</span>
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
                                                                    <input type="checkbox" checked={acc.isReturning} onChange={(e) => {
                                                                        const newCart = [...returnCart];
                                                                        const targetItem = newCart.find(i => i.dbId === cItem.dbId);
                                                                        if (targetItem) targetItem.accessories[idx].isReturning = e.target.checked;
                                                                        setReturnCart(newCart);
                                                                    }} className="w-4 h-4" />
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

            {/* MINI-MODAL: Wpis ręczny dla protokołu zwrotu (Aplikacyjnego) */}
            {isReturnManualModalOpen && (
                <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-fade-in border border-blue-300">
                        <h3 className="text-lg font-black text-blue-700 mb-4 flex items-center gap-2"><span>📝</span> Dodaj wpis z palca</h3>
                        <div className="space-y-4 mb-6">
                            <div>
                                <label className="block text-[11px] font-black text-slate-400 uppercase mb-1">Nazwa</label>
                                <input type="text" value={manualName} onChange={(e) => setManualName(e.target.value)} className="w-full p-3 border-2 rounded-xl outline-none focus:border-blue-500 font-bold" />
                            </div>
                            <div className="flex gap-3">
                                <div className="flex-1">
                                    <label className="block text-[11px] font-black text-slate-400 uppercase mb-1">Zwracana Ilość</label>
                                    <input type="number" min="0.01" step="any" value={manualQty} onChange={(e) => setManualQty(e.target.value === "" ? "" : Number(e.target.value))} className="w-full p-3 border-2 rounded-xl outline-none focus:border-blue-500 font-bold text-center" />
                                </div>
                                <div className="w-[45%]">
                                    <label className="block text-[11px] font-black text-slate-400 uppercase mb-1">Jednostka</label>
                                    <select value={manualUnit} onChange={(e) => setManualUnit(e.target.value)} className="w-full p-3 border-2 rounded-xl outline-none focus:border-blue-500 font-bold bg-white text-center cursor-pointer">
                                        <option value="szt.">szt.</option><option value="kg">kg</option><option value="mb">mb</option><option value="m²">m²</option><option value="m³">m³</option><option value="kpl.">kpl.</option><option value="opak.">opak.</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <button onClick={() => setIsReturnManualModalOpen(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition">Anuluj</button>
                            <button onClick={confirmReturnManualAdd} className="flex-1 py-3 bg-blue-600 text-white font-black rounded-xl hover:bg-blue-700 shadow-md transition">Dodaj</button>
                        </div>
                    </div>
                </div>
            )}

            {/* MODAL: WPROWADŹ ZWROT Z PAPIERU */}
            {isPaperReturnModalOpen && (
                <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-3xl shadow-2xl w-[95vw] h-[90vh] flex flex-col overflow-hidden animate-fade-in border border-orange-200">
                        <div className="p-6 bg-orange-50 border-b border-orange-200 flex justify-between items-center">
                            <div>
                                <h2 className="text-2xl font-black text-orange-700">Wprowadź Zwrot (Z papieru)</h2>
                                <p className="text-sm text-orange-600">Przepisz fizyczny dokument. Protokół od razu zostanie zaakceptowany i sprzęt wróci na magazyn.</p>
                            </div>
                            <button onClick={closeModal} className="text-4xl text-orange-400 hover:text-orange-800 leading-none">&times;</button>
                        </div>
                        <div className="flex-1 flex overflow-hidden">
                            {/* LEWA STRONA - BUDA I INWENTARZ */}
                            <div className="w-[45%] border-r flex flex-col bg-white">
                                <div className="p-6 border-b bg-orange-50/50">
                                    <label className="block text-[11px] font-black text-orange-800 uppercase tracking-widest mb-2">1. Wybierz Budowę</label>
                                    <select value={paperReturnSiteId} onChange={(e) => { setPaperReturnSiteId(e.target.value); setPaperReturnCart([]); }} className="w-full p-4 border-2 border-orange-200 rounded-xl outline-none focus:border-orange-500 font-bold bg-white mb-4">
                                        <option value="" disabled>-- Wybierz budowę --</option>
                                        {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                    </select>
                                    <div className="flex gap-2 bg-orange-100/50 p-1 rounded-xl w-fit border border-orange-200">
                                        <button onClick={() => setPaperReturnActiveTab("UNIQUE")} className={`px-4 py-2 rounded-lg text-xs font-black transition-all ${paperReturnActiveTab === 'UNIQUE' ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-500'}`}>NARZĘDZIA</button>
                                        <button onClick={() => setPaperReturnActiveTab("BULK")} className={`px-4 py-2 rounded-lg text-xs font-black transition-all ${paperReturnActiveTab === 'BULK' ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-500'}`}>RUSZTOWANIA</button>
                                        <button onClick={() => setPaperReturnActiveTab("MANUAL")} className={`px-4 py-2 rounded-lg text-xs font-black transition-all ${paperReturnActiveTab === 'MANUAL' ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-500'}`}>WPISY RĘCZNE</button>
                                    </div>
                                </div>
                                <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-slate-50">
                                    {!paperReturnSiteId ? (
                                        <div className="text-center p-10 text-slate-400">Wybierz budowę, by zobaczyć co na niej jest.</div>
                                    ) : filteredPaperInventory.length === 0 ? (
                                        <div className="text-center p-10 text-slate-400">Brak sprzętu w tej kategorii na wybranej budowie (lub cały oczekuje na weryfikację).</div>
                                    ) : (
                                        filteredPaperInventory.map(item => (
                                            <div key={item.id} className="flex justify-between items-center p-3 border rounded-xl bg-white shadow-sm hover:border-orange-300">
                                                <div>
                                                    <p className="font-bold text-sm text-slate-800">{item.name}</p>
                                                    <p className="text-[11px] font-mono text-slate-500">
                                                        Nr Mag: {item.inventoryNumber || "-"} | Na budowie (Dostępne): <b className="text-orange-600">{item.availableToReturn}</b> {item.unit || "szt."}
                                                    </p>
                                                </div>
                                                <button onClick={() => addToPaperReturnCart(item)} className="bg-orange-100 hover:bg-orange-500 text-orange-700 hover:text-white px-3 py-1.5 rounded-lg text-xs font-bold transition">Dodaj do zwrotu</button>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>

                            {/* PRAWA STRONA - KOSZYK I AKCEPTACJA */}
                            <div className="w-[55%] flex flex-col bg-white">
                                <div className="p-6 border-b bg-white flex gap-4 items-center">
                                    <div className="flex-1">
                                        <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-1">Nr dokumentu papierowego (Opcjonalnie)</label>
                                        <input type="text" placeholder="np. WZ 12/05/2026" value={paperDocReference} onChange={e => setPaperDocReference(e.target.value)} className="w-full p-3 border rounded-xl outline-none focus:ring-2 focus:ring-orange-500 font-bold bg-slate-50" />
                                    </div>
                                    <button onClick={() => { setManualName(""); setManualQty(""); setIsPaperManualModalOpen(true); }} className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-3 rounded-xl text-xs font-bold transition shadow-sm h-fit self-end border border-slate-200 whitespace-nowrap">
                                        + Dodaj z palca (Poza listą)
                                    </button>
                                </div>
                                <div className="flex-1 overflow-y-auto p-6 bg-slate-50 space-y-3">
                                    {paperReturnCart.length === 0 ? (
                                        <div className="text-center p-10 text-slate-400 border-2 border-dashed rounded-xl">Wybierz pozycje z lewej strony lub dodaj ręcznie.</div>
                                    ) : (
                                        paperReturnCart.map(cItem => (
                                            <div key={cItem.cartItemId} className={`p-4 border rounded-xl shadow-sm bg-white ${cItem.isManual ? 'border-dashed border-orange-300' : 'border-slate-200'}`}>
                                                <div className="flex justify-between items-start mb-3">
                                                    <div>
                                                        <p className="font-bold text-slate-800">
                                                            {cItem.name}
                                                            {cItem.isManual && <span className="ml-2 text-[9px] bg-orange-100 text-orange-800 px-2 rounded uppercase border border-orange-200">Ręczny</span>}
                                                        </p>
                                                        {!cItem.isManual && <p className="text-[10px] font-mono text-slate-500">Nr Mag: {cItem.inventoryNumber || "-"} | Max do zwrotu: {cItem.maxQty} {cItem.unit}</p>}
                                                    </div>
                                                    <button onClick={() => removePaperReturnItem(cItem.cartItemId)} className="text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 px-2 py-1 rounded text-xs font-bold">&times; Usuń</button>
                                                </div>
                                                <div className="flex flex-wrap gap-4 items-center bg-slate-50 p-2 rounded border border-slate-100">
                                                    {cItem.type === "BULK" || cItem.isManual ? (
                                                        <div className="flex items-center gap-2">
                                                            <label className="text-xs text-slate-600 font-bold">Zwrócono:</label>
                                                            <input type="number" min="0.01" step="any" max={cItem.isManual ? undefined : cItem.maxQty} value={cItem.receivedQty} onChange={e => updatePaperReturnItem(cItem.cartItemId, 'receivedQty', Number(e.target.value))} className="w-20 p-1.5 border rounded text-center font-bold outline-none bg-white" />
                                                            <span className="text-[10px] font-bold text-slate-500">{cItem.unit}</span>
                                                        </div>
                                                    ) : (
                                                        <div className="flex items-center gap-2">
                                                            <label className="text-xs text-slate-600 font-bold">Stan po zwrocie:</label>
                                                            <select value={cItem.finalStatus} onChange={e => updatePaperReturnItem(cItem.cartItemId, 'finalStatus', e.target.value)} className="p-1.5 border rounded text-xs font-bold outline-none bg-white">
                                                                <option value="sprawne">✅ Sprawne</option>
                                                                <option value="do przeglądu">⚠️ Do przeglądu</option>
                                                                <option value="uszkodzone">❌ Uszkodzone</option>
                                                            </select>
                                                        </div>
                                                    )}
                                                    <input type="text" placeholder="Notatka magazyniera..." value={cItem.notes} onChange={e => updatePaperReturnItem(cItem.cartItemId, 'notes', e.target.value)} className="flex-1 text-xs p-1.5 border rounded bg-white outline-none min-w-[150px]" />
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                                <div className="p-6 border-t bg-white flex gap-4">
                                    <button onClick={closeModal} className="w-1/3 py-4 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl border border-slate-200">ANULUJ</button>
                                    <button onClick={handlePaperReturnSubmit} disabled={isSubmitting || paperReturnCart.length === 0} className="w-2/3 py-4 bg-orange-500 hover:bg-orange-600 text-white font-black rounded-xl shadow-xl disabled:bg-slate-300 transition">ZATWIERDŹ ZWROT PAPIEROWY</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* MINI-MODAL: Wpis ręczny dla protokołu papierowego */}
            {isPaperManualModalOpen && (
                <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-fade-in border border-orange-300">
                        <h3 className="text-lg font-black text-orange-700 mb-4 flex items-center gap-2"><span>📝</span> Dodaj wpis z palca</h3>
                        <div className="space-y-4 mb-6">
                            <div>
                                <label className="block text-[11px] font-black text-slate-400 uppercase mb-1">Nazwa</label>
                                <input type="text" value={manualName} onChange={(e) => setManualName(e.target.value)} className="w-full p-3 border-2 rounded-xl outline-none focus:border-orange-500 font-bold" />
                            </div>
                            <div className="flex gap-3">
                                <div className="flex-1">
                                    <label className="block text-[11px] font-black text-slate-400 uppercase mb-1">Przyjęta Ilość</label>
                                    <input type="number" min="0.01" step="any" value={manualQty} onChange={(e) => setManualQty(e.target.value === "" ? "" : Number(e.target.value))} className="w-full p-3 border-2 rounded-xl outline-none focus:border-orange-500 font-bold text-center" />
                                </div>
                                <div className="w-[45%]">
                                    <label className="block text-[11px] font-black text-slate-400 uppercase mb-1">Jednostka</label>
                                    <select value={manualUnit} onChange={(e) => setManualUnit(e.target.value)} className="w-full p-3 border-2 rounded-xl outline-none focus:border-orange-500 font-bold bg-white text-center cursor-pointer">
                                        <option value="szt.">szt.</option><option value="kg">kg</option><option value="mb">mb</option><option value="m²">m²</option><option value="m³">m³</option><option value="kpl.">kpl.</option><option value="opak.">opak.</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <button onClick={() => setIsPaperManualModalOpen(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition">Anuluj</button>
                            <button onClick={confirmPaperManualAdd} className="flex-1 py-3 bg-orange-500 text-white font-black rounded-xl hover:bg-orange-600 shadow-md transition">Dodaj</button>
                        </div>
                    </div>
                </div>
            )}


            {/* MODAL 3: AKCEPTACJA ZWROTU APLIKACYJNEGO */}
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
                                            <div className="space-y-4 mb-8">
                                                {selectedProtocol.items.map((item: any) => {
                                                    const inputState = acceptInputs[item.inventoryId] || { receivedQty: item.declaredQty, finalStatus: item.declaredStatus || "sprawne", notes: "", createClaim: false, verifiedAccessories: {} };
                                                    const isQtyDifferent = item.type === "BULK" && inputState.receivedQty !== item.declaredQty;
                                                    const isStatusDifferent = item.type === "UNIQUE" && inputState.finalStatus !== item.declaredStatus;

                                                    // Wyszukujemy max dozwoloną ilość dla BULK (żeby zabezpieczyć przed pomyłką)
                                                    const invItem = inventory.find(inv => inv.id === item.inventoryId);
                                                    let maxAllowed = 999999;
                                                    if (!item.isNewManual && invItem && invItem.type === "BULK") {
                                                        maxAllowed = invItem.allocations?.[selectedProtocol.sourceId] || 0;
                                                    }

                                                    return (
                                                        <div key={item.inventoryId} className={`p-4 border rounded-xl shadow-sm relative ${isQtyDifferent || isStatusDifferent ? 'bg-orange-50 border-orange-300' : 'bg-slate-50'}`}>

                                                            <div className="flex items-start justify-between mb-3">
                                                                <div>
                                                                    <p className="font-bold text-slate-800 pr-20">
                                                                        {item.name}
                                                                        {item.isNewManual && <span className="ml-2 text-[9px] bg-orange-200 text-orange-800 px-2 rounded uppercase">Dopisany Ręczny</span>}
                                                                        {item.declaredQty === 0 && !item.isNewManual && <span className="ml-2 text-[9px] bg-purple-200 text-purple-800 px-2 rounded uppercase">ZAPOMNIANY (Z BUDOWY)</span>}
                                                                    </p>
                                                                    <p className="text-[10px] font-mono text-slate-500">Nr Mag: {item.inventoryNumber || "BRAK"}</p>
                                                                </div>

                                                                <div className="flex flex-col items-end gap-1">
                                                                    <button
                                                                        onClick={() => removeItemFromAcceptProtocol(item.inventoryId)}
                                                                        className="bg-red-50 hover:bg-red-500 text-red-500 hover:text-white border border-red-200 hover:border-red-500 rounded px-2 py-0.5 text-[10px] font-bold uppercase transition-colors"
                                                                        title="Usuń tę pozycję z protokołu"
                                                                    >
                                                                        &times; Usuń
                                                                    </button>
                                                                    <div className="text-right mt-1">
                                                                        <p className="text-[10px] text-slate-500 uppercase">Kierownik Zgłosił:</p>
                                                                        {item.type === "BULK" ? (
                                                                            <p className={`font-black ${item.declaredQty === 0 ? 'text-purple-600' : 'text-slate-700'}`}>{item.declaredQty} {item.unit || "szt."}</p>
                                                                        ) : (
                                                                            <p className={`font-bold text-sm ${item.declaredQty === 0 ? 'text-purple-600' : ''}`}>Status: {item.declaredStatus || "Brak"}</p>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>

                                                            <div className="bg-white p-3 rounded border border-slate-200 flex flex-wrap gap-4 items-center">
                                                                <div className="text-xs font-bold text-purple-800 uppercase w-full mb-1">Weryfikacja Magazynu:</div>

                                                                {item.type === "BULK" && (
                                                                    <div className="flex flex-col gap-1">
                                                                        <div className="flex items-center gap-2">
                                                                            <label className="text-xs text-slate-600">Przyjęto:</label>
                                                                            <input
                                                                                type="number" min="0" step="any" max={maxAllowed}
                                                                                value={inputState.receivedQty}
                                                                                onChange={(e) => {
                                                                                    let val = Number(e.target.value);
                                                                                    if (val > maxAllowed) val = maxAllowed;
                                                                                    if (val < 0) val = 0;
                                                                                    setAcceptInputs({ ...acceptInputs, [item.inventoryId]: { ...inputState, receivedQty: val } });
                                                                                }}
                                                                                className={`w-20 p-1.5 border rounded text-center font-bold outline-none ${isQtyDifferent ? 'bg-orange-100 text-orange-900 border-orange-400' : 'bg-slate-50'}`}
                                                                            />
                                                                            <span className="text-[10px] font-bold text-slate-500">{item.unit || "szt."}</span>
                                                                        </div>
                                                                        {!item.isNewManual && (
                                                                            <span className="text-[9px] text-slate-400 block ml-14">Max na budowie: {maxAllowed} {item.unit || "szt."}</span>
                                                                        )}
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
                                                                        {inputState.finalStatus === "uszkodzone" && (
                                                                            <label className="flex items-center gap-2 p-2 bg-red-50 border border-red-200 rounded cursor-pointer mt-1 animate-fade-in">
                                                                                <input type="checkbox" checked={inputState.createClaim || false} onChange={(e) => setAcceptInputs({ ...acceptInputs, [item.inventoryId]: { ...inputState, createClaim: e.target.checked } })} className="w-4 h-4 text-red-600 rounded border-red-300 focus:ring-red-500" />
                                                                                <span className="text-xs font-bold text-red-800">⚖️ Zgłoś od razu do Centrum Likwidacji Szkód</span>
                                                                            </label>
                                                                        )}
                                                                    </div>
                                                                )}

                                                                <div className="flex-1 min-w-[200px]">
                                                                    <input type="text" placeholder="Notatka magazyniera (np. brak wtyczki)..." value={inputState.notes} onChange={(e) => setAcceptInputs({ ...acceptInputs, [item.inventoryId]: { ...inputState, notes: e.target.value } })} className="w-full text-xs p-1.5 border rounded bg-slate-50 outline-none" />
                                                                </div>
                                                            </div>

                                                            {item.accessories && item.accessories.length > 0 && (
                                                                <div className="mt-3 p-3 bg-orange-50 border border-orange-200 rounded text-xs">
                                                                    <p className="font-bold text-orange-800 mb-2">Fizyczna weryfikacja osprzętu z wydania:</p>
                                                                    <div className="space-y-1">
                                                                        {item.accessories.map((acc: any, i: number) => (
                                                                            <label key={i} className="flex items-center gap-2 cursor-pointer p-1 hover:bg-orange-100 rounded transition">
                                                                                <input type="checkbox" checked={inputState.verifiedAccessories[i] !== undefined ? inputState.verifiedAccessories[i] : acc.isReturning} onChange={(e) => { const newVerified = { ...inputState.verifiedAccessories, [i]: e.target.checked }; setAcceptInputs({ ...acceptInputs, [item.inventoryId]: { ...inputState, verifiedAccessories: newVerified } }); }} className="w-4 h-4 text-purple-600 rounded border-slate-300 focus:ring-purple-500" />
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
                                                    );
                                                })}
                                            </div>

                                            {/* ZDJĘCIA i DODAWANIE DODATKOWYCH SPRZĘTÓW */}
                                            <div className="flex gap-4">
                                                {/* Lewa strona: ZDJĘCIA */}
                                                <div className="flex-1 bg-slate-50 border border-slate-200 p-4 rounded-xl">
                                                    <h4 className="text-xs font-bold text-slate-800 mb-2 uppercase tracking-wider">📸 Zdjęcia do protokołu (Opcjonalnie)</h4>
                                                    <input type="file" multiple accept="image/*" onChange={handlePhotoSelect} className="block w-full text-xs text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-purple-100 file:text-purple-700 hover:file:bg-purple-200 cursor-pointer mb-3" />
                                                    {returnPhotos.length > 0 && (
                                                        <div className="flex gap-2 flex-wrap">
                                                            {returnPhotos.map((photo, index) => (
                                                                <div key={index} className="relative w-16 h-16 rounded border bg-white shadow-sm overflow-hidden flex items-center justify-center">
                                                                    <img src={URL.createObjectURL(photo)} alt="preview" className="object-cover w-full h-full" />
                                                                    <button onClick={() => removePhoto(index)} className="absolute top-1 right-1 bg-red-500 text-white w-4 h-4 rounded-full text-[10px] font-bold leading-none">&times;</button>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>

                                                {/* Prawa strona: BRAKI */}
                                                <div className="flex-1 bg-purple-50 border-2 border-dashed border-purple-200 p-4 rounded-xl flex flex-col justify-center">
                                                    <h4 className="text-xs font-bold text-purple-800 mb-3 uppercase tracking-wider text-center">Zapomniał czegoś zgłosić?</h4>
                                                    <div className="flex flex-col gap-2">
                                                        <button onClick={() => setIsAddFromSiteOpen(true)} className="py-2 px-4 bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold rounded-lg transition shadow-sm w-full">
                                                            + Dodaj to z zapasów {selectedProtocol.sourceName}
                                                        </button>
                                                        <button onClick={openAddManualToAccept} className="py-2 px-4 bg-purple-100 hover:bg-purple-200 text-purple-800 text-xs font-bold rounded-lg transition border border-purple-300 w-full">
                                                            + Dodaj nowy wpis ręczny
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>

                                        </div>

                                        <div className="p-6 border-t bg-slate-50 flex gap-4 items-center">
                                            <p className="text-[10px] text-slate-400 flex-1 leading-tight">Zatwierdzenie zdejmie sprzęt z budowy i przywróci na magazyn. Sprzęty zapomniane (dodane ręcznie w tym oknie) będą odnotowane jako oddane "ponad stan".</p>
                                            <button onClick={() => handleAcceptSubmit(false)} disabled={isSubmitting} className="px-8 py-3 bg-purple-600 hover:bg-purple-700 text-white font-black rounded-xl shadow-xl disabled:bg-slate-300">
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

            {/* SUB-MODAL WEWNĄTRZ AKCEPTACJI ZWROTÓW (Wybór z budowy) */}
            {isAddFromSiteOpen && (
                <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden animate-fade-in flex flex-col max-h-[80vh]">
                        <div className="p-5 bg-purple-50 border-b flex justify-between items-center">
                            <div><h3 className="text-lg font-black text-purple-900">Sprzęt fizycznie na budowie</h3><p className="text-xs text-purple-700">Wybierz to, co przyjechało niespodziewanie.</p></div>
                            <button onClick={() => setIsAddFromSiteOpen(false)} className="text-2xl text-slate-400 hover:text-slate-900 leading-none">&times;</button>
                        </div>
                        <div className="p-4 bg-white border-b flex justify-center">
                            <div className="flex gap-2 bg-purple-100/50 p-1 rounded-xl w-fit border border-purple-200">
                                <button onClick={() => setAcceptSiteTab("UNIQUE")} className={`px-4 py-2 rounded-lg text-xs font-black transition-all ${acceptSiteTab === 'UNIQUE' ? 'bg-white text-purple-600 shadow-sm' : 'text-slate-500'}`}>NARZĘDZIA</button>
                                <button onClick={() => setAcceptSiteTab("BULK")} className={`px-4 py-2 rounded-lg text-xs font-black transition-all ${acceptSiteTab === 'BULK' ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-500'}`}>RUSZTOWANIA</button>
                                <button onClick={() => setAcceptSiteTab("MANUAL")} className={`px-4 py-2 rounded-lg text-xs font-black transition-all ${acceptSiteTab === 'MANUAL' ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-500'}`}>WPISY RĘCZNE</button>
                            </div>
                        </div>
                        <div className="p-4 overflow-y-auto flex-1 space-y-2 bg-slate-50">
                            {filteredAcceptAddInventory.length === 0 ? (
                                <div className="text-center p-10 text-slate-400 text-sm">Brak innych sprzętów w tej kategorii przypisanych do tej budowy.</div>
                            ) : (
                                filteredAcceptAddInventory.map(item => (
                                    <div key={item.id} className="flex justify-between items-center p-3 border rounded-xl bg-white shadow-sm hover:border-purple-300">
                                        <div>
                                            <p className="font-bold text-sm text-slate-800">{item.name}</p>
                                            <p className="text-[11px] font-mono text-slate-500">Na budowie: <b className="text-purple-600">{item.allocations[selectedProtocol.sourceId]}</b> {item.unit || "szt."}</p>
                                        </div>
                                        <button onClick={() => addItemToAcceptProtocol(item)} className="bg-purple-100 hover:bg-purple-600 text-purple-600 hover:text-white px-3 py-1.5 rounded-lg text-xs font-bold transition">Dodaj</button>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* SUB-MODAL WEWNĄTRZ AKCEPTACJI ZWROTÓW (Wpis całkowicie ręczny) */}
            {isAddManualToAcceptOpen && (
                <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-fade-in">
                        <h3 className="text-lg font-black text-purple-700 mb-4 flex items-center gap-2"><span>📝</span> Dodaj nowy wpis z palca</h3>
                        <div className="space-y-4 mb-6">
                            <div>
                                <label className="block text-[11px] font-black text-slate-400 uppercase mb-1">Nazwa przedmiotu / materiału</label>
                                <input type="text" value={manualName} onChange={(e) => setManualName(e.target.value)} className="w-full p-3 border-2 rounded-xl outline-none focus:border-purple-500 font-bold" />
                            </div>
                            <div className="flex gap-3">
                                <div className="flex-1">
                                    <label className="block text-[11px] font-black text-slate-400 uppercase mb-1">Przyjęta Ilość</label>
                                    <input type="number" min="0.01" step="any" value={manualQty} onChange={(e) => setManualQty(e.target.value === "" ? "" : Number(e.target.value))} className="w-full p-3 border-2 rounded-xl outline-none focus:border-purple-500 font-bold text-center" />
                                </div>
                                <div className="w-[45%]">
                                    <label className="block text-[11px] font-black text-slate-400 uppercase mb-1">Jednostka</label>
                                    <select value={manualUnit} onChange={(e) => setManualUnit(e.target.value)} className="w-full p-3 border-2 rounded-xl outline-none focus:border-purple-500 font-bold bg-white text-center cursor-pointer">
                                        <option value="szt.">szt.</option><option value="kg">kg</option><option value="mb">mb</option><option value="m²">m²</option><option value="m³">m³</option><option value="kpl.">kpl.</option><option value="opak.">opak.</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <button onClick={() => setIsAddManualToAcceptOpen(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition">Anuluj</button>
                            <button onClick={confirmAddManualToAccept} className="flex-1 py-3 bg-purple-600 text-white font-black rounded-xl hover:bg-purple-700 shadow-md transition">Zatwierdź wpis</button>
                        </div>
                    </div>
                </div>
            )}

            {investigationData && (
                <ClaimInvestigationModal
                    isOpen={!!investigationData}
                    onClose={() => { setAcceptInputs(prev => ({ ...prev, [investigationData.inventoryId]: { ...prev[investigationData.inventoryId], createClaim: false } })); setInvestigationData(null); }}
                    onClaimCreated={(_claimId, _docId) => { setInvestigationData(null); setInvestigationDone(true); setTimeout(() => handleAcceptSubmit(true), 100); }}
                    inventoryId={investigationData.inventoryId} inventoryName={investigationData.inventoryName} inventoryNumber={investigationData.inventoryNumber}
                    siteName={investigationData.siteName} reportedByUid={user?.uid || ""} reportedByName={`${user?.firstName} ${user?.lastName}`}
                    warehouseNotes={investigationData.warehouseNotes} declaredStatus={investigationData.declaredStatus}
                />
            )}
        </div>
    );
}