"use client";

import React, { useState, useEffect } from "react";
import { collection, getDocs, doc, setDoc, query, where, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";

interface Site { id: string; name: string; status?: string; location?: string; }
interface InventoryItem {
    id: string; name: string; type: string; subType?: string;
    category: string; inventoryNumber: string; allocations: Record<string, number>;
    status: string; unit?: string; failureDescription?: string;
}
interface Claim { id: string; siteId: string; inventoryName: string; status: string; penaltyAmount?: number; }
interface Protocol { id: string; protocolId: string; type: string; createdAt: string; createdByName?: string; items?: any[]; }
interface UserAccount { uid: string; firstName: string; lastName: string; email: string; assignedSites: string[]; }
interface SiteDamage {
    id: string;
    siteId: string;
    inventoryName: string;
    inventoryNumber?: string;
    quantity: number;
    unit?: string;
    description: string;
    reportedByName?: string;
    reportedAt?: string;
}

export type ResolutionType = "LOSS" | "CONSUMED" | "DISPUTED_INVESTOR" | "SCRAPPED" | "EXCLUDED";

interface ManualCloseoutItem {
    id: string;
    name: string;
    quantity: number;
    unit: string;
    inventoryNumber: string;
    resolution: ResolutionType;
    notes: string;
    estimatedUnitCost: number;
}

type TabType = "TOOLS" | "SCAFFOLDING" | "OTHER" | "DAMAGES" | "EXPENSES" | "MANUAL" | "CLAIMS" | "DETECTIVE" | "HISTORY";

export default function ProjectCloseoutsPage() {
    const { user } = useAuth();
    const [viewMode, setViewMode] = useState<"ACTIVE_AUDITS" | "ARCHIVE">("ACTIVE_AUDITS");

    const [sites, setSites] = useState<Site[]>([]);
    const [users, setUsers] = useState<UserAccount[]>([]);
    const [loading, setLoading] = useState(true);

    const [selectedSite, setSelectedSite] = useState<Site | null>(null);
    const [selectedManagerUid, setSelectedManagerUid] = useState("");
    const [activeTab, setActiveTab] = useState<TabType>("TOOLS");
    const [auditLoading, setAuditLoading] = useState(false);

    // Dane audytowe
    const [toolsItems, setToolsItems] = useState<InventoryItem[]>([]);
    const [scaffoldingItems, setScaffoldingItems] = useState<InventoryItem[]>([]);
    const [otherItems, setOtherItems] = useState<InventoryItem[]>([]);
    const [siteDamages, setSiteDamages] = useState<SiteDamage[]>([]);
    const [siteClaims, setSiteClaims] = useState<Claim[]>([]);
    const [suspiciousItems, setSuspiciousItems] = useState<any[]>([]);
    const [siteExpenses, setSiteExpenses] = useState<any[]>([]);
    const [repairCostOverrides, setRepairCostOverrides] = useState<Record<string, number>>({});
    const [siteProtocols, setSiteProtocols] = useState<Protocol[]>([]);

    // Decyzje dyspozycji (LOSS, CONSUMED, DISPUTED_INVESTOR, SCRAPPED, EXCLUDED)
    const [resolutions, setResolutions] = useState<Record<string, ResolutionType>>({});
    // Notatki do poszczególnych pozycji
    const [itemNotes, setItemNotes] = useState<Record<string, string>>({});
    // Ilości (możliwość zmiany z domyślnej alokacji)
    const [itemQuantities, setItemQuantities] = useState<Record<string, number>>({});
    // Wyceny w PLN (z AI lub edycji ręcznej)
    const [itemCosts, setItemCosts] = useState<Record<string, number>>({});
    const [isEstimatingCosts, setIsEstimatingCosts] = useState(false);

    // Pozycje dopisywane "z głowy" / ręcznie
    const [manualItems, setManualItems] = useState<ManualCloseoutItem[]>([]);
    const [isAddManualOpen, setIsAddManualOpen] = useState(false);
    const [newManualName, setNewManualName] = useState("");
    const [newManualQty, setNewManualQty] = useState(1);
    const [newManualUnit, setNewManualUnit] = useState("szt.");
    const [newManualRes, setNewManualRes] = useState<ResolutionType>("LOSS");
    const [newManualNotes, setNewManualNotes] = useState("");
    const [newManualCost, setNewManualCost] = useState(0);

    // Ogólne uwagi audytora
    const [generalNotes, setGeneralNotes] = useState("");
    const [isProcessing, setIsProcessing] = useState(false);

    // Archiwum
    const [archivedCloseouts, setArchivedCloseouts] = useState<any[]>([]);
    const [selectedArchived, setSelectedArchived] = useState<any | null>(null);
    const [archiveSearch, setArchiveSearch] = useState("");
    const [archiveLoading, setArchiveLoading] = useState(false);

    useEffect(() => {
        fetchSitesAndUsers();
    }, []);

    const fetchSitesAndUsers = async () => {
        setLoading(true);
        try {
            const sitesSnap = await getDocs(collection(db, "sites"));
            const allSites = sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[];
            setSites(allSites.filter(s => s.status !== "ZAKOŃCZONA" && s.status !== "W_TRAKCIE_ROZLICZENIA" && s.location !== "Wpis ręczny"));

            const usersSnap = await getDocs(collection(db, "users"));
            const allUsers = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() })) as UserAccount[];
            setUsers(allUsers);
        } catch (error) {
            console.error("Błąd pobierania budów/kierowników:", error);
        } finally {
            setLoading(false);
        }
    };

    const fetchArchive = async () => {
        setArchiveLoading(true);
        try {
            const snap = await getDocs(collection(db, "closeouts"));
            const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            const finalized = all.filter((c: any) => c.status === "ROZLICZONA");
            finalized.sort((a: any, b: any) => (b.directorSignedAt || b.initiatedAt || "").localeCompare(a.directorSignedAt || a.initiatedAt || ""));
            setArchivedCloseouts(finalized);
        } catch (error) {
            console.error("Błąd pobierania archiwum:", error);
        } finally {
            setArchiveLoading(false);
        }
    };

    const runAudit = async (site: Site) => {
        setSelectedSite(site);
        setAuditLoading(true);
        setActiveTab("TOOLS");

        setToolsItems([]);
        setScaffoldingItems([]);
        setOtherItems([]);
        setSiteDamages([]);
        setSiteClaims([]);
        setSuspiciousItems([]);
        setSiteProtocols([]);
        setResolutions({});
        setItemNotes({});
        setItemQuantities({});
        setItemCosts({});
        setManualItems([]);
        setGeneralNotes("");

        // Autopodpowiedź kierownika
        const assignedManager = users.find(u => u.assignedSites?.includes(site.id) || u.assignedSites?.includes("ALL"));
        setSelectedManagerUid(assignedManager ? assignedManager.uid : "");

        try {
            const invSnap = await getDocs(collection(db, "inventory"));
            const allInventory = invSnap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[];
            const activeOnSite = allInventory.filter(item => item.allocations && item.allocations[site.id] > 0);

            setToolsItems(activeOnSite.filter(item => item.type === "UNIQUE"));
            setScaffoldingItems(activeOnSite.filter(item => item.type === "BULK" && item.subType !== "MANUAL" && item.category !== "Zaległości osprzętu"));
            setOtherItems(activeOnSite.filter(item => item.subType === "MANUAL" || item.category === "Zaległości osprzętu" || item.inventoryNumber === "OSPRZĘT"));

            // Domyślne ilości i decyzje
            const defaultQty: Record<string, number> = {};
            const defaultRes: Record<string, ResolutionType> = {};
            activeOnSite.forEach(i => {
                defaultQty[i.id] = i.allocations[site.id] || 1;
                defaultRes[i.id] = "LOSS";
            });
            setItemQuantities(defaultQty);
            setResolutions(defaultRes);

            // Uszkodzenia zgłoszone na budowie w trakcie prac (site_damages)
            try {
                const damagesQ = query(collection(db, "site_damages"), where("siteId", "==", site.id));
                const damagesSnap = await getDocs(damagesQ);
                setSiteDamages(damagesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as SiteDamage[]);
            } catch (err) {
                console.warn("Błąd pobierania site_damages:", err);
            }

            // Drobne wydatki i naprawy bieżące z budowy (site_expenses)
            try {
                const expensesQ = query(collection(db, "site_expenses"), where("siteId", "==", site.id));
                const expensesSnap = await getDocs(expensesQ);
                const expList = expensesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
                expList.sort((a: any, b: any) => (b.date || "").localeCompare(a.date || ""));
                setSiteExpenses(expList);
            } catch (err) {
                console.warn("Błąd pobierania site_expenses:", err);
            }

            // Sprawy sądowe
            const claimsQ = query(collection(db, "claims"), where("siteId", "==", site.id));
            const claimsSnap = await getDocs(claimsQ);
            setSiteClaims(claimsSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Claim[]);

            // Detektyw & Naprawy Serwisowe (w tym sprzęt naprawiony po zwrocie z tej budowy)
            const protoQ = query(collection(db, "protocols"), where("sourceId", "==", site.id), where("type", "==", "ZWROT"));
            const protoSnap = await getDocs(protoQ);
            
            const returnedItemsMap = new Map<string, {
                protocolDate: string;
                protocolId: string;
                declaredStatus?: string;
                finalStatus?: string;
                warehouseNotes?: string;
            }>();

            protoSnap.docs.forEach(doc => {
                const data = doc.data();
                data.items?.forEach((item: any) => {
                    if (item.inventoryId) {
                        returnedItemsMap.set(item.inventoryId, {
                            protocolDate: data.createdAt || "",
                            protocolId: data.protocolId || doc.id,
                            declaredStatus: item.declaredStatus,
                            finalStatus: item.finalStatus,
                            warehouseNotes: item.warehouseNotes
                        });
                    }
                });
            });

            const detectedItems: any[] = [];
            const initialRepairCosts: Record<string, number> = {};

            for (const [invId, returnInfo] of returnedItemsMap.entries()) {
                const invItem = allInventory.find(i => i.id === invId);
                if (!invItem) continue;

                // Sprawdzamy historię tego urządzenia w poszukiwaniu zgłoszeń awarii, serwisu lub napraw
                let historyDocs: any[] = [];
                try {
                    const hSnap = await getDocs(collection(db, "inventory", invId, "history"));
                    if (!hSnap.empty) {
                        historyDocs = hSnap.docs.map(d => d.data());
                    }
                } catch (hErr) {
                    console.warn(`Błąd historii dla ${invId}:`, hErr);
                }

                // Znajdź WYŁĄCZNIE prawdziwe naprawy (nie zwykłe przeglądy BHP):
                // - typ SERWIS/NAPRAWA ORAZ opis zawiera słowo kluczowe naprawy lub kwotę pieniężną
                const serviceEvents = historyDocs.filter(h => {
                    if (h.type !== "SERWIS" && h.type !== "NAPRAWA") return false;
                    const desc = (h.description || "").toLowerCase();
                    // Musi zawierać słowo naprawy lub koszt — samo "wpis serwisowy" / "przegląd" nie wystarczy
                    const isRealRepair = /(naprawa|programator|uszkodz|usterk|wymian|awari|usterka|koszt)/.test(desc);
                    const hasCost = /\d+\s*(?:pln|zł)/.test(desc);
                    return isRealRepair || hasCost;
                });

                // Znajdź ZWROT z tej konkretnej budowy
                const returnFromThisSite = historyDocs.find(h =>
                    h.type === "ZWROT" &&
                    (h.description?.includes(site.name) || h.description?.includes(site.id))
                );
                // Sprzęt wrócił uszkodzony — ZWROT musi zawierać "uszkodzone" lub "do przeglądu"
                const returnedAsDamaged = !!returnFromThisSite && (
                    returnFromThisSite.description?.includes("uszkodzone") ||
                    returnFromThisSite.description?.includes("do przeglądu")
                );

                const isReturnedDamaged = returnInfo.declaredStatus === "uszkodzone" ||
                                          returnInfo.finalStatus === "uszkodzone" ||
                                          returnInfo.declaredStatus === "do przeglądu" ||
                                          returnInfo.finalStatus === "do przeglądu" ||
                                          returnedAsDamaged;

                const isCurrentlyDamaged = invItem.status === "uszkodzone" || invItem.status === "do przeglądu";
                // Liczymy serwis jako powód TYLKO gdy jest prawdziwą naprawą (z kosztem lub słowem kluczowym naprawy)
                const hasRealRepairService = serviceEvents.length > 0;

                // Wchodzimy do Detektywa TYLKO gdy: wrócił uszkodzony, ALBO nadal uszkodzony, ALBO przeszedł realną naprawę
                if (isReturnedDamaged || isCurrentlyDamaged || hasRealRepairService) {
                    let failureText = returnInfo.warehouseNotes || "";
                    let parsedCost = 0;
                    let serviceEventDesc = "";

                    const latestService = serviceEvents.find(h => h.type === "SERWIS" || h.type === "NAPRAWA") || serviceEvents[0];
                    if (latestService) {
                        serviceEventDesc = latestService.description || "";
                    }

                    const allText = `${serviceEventDesc} ${failureText} ${returnInfo.warehouseNotes || ""}`;
                    const costMatch = allText.match(/(?:koszt(?:\s*naprawy)?[:\s]*)?(\d+(?:[.,]\d+)?)\s*(?:pln|zł)/i)
                        || allText.match(/(\d+(?:[.,]\d+)?)\s*(?:pln|zł)/i);
                    if (costMatch) {
                        parsedCost = parseFloat(costMatch[1].replace(",", "."));
                    }

                    if (serviceEventDesc) {
                        failureText = failureText ? `${serviceEventDesc} (Notatka ze zwrotu: ${failureText})` : serviceEventDesc;
                    } else if (!failureText) {
                        // Użyj tekstu z wpisu ZWROT z tej budowy
                        failureText = returnFromThisSite?.description || `Zwrócono z budowy ${site.name} ze statusem: ${returnInfo.finalStatus || returnInfo.declaredStatus || invItem.status}`;
                    }

                    const isRepaired = invItem.status === "sprawne" || (latestService && latestService.status === "sprawne");

                    initialRepairCosts[invItem.id] = parsedCost;

                    detectedItems.push({
                        ...invItem,
                        failureDescription: failureText,
                        repairCost: parsedCost,
                        isRepaired: isRepaired,
                        returnProtocolId: returnInfo.protocolId,
                        returnProtocolDate: returnInfo.protocolDate
                    });
                }
            }

            setSuspiciousItems(detectedItems);
            setRepairCostOverrides(initialRepairCosts);

            // Historia protokołów
            const qIn = query(collection(db, "protocols"), where("destinationId", "==", site.id));
            const qOut = query(collection(db, "protocols"), where("sourceId", "==", site.id));
            const [snapIn, snapOut] = await Promise.all([getDocs(qIn), getDocs(qOut)]);
            const combined = [
                ...snapIn.docs.map(d => ({ id: d.id, ...d.data() })),
                ...snapOut.docs.map(d => ({ id: d.id, ...d.data() }))
            ] as Protocol[];
            combined.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
            setSiteProtocols(combined);

        } catch (error) {
            console.error("Błąd audytu:", error);
        } finally {
            setAuditLoading(false);
        }
    };

    // Wycena orientacyjnych kosztów przez AI dla wszystkich nie-wykluczonych pozycji
    const handleEstimateCostsAI = async () => {
        if (!selectedSite) return;
        setIsEstimatingCosts(true);

        const allItems = [...toolsItems, ...scaffoldingItems, ...otherItems];
        const activeItemsToPrice = allItems
            .filter(i => (resolutions[i.id] || "LOSS") !== "EXCLUDED")
            .map(i => ({
                id: i.id,
                name: i.name,
                quantity: itemQuantities[i.id] !== undefined ? itemQuantities[i.id] : (i.allocations[selectedSite.id] || 1),
                unit: i.unit || "szt."
            }));

        manualItems.forEach(m => {
            if (m.resolution !== "EXCLUDED") {
                activeItemsToPrice.push({
                    id: m.id,
                    name: m.name,
                    quantity: m.quantity,
                    unit: m.unit
                });
            }
        });

        if (activeItemsToPrice.length === 0) {
            alert("Brak aktywnych pozycji do wyceny (wszystkie wykluczone lub brak sprzętu).");
            setIsEstimatingCosts(false);
            return;
        }

        try {
            const res = await fetch("/api/closeout-pricing", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ items: activeItemsToPrice })
            });
            const data = await res.json();
            if (data.success && data.estimates) {
                const newCosts = { ...itemCosts };
                for (const [id, est] of Object.entries(data.estimates as Record<string, { estimatedUnitCost: number }>)) {
                    newCosts[id] = est.estimatedUnitCost;
                }
                setItemCosts(newCosts);

                // Aktualizacja cen dla pozycji ręcznych
                setManualItems(prev => prev.map(m => {
                    if (data.estimates[m.id]) {
                        return { ...m, estimatedUnitCost: data.estimates[m.id].estimatedUnitCost };
                    }
                    return m;
                }));

                alert("✨ Wycena rynkowa AI została pobrana! Możesz sprawdzić lub ręcznie skorygować każdą kwotę w PLN.");
            } else {
                throw new Error(data.error || "Błąd pobierania wyceny");
            }
        } catch (e: any) {
            console.error("Błąd wyceny AI:", e);
            alert("Nie udało się pobrać wyceny AI: " + e.message);
        } finally {
            setIsEstimatingCosts(false);
        }
    };

    // Dodanie pozycji "z głowy" / z ręki
    const handleAddManualItem = (e: React.FormEvent) => {
        e.preventDefault();
        if (!newManualName.trim()) return alert("Wpisz nazwę przedmiotu!");

        const newItem: ManualCloseoutItem = {
            id: `manual_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
            name: newManualName.trim(),
            quantity: Number(newManualQty) || 1,
            unit: newManualUnit || "szt.",
            inventoryNumber: "WPIS RĘCZNY",
            resolution: newManualRes,
            notes: newManualNotes.trim(),
            estimatedUnitCost: Number(newManualCost) || 0
        };

        setManualItems(prev => [...prev, newItem]);
        setNewManualName("");
        setNewManualQty(1);
        setNewManualNotes("");
        setNewManualCost(0);
        setIsAddManualOpen(false);
    };

    const handleRemoveManualItem = (id: string) => {
        setManualItems(prev => prev.filter(m => m.id !== id));
    };

    // Podsumowanie finansowe na żywo
    const calculateFinancials = () => {
        let totalLoss = 0;
        let totalDisputed = 0;
        let totalScrapped = 0;
        let totalRepairs = 0;
        let totalExpenses = 0;

        if (!selectedSite) return { totalLoss, totalDisputed, totalScrapped, totalRepairs, totalExpenses };

        const allItems = [...toolsItems, ...scaffoldingItems, ...otherItems];
        allItems.forEach(i => {
            const res = resolutions[i.id] || "LOSS";
            if (res === "EXCLUDED" || res === "CONSUMED") return;

            const qty = itemQuantities[i.id] !== undefined ? itemQuantities[i.id] : (i.allocations[selectedSite.id] || 0);
            const unitPrice = itemCosts[i.id] || 0;
            const itemTotal = qty * unitPrice;

            if (res === "LOSS") totalLoss += itemTotal;
            else if (res === "DISPUTED_INVESTOR") totalDisputed += itemTotal;
            else if (res === "SCRAPPED") totalScrapped += itemTotal;
        });

        manualItems.forEach(m => {
            if (m.resolution === "EXCLUDED" || m.resolution === "CONSUMED") return;
            const itemTotal = m.quantity * (m.estimatedUnitCost || 0);
            if (m.resolution === "LOSS") totalLoss += itemTotal;
            else if (m.resolution === "DISPUTED_INVESTOR") totalDisputed += itemTotal;
            else if (m.resolution === "SCRAPPED") totalScrapped += itemTotal;
        });

        // Suma kosztów napraw sprzętu
        suspiciousItems.forEach(item => {
            const cost = repairCostOverrides[item.id] !== undefined ? repairCostOverrides[item.id] : (item.repairCost || 0);
            totalRepairs += (Number(cost) || 0);
        });

        // Suma drobnych bieżących wydatków i napraw na budowie
        siteExpenses.forEach(exp => {
            totalExpenses += (Number(exp.amount) || 0);
        });

        return { totalLoss, totalDisputed, totalScrapped, totalRepairs, totalExpenses };
    };

    const handleInitiateCloseout = async () => {
        if (!selectedSite || !user) return;
        if (!selectedManagerUid) return alert("Wybierz kierownika budowy odpowiedzialnego za rozliczenie!");
        setIsProcessing(true);

        try {
            const closeoutRef = doc(db, "closeouts", selectedSite.id);
            const chosenManager = users.find(u => u.uid === selectedManagerUid);

            const allItems = [...toolsItems, ...scaffoldingItems, ...otherItems];
            const debtsList: any[] = [];
            const excludedItems: any[] = [];

            allItems.forEach(i => {
                const res = resolutions[i.id] || "LOSS";
                const qty = itemQuantities[i.id] !== undefined ? itemQuantities[i.id] : (i.allocations[selectedSite.id] || 0);
                const unitPrice = itemCosts[i.id] || 0;
                const note = itemNotes[i.id] || "";

                if (res === "EXCLUDED") {
                    excludedItems.push({
                        id: i.id,
                        name: i.name,
                        inventoryNumber: i.inventoryNumber || "-",
                        quantity: qty,
                        unit: i.unit || "szt.",
                        reason: note || "Wykluczone z raportu przez audytora"
                    });
                } else {
                    debtsList.push({
                        id: i.id,
                        name: i.name,
                        type: i.type,
                        inventoryNumber: i.inventoryNumber || "-",
                        quantity: qty,
                        unit: i.unit || "szt.",
                        resolution: res,
                        notes: note,
                        estimatedUnitCost: unitPrice,
                        estimatedTotalCost: qty * unitPrice,
                        isManualEntry: false
                    });
                }
            });

            // Dołączenie pozycji ręcznych ("z głowy")
            manualItems.forEach(m => {
                if (m.resolution === "EXCLUDED") {
                    excludedItems.push({
                        id: m.id,
                        name: m.name,
                        inventoryNumber: m.inventoryNumber,
                        quantity: m.quantity,
                        unit: m.unit,
                        reason: m.notes || "Wykluczone"
                    });
                } else {
                    debtsList.push({
                        id: m.id,
                        name: m.name,
                        type: "MANUAL",
                        inventoryNumber: m.inventoryNumber,
                        quantity: m.quantity,
                        unit: m.unit,
                        resolution: m.resolution,
                        notes: m.notes,
                        estimatedUnitCost: m.estimatedUnitCost || 0,
                        estimatedTotalCost: m.quantity * (m.estimatedUnitCost || 0),
                        isManualEntry: true
                    });
                }
            });

            const financials = calculateFinancials();

            const detectivePayload = suspiciousItems.map(i => ({
                id: i.id,
                name: i.name,
                inventoryNumber: i.inventoryNumber || "-",
                failureDescription: i.failureDescription,
                repairCost: repairCostOverrides[i.id] !== undefined ? repairCostOverrides[i.id] : (i.repairCost || 0),
                isRepaired: i.isRepaired || i.status === "sprawne",
                status: i.status
            }));

            // Utwórz szkic rozliczenia
            await setDoc(closeoutRef, {
                siteId: selectedSite.id,
                siteName: selectedSite.name,
                status: "OCZEKUJE_NA_KIEROWNIKA",
                initiatedBy: user.uid,
                initiatedByName: `${user.firstName} ${user.lastName}`,
                initiatedAt: new Date().toISOString(),
                managerUid: chosenManager?.uid || "",
                managerName: chosenManager ? `${chosenManager.firstName} ${chosenManager.lastName}` : "Brak",
                managerEmail: chosenManager?.email || "",
                generalNotes: generalNotes.trim(),
                financialSummary: {
                    totalLossCost: financials.totalLoss,
                    totalDisputedCost: financials.totalDisputed,
                    totalScrappedCost: financials.totalScrapped,
                    totalRepairsCost: financials.totalRepairs,
                    totalExpensesCost: financials.totalExpenses
                },
                debtsList: debtsList,
                excludedItems: excludedItems,
                siteDamagesList: siteDamages,
                siteExpensesList: siteExpenses,
                claimsList: siteClaims,
                detectiveList: detectivePayload,
                managerSignedAt: null,
                directorSignedAt: null
            });

            // Blokuj budowę
            await updateDoc(doc(db, "sites", selectedSite.id), { status: "W_TRAKCIE_ROZLICZENIA" });

            // Powiadomienie e-mail
            try {
                const response = await fetch("/api/closeout-email", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        type: "CLOSEOUT_INITIATED",
                        siteName: selectedSite.name,
                        managerName: chosenManager ? `${chosenManager.firstName} ${chosenManager.lastName}` : "Brak",
                        managerEmail: chosenManager?.email || "",
                        warehousemanName: `${user.firstName} ${user.lastName}`,
                        debtsList: debtsList,
                        detectiveList: detectivePayload,
                        siteDamagesList: siteDamages,
                        siteExpensesList: siteExpenses,
                        generalNotes: generalNotes.trim(),
                        financialSummary: {
                            totalLossCost: financials.totalLoss,
                            totalDisputedCost: financials.totalDisputed,
                            totalScrappedCost: financials.totalScrapped,
                            totalRepairsCost: financials.totalRepairs,
                            totalExpensesCost: financials.totalExpenses
                        }
                    })
                });

                const result = await response.json();
                if (!response.ok || !result.success) {
                    console.error("Błąd API mailera:", result);
                    alert(`⚠️ ROZLICZENIE ZAPISANE, ALE BŁĄD WYSYŁKI E-MAILA!\n\nPowód błędu serwera: ${result.error || "Nieznany błąd poczty"}`);
                } else {
                    alert("✅ Audyt utworzony pomyślnie! E-mail ze szczegółowym raportem i wyceną wysłany do Kierownika i Dyrekcji.");
                }
            } catch (e) {
                console.error("Krytyczny błąd mailera:", e);
                alert("⚠️ Rozliczenie zostało zapisane w bazie, ale wystąpił błąd komunikacji z serwerem poczty.");
            }

            setSelectedSite(null);
            fetchSitesAndUsers();
        } catch (error) {
            alert("Błąd inicjowania: " + error);
        } finally {
            setIsProcessing(false);
        }
    };

    if (loading) return <div className="p-10 text-center animate-pulse">Ładowanie modułu audytów...</div>;

    const financials = calculateFinancials();

    // Pomocniczy komponent wiersza pozycji audytu
    const renderItemRow = (item: InventoryItem) => {
        const currentRes = resolutions[item.id] || "LOSS";
        const currentQty = itemQuantities[item.id] !== undefined ? itemQuantities[item.id] : (selectedSite ? item.allocations[selectedSite.id] || 0 : 0);
        const currentNote = itemNotes[item.id] || "";
        const currentCost = itemCosts[item.id] || 0;
        const isExcluded = currentRes === "EXCLUDED";

        return (
            <div
                key={item.id}
                className={`p-4 border rounded-2xl shadow-sm transition space-y-3 ${isExcluded ? 'bg-slate-100/60 border-slate-200 opacity-60' : 'bg-white border-slate-200 hover:border-slate-300'}`}
            >
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                    <div>
                        <p className={`font-bold text-sm ${isExcluded ? 'line-through text-slate-500' : 'text-slate-800'}`}>
                            {item.name}
                        </p>
                        <p className="text-[10px] text-slate-400 font-mono">Nr Mag: {item.inventoryNumber || "-"}</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                        {/* WYBÓR DECYZJI / STATUSU DYSPOZYCJI */}
                        <select
                            value={currentRes}
                            onChange={e => setResolutions({ ...resolutions, [item.id]: e.target.value as ResolutionType })}
                            className={`p-1.5 text-xs font-bold border rounded-xl outline-none cursor-pointer ${
                                currentRes === "LOSS" ? "bg-red-50 text-red-700 border-red-200" :
                                currentRes === "DISPUTED_INVESTOR" ? "bg-amber-50 text-amber-800 border-amber-300 font-extrabold" :
                                currentRes === "SCRAPPED" ? "bg-slate-200 text-slate-800 border-slate-300" :
                                currentRes === "CONSUMED" ? "bg-blue-50 text-blue-700 border-blue-200" :
                                "bg-slate-200 text-slate-600 border-slate-300"
                            }`}
                        >
                            <option value="LOSS">❌ Strata / Dług</option>
                            <option value="DISPUTED_INVESTOR">🚧 Pozostawiono u Inwestora / Spór</option>
                            <option value="SCRAPPED">♻️ Złomowanie / Do wyrzucenia</option>
                            <option value="CONSUMED">🧼 Zużycie normalne</option>
                            <option value="EXCLUDED">🗑️ Wyklucz z raportu</option>
                        </select>

                        {/* EDYCJA ILOŚCI */}
                        <div className="flex items-center gap-1 bg-slate-50 border rounded-lg px-2 py-1">
                            <span className="text-[10px] font-bold text-slate-400">Ilość:</span>
                            <input
                                type="number"
                                min="0"
                                value={currentQty}
                                onChange={e => setItemQuantities({ ...itemQuantities, [item.id]: Math.max(0, parseInt(e.target.value) || 0) })}
                                className="w-12 text-xs font-bold text-slate-800 text-center outline-none bg-transparent"
                            />
                            <span className="text-[10px] text-slate-400">{item.unit || "szt."}</span>
                        </div>

                        {/* SZACUNKOWY KOSZT JEDNOSTKOWY PLN */}
                        <div className="flex items-center gap-1 bg-slate-50 border rounded-lg px-2 py-1">
                            <span className="text-[10px] font-bold text-slate-400">Cena:</span>
                            <input
                                type="number"
                                min="0"
                                placeholder="0"
                                value={currentCost || ""}
                                onChange={e => setItemCosts({ ...itemCosts, [item.id]: Math.max(0, parseInt(e.target.value) || 0) })}
                                className="w-14 text-xs font-bold text-slate-800 text-center outline-none bg-transparent"
                            />
                            <span className="text-[10px] text-slate-400">zł</span>
                        </div>

                        {currentCost > 0 && currentQty > 0 && (
                            <span className="text-xs font-black text-slate-600 whitespace-nowrap pl-1">
                                = {currentCost * currentQty} zł
                            </span>
                        )}
                    </div>
                </div>

                {/* NOTATKA AUDYTORA DO POZYCJI (np. powód utylizacji, spór z inwestorem) */}
                <div className="flex items-center gap-2 pt-1 border-t border-slate-100">
                    <span className="text-xs text-slate-400">💬</span>
                    <input
                        type="text"
                        placeholder={
                            currentRes === "DISPUTED_INVESTOR" ? "Opisz sytuację: np. Ogrodzenie zablokowane na budowie, toczą się rozmowy z inwestorem..." :
                            currentRes === "SCRAPPED" ? "Powód złomowania: np. Brak części do naprawy, łata wygięta, niezdatna do użytku..." :
                            currentRes === "EXCLUDED" ? "Powód wykluczenia: np. Sprzęt odnaleziony na magazynie centralnym..." :
                            "Notatka / uwagi audytora do tej pozycji..."
                        }
                        value={currentNote}
                        onChange={e => setItemNotes({ ...itemNotes, [item.id]: e.target.value })}
                        className="w-full text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none focus:bg-white focus:border-blue-400 transition"
                    />
                </div>
            </div>
        );
    };

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto animate-fade-in font-sans space-y-6">
            {/* PRZEŁĄCZNIK TRYBU: AUDYT / ARCHIWUM */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b pb-4">
                <div>
                    <h1 className="text-3xl font-black text-slate-800 tracking-tight">Rozliczenia Projektów</h1>
                    <p className="text-slate-500 text-sm mt-0.5">Audyty końcowe budów, obsługa braków, wycena strat i archiwum.</p>
                </div>
                <div className="flex bg-slate-100 p-1 rounded-2xl border border-slate-200 shadow-sm">
                    <button
                        onClick={() => setViewMode("ACTIVE_AUDITS")}
                        className={`px-5 py-2.5 rounded-xl font-bold text-xs uppercase transition ${viewMode === "ACTIVE_AUDITS" ? "bg-slate-900 text-white shadow" : "text-slate-600 hover:text-slate-900"}`}
                    >
                        🔨 Aktywne Audyty Budów
                    </button>
                    <button
                        onClick={() => { setViewMode("ARCHIVE"); fetchArchive(); }}
                        className={`px-5 py-2.5 rounded-xl font-bold text-xs uppercase transition ${viewMode === "ARCHIVE" ? "bg-blue-600 text-white shadow" : "text-slate-600 hover:text-slate-900"}`}
                    >
                        📜 Historia i Archiwum Zamknięć
                    </button>
                </div>
            </div>

            {/* WIDOK ARCHIWUM I HISTORII ZAMKNIĘĆ */}
            {viewMode === "ARCHIVE" ? (
                <div className="bg-white border border-slate-200 rounded-3xl shadow-sm p-6 space-y-6">
                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                        <div>
                            <h2 className="text-xl font-black text-slate-800">Archiwum Rozliczonych Budów</h2>
                            <p className="text-xs text-slate-500 mt-0.5">Wszystkie formalnie zamknięte i podpisane projekty w systemie PESAM.</p>
                        </div>
                        <div className="relative w-full sm:w-72">
                            <span className="absolute inset-y-0 left-3 flex items-center text-slate-400">🔍</span>
                            <input
                                type="text"
                                placeholder="Szukaj budowy lub kierownika..."
                                value={archiveSearch}
                                onChange={e => setArchiveSearch(e.target.value)}
                                className="w-full pl-9 pr-4 py-2 border rounded-xl text-xs font-bold outline-none focus:border-blue-500"
                            />
                        </div>
                    </div>

                    {archiveLoading ? (
                        <div className="p-12 text-center text-slate-400 animate-pulse">Wczytywanie archiwum zamknięć...</div>
                    ) : archivedCloseouts.length === 0 ? (
                        <div className="p-16 text-center text-slate-400 border-2 border-dashed rounded-2xl">
                            <span className="text-4xl mb-2 block">📁</span>
                            Brak zarchiwizowanych rozliczeń budów.
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {archivedCloseouts
                                .filter(c => !archiveSearch || c.siteName?.toLowerCase().includes(archiveSearch.toLowerCase()) || c.managerName?.toLowerCase().includes(archiveSearch.toLowerCase()))
                                .map(c => (
                                    <div
                                        key={c.id}
                                        onClick={() => setSelectedArchived(c)}
                                        className="p-5 border border-slate-200 hover:border-blue-500 bg-white hover:bg-blue-50/20 rounded-2xl cursor-pointer transition shadow-sm space-y-3"
                                    >
                                        <div className="flex justify-between items-start">
                                            <h3 className="font-black text-slate-800 text-base">{c.siteName}</h3>
                                            <span className="bg-green-100 text-green-800 text-[10px] font-black px-2 py-0.5 rounded-md uppercase">ROZLICZONA</span>
                                        </div>
                                        <div className="text-xs text-slate-500 space-y-1">
                                            <p>👤 Kierownik: <b>{c.managerName || "Brak"}</b></p>
                                            <p>✍️ Zamknął Dyrektor: <b>{c.directorName || "Dyrekcja"}</b></p>
                                            <p>📅 Data: {c.directorSignedAt ? new Date(c.directorSignedAt).toLocaleDateString("pl-PL") : "-"}</p>
                                        </div>
                                        <div className="pt-2 border-t flex justify-between text-xs font-bold text-slate-700">
                                            <span>Pozycje ubytków: {c.debtsList?.length || 0}</span>
                                            {c.financialSummary?.totalLossCost ? (
                                                <span className="text-red-600 font-black">Straty: {c.financialSummary.totalLossCost} zł</span>
                                            ) : null}
                                        </div>
                                    </div>
                                ))}
                        </div>
                    )}

                    {/* MODAL PODGLĄDU SZCZEGÓŁÓW ZARCHIWIZOWANEJ BUDOWY */}
                    {selectedArchived && (
                        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
                            <div className="bg-white rounded-3xl max-w-3xl w-full p-6 sm:p-8 shadow-2xl border border-slate-200 animate-fade-in max-h-[90vh] overflow-y-auto space-y-6">
                                <div className="flex justify-between items-center border-b pb-4">
                                    <div>
                                        <span className="bg-green-100 text-green-800 text-[10px] font-black px-2.5 py-0.5 rounded uppercase">Archiwum Raportu</span>
                                        <h2 className="text-2xl font-black text-slate-900 mt-1">{selectedArchived.siteName}</h2>
                                    </div>
                                    <button onClick={() => setSelectedArchived(null)} className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 font-bold text-slate-500">&times;</button>
                                </div>

                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 p-4 rounded-2xl border text-xs">
                                    <div><p className="text-slate-400 font-bold uppercase text-[9px]">Kierownik:</p><p className="font-bold text-slate-800">{selectedArchived.managerName}</p></div>
                                    <div><p className="text-slate-400 font-bold uppercase text-[9px]">Zainicjował:</p><p className="font-bold text-slate-800">{selectedArchived.initiatedByName}</p></div>
                                    <div><p className="text-slate-400 font-bold uppercase text-[9px]">Autoryzował:</p><p className="font-bold text-slate-800">{selectedArchived.directorName || "Dyrektor"}</p></div>
                                    <div><p className="text-slate-400 font-bold uppercase text-[9px]">Data Zamknięcia:</p><p className="font-bold text-slate-800">{selectedArchived.directorSignedAt ? new Date(selectedArchived.directorSignedAt).toLocaleDateString("pl-PL") : "-"}</p></div>
                                </div>

                                {selectedArchived.generalNotes && (
                                    <div className="p-4 bg-blue-50 border border-blue-200 rounded-2xl text-xs text-blue-900">
                                        <b>Uwagi audytora:</b> {selectedArchived.generalNotes}
                                    </div>
                                )}

                                {selectedArchived.financialSummary && (
                                    <div className="p-4 bg-slate-100 border border-slate-200 rounded-2xl flex flex-wrap justify-between gap-3 text-xs">
                                        <div><span className="text-slate-500 font-bold uppercase text-[9px] block">Straty:</span><b className="text-red-600">{selectedArchived.financialSummary.totalLossCost || 0} zł</b></div>
                                        <div><span className="text-slate-500 font-bold uppercase text-[9px] block">U Inwestora:</span><b className="text-amber-700">{selectedArchived.financialSummary.totalDisputedCost || 0} zł</b></div>
                                        <div><span className="text-slate-500 font-bold uppercase text-[9px] block">Złomowane:</span><b className="text-slate-700">{selectedArchived.financialSummary.totalScrappedCost || 0} zł</b></div>
                                        {selectedArchived.financialSummary.totalRepairsCost ? (
                                            <div><span className="text-slate-500 font-bold uppercase text-[9px] block">Naprawy sprzętu:</span><b className="text-blue-700">{selectedArchived.financialSummary.totalRepairsCost} zł</b></div>
                                        ) : null}
                                        {selectedArchived.financialSummary.totalExpensesCost ? (
                                            <div><span className="text-slate-500 font-bold uppercase text-[9px] block">Drobne wydatki:</span><b className="text-emerald-700">{selectedArchived.financialSummary.totalExpensesCost} zł</b></div>
                                        ) : null}
                                    </div>
                                )}

                                {selectedArchived.siteExpensesList && selectedArchived.siteExpensesList.length > 0 && (
                                    <div className="space-y-2">
                                        <h4 className="font-black text-xs uppercase tracking-wider text-emerald-800">Drobne wydatki budowy ({selectedArchived.siteExpensesList.length}):</h4>
                                        <div className="space-y-1.5">
                                            {selectedArchived.siteExpensesList.map((exp: any, idx: number) => (
                                                <div key={idx} className="p-2.5 bg-emerald-50/50 border border-emerald-200 rounded-xl flex justify-between items-center text-xs">
                                                    <div>
                                                        <b>{exp.title}</b> <span className="text-[9px] text-slate-500">({exp.date || "-"})</span>
                                                        {exp.notes && <p className="text-[10px] text-slate-500 italic">💬 {exp.notes}</p>}
                                                    </div>
                                                    <b className="text-emerald-700">{exp.amount} zł</b>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {selectedArchived.detectiveList && selectedArchived.detectiveList.length > 0 && (
                                    <div className="space-y-2">
                                        <h4 className="font-black text-xs uppercase tracking-wider text-orange-800">Ujawnione usterki i naprawy po zwrocie ({selectedArchived.detectiveList.length}):</h4>
                                        <div className="space-y-1.5">
                                            {selectedArchived.detectiveList.map((det: any, idx: number) => (
                                                <div key={idx} className="p-2.5 bg-orange-50/50 border border-orange-200 rounded-xl text-xs space-y-1">
                                                    <div className="flex justify-between items-center">
                                                        <b>{det.name}</b>
                                                        <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded ${det.isRepaired || det.status === 'sprawne' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                                            {det.isRepaired || det.status === 'sprawne' ? 'Naprawione' : 'Uszkodzone'}
                                                        </span>
                                                    </div>
                                                    <p className="text-[11px] text-slate-600">{det.failureDescription}</p>
                                                    {det.repairCost ? <p className="text-[11px] font-bold text-blue-700">Koszt naprawy: {det.repairCost} zł</p> : null}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                <div className="space-y-3">
                                    <h4 className="font-black text-xs uppercase tracking-wider text-slate-600">Rozliczone pozycje ({selectedArchived.debtsList?.length || 0}):</h4>
                                    <div className="space-y-2">
                                        {(selectedArchived.debtsList || []).map((item: any, idx: number) => (
                                            <div key={idx} className="p-3 bg-slate-50 border rounded-xl flex justify-between items-center text-xs">
                                                <div>
                                                    <p className="font-bold text-slate-800">{item.name}</p>
                                                    <p className="text-[10px] text-slate-400 font-mono">Nr Mag: {item.inventoryNumber || "-"}</p>
                                                    {item.notes && <p className="text-[11px] text-amber-700 italic mt-0.5">💬 {item.notes}</p>}
                                                </div>
                                                <div className="text-right">
                                                    <span className={`px-2 py-0.5 rounded font-black text-[10px] uppercase ${
                                                        item.resolution === "DISPUTED_INVESTOR" ? "bg-amber-100 text-amber-800" :
                                                        item.resolution === "SCRAPPED" ? "bg-slate-200 text-slate-700" :
                                                        item.resolution === "CONSUMED" ? "bg-blue-100 text-blue-800" :
                                                        "bg-red-100 text-red-700"
                                                    }`}>
                                                        {item.resolution === "DISPUTED_INVESTOR" ? "U Inwestora" : item.resolution === "SCRAPPED" ? "Złomowane" : item.resolution === "CONSUMED" ? "Zużycie" : "Strata"}
                                                    </span>
                                                    <p className="font-bold text-slate-800 mt-1">{item.quantity} {item.unit || "szt."}</p>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div className="pt-4 border-t flex justify-end">
                                    <button onClick={() => window.print()} className="bg-slate-900 hover:bg-slate-800 text-white font-black px-6 py-2.5 rounded-xl text-xs uppercase">
                                        🖨️ Drukuj Raport (PDF)
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            ) : (
                /* WIDOK AKTYWNYCH AUDYTÓW */
                <div className="flex flex-col md:flex-row gap-6">
                    {/* LEWA KOLUMNA: LISTA AKTYWNYCH BUDÓW */}
                    <div className="w-full md:w-1/3 space-y-3">
                        <div className="bg-slate-900 text-white p-4 rounded-xl shadow-md">
                            <h3 className="font-black text-xs uppercase tracking-wider">Rozpocznij nowy audyt</h3>
                        </div>
                        <div className="bg-white border border-slate-200 rounded-xl p-3 h-[60vh] overflow-y-auto space-y-2 shadow-sm">
                            {sites.length === 0 ? <p className="text-slate-400 text-xs p-4 text-center">Brak aktywnych budów.</p> : sites.map(site => (
                                <button
                                    key={site.id}
                                    onClick={() => runAudit(site)}
                                    className={`w-full text-left p-4 rounded-lg border transition ${selectedSite?.id === site.id ? 'bg-blue-600 border-blue-600 text-white shadow-md' : 'bg-white border-slate-100 hover:border-blue-200 hover:bg-slate-50'}`}
                                >
                                    <p className={`font-bold text-sm ${selectedSite?.id === site.id ? 'text-white' : 'text-slate-800'}`}>{site.name}</p>
                                    <p className={`text-[10px] uppercase mt-1 font-semibold ${selectedSite?.id === site.id ? 'text-blue-200' : 'text-slate-500'}`}>📍 {site.location || "Brak lokalizacji"}</p>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* PRAWA KOLUMNA: PANEL AUDYTORA DLA WYBRANEJ BUDOWY */}
                    <div className="w-full md:w-2/3">
                        {!selectedSite ? (
                            <div className="h-full flex flex-col items-center justify-center bg-slate-50 border-2 border-dashed border-slate-200 rounded-2xl p-12 text-slate-400">
                                <span className="text-5xl mb-4">📊</span>
                                <p className="font-black text-slate-700 text-center">Wybierz budowę z listy po lewej stronie, aby otworzyć system audytora.</p>
                            </div>
                        ) : auditLoading ? (
                            <div className="h-full flex flex-col items-center justify-center bg-white border border-slate-200 rounded-2xl p-12 animate-pulse text-slate-500">
                                <span className="text-3xl animate-spin mb-3">⚙️</span>
                                Pobieranie i szczegółowa analiza ubytków projektu...
                            </div>
                        ) : (
                            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col max-h-[88vh]">

                                {/* NAGŁÓWEK SZKICU */}
                                <div className="p-6 bg-slate-900 border-b border-slate-800 flex justify-between items-center text-white">
                                    <div>
                                        <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest">Generowanie szkicu rozliczenia</p>
                                        <h2 className="text-xl font-black">{selectedSite.name}</h2>
                                    </div>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setIsAddManualOpen(true)}
                                            className="bg-emerald-600 hover:bg-emerald-700 text-white font-black px-3 py-1.5 rounded-lg text-xs uppercase shadow transition flex items-center gap-1"
                                        >
                                            ➕ Dopisz z ręki
                                        </button>
                                        <button
                                            onClick={handleEstimateCostsAI}
                                            disabled={isEstimatingCosts}
                                            className="bg-indigo-600 hover:bg-indigo-700 text-white font-black px-3.5 py-1.5 rounded-lg text-xs uppercase shadow transition flex items-center gap-1.5 disabled:opacity-50"
                                        >
                                            {isEstimatingCosts ? "Wyceniam AI..." : "✨ Wycena Kosztów AI"}
                                        </button>
                                    </div>
                                </div>

                                {/* PASEK BILANSU FINANSOWEGO NA ŻYWO DLA SZEFA */}
                                <div className="bg-slate-800 text-white px-6 py-2.5 flex flex-wrap justify-between items-center text-xs border-b border-slate-700 gap-2">
                                    <span className="font-black text-slate-300 uppercase tracking-wide">Podsumowanie finansowe:</span>
                                    <div className="flex flex-wrap gap-4 font-bold">
                                        <span className="text-red-400">❌ Straty: <b>{financials.totalLoss} zł</b></span>
                                        <span className="text-amber-400">🚧 U Inwestora: <b>{financials.totalDisputed} zł</b></span>
                                        <span className="text-slate-400">♻️ Do Złomowania: <b>{financials.totalScrapped} zł</b></span>
                                        <span className="text-blue-400">🔧 Naprawy sprzętu: <b>{financials.totalRepairs} zł</b></span>
                                        <span className="text-emerald-400">💰 Drobne wydatki: <b>{financials.totalExpenses} zł</b></span>
                                    </div>
                                </div>

                                {/* ZAKŁADKI KATEGORII */}
                                <div className="bg-slate-100 p-2.5 border-b border-slate-200 flex flex-wrap gap-2">
                                    <button onClick={() => setActiveTab("TOOLS")} className={`px-3.5 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "TOOLS" ? "bg-blue-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                        🛠️ Narzędzia <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "TOOLS" ? "bg-white text-blue-600" : "bg-slate-100 text-slate-600"}`}>{toolsItems.length}</span>
                                    </button>
                                    <button onClick={() => setActiveTab("SCAFFOLDING")} className={`px-3.5 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "SCAFFOLDING" ? "bg-blue-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                        🏗️ Rusztowania <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "SCAFFOLDING" ? "bg-white text-blue-600" : "bg-slate-100 text-slate-600"}`}>{scaffoldingItems.length}</span>
                                    </button>
                                    <button onClick={() => setActiveTab("OTHER")} className={`px-3.5 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "OTHER" ? "bg-blue-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                        ⚙️ Osprzęt i Inne <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "OTHER" ? "bg-white text-blue-600" : "bg-slate-100 text-slate-600"}`}>{otherItems.length}</span>
                                    </button>
                                    <button onClick={() => setActiveTab("DAMAGES")} className={`px-3.5 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "DAMAGES" ? "bg-blue-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                        💥 Uszkodzenia Budowy <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "DAMAGES" ? "bg-white text-blue-600" : "bg-slate-100 text-slate-600"}`}>{siteDamages.length}</span>
                                    </button>
                                    <button onClick={() => setActiveTab("EXPENSES")} className={`px-3.5 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "EXPENSES" ? "bg-emerald-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                        💰 Drobne Wydatki <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "EXPENSES" ? "bg-white text-emerald-700" : "bg-emerald-100 text-emerald-800"}`}>{siteExpenses.length}</span>
                                    </button>
                                    <button onClick={() => setActiveTab("MANUAL")} className={`px-3.5 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "MANUAL" ? "bg-blue-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                        ✍️ Wpisy Ręczne <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "MANUAL" ? "bg-white text-blue-600" : "bg-slate-100 text-slate-600"}`}>{manualItems.length}</span>
                                    </button>
                                    <button onClick={() => setActiveTab("CLAIMS")} className={`px-3.5 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "CLAIMS" ? "bg-blue-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                        ⚖️ Sąd PESAM <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "CLAIMS" ? "bg-white text-blue-600" : "bg-slate-100 text-slate-600"}`}>{siteClaims.length}</span>
                                    </button>
                                    <button onClick={() => setActiveTab("DETECTIVE")} className={`px-3.5 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "DETECTIVE" ? "bg-blue-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                        🕵️ Detektyw & Naprawy <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "DETECTIVE" ? "bg-white text-blue-600" : "bg-slate-100 text-slate-600"}`}>{suspiciousItems.length}</span>
                                    </button>
                                    <button onClick={() => setActiveTab("HISTORY")} className={`px-3.5 py-2 text-xs font-black rounded-lg transition-all flex items-center gap-2 ${activeTab === "HISTORY" ? "bg-blue-600 text-white shadow" : "bg-white hover:bg-slate-50 text-slate-700 border"}`}>
                                        📋 Protokoły <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "HISTORY" ? "bg-white text-blue-600" : "bg-slate-100 text-slate-600"}`}>{siteProtocols.length}</span>
                                    </button>
                                </div>

                                {/* ZAWARTOŚĆ ZAKŁADEK */}
                                <div className="flex-1 overflow-y-auto p-6 bg-slate-50 space-y-4">
                                    {activeTab === "TOOLS" && (
                                        <div className="space-y-3">
                                            <div className="border-b pb-2 mb-2 flex justify-between items-center">
                                                <h4 className="font-black text-sm text-slate-800">Narzędzia unikalne (UNIQUE) aktualnie na budowie:</h4>
                                                <span className="text-xs text-slate-400">Możesz zmienić decyzję, edytować ilość, cenę lub dodać notatkę</span>
                                            </div>
                                            {toolsItems.length === 0 ? (
                                                <div className="p-6 bg-green-50 text-green-800 border border-green-200 rounded-xl font-bold flex items-center gap-2 text-sm"><span>✅</span> Brak zalegających narzędzi na placu budowy.</div>
                                            ) : (
                                                <div className="space-y-2.5">
                                                    {toolsItems.map(item => renderItemRow(item))}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {activeTab === "SCAFFOLDING" && (
                                        <div className="space-y-3">
                                            <div className="border-b pb-2 mb-2 flex justify-between items-center">
                                                <h4 className="font-black text-sm text-slate-800">Elementy masowe (BULK) rusztowań / szalunków / ogrodzeń:</h4>
                                                <span className="text-xs text-slate-400">Wybierz np. &quot;Pozostawiono u Inwestora&quot; dla ogrodzenia</span>
                                            </div>
                                            {scaffoldingItems.length === 0 ? (
                                                <div className="p-6 bg-green-50 text-green-800 border border-green-200 rounded-xl font-bold flex items-center gap-2 text-sm"><span>✅</span> Brak zalegających rusztowań/szalunków.</div>
                                            ) : (
                                                <div className="space-y-2.5">
                                                    {scaffoldingItems.map(item => renderItemRow(item))}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {activeTab === "OTHER" && (
                                        <div className="space-y-3">
                                            <div className="border-b pb-2 mb-2 flex justify-between items-center">
                                                <h4 className="font-black text-sm text-slate-800">Zaległe brakujące elementy, osprzęt oraz wpisy z palca:</h4>
                                                <span className="text-xs text-slate-400">np. Łata do niwelatora &rarr; Złomowanie / Do wyrzucenia z notatką</span>
                                            </div>
                                            {otherItems.length === 0 ? (
                                                <div className="p-6 bg-green-50 text-green-800 border border-green-200 rounded-xl font-bold flex items-center gap-2 text-sm"><span>✅</span> Brak zaległego osprzętu czy ubytków.</div>
                                            ) : (
                                                <div className="space-y-2.5">
                                                    {otherItems.map(item => renderItemRow(item))}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {activeTab === "DAMAGES" && (
                                        <div className="space-y-3">
                                            <div className="border-b pb-2 mb-2 flex justify-between items-center">
                                                <h4 className="font-black text-sm text-slate-800">Uszkodzenia zarejestrowane na budowie w trakcie prac:</h4>
                                                <span className="text-xs text-slate-500">Zgłoszenia kierownika z modułu Twoja Budowa</span>
                                            </div>
                                            {siteDamages.length === 0 ? (
                                                <div className="p-8 text-center bg-white border border-dashed rounded-xl text-slate-400 text-sm">
                                                    Brak zarejestrowanych uszkodzeń podczas trwania tej budowy.
                                                </div>
                                            ) : (
                                                <div className="space-y-2.5">
                                                    {siteDamages.map((dmg, idx) => (
                                                        <div key={dmg.id || idx} className="p-4 bg-orange-50/80 border border-orange-200 rounded-2xl shadow-sm space-y-2">
                                                            <div className="flex justify-between items-start">
                                                                <div>
                                                                    <p className="font-bold text-slate-900 text-sm">{dmg.inventoryName}</p>
                                                                    <p className="text-[10px] text-slate-500 font-mono">Nr Mag: {dmg.inventoryNumber || "-"} • Zgłosił: <b>{dmg.reportedByName || "Kierownik"}</b></p>
                                                                </div>
                                                                <span className="bg-orange-600 text-white font-black text-xs px-2.5 py-1 rounded-lg">
                                                                    {dmg.quantity} {dmg.unit || "szt."}
                                                                </span>
                                                            </div>
                                                            <div className="p-3 bg-white border border-orange-200 rounded-xl text-xs text-slate-700 leading-relaxed shadow-inner">
                                                                <b>Opis usterki z placu:</b> {dmg.description}
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {activeTab === "EXPENSES" && (
                                        <div className="space-y-4">
                                            <div className="border-b pb-2 flex justify-between items-center">
                                                <div>
                                                    <h4 className="font-black text-sm text-slate-800">Drobne wydatki i naprawy bieżące z placu budowy:</h4>
                                                    <p className="text-xs text-slate-500">Zarejestrowane przez kierowników i brygadzistów w module Twoja Budowa</p>
                                                </div>
                                                <div className="bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-xl text-right">
                                                    <span className="text-[10px] uppercase font-bold text-emerald-800 block">Suma wydatków:</span>
                                                    <span className="text-sm font-black text-emerald-900">{financials.totalExpenses} zł</span>
                                                </div>
                                            </div>

                                            {siteExpenses.length === 0 ? (
                                                <div className="p-8 text-center bg-white border border-dashed rounded-xl text-slate-400 text-sm">
                                                    Brak zarejestrowanych drobnych wydatków dla tej budowy.
                                                </div>
                                            ) : (
                                                <div className="space-y-2.5">
                                                    {siteExpenses.map((exp: any) => (
                                                        <div key={exp.id} className="p-4 bg-white border rounded-2xl shadow-sm flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                                                            <div>
                                                                <div className="flex items-center gap-2">
                                                                    <p className="font-bold text-slate-800 text-sm">{exp.title}</p>
                                                                    <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded bg-slate-100 text-slate-600">
                                                                        {exp.category || "OGÓLNE"}
                                                                    </span>
                                                                </div>
                                                                <p className="text-xs text-slate-500 mt-1">
                                                                    📅 Data: <b>{exp.date || "-"}</b> • Wprowadził: <b>{exp.reportedByName || "Pracownik"}</b>
                                                                </p>
                                                                {exp.notes && <p className="text-xs text-slate-600 italic mt-1 bg-slate-50 p-2 rounded-lg border">💬 {exp.notes}</p>}
                                                            </div>
                                                            <div className="text-right">
                                                                <span className="text-base font-black text-emerald-600 bg-emerald-50 px-3 py-1 rounded-xl border border-emerald-100">
                                                                    {exp.amount} zł
                                                                </span>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {activeTab === "MANUAL" && (
                                        <div className="space-y-3">
                                            <div className="border-b pb-2 mb-2 flex justify-between items-center">
                                                <h4 className="font-black text-sm text-slate-800">Pozycje dopisane z ręki (&quot;z głowy&quot;):</h4>
                                                <button
                                                    onClick={() => setIsAddManualOpen(true)}
                                                    className="bg-emerald-600 text-white font-bold text-xs px-3 py-1.5 rounded-lg hover:bg-emerald-700"
                                                >
                                                    + Dodaj kolejną pozycję
                                                </button>
                                            </div>
                                            {manualItems.length === 0 ? (
                                                <div className="p-8 text-center bg-white border border-dashed rounded-xl text-slate-400 text-sm">
                                                    Nie dopisano jeszcze żadnych pozycji ręcznych. Kliknij przycisk powyżej, aby dopisać rzecz z głowy.
                                                </div>
                                            ) : (
                                                <div className="space-y-2.5">
                                                    {manualItems.map(m => (
                                                        <div key={m.id} className="p-4 bg-white border rounded-2xl shadow-sm flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                                                            <div>
                                                                <div className="flex items-center gap-2">
                                                                    <p className="font-bold text-slate-900 text-sm">{m.name}</p>
                                                                    <span className="bg-emerald-100 text-emerald-800 font-black text-[9px] px-2 py-0.5 rounded uppercase">Wpis ręczny</span>
                                                                </div>
                                                                {m.notes && <p className="text-xs text-slate-500 mt-1 italic">💬 {m.notes}</p>}
                                                            </div>
                                                            <div className="flex items-center gap-3">
                                                                <span className="text-xs font-bold text-slate-700 bg-slate-100 px-2.5 py-1 rounded-lg">
                                                                    {m.quantity} {m.unit}
                                                                </span>
                                                                <span className="text-xs font-black text-slate-800">
                                                                    {m.estimatedUnitCost * m.quantity} zł
                                                                </span>
                                                                <button
                                                                    onClick={() => handleRemoveManualItem(m.id)}
                                                                    className="text-red-500 hover:text-red-700 font-bold text-sm px-2 py-1"
                                                                >
                                                                    &times;
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {activeTab === "CLAIMS" && (
                                        <div className="space-y-3">
                                            <div className="border-b pb-2 mb-2"><h4 className="font-black text-sm text-slate-800">Sprawy prowadzone przez Sąd PESAM (CLS):</h4></div>
                                            {siteClaims.length === 0 ? (
                                                <p className="text-sm text-slate-500 italic p-4 text-center">Brak spraw szkodowych przypisanych do tego projektu.</p>
                                            ) : (
                                                <div className="space-y-2">
                                                    {siteClaims.map(claim => (
                                                        <div key={claim.id} className="flex justify-between items-center p-3 bg-white border rounded-xl shadow-sm text-sm">
                                                            <span className="font-semibold text-slate-800">{claim.inventoryName}</span>
                                                            <span className={`text-[10px] font-black px-2.5 py-1 rounded uppercase ${claim.status === "ZAMKNIETA" ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-800'}`}>
                                                                {claim.status} {claim.penaltyAmount ? `— Kara: ${claim.penaltyAmount} zł` : ""}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {activeTab === "DETECTIVE" && (
                                        <div className="space-y-4">
                                            <div className="border-b pb-2 flex justify-between items-center">
                                                <div>
                                                    <h4 className="font-black text-sm text-slate-800">Ujawnione uszkodzenia i naprawy serwisowe po zwrocie:</h4>
                                                    <p className="text-xs text-slate-500">Sprzęt zwrócony jako uszkodzony, wymagający serwisu lub już naprawiony na koszt firmy</p>
                                                </div>
                                                <div className="bg-blue-50 border border-blue-200 px-3 py-1.5 rounded-xl text-right">
                                                    <span className="text-[10px] uppercase font-bold text-blue-800 block">Suma napraw:</span>
                                                    <span className="text-sm font-black text-blue-900">{financials.totalRepairs} zł</span>
                                                </div>
                                            </div>

                                            {suspiciousItems.length === 0 ? (
                                                <div className="p-8 text-center bg-white border border-dashed rounded-xl text-slate-400 text-sm">
                                                    Brak urządzeń ze zgłoszonymi awariami lub naprawami powiązanymi z tą budową.
                                                </div>
                                            ) : (
                                                <div className="space-y-3">
                                                    {suspiciousItems.map(item => {
                                                        const currentRepairCost = repairCostOverrides[item.id] !== undefined ? repairCostOverrides[item.id] : (item.repairCost || 0);
                                                        const isRepaired = item.isRepaired || item.status === "sprawne";

                                                        return (
                                                            <div key={item.id} className="p-4 bg-orange-50/70 border border-orange-200 rounded-2xl shadow-sm text-sm space-y-3">
                                                                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                                                                    <div>
                                                                        <div className="flex items-center gap-2">
                                                                            <p className="font-bold text-slate-900 text-base">{item.name}</p>
                                                                            <span className={`text-[10px] font-black px-2.5 py-0.5 rounded-lg uppercase ${
                                                                                isRepaired
                                                                                    ? "bg-green-100 text-green-800 border border-green-200"
                                                                                    : "bg-red-100 text-red-800 border border-red-200"
                                                                            }`}>
                                                                                {isRepaired ? "✅ Naprawione w serwisie" : `⚠️ W bazie: ${item.status}`}
                                                                            </span>
                                                                        </div>
                                                                        <p className="text-[11px] text-slate-500 font-mono mt-0.5">
                                                                            Nr Mag: <b>{item.inventoryNumber || "-"}</b>
                                                                            {item.returnProtocolId ? ` • Protokół zwrotu: ${item.returnProtocolId}` : ""}
                                                                        </p>
                                                                    </div>

                                                                    {/* KOSZT NAPRAWY (EDYTOWALNY Z WYKRYTEJ WARTOŚCI) */}
                                                                    <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-xl border border-orange-200 shadow-sm">
                                                                        <span className="text-xs font-bold text-slate-600">Koszt naprawy:</span>
                                                                        <input
                                                                            type="number"
                                                                            min="0"
                                                                            value={currentRepairCost || ""}
                                                                            placeholder="0"
                                                                            onChange={e => setRepairCostOverrides({ ...repairCostOverrides, [item.id]: Math.max(0, parseInt(e.target.value) || 0) })}
                                                                            className="w-16 text-center font-black text-blue-700 outline-none border-b border-slate-300 focus:border-blue-500"
                                                                        />
                                                                        <span className="text-xs font-bold text-slate-500">zł</span>
                                                                    </div>
                                                                </div>

                                                                <div className="p-3 bg-white border border-orange-100 rounded-xl text-xs leading-relaxed text-slate-700 shadow-inner">
                                                                    <b>Zapis z kartoteki / usterka:</b> {item.failureDescription}
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {activeTab === "HISTORY" && (
                                        <div className="space-y-3">
                                            <div className="border-b pb-2 mb-2"><h4 className="font-black text-sm text-slate-800">Historia wydań, zwrotów i dostaw powiązanych z budową:</h4></div>
                                            {siteProtocols.length === 0 ? (
                                                <p className="text-sm text-slate-500 italic p-4 text-center">Brak zarejestrowanych protokołów.</p>
                                            ) : (
                                                <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                                                    {siteProtocols.map(proto => (
                                                        <div key={proto.id} className="p-3 bg-white border rounded-xl shadow-sm text-xs flex justify-between items-center hover:border-blue-400 transition">
                                                            <div>
                                                                <p className="font-black text-slate-800">{proto.protocolId}</p>
                                                                <p className="text-[10px] text-slate-400 font-bold uppercase mt-0.5">{proto.type} — {proto.createdAt.split('T')[0]}</p>
                                                            </div>
                                                            <span className="text-slate-500 font-medium">{proto.createdByName || "System"}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* SEKCJA UWAG OGÓLNYCH AUDYTORA DO RAPORTU KOŃCOWEGO */}
                                <div className="p-4 bg-slate-50 border-t border-slate-200">
                                    <label className="block text-[11px] font-black text-slate-600 uppercase tracking-wide mb-1">
                                        📝 Ogólne uwagi audytora do zamknięcia budowy (widoczne dla Kierownika, Dyrekcji i Prezesa):
                                    </label>
                                    <textarea
                                        rows={2}
                                        placeholder="np. Budowa zakończona w terminie. Ogrodzenie zablokowane na wniosek inwestora – sprawa w toku. Łata niwelatora złomowana ze względu na brak części..."
                                        value={generalNotes}
                                        onChange={e => setGeneralNotes(e.target.value)}
                                        className="w-full p-2.5 bg-white border border-slate-300 rounded-xl text-xs font-medium outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>

                                {/* STOPKA: WYBÓR KIEROWNIKA I INICJOWANIE */}
                                <div className="p-5 border-t bg-slate-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                                    <div className="flex items-center gap-2 w-full sm:w-auto">
                                        <span className="text-xs font-black text-slate-600 uppercase whitespace-nowrap">Odp. Kierownik:</span>
                                        <select
                                            value={selectedManagerUid}
                                            onChange={e => setSelectedManagerUid(e.target.value)}
                                            className="p-2.5 bg-white border border-slate-300 rounded-xl text-xs font-bold text-slate-700 outline-none cursor-pointer w-full sm:w-64 shadow-sm"
                                        >
                                            <option value="">-- Wybierz Kierownika Budowy --</option>
                                            {users.filter(u => u.uid).map(u => (
                                                <option key={u.uid} value={u.uid}>{u.firstName} {u.lastName} ({u.email})</option>
                                            ))}
                                        </select>
                                    </div>
                                    <button
                                        onClick={handleInitiateCloseout}
                                        disabled={isProcessing || !selectedManagerUid}
                                        className="bg-red-600 hover:bg-red-700 text-white font-black px-6 py-3.5 rounded-xl shadow-lg transition disabled:bg-slate-400 flex items-center gap-2 text-sm uppercase tracking-wide w-full sm:w-auto justify-center"
                                    >
                                        {isProcessing ? "Inicjowanie..." : "Zatwierdź Audyt i wyślij do podpisu ✍️"}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* MODAL DOPISYWANIA POZYCJI "Z GŁOWY" / RĘCZNEJ */}
            {isAddManualOpen && (
                <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-200 animate-fade-in space-y-4">
                        <div className="flex justify-between items-center border-b pb-3">
                            <h3 className="font-black text-slate-800 text-lg">➕ Dopisz pozycję z ręki (&quot;z głowy&quot;)</h3>
                            <button onClick={() => setIsAddManualOpen(false)} className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 font-bold text-slate-500">&times;</button>
                        </div>
                        <form onSubmit={handleAddManualItem} className="space-y-3 text-xs">
                            <div>
                                <label className="block font-bold text-slate-700 mb-1 uppercase text-[10px]">Nazwa przedmiotu:</label>
                                <input
                                    type="text"
                                    placeholder="np. Przewód siłowy 50m / Zaginiony klucz do rusztowań"
                                    value={newManualName}
                                    onChange={e => setNewManualName(e.target.value)}
                                    className="w-full p-2.5 border rounded-xl font-bold bg-slate-50 outline-none focus:bg-white focus:border-blue-500"
                                    required
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block font-bold text-slate-700 mb-1 uppercase text-[10px]">Ilość:</label>
                                    <input
                                        type="number"
                                        min="1"
                                        value={newManualQty}
                                        onChange={e => setNewManualQty(Math.max(1, parseInt(e.target.value) || 1))}
                                        className="w-full p-2.5 border rounded-xl font-bold bg-slate-50 outline-none focus:bg-white focus:border-blue-500"
                                    />
                                </div>
                                <div>
                                    <label className="block font-bold text-slate-700 mb-1 uppercase text-[10px]">Jednostka:</label>
                                    <input
                                        type="text"
                                        value={newManualUnit}
                                        onChange={e => setNewManualUnit(e.target.value)}
                                        className="w-full p-2.5 border rounded-xl font-bold bg-slate-50 outline-none focus:bg-white focus:border-blue-500"
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block font-bold text-slate-700 mb-1 uppercase text-[10px]">Status / Decyzja:</label>
                                    <select
                                        value={newManualRes}
                                        onChange={e => setNewManualRes(e.target.value as ResolutionType)}
                                        className="w-full p-2.5 border rounded-xl font-bold bg-slate-50 outline-none focus:bg-white focus:border-blue-500 cursor-pointer"
                                    >
                                        <option value="LOSS">❌ Strata / Dług</option>
                                        <option value="DISPUTED_INVESTOR">🚧 U Inwestora</option>
                                        <option value="SCRAPPED">♻️ Złomowanie</option>
                                        <option value="CONSUMED">🧼 Zużycie</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block font-bold text-slate-700 mb-1 uppercase text-[10px]">Orientacyjna cena (zł):</label>
                                    <input
                                        type="number"
                                        min="0"
                                        placeholder="np. 150"
                                        value={newManualCost || ""}
                                        onChange={e => setNewManualCost(Math.max(0, parseInt(e.target.value) || 0))}
                                        className="w-full p-2.5 border rounded-xl font-bold bg-slate-50 outline-none focus:bg-white focus:border-blue-500"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block font-bold text-slate-700 mb-1 uppercase text-[10px]">Notatka / Uzasadnienie:</label>
                                <textarea
                                    rows={2}
                                    placeholder="np. Zabrane przez podwykonawców, nie było w kwicie..."
                                    value={newManualNotes}
                                    onChange={e => setNewManualNotes(e.target.value)}
                                    className="w-full p-2.5 border rounded-xl font-medium bg-slate-50 outline-none focus:bg-white focus:border-blue-500"
                                />
                            </div>

                            <div className="pt-2 flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => setIsAddManualOpen(false)}
                                    className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl uppercase text-[10px]"
                                >
                                    Anuluj
                                </button>
                                <button
                                    type="submit"
                                    className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl uppercase text-[10px] shadow-md"
                                >
                                    Dodaj do audytu
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
