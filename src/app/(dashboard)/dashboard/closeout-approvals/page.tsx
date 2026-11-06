"use client";

import React, { useState, useEffect } from "react";
import { collection, getDocs, doc, setDoc, query, where, getDoc, updateDoc, runTransaction } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";

interface CloseoutDoc {
    id: string;
    siteId: string;
    siteName: string;
    status: "OCZEKUJE_NA_KIEROWNIKA" | "OCZEKUJE_NA_DYREKCJE" | "ROZLICZONA";
    initiatedBy: string;
    initiatedByName: string;
    initiatedAt: string;
    managerUid?: string;
    managerName?: string;
    managerEmail?: string;
    managerSignedAt?: string;
    directorUid?: string;
    directorName?: string;
    directorSignedAt?: string;
    generalNotes?: string;
    financialSummary?: {
        totalLossCost: number;
        totalDisputedCost: number;
        totalScrappedCost: number;
        totalRepairsCost?: number;
        totalExpensesCost?: number;
    };
    debtsList: any[];
    excludedItems?: any[];
    siteDamagesList?: any[];
    siteExpensesList?: any[];
    claimsList: any[];
    detectiveList: any[];
}

export default function CloseoutApprovalsPage() {
    const { user } = useAuth();
    const [closeouts, setCloseouts] = useState<CloseoutDoc[]>([]);
    const [selectedCloseout, setSelectedCloseout] = useState<CloseoutDoc | null>(null);
    const [loading, setLoading] = useState(true);
    const [isProcessing, setIsProcessing] = useState(false);
    const [activeTab, setActiveTab] = useState<"DEBTS" | "DISPUTED" | "SCRAPPED" | "DAMAGES" | "EXPENSES" | "CLAIMS" | "DETECTIVE">("DEBTS");
    const [isSandboxActive, setIsSandboxActive] = useState(true);

    useEffect(() => {
        fetchCloseouts();
    }, [user]);

    const fetchCloseouts = async () => {
        if (!user) return;
        setLoading(true);
        try {
            const settingsSnap = await getDoc(doc(db, "settings", "system"));
            if (settingsSnap.exists()) {
                const sData = settingsSnap.data();
                setIsSandboxActive(sData.isCloseoutSandboxMode !== undefined ? sData.isCloseoutSandboxMode : true);
            }

            const snap = await getDocs(collection(db, "closeouts"));
            const allCloseouts = snap.docs.map(d => ({ id: d.id, ...d.data() })) as CloseoutDoc[];

            const canManageGlobally = hasPermission("manageProjectCloseouts", user.rolePermissions, user.permissionOverrides);
            const canApprove = hasPermission("approveProjectCloseouts", user.rolePermissions, user.permissionOverrides);

            if (canManageGlobally) {
                setCloseouts(allCloseouts.filter(c => c.status !== "ROZLICZONA"));
            } else if (canApprove) {
                setCloseouts(allCloseouts.filter(c => c.managerUid === user.uid && c.status === "OCZEKUJE_NA_KIEROWNIKA"));
            } else {
                setCloseouts([]);
            }
        } catch (error) {
            console.error("Błąd pobierania obiegów rozliczeniowych:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleCancelCloseout = async (closeout: CloseoutDoc) => {
        if (!window.confirm("⚠️ UWAGA!\n\nCzy na pewno chcesz anulować ten obieg rozliczeniowy? Rozliczenie zostanie skasowane, a budowa wróci do statusu AKTYWNA, co pozwoli zainicjować audyt na nowo z innym kierownikiem.")) return;

        setIsProcessing(true);
        try {
            await runTransaction(db, async (transaction) => {
                const closeoutRef = doc(db, "closeouts", closeout.id);
                transaction.delete(closeoutRef);

                const siteRef = doc(db, "sites", closeout.siteId);
                transaction.update(siteRef, { status: "aktywna" });
            });

            alert("🗑️ Rozliczenie zostało pomyślnie anulowane. Budowa jest z powrotem aktywna.");
            setSelectedCloseout(null);
            fetchCloseouts();
        } catch (error) {
            console.error("Błąd anulowania rozliczenia:", error);
            alert("Wystąpił błąd podczas anulowania: " + error);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleSignAsManager = async () => {
        if (!selectedCloseout || !user) return;

        if (!window.confirm("Czy potwierdzasz zgodność stanu rozliczenia i składasz podpis cyfrowy?")) {
            return;
        }

        setIsProcessing(true);
        try {
            const closeoutRef = doc(db, "closeouts", selectedCloseout.id);

            await updateDoc(closeoutRef, {
                status: "OCZEKUJE_NA_DYREKCJE",
                managerSignedAt: new Date().toISOString(),
                managerName: `${user.firstName} ${user.lastName}`
            });

            try {
                await fetch("/api/closeout-email", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        type: "CLOSEOUT_SIGNED_BY_MANAGER",
                        siteName: selectedCloseout.siteName,
                        managerName: `${user.firstName} ${user.lastName}`,
                        managerEmail: user.email,
                        warehousemanName: selectedCloseout.initiatedByName,
                        debtsList: selectedCloseout.debtsList,
                        detectiveList: selectedCloseout.detectiveList,
                        siteDamagesList: selectedCloseout.siteDamagesList,
                        siteExpensesList: selectedCloseout.siteExpensesList,
                        generalNotes: selectedCloseout.generalNotes,
                        financialSummary: selectedCloseout.financialSummary
                    })
                });
            } catch (mailError) {
                console.error("Błąd wysyłki powiadomienia do dyrekcji:", mailError);
            }

            alert(`✍️ Twój podpis został pomyślnie złożony! Sprawa została przekazana do ostatecznego zatwierdzenia przez Dyrekcję i Prezesa.`);
            setSelectedCloseout(null);
            fetchCloseouts();
        } catch (error) {
            console.error("Błąd składania podpisu:", error);
            alert("Błąd składania podpisu: " + error);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleSignAsDirector = async () => {
        if (!selectedCloseout || !user) return;
        if (!window.confirm("⚠️ OSTATECZNA DECYZJA ZARZĄDU / DYREKCJI\n\nCzy akceptujesz raport finansowy strat i ostatecznie zamykasz projekt? Ta operacja zaktualizuje stany inwentarza.")) return;

        setIsProcessing(true);
        try {
            await runTransaction(db, async (transaction) => {
                const closeoutRef = doc(db, "closeouts", selectedCloseout.id);
                transaction.update(closeoutRef, {
                    status: "ROZLICZONA",
                    directorUid: user.uid,
                    directorName: `${user.firstName} ${user.lastName}`,
                    directorSignedAt: new Date().toISOString()
                });

                const siteRef = doc(db, "sites", selectedCloseout.siteId);
                transaction.update(siteRef, { status: "ZAKOŃCZONA", closedAt: new Date().toISOString() });

                if (selectedCloseout.debtsList && selectedCloseout.debtsList.length > 0) {
                    const protocolRef = doc(collection(db, "protocols"));
                    const protocolId = `LIKW-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.floor(100 + Math.random() * 900)}`;
                    const lostItemsList = [];

                    for (const debt of selectedCloseout.debtsList) {
                        if (!debt.id || debt.isManualEntry) continue;

                        const itemRef = doc(db, "inventory", debt.id);
                        const itemDoc = await transaction.get(itemRef);
                        if (!itemDoc.exists()) continue;

                        const data = itemDoc.data();
                        const qtyLost = debt.quantity || 0;

                        // W PRZYPADKU SPRZĘTU SPORNEGO U INWESTORA: NIE NISZCZYMY/NIE LIKWIDUJEMY SPRZĘTU!
                        if (debt.resolution === "DISPUTED_INVESTOR") {
                            if (data.type === "UNIQUE") {
                                transaction.update(itemRef, {
                                    status: "spór_z_inwestorem",
                                    currentLocation: `SPÓR Z INWESTOREM (${selectedCloseout.siteName})`,
                                    [`allocations.${selectedCloseout.siteId}`]: 0
                                });
                            } else {
                                transaction.update(itemRef, {
                                    [`allocations.${selectedCloseout.siteId}`]: 0
                                });
                            }
                            continue;
                        }

                        // W PRZYPADKU STRATY LUB ZŁOMOWANIA
                        if (data.type === "UNIQUE") {
                            transaction.update(itemRef, {
                                status: debt.resolution === "SCRAPPED" ? "złomowane" : "zagubione",
                                currentLocation: debt.resolution === "SCRAPPED" ? "UTYLIZACJA / ZŁOM" : "STRATY / BRAKI",
                                availableQuantity: 0,
                                [`allocations.${selectedCloseout.siteId}`]: 0
                            });
                        } else {
                            const currentTotal = data.totalQuantity || 0;
                            transaction.update(itemRef, {
                                totalQuantity: Math.max(0, currentTotal - qtyLost),
                                [`allocations.${selectedCloseout.siteId}`]: 0
                            });
                        }

                        lostItemsList.push({
                            inventoryId: debt.id,
                            name: debt.name,
                            type: data.type,
                            inventoryNumber: debt.inventoryNumber || "BRAK",
                            quantity: qtyLost,
                            unit: data.unit || "szt.",
                            finalStatus: debt.resolution === "CONSUMED" ? "ZUŻYCIE" : debt.resolution === "SCRAPPED" ? "ZŁOMOWANIE" : "STRATA",
                            notes: debt.notes || ""
                        });
                    }

                    if (lostItemsList.length > 0) {
                        transaction.set(protocolRef, {
                            protocolId,
                            type: "LIKWIDACJA",
                            sourceId: selectedCloseout.siteId,
                            sourceName: selectedCloseout.siteName,
                            destinationId: "STRATY",
                            destinationName: "Odpis w koszty",
                            createdBy: user?.uid,
                            createdByName: `${user?.firstName} ${user?.lastName}`,
                            status: "ZAAKCEPTOWANY",
                            createdAt: new Date().toISOString(),
                            documentDate: new Date().toISOString().split('T')[0],
                            items: lostItemsList,
                            notes: selectedCloseout.generalNotes || "Odpis strat na podstawie zamknięcia budowy."
                        });
                    }
                }
            });

            try {
                await fetch("/api/closeout-email", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        type: "CLOSEOUT_FINALIZED",
                        siteName: selectedCloseout.siteName,
                        managerName: selectedCloseout.managerName || "Brak",
                        managerEmail: selectedCloseout.managerEmail || "",
                        warehousemanName: selectedCloseout.initiatedByName,
                        debtsList: selectedCloseout.debtsList,
                        detectiveList: selectedCloseout.detectiveList,
                        siteDamagesList: selectedCloseout.siteDamagesList,
                        siteExpensesList: selectedCloseout.siteExpensesList,
                        generalNotes: selectedCloseout.generalNotes,
                        financialSummary: selectedCloseout.financialSummary
                    })
                });
            } catch (mailError) {
                console.error("Błąd wysyłki końcowego maila:", mailError);
            }

            alert(`✅ Projekt został oficjalnie rozliczony i ZAMKNIĘTY!\n\nRaport końcowy został przesłany do sygnatariuszy, a dane zapisano trwale w archiwum.`);
            setSelectedCloseout(null);
            fetchCloseouts();
        } catch (error) {
            alert("Błąd podczas podpisywania: " + error);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleSendTestEmail = async (closeout: CloseoutDoc) => {
        setIsProcessing(true);
        try {
            const emailTypeToTest = closeout.status === "OCZEKUJE_NA_KIEROWNIKA"
                ? "CLOSEOUT_SIGNED_BY_MANAGER"
                : "CLOSEOUT_FINALIZED";

            const response = await fetch("/api/closeout-email", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    type: emailTypeToTest,
                    siteName: closeout.siteName,
                    managerName: closeout.managerName || user?.firstName + " " + user?.lastName,
                    managerEmail: closeout.managerEmail || user?.email,
                    warehousemanName: closeout.initiatedByName,
                    debtsList: closeout.debtsList,
                    detectiveList: closeout.detectiveList,
                    siteDamagesList: closeout.siteDamagesList,
                    siteExpensesList: closeout.siteExpensesList,
                    generalNotes: closeout.generalNotes,
                    financialSummary: closeout.financialSummary
                })
            });

            const result = await response.json();

            if (result.success) {
                alert(`🧪 WYSYŁKA TESTOWA (SANDBOX):\nWiadomość [ ${emailTypeToTest} ] została pomyślnie wysłana na Twoje skrzynki testowe.`);
            } else {
                throw new Error(result.error || "Nieznany błąd serwera");
            }
        } catch (error) {
            console.error("Błąd w handleSendTestEmail:", error);
            alert("Błąd testowej wysyłki: " + error);
        } finally {
            setIsProcessing(false);
        }
    };

    if (!user || !hasPermission("approveProjectCloseouts", user.rolePermissions, user.permissionOverrides)) {
        return <div className="p-10 text-center text-slate-500">Brak uprawnień do zatwierdzania zamknięć budów.</div>;
    }

    if (loading) return <div className="p-10 text-center animate-pulse">Wczytywanie spraw do zatwierdzenia...</div>;

    const canManageGlobally = hasPermission("manageProjectCloseouts", user.rolePermissions, user.permissionOverrides);

    // Filtrowanie pozycji wg statusu
    const lossItems = (selectedCloseout?.debtsList || []).filter(i => i.resolution === "LOSS" || !i.resolution);
    const disputedItems = (selectedCloseout?.debtsList || []).filter(i => i.resolution === "DISPUTED_INVESTOR");
    const scrappedItems = (selectedCloseout?.debtsList || []).filter(i => i.resolution === "SCRAPPED");

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto animate-fade-in font-sans space-y-6">

            {/* BANER SANDBOX */}
            {isSandboxActive && (
                <div className="bg-orange-50 border-2 border-dashed border-orange-200 p-4 rounded-3xl flex justify-between items-center shadow-sm">
                    <div className="flex items-center gap-3">
                        <span className="text-2xl">🧪</span>
                        <div>
                            <p className="text-xs font-black text-orange-950 uppercase tracking-wider">Tryb piaskownicy (Sandbox) jest AKTYWNY</p>
                            <p className="text-[11px] text-orange-800">Wszystkie powiadomienia e-mail i wysyłki raportów są przekierowywane na Twoje adresy testowe z Ustawień Systemu.</p>
                        </div>
                    </div>
                </div>
            )}

            <div>
                <h1 className="text-3xl font-black text-slate-800 tracking-tight">✍️ Zatwierdzanie Zamknięć</h1>
                <p className="text-slate-500 text-sm mt-1">Złóż cyfrowy podpis pod audytem końcowym budowy, aby zakończyć projekt.</p>
            </div>

            <div className="flex flex-col md:flex-row gap-6">
                {/* LEWA KOLUMNA: LISTA SPRAW */}
                <div className="w-full md:w-1/3 space-y-3">
                    <div className="bg-slate-900 text-white p-4 rounded-xl shadow-md">
                        <h3 className="font-black text-xs uppercase tracking-wider">Rozliczenia budów</h3>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-xl p-3 h-[55vh] overflow-y-auto space-y-2 shadow-sm">
                        {closeouts.length === 0 ? (
                            <p className="text-slate-400 text-xs p-4 text-center">Brak spraw oczekujących na Twój podpis.</p>
                        ) : (
                            closeouts.map(closeout => (
                                <button
                                    key={closeout.id}
                                    onClick={() => setSelectedCloseout(closeout)}
                                    className={`w-full text-left p-4 rounded-lg border transition ${selectedCloseout?.id === closeout.id ? 'bg-blue-600 border-blue-600 text-white shadow-md' : 'bg-white border-slate-100 hover:border-blue-200 hover:bg-slate-50'}`}
                                >
                                    <p className={`font-bold text-sm ${selectedCloseout?.id === closeout.id ? 'text-white' : 'text-slate-800'}`}>{closeout.siteName}</p>
                                    <p className={`text-[10px] uppercase mt-2 font-black ${selectedCloseout?.id === closeout.id ? 'text-blue-200' : 'text-orange-600'}`}>
                                        {closeout.status === "OCZEKUJE_NA_KIEROWNIKA" ? "⏳ Czeka na Kierownika" : "⏳ Czeka na Dyrekcję / Prezesa"}
                                    </p>
                                </button>
                            ))
                        )}
                    </div>
                </div>

                {/* PRAWA KOLUMNA: SZCZEGÓŁY SPRAWY I DECYZJA */}
                <div className="w-full md:w-2/3">
                    {!selectedCloseout ? (
                        <div className="h-full flex flex-col items-center justify-center bg-slate-50 border-2 border-dashed border-slate-200 rounded-2xl p-12 text-slate-400">
                            <span className="text-5xl mb-4">✍️</span>
                            <p className="font-black text-slate-700 text-center">Wybierz budowę, aby zapoznać się ze stanem strat i złożyć podpis.</p>
                        </div>
                    ) : (
                        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col max-h-[88vh]">

                            {/* NAGŁÓWEK */}
                            <div className="p-6 bg-slate-900 border-b border-slate-800 text-white flex justify-between items-center">
                                <div>
                                    <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest">Szczegóły do podpisu</p>
                                    <h2 className="text-xl font-black">{selectedCloseout.siteName}</h2>
                                </div>
                                <span className="bg-orange-500 text-white font-black px-3 py-1 rounded text-[10px] uppercase">
                                    {selectedCloseout.status === "OCZEKUJE_NA_KIEROWNIKA" ? "Podpis Kierownika" : "Autoryzacja Zarządu"}
                                </span>
                            </div>

                            {/* BILANS FINANSOWY DLA SZEFA */}
                            {selectedCloseout.financialSummary && (
                                <div className="bg-slate-800 text-white px-6 py-2.5 flex flex-wrap justify-between items-center text-xs border-b border-slate-700 gap-2">
                                    <span className="font-bold text-slate-300">Wartość strat i kosztów:</span>
                                    <div className="flex flex-wrap gap-4 font-bold">
                                        <span className="text-red-400">Straty: <b>{selectedCloseout.financialSummary.totalLossCost || 0} zł</b></span>
                                        <span className="text-amber-400">U Inwestora: <b>{selectedCloseout.financialSummary.totalDisputedCost || 0} zł</b></span>
                                        <span className="text-slate-400">Złomowane: <b>{selectedCloseout.financialSummary.totalScrappedCost || 0} zł</b></span>
                                        <span className="text-blue-400">Naprawy: <b>{selectedCloseout.financialSummary.totalRepairsCost || 0} zł</b></span>
                                        <span className="text-emerald-400">Wydatki budowy: <b>{selectedCloseout.financialSummary.totalExpensesCost || 0} zł</b></span>
                                    </div>
                                </div>
                            )}

                            {/* UWAGI AUDYTORA */}
                            {selectedCloseout.generalNotes && (
                                <div className="p-4 bg-blue-50 border-b border-blue-100 text-xs text-blue-900">
                                    <b>Notatka audytora:</b> {selectedCloseout.generalNotes}
                                </div>
                            )}

                            {/* ZAKŁADKI POZYCJI */}
                            <div className="bg-slate-100 p-2 border-b flex flex-wrap gap-2 text-xs font-bold">
                                <button onClick={() => setActiveTab("DEBTS")} className={`px-3 py-1.5 rounded-lg ${activeTab === "DEBTS" ? "bg-blue-600 text-white" : "bg-white text-slate-600 border"}`}>
                                    ❌ Straty ({lossItems.length})
                                </button>
                                <button onClick={() => setActiveTab("DISPUTED")} className={`px-3 py-1.5 rounded-lg ${activeTab === "DISPUTED" ? "bg-amber-600 text-white" : "bg-white text-slate-600 border"}`}>
                                    🚧 U Inwestora ({disputedItems.length})
                                </button>
                                <button onClick={() => setActiveTab("SCRAPPED")} className={`px-3 py-1.5 rounded-lg ${activeTab === "SCRAPPED" ? "bg-slate-700 text-white" : "bg-white text-slate-600 border"}`}>
                                    ♻️ Złomowanie ({scrappedItems.length})
                                </button>
                                <button onClick={() => setActiveTab("DAMAGES")} className={`px-3 py-1.5 rounded-lg ${activeTab === "DAMAGES" ? "bg-orange-600 text-white" : "bg-white text-slate-600 border"}`}>
                                    💥 Zgłoszone Usterki ({selectedCloseout.siteDamagesList?.length || 0})
                                </button>
                                <button onClick={() => setActiveTab("EXPENSES")} className={`px-3 py-1.5 rounded-lg ${activeTab === "EXPENSES" ? "bg-emerald-600 text-white" : "bg-white text-emerald-800 border"}`}>
                                    💰 Wydatki Budowy ({selectedCloseout.siteExpensesList?.length || 0})
                                </button>
                                <button onClick={() => setActiveTab("CLAIMS")} className={`px-3 py-1.5 rounded-lg ${activeTab === "CLAIMS" ? "bg-blue-600 text-white" : "bg-white text-slate-600 border"}`}>
                                    ⚖️ Sąd ({selectedCloseout.claimsList?.length || 0})
                                </button>
                                <button onClick={() => setActiveTab("DETECTIVE")} className={`px-3 py-1.5 rounded-lg ${activeTab === "DETECTIVE" ? "bg-blue-600 text-white" : "bg-white text-slate-600 border"}`}>
                                    🕵️ Detektyw & Naprawy ({selectedCloseout.detectiveList?.length || 0})
                                </button>
                            </div>

                            {/* ZAWARTOŚĆ POZYCJI DO PODPISU */}
                            <div className="flex-1 overflow-y-auto p-6 bg-slate-50 space-y-3">
                                {activeTab === "DEBTS" && (
                                    <div className="space-y-2">
                                        <p className="text-xs font-bold text-slate-500 uppercase pb-1 border-b">Straty bezpośrednie obciążające budowę:</p>
                                        {lossItems.length === 0 ? <p className="text-sm italic text-green-700 font-bold p-3">Brak bezpośrednich strat.</p> : lossItems.map((item, idx) => (
                                            <div key={idx} className="p-3.5 bg-white border rounded-xl flex justify-between items-center text-sm shadow-sm">
                                                <div>
                                                    <p className="font-bold text-slate-800">{item.name}</p>
                                                    <p className="text-[10px] text-slate-400 font-mono">Nr Mag: {item.inventoryNumber || "-"}</p>
                                                    {item.notes && <p className="text-xs text-red-700 italic mt-0.5">💬 {item.notes}</p>}
                                                </div>
                                                <div className="text-right">
                                                    <span className="bg-red-50 text-red-700 border border-red-200 text-xs font-black px-2.5 py-1 rounded-lg">
                                                        {item.quantity} {item.unit || "szt."}
                                                    </span>
                                                    {item.estimatedTotalCost ? <p className="text-xs font-bold text-slate-700 mt-1">~{item.estimatedTotalCost} zł</p> : null}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {activeTab === "DISPUTED" && (
                                    <div className="space-y-2">
                                        <p className="text-xs font-bold text-amber-800 uppercase pb-1 border-b">Sprzęt pozostawiony na budowie (spór z inwestorem / do refakturowania):</p>
                                        {disputedItems.length === 0 ? <p className="text-sm italic text-slate-500 p-3">Brak sprzętu w toku sporów z inwestorem.</p> : disputedItems.map((item, idx) => (
                                            <div key={idx} className="p-3.5 bg-amber-50/70 border border-amber-200 rounded-xl flex justify-between items-center text-sm shadow-sm">
                                                <div>
                                                    <p className="font-bold text-amber-950">{item.name}</p>
                                                    <p className="text-[10px] text-amber-700 font-mono">Nr Mag: {item.inventoryNumber || "-"}</p>
                                                    {item.notes && <p className="text-xs text-amber-800 italic mt-0.5">💬 Sytuacja: {item.notes}</p>}
                                                </div>
                                                <div className="text-right">
                                                    <span className="bg-amber-100 text-amber-900 border border-amber-300 text-xs font-black px-2.5 py-1 rounded-lg">
                                                        {item.quantity} {item.unit || "szt."}
                                                    </span>
                                                    {item.estimatedTotalCost ? <p className="text-xs font-bold text-amber-900 mt-1">Wartość: ~{item.estimatedTotalCost} zł</p> : null}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {activeTab === "SCRAPPED" && (
                                    <div className="space-y-2">
                                        <p className="text-xs font-bold text-slate-600 uppercase pb-1 border-b">Sprzęt zutylizowany / zezłomowany:</p>
                                        {scrappedItems.length === 0 ? <p className="text-sm italic text-slate-500 p-3">Brak sprzętu do złomowania.</p> : scrappedItems.map((item, idx) => (
                                            <div key={idx} className="p-3.5 bg-white border border-slate-200 rounded-xl flex justify-between items-center text-sm shadow-sm">
                                                <div>
                                                    <p className="font-bold text-slate-800">{item.name}</p>
                                                    <p className="text-[10px] text-slate-400 font-mono">Nr Mag: {item.inventoryNumber || "-"}</p>
                                                    <p className="text-xs text-slate-600 italic mt-0.5">⚙️ Powód: {item.notes || "Brak możliwości naprawy / części"}</p>
                                                </div>
                                                <div className="text-right">
                                                    <span className="bg-slate-100 text-slate-700 border text-xs font-black px-2.5 py-1 rounded-lg">
                                                        {item.quantity} {item.unit || "szt."}
                                                    </span>
                                                    {item.estimatedTotalCost ? <p className="text-xs font-bold text-slate-600 mt-1">~{item.estimatedTotalCost} zł</p> : null}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {activeTab === "DAMAGES" && (
                                    <div className="space-y-2">
                                        <p className="text-xs font-bold text-slate-600 uppercase pb-1 border-b">Awarie zgłoszone z placu budowy:</p>
                                        {(selectedCloseout.siteDamagesList || []).length === 0 ? <p className="text-sm italic text-slate-500 p-3">Brak zgłoszeń.</p> : selectedCloseout.siteDamagesList?.map((dmg: any, idx: number) => (
                                            <div key={idx} className="p-3.5 bg-orange-50 border border-orange-200 rounded-xl text-xs space-y-1">
                                                <div className="flex justify-between items-center">
                                                    <p className="font-bold text-slate-800 text-sm">{dmg.inventoryName}</p>
                                                    <span className="bg-orange-200 text-orange-900 font-bold px-2 py-0.5 rounded">{dmg.quantity} {dmg.unit || "szt."}</span>
                                                </div>
                                                <p className="text-slate-600 italic">Opis: {dmg.description}</p>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {activeTab === "EXPENSES" && (
                                    <div className="space-y-2">
                                        <p className="text-xs font-bold text-emerald-800 uppercase pb-1 border-b">Drobne wydatki i naprawy na budowie:</p>
                                        {(selectedCloseout.siteExpensesList || []).length === 0 ? (
                                            <p className="text-sm italic text-slate-500 p-3">Brak zarejestrowanych drobnych wydatków z tej budowy.</p>
                                        ) : (
                                            selectedCloseout.siteExpensesList?.map((exp: any, idx: number) => (
                                                <div key={idx} className="p-3.5 bg-white border rounded-xl flex justify-between items-center text-xs shadow-sm">
                                                    <div>
                                                        <div className="flex items-center gap-2">
                                                            <p className="font-bold text-slate-800 text-sm">{exp.title}</p>
                                                            <span className="text-[9px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded uppercase font-bold">{exp.category || "OGÓLNE"}</span>
                                                        </div>
                                                        <p className="text-[10px] text-slate-500 mt-0.5">📅 {exp.date || "-"} • Wprowadził: <b>{exp.reportedByName || "Pracownik"}</b></p>
                                                        {exp.notes && <p className="text-slate-600 italic mt-0.5">💬 {exp.notes}</p>}
                                                    </div>
                                                    <span className="text-sm font-black text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-100">
                                                        {exp.amount} zł
                                                    </span>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                )}

                                {activeTab === "CLAIMS" && (
                                    <div className="space-y-2">
                                        <p className="text-xs font-bold text-slate-500 uppercase pb-1 border-b">Sprawy w Sądzie CLS:</p>
                                        {(selectedCloseout.claimsList || []).length === 0 ? <p className="text-sm italic text-slate-500 p-3">Brak spraw.</p> : selectedCloseout.claimsList.map((claim, idx) => (
                                            <div key={idx} className="p-3 bg-white border rounded-xl flex justify-between items-center text-sm">
                                                <span className="font-bold text-slate-800">{claim.inventoryName}</span>
                                                <span className="text-[10px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-black uppercase">{claim.status}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {activeTab === "DETECTIVE" && (
                                    <div className="space-y-2">
                                        <p className="text-xs font-bold text-slate-500 uppercase pb-1 border-b">Usterki & Naprawy serwisowe po zwrocie:</p>
                                        {(selectedCloseout.detectiveList || []).length === 0 ? <p className="text-sm italic text-slate-500 p-3">Brak awarii.</p> : selectedCloseout.detectiveList.map((item, idx) => (
                                            <div key={idx} className="p-3.5 bg-orange-50/70 border border-orange-200 rounded-xl text-xs space-y-1.5 shadow-sm">
                                                <div className="flex justify-between items-center">
                                                    <div>
                                                        <p className="font-bold text-slate-900 text-sm">{item.name}</p>
                                                        <p className="text-[10px] text-slate-500 font-mono">Nr Mag: {item.inventoryNumber || "-"}</p>
                                                    </div>
                                                    <span className={`text-[10px] font-black px-2 py-0.5 rounded uppercase ${
                                                        item.isRepaired || item.status === "sprawne"
                                                            ? "bg-green-100 text-green-800 border border-green-200"
                                                            : "bg-red-100 text-red-800 border border-red-200"
                                                    }`}>
                                                        {item.isRepaired || item.status === "sprawne" ? "✅ Naprawione w serwisie" : `⚠️ W bazie: ${item.status || "Uszkodzone"}`}
                                                    </span>
                                                </div>
                                                <div className="p-2 bg-white rounded-lg border text-slate-700 leading-relaxed">
                                                    {item.failureDescription}
                                                </div>
                                                {item.repairCost ? (
                                                    <p className="text-xs font-black text-blue-700">
                                                        🔧 Koszt naprawy serwisowej: {item.repairCost} zł
                                                    </p>
                                                ) : null}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* STOPKA Z PRZYCISKAMI PODPISU */}
                            <div className="p-5 border-t bg-slate-100 flex flex-col sm:flex-row justify-between items-center gap-4">
                                <div className="text-xs space-y-1">
                                    <p className="font-black text-slate-600 uppercase">Status sprawy:</p>
                                    <p className="text-slate-500">Zgłosił: <b>{selectedCloseout.initiatedByName}</b></p>
                                    {selectedCloseout.managerName && <p className="text-slate-500">Kierownik: <b>{selectedCloseout.managerName}</b></p>}
                                </div>

                                <div className="flex gap-2 w-full sm:w-auto flex-wrap justify-end">
                                    {canManageGlobally && (
                                        <button onClick={() => handleCancelCloseout(selectedCloseout)} disabled={isProcessing} className="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-xs font-bold px-4 py-3 rounded-xl transition mr-auto">
                                            🗑️ Anuluj rozliczenie
                                        </button>
                                    )}

                                    {isSandboxActive && (
                                        <button onClick={() => handleSendTestEmail(selectedCloseout)} disabled={isProcessing} className="bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold px-4 py-3 rounded-xl transition">
                                            🧪 Testuj e-mail PDF
                                        </button>
                                    )}

                                    {selectedCloseout.status === "OCZEKUJE_NA_KIEROWNIKA" && !canManageGlobally && (
                                        <button
                                            onClick={handleSignAsManager}
                                            disabled={isProcessing}
                                            className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 text-white font-black px-6 py-3 rounded-xl shadow-lg uppercase text-xs tracking-wider"
                                        >
                                            {isProcessing ? "Podpisywanie..." : "✍️ Podpisz i wyślij do Zarządu"}
                                        </button>
                                    )}

                                    {selectedCloseout.status === "OCZEKUJE_NA_DYREKCJE" && canManageGlobally && (
                                        <button
                                            onClick={handleSignAsDirector}
                                            disabled={isProcessing}
                                            className="w-full sm:w-auto bg-green-600 hover:bg-green-700 text-white font-black px-6 py-3 rounded-xl shadow-lg uppercase text-xs tracking-wider"
                                        >
                                            {isProcessing ? "Zamykanie projektu..." : "🔒 Autoryzuj i Zamknij Projekt"}
                                        </button>
                                    )}
                                </div>
                            </div>

                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
