// src/app/(dashboard)/dashboard/page.tsx
"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, getDoc, doc, query, where, orderBy, limit } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { useRouter } from "next/navigation";
import { hasPermission } from "@/lib/auth/permissions";
import Link from "next/link";

// --- INTERFEJSY ---
interface HistoryEntry {
    date: string; type: string; description: string; status: string; user: string;
}

interface InventoryItem {
    id: string; name: string; type: "UNIQUE" | "BULK"; subType?: "MAIN_CAT" | "SUB_ITEM";
    inventoryNumber: string; category: string; subcategory: string; status: string;
    imageUrl: string; currentLocation: string; totalQuantity: number; availableQuantity: number;
    purchasePrice: number; allocations: Record<string, number>;
    requiresInspection?: boolean; lastInspectionDate?: string; nextInspectionDate?: string;
    unit?: string;
}

interface Site {
    id: string; name: string; status?: string; location?: string;
}

interface StorageLocation {
    id: string;
    name: string;
    description?: string;
    totalCapacity: number;     // Łączna pojemność w JPP (miejsca paletowe)
    currentOccupied: number;   // Aktualnie zajęte w JPP
    categories: string[];      // ID kategorii przypisanych do tego miejsca
    alertThreshold: number;    // np. 70 (%)
    criticalThreshold: number; // np. 85 (%)
    updatedAt?: string;
    updatedBy?: string;
}

export default function DashboardPage() {
    const { user, firebaseUser, loading: authLoading } = useAuth();
    const router = useRouter();

    const [items, setItems] = useState<InventoryItem[]>([]);
    const [sites, setSites] = useState<Site[]>([]);
    const [pendingProtocolsCount, setPendingProtocolsCount] = useState(0);
    const [pendingWzCount, setPendingWzCount] = useState(0);
    const [loading, setLoading] = useState(true);

    // NOWE STANY DLA WIDŻETU MIEJSC SKŁADOWANIA (PLAC / HALE)
    const [storageLocations, setStorageLocations] = useState<StorageLocation[]>([]);
    const [isStorageWidgetVisible, setIsStorageWidgetVisible] = useState<boolean>(true);
    const [activeLocationModal, setActiveLocationModal] = useState<StorageLocation | null>(null);
    const [modalSearchTerm, setModalSearchTerm] = useState("");
    const [modalCategoryFilter, setModalCategoryFilter] = useState("ALL");
    const [sendingAlertLocationId, setSendingAlertLocationId] = useState<string | null>(null);

    // Wysyłanie alertu e-mail o zapełnieniu (dla wybranej strefy lub dla wszystkich przepełnionych)
    const handleSendCapacityAlert = async (targetLoc?: StorageLocation) => {
        const updater = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || 'Dyspozytor' : 'Dyspozytor';
        const targetId = targetLoc ? targetLoc.id : "ALL";

        const locsToSend = targetLoc
            ? [targetLoc]
            : storageLocations.filter(l => {
                const fill = l.totalCapacity > 0 ? (l.currentOccupied / l.totalCapacity) * 100 : 0;
                return fill >= (l.alertThreshold || 70);
            });

        if (locsToSend.length === 0) {
            alert("Żadna ze stref nie przekracza progu ostrzegawczego (>= 70%). Możesz jednak wysłać alert bezpośrednio z poziomu konkretnej strefy.");
            return;
        }

        const confirmText = targetLoc
            ? `Czy na pewno chcesz wysłać powiadomienie e-mail o stanie strefy: "${targetLoc.name}"?`
            : `Czy na pewno chcesz wysłać powiadomienie e-mail o zapełnieniu stref (${locsToSend.length} stref)?`;

        if (!window.confirm(confirmText)) return;

        setSendingAlertLocationId(targetId);
        try {
            const res = await fetch("/api/warehouse-capacity-alert", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    locations: locsToSend.map(l => ({
                        name: l.name,
                        totalCapacity: l.totalCapacity,
                        currentOccupied: l.currentOccupied,
                        fillPercentage: l.totalCapacity > 0 ? Math.round((l.currentOccupied / l.totalCapacity) * 100) : 0,
                        alertThreshold: l.alertThreshold || 70,
                        criticalThreshold: l.criticalThreshold || 85,
                        categories: l.categories,
                        thresholdType: (l.totalCapacity > 0 && (l.currentOccupied / l.totalCapacity) * 100 >= (l.criticalThreshold || 85)) ? "CRITICAL" : "ALERT"
                    })),
                    updaterName: updater
                })
            });

            const data = await res.json();
            if (data.success) {
                alert(`✅ Alert e-mail został pomyślnie wysłany!\n${data.message || ''}`);
            } else {
                alert(`⚠️ Komunikat: ${data.message || data.error || 'Nie udało się wysłać powiadomienia.'}`);
            }
        } catch (err: any) {
            console.error("Błąd wysyłania alertu:", err);
            alert("Wystąpił błąd podczas próby wysłania powiadomienia e-mail.");
        } finally {
            setSendingAlertLocationId(null);
        }
    };

    // NOWE STANY SPECJALNE DLA KIEROWNIKA BUDOWY (OBSŁUGA WIELU BUDÓW)
    const [activeManagerSiteId, setActiveManagerSiteId] = useState("");
    const [managerProtocols, setManagerProtocols] = useState<any[]>([]);
    const [managerActiveClaimsCount, setManagerActiveClaimsCount] = useState(0);
    const [statsLoading, setStatsLoading] = useState(false);

    // Zabezpieczenie przed brakiem sesji
    useEffect(() => {
        if (!authLoading && !firebaseUser) {
            router.push("/login");
        }
    }, [firebaseUser, authLoading, router]);

    // 1. POBIERANIE DANYCH GLOBALNYCH (Katalog, Budowy, Ogólne Alerty)
    useEffect(() => {
        const fetchGlobalData = async () => {
            if (!user) return;
            setLoading(true);
            try {
                // Pobierz katalog sprzętu
                const invSnap = await getDocs(collection(db, "inventory"));
                const allItems = invSnap.docs.map(d => ({ id: d.id, ...d.data() })) as InventoryItem[];
                setItems(allItems);

                // Pobierz budowy
                const sitesSnap = await getDocs(collection(db, "sites"));
                const allSites = sitesSnap.docs.map(d => ({ id: d.id, ...d.data() })) as Site[];
                setSites(allSites);

                // Pobierz ogólną liczbę oczekujących zwrotów (dla Magazyniera)
                const q = query(collection(db, "protocols"), where("status", "==", "OCZEKUJACY"), where("type", "==", "ZWROT"));
                const protoSnap = await getDocs(q);
                setPendingProtocolsCount(protoSnap.size);

                // Pobierz liczbę oczekujących wpisów WZ
                const wzQ = query(collection(db, "pending_wz_items"), where("status", "==", "OCZEKUJACY_NA_PRZYPISANIE"));
                const wzSnap = await getDocs(wzQ);
                setPendingWzCount(wzSnap.size);

                // --- POPRAWIONE: GLOBALNY SĄD (Szukamy spraw, w których Kierownik jest OSKARŻONY/PRZYPISANY) ---
                const claimsQ = query(collection(db, "claims"), where("assignedManagers", "array-contains", user.uid));
                const claimsSnap = await getDocs(claimsQ);
                const activeClaims = claimsSnap.docs.map(d => d.data()).filter(c => c.status !== "ZAMKNIETA");
                setManagerActiveClaimsCount(activeClaims.length);

                // Ustawienie domyślnej budowy dla Kierownika
                const mSites = allSites.filter(s =>
                    user.assignedSites?.includes("ALL") || user.assignedSites?.includes(s.id)
                );
                if (mSites.length > 0 && !activeManagerSiteId) {
                    setActiveManagerSiteId(mSites[0].id);
                }

                // Pobierz konfigurację stref magazynowych (JPP / Miejsca składowania)
                const capSnap = await getDoc(doc(db, "settings", "warehouse_capacity"));
                if (capSnap.exists()) {
                    const capData = capSnap.data() || {};
                    if (Array.isArray(capData.locations) && capData.locations.length > 0) {
                        setStorageLocations(capData.locations);
                    }
                }

                // Wczytaj preferencję widoczności widżetu z localStorage
                const savedWidgetPref = localStorage.getItem("pesam_widget_storage_locations");
                if (savedWidgetPref !== null) {
                    setIsStorageWidgetVisible(savedWidgetPref === "true");
                }

            } catch (error) {
                console.error("Błąd pobierania danych globalnych:", error);
            } finally {
                setLoading(false);
            }
        };

        if (user) fetchGlobalData();
    }, [user]);

    // --- DETEKCJA UPRAWNIEŃ ---
    const isWarehouse = user ? hasPermission("acceptReturns", user.rolePermissions, user.permissionOverrides) : false;
    const isAccountant = user ? hasPermission("workersAddToSite", user.rolePermissions, user.permissionOverrides) : false;
    const isManager = user ? hasPermission("viewSiteState", user.rolePermissions, user.permissionOverrides) : false;
    const canManageCloseouts = user ? hasPermission("manageProjectCloseouts", user.rolePermissions, user.permissionOverrides) : false;
    const canApproveWz = user ? hasPermission("wzApproveDelivery", user.rolePermissions, user.permissionOverrides) : false;
    const canCreateWz = user ? hasPermission("wzCreateDelivery", user.rolePermissions, user.permissionOverrides) : false;

    // Sprawdzamy czy użytkownik ma dostęp do przeglądania katalogu sprzętu
    const canViewCatalog = user ? hasPermission("viewInventory", user.rolePermissions, user.permissionOverrides) : false;

    // Sprawdzamy czy użytkownik jest administratorem
    const isUserAdmin = Boolean(
        user && (
            user.roleName?.toLowerCase() === "admin" ||
            user.roleName?.toLowerCase().includes("administrator") ||
            user.email?.toLowerCase().includes("admin")
        )
    );

    // Dostęp do dedykowanego widżetu zapełnienia stref magazynowych (Plac / JPP)
    const canViewStorageWidget = Boolean(
        user && (
            isUserAdmin ||
            hasPermission("widgetStorageLocations", user.rolePermissions, user.permissionOverrides)
        )
    );

    const toggleStorageWidget = () => {
        setIsStorageWidgetVisible(prev => {
            const next = !prev;
            try {
                localStorage.setItem("pesam_widget_storage_locations", String(next));
            } catch (e) {}
            return next;
        });
    };

    // Sprawdzamy, czy użytkownik posiada JAKIEKOLWIEK uprawnienie do wyświetlenia sekcji operacyjnych (Magazyn, Biuro, Zarządzanie budową)
    const hasAnyOperationalPermission = isWarehouse || isAccountant || isManager || canManageCloseouts || canViewStorageWidget;

    // 2. DYNAMICZNE POBIERANIE DANYCH DLA WYBRANEJ BUDOWY KIEROWNIKA
    useEffect(() => {
        const fetchSiteSpecificData = async () => {
            if (!activeManagerSiteId || !isManager) return;
            setStatsLoading(true);
            try {
                // Pobieramy protokoły wejściowe i wyjściowe dla AKTUALNIE WYBRANEJ budowy
                const protoInSnap = await getDocs(query(collection(db, "protocols"), where("destinationId", "==", activeManagerSiteId)));
                const protoOutSnap = await getDocs(query(collection(db, "protocols"), where("sourceId", "==", activeManagerSiteId)));

                const combined = [
                    ...protoInSnap.docs.map(d => d.data()),
                    ...protoOutSnap.docs.map(d => d.data())
                ];
                setManagerProtocols(combined);
            } catch (e) {
                console.error("Błąd pobierania protokołów budowy:", e);
            } finally {
                setStatsLoading(false);
            }
        };

        fetchSiteSpecificData();
    }, [activeManagerSiteId, isManager]);

    // Jeśli się ładuje, pokaż cokolwiek, żeby nie było białego ekranu
    if (authLoading || (user && loading)) {
        return <div className="p-10 text-center text-slate-500 animate-pulse">Ładowanie panelu głównego...</div>;
    }

    if (!firebaseUser) return null;

    // --- OBLICZENIA STATYSTYK ---
    const activeSites = sites.filter(s => s.status !== "ZAKOŃCZONA" && s.location !== "Wpis ręczny");
    const itemsInRepair = items.filter(i => i.status === "uszkodzone" || i.status === "do przeglądu");

    // Alerty niskiego stanu drobnicy BHP dla Magazyniera
    const lowStockAlerts = items.filter(i =>
        i.type === "BULK" &&
        i.availableQuantity < 5 &&
        (i.category?.toLowerCase().includes("bhp") || i.category?.toLowerCase().includes("osobiste") || i.category?.toLowerCase().includes("ręczne"))
    );

    // Wartość aktywnego sprzętu unikalnego na budowach (Księgowość)
    const equipmentInField = items.filter(i => i.type === "UNIQUE" && i.currentLocation !== "MAGAZYN PESAM");
    const totalFieldAssetsValue = equipmentInField.reduce((sum, item) => sum + (item.purchasePrice || 0), 0);

    // --- FILTROWANIE DLA KIEROWNIKA (DLA WYBRANEJ BUDOWY) ---
    const managerSite = sites.find(s => s.id === activeManagerSiteId);

    // Lista wszystkich przypisanych kierownikowi budów (do dropdowna)
    const managerSites = sites.filter(s =>
        user?.assignedSites?.includes("ALL") || user?.assignedSites?.includes(s.id)
    );

    const itemsOnManagerSite = items.filter(i => i.allocations && i.allocations[activeManagerSiteId] > 0);

    // Data sprzed 7 dni do porównania chronologicznego
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoISO = sevenDaysAgo.toISOString();

    // 1. Wydania z magazynu na AKTUALNĄ budowę (7 dni)
    const managerRecentIssues = managerProtocols.filter(p =>
        p.type === "WYDANIE" &&
        p.destinationId === activeManagerSiteId &&
        p.createdAt >= sevenDaysAgoISO
    );

    // 2. Zwroty z AKTUALNEJ budowy oczekujące na akceptację
    const managerPendingReturns = managerProtocols.filter(p =>
        p.type === "ZWROT" &&
        p.sourceId === activeManagerSiteId &&
        p.status === "OCZEKUJACY"
    );

    // 3. Zakupy bezpośrednie na AKTUALNĄ budowę (7 dni)
    const managerRecentDirectPurchases = managerProtocols.filter(p =>
        p.type === "DOSTAWA_BEZP" &&
        p.destinationId === activeManagerSiteId &&
        p.createdAt >= sevenDaysAgoISO
    );

    // Obliczanie zaległych i nadchodzących przeglądów BHP
    const todayStr = new Date().toISOString().split("T")[0];
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);

    const overdueBhpItems = items.filter(i => {
        if (!i.requiresInspection || !i.nextInspectionDate) return false;
        return i.nextInspectionDate < todayStr;
    });

    const upcomingBhpItems = items.filter(i => {
        if (!i.requiresInspection || !i.nextInspectionDate) return false;
        const nextDate = new Date(i.nextInspectionDate);
        nextDate.setHours(0, 0, 0, 0);
        const diffDays = Math.ceil((nextDate.getTime() - todayDate.getTime()) / (1000 * 3600 * 24));
        return diffDays >= 0 && diffDays <= 30;
    });

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-8 animate-fade-in">
            {/* Witaj pracowniku (Zawsze widoczne na górze) */}
            <div className="bg-white rounded-3xl p-6 border shadow-sm flex flex-col sm:flex-row justify-between items-center gap-4">
                <div>
                    <h1 className="text-3xl font-black text-slate-800 tracking-tight">Witaj, {user?.firstName || firebaseUser.email}! 👋</h1>
                    {user && (
                        <p className="text-sm text-slate-500 mt-1">
                            Twoja rola w systemie to: <span className="bg-green-100 text-green-800 font-bold px-2 py-0.5 rounded text-xs uppercase tracking-wider">{user.roleName || user.roleId}</span>
                        </p>
                    )}
                </div>
                <div className="text-slate-400 font-mono text-xs text-right">PESAM System v1.5 • {new Date().toLocaleDateString("pl-PL")}</div>
            </div>

            {/* Ostrzeżenie o braku profilu w bazie Firestore */}
            {!user && (
                <div className="bg-yellow-50 border border-yellow-200 p-6 rounded-3xl shadow-sm">
                    <h3 className="font-bold text-yellow-800 text-lg">Brak profilu w bazie!</h3>
                    <p className="text-yellow-700 mt-2 text-sm leading-relaxed">
                        Jesteś poprawnie zalogowany do systemu, ale Twoje konto nie posiada jeszcze profilu w bazie <b>Firestore (kolekcja 'users')</b>.
                        System nie wie, jakie masz uprawnienia, dlatego na razie widzisz tylko ten ekran. Poproś administratora o nadanie uprawnień.
                    </p>
                </div>
            )}

            {/* ========================================================================= */}
            {/* OPCJA A: UŻYTKOWNIK POSIADA UPRAWNIENIA OPERACYJNE (Magazyn, Biuro, Budowy) */}
            {/* ========================================================================= */}
            {user && hasAnyOperationalPermission ? (
                <div className="space-y-8">
                    {/* BANER ALERTO-NOTYFIKACJA O PRZEGLĄDACH BHP */}
                    {(overdueBhpItems.length > 0 || upcomingBhpItems.length > 0) && (
                        <div className="bg-gradient-to-r from-purple-900 to-indigo-900 text-white p-6 rounded-3xl shadow-xl flex flex-col md:flex-row justify-between items-center gap-4 animate-fade-in border-2 border-purple-400">
                            <div className="flex items-center gap-4">
                                <div className="bg-purple-800/80 p-3.5 rounded-2xl text-3xl border border-purple-400">🦺</div>
                                <div>
                                    <h4 className="font-extrabold text-base uppercase tracking-wider flex items-center gap-2 flex-wrap">
                                        <span>Alerty Przeglądów Technicznych & BHP</span>
                                        {overdueBhpItems.length > 0 && (
                                            <span className="bg-red-600 text-white text-xs px-3 py-0.5 rounded-full font-black animate-pulse">
                                                🔴 Przeterminowane: {overdueBhpItems.length}
                                            </span>
                                        )}
                                        {upcomingBhpItems.length > 0 && (
                                            <span className="bg-amber-400 text-amber-950 text-xs px-3 py-0.5 rounded-full font-black">
                                                ⚠️ Do 30 dni: {upcomingBhpItems.length}
                                            </span>
                                        )}
                                    </h4>
                                    <p className="text-xs text-purple-200 mt-1 leading-relaxed">
                                        Wykryto sprzęt ochrony osobistej (szelki, liny, osprzęt), którego okresowy przegląd minął lub upływa w ciągu najbliższych 30 dni.
                                    </p>
                                </div>
                            </div>
                            <Link
                                href="/dashboard/inventory"
                                className="bg-purple-400 hover:bg-purple-300 text-purple-950 px-5 py-3 rounded-xl font-black text-xs uppercase tracking-wider shadow-md transition whitespace-nowrap"
                            >
                                Przejdź do BHP ➡️
                            </Link>
                        </div>
                    )}

                    {/* BANER ALERTO-NOTYFIKACJA DLA MAGAZYNIERA O OCZEKUJĄCYCH WZ */}
                    {pendingWzCount > 0 && canApproveWz && (
                        <div className="bg-gradient-to-r from-blue-600 to-indigo-700 text-white p-6 rounded-3xl shadow-lg flex flex-col md:flex-row justify-between items-center gap-4 animate-fade-in">
                            <div className="flex items-center gap-4">
                                <div className="bg-white/20 p-3.5 rounded-2xl text-3xl">📦</div>
                                <div>
                                    <h4 className="font-extrabold text-base uppercase tracking-wider flex items-center gap-2">
                                        <span>Nowe pozycje z WZ do zatwierdzenia</span>
                                        <span className="bg-white text-blue-700 text-xs px-2.5 py-0.5 rounded-full font-black animate-pulse">{pendingWzCount}</span>
                                    </h4>
                                    <p className="text-xs text-blue-100 mt-1 leading-relaxed">
                                        Księgowość wprowadziła nowe zakupy z dokumentów WZ/Faktur na budowę. Wymagają one Twojej weryfikacji i dopasowania do kartotek budowlanych.
                                    </p>
                                </div>
                            </div>
                            <Link
                                href="/dashboard/wz-approvals"
                                className="bg-white text-blue-700 hover:bg-blue-50 px-5 py-3 rounded-xl font-black text-xs uppercase tracking-wider shadow-md transition whitespace-nowrap"
                            >
                                Zatwierdź pozycje WZ ➡️
                            </Link>
                        </div>
                    )}

                    {/* WIDŻET: MIEJSCA SKŁADOWANIA & PLAC (ZAPEŁNIENIE MAGAZYNU JPP) */}
                    {canViewStorageWidget && (
                        <div className="bg-white border rounded-3xl p-6 shadow-sm space-y-6">
                            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b pb-4">
                                <div>
                                    <div className="flex items-center gap-2.5">
                                        <span className="text-2xl">📍</span>
                                        <h3 className="text-lg font-black text-slate-800 tracking-tight">
                                            Miejsca Składowania & Plac (Zapełnienie JPP)
                                        </h3>
                                        <span className="bg-blue-100 text-blue-800 text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider">
                                            Widżet
                                        </span>
                                    </div>
                                    <p className="text-xs text-slate-500 mt-1">
                                        Monitorowanie wolnych miejsc paletowych (JPP) na placu, halach oraz magazynie chemii.
                                    </p>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => handleSendCapacityAlert()}
                                        disabled={sendingAlertLocationId === "ALL"}
                                        className="text-xs font-black text-white bg-gradient-to-r from-red-600 to-amber-600 hover:from-red-700 hover:to-amber-700 disabled:opacity-50 px-3.5 py-1.5 rounded-xl transition shadow-xs flex items-center gap-1.5 cursor-pointer"
                                        title="Wyślij powiadomienie e-mail o przepełnionych strefach"
                                    >
                                        <span>{sendingAlertLocationId === "ALL" ? "⏳ Wysyłanie..." : "🚨 Wyślij Alert E-mail"}</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={toggleStorageWidget}
                                        className="text-xs font-bold text-slate-500 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-xl transition"
                                        title={isStorageWidgetVisible ? "Zwiń widżet" : "Rozwiń widżet"}
                                    >
                                        {isStorageWidgetVisible ? "👁️ Zwiń" : "👁️ Rozwiń widżet"}
                                    </button>
                                    <Link
                                        href="/dashboard/inventory"
                                        className="text-xs font-black text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-xl transition flex items-center gap-1"
                                    >
                                        ⚙️ Konfiguruj strefy ➡️
                                    </Link>
                                </div>
                            </div>

                            {isStorageWidgetVisible && (
                                <div className="space-y-6">
                                    {storageLocations.length === 0 ? (
                                        <div className="p-8 text-center text-slate-400 text-xs italic bg-slate-50 rounded-2xl border border-dashed">
                                            Brak skonfigurowanych miejsc składowania. Skonfiguruj strefy w module reguł magazynu w Katalogu Sprzętu.
                                        </div>
                                    ) : (
                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                                            {storageLocations.map(loc => {
                                                const totalCap = Number((loc.totalCapacity || 0).toFixed(2));
                                                const occupied = Number((loc.currentOccupied || 0).toFixed(2));
                                                const fillPct = totalCap > 0 ? Math.min(100, Math.round((occupied / totalCap) * 100)) : 0;
                                                const rawFreeSlots = Math.max(0, totalCap - occupied);
                                                // Precyzyjne zaokrąglenie do maksymalnie 2 miejsc po przecinku (np. 0.3 zamiast 0.30000000000000004)
                                                const freeSlots = Math.round(rawFreeSlots * 100) / 100;
                                                const isCritical = fillPct >= (loc.criticalThreshold || 85);
                                                const isAlert = !isCritical && fillPct >= (loc.alertThreshold || 70);

                                                let barColor = "bg-emerald-500";
                                                let badgeColor = "bg-emerald-100 text-emerald-800 border-emerald-200";
                                                let badgeText = "Optymalnie";
                                                if (isCritical) {
                                                    barColor = "bg-red-600";
                                                    badgeColor = "bg-red-100 text-red-800 border-red-200";
                                                    badgeText = "Krytyczne zapełnienie!";
                                                } else if (isAlert) {
                                                    barColor = "bg-amber-500";
                                                    badgeColor = "bg-amber-100 text-amber-800 border-amber-200";
                                                    badgeText = "Próg ostrzegawczy";
                                                }

                                                // Przypisane resztki z inwentarza pasujące do kategorii tej strefy
                                                const assignedItems = items.filter(it => {
                                                    const isResidual = it.category === "Pozostałości budowlane" || it.inventoryNumber === "RESZTKI" || it.subType === "SUB_ITEM";
                                                    if (!isResidual) return false;
                                                    return loc.categories.some(catId => {
                                                        const catIdLower = catId.toLowerCase();
                                                        return (it.category && it.category.toLowerCase().includes(catIdLower)) ||
                                                               (it.subcategory && it.subcategory.toLowerCase().includes(catIdLower)) ||
                                                               (it.name && it.name.toLowerCase().includes(catIdLower));
                                                    });
                                                });

                                                return (
                                                    <div
                                                        key={loc.id}
                                                        className={`p-5 rounded-2xl border transition-all ${
                                                            isCritical
                                                                ? "bg-red-50/40 border-red-200 shadow-sm"
                                                                : isAlert
                                                                ? "bg-amber-50/40 border-amber-200 shadow-sm"
                                                                : "bg-slate-50/60 border-slate-200 hover:border-slate-300 shadow-sm"
                                                        }`}
                                                    >
                                                        <div className="flex justify-between items-start gap-2">
                                                            <div>
                                                                <h4 className="font-black text-slate-800 text-sm">{loc.name}</h4>
                                                                {loc.description && (
                                                                    <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">{loc.description}</p>
                                                                )}
                                                            </div>
                                                            <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${badgeColor} whitespace-nowrap`}>
                                                                {badgeText}
                                                            </span>
                                                        </div>

                                                        {/* Pasek postępu zapełnienia */}
                                                        <div className="mt-4">
                                                            <div className="flex justify-between items-baseline mb-1">
                                                                <span className="text-[11px] font-bold text-slate-500">Zapełnienie strefy:</span>
                                                                <span className="text-xs font-black font-mono text-slate-800">{fillPct}%</span>
                                                            </div>
                                                            <div className="w-full bg-slate-200 h-2.5 rounded-full overflow-hidden">
                                                                <div
                                                                    className={`h-full transition-all duration-500 ${barColor}`}
                                                                    style={{ width: `${fillPct}%` }}
                                                                />
                                                            </div>
                                                        </div>

                                                        {/* Liczniki JPP */}
                                                        <div className="grid grid-cols-2 gap-2 mt-4 pt-3 border-t border-slate-200/80 text-center">
                                                            <div className="bg-white p-2 rounded-xl border border-slate-100 shadow-xs">
                                                                <span className="text-[10px] text-slate-400 font-bold block uppercase">Zajęte</span>
                                                                <span className="text-base font-black text-slate-800 font-mono">
                                                                    {occupied} <span className="text-[10px] font-medium text-slate-400">JPP</span>
                                                                </span>
                                                            </div>
                                                            <div className="bg-white p-2 rounded-xl border border-slate-100 shadow-xs">
                                                                <span className="text-[10px] text-slate-400 font-bold block uppercase">Wolne</span>
                                                                <span className={`text-base font-black font-mono ${freeSlots <= 2 ? "text-red-600" : "text-emerald-700"}`}>
                                                                    {freeSlots} <span className="text-[10px] font-medium text-slate-400">JPP</span>
                                                                </span>
                                                            </div>
                                                        </div>

                                                        {/* Kategorie powiązane */}
                                                        <div className="mt-3 flex flex-wrap gap-1">
                                                            {loc.categories.map(c => (
                                                                <span key={c} className="text-[10px] font-bold bg-white text-slate-600 px-2 py-0.5 rounded-md border border-slate-200">
                                                                    {c}
                                                                </span>
                                                            ))}
                                                        </div>

                                                        {/* Przyciski akcji dla strefy */}
                                                        <div className="mt-4 flex gap-2">
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    setActiveLocationModal(loc);
                                                                    setModalSearchTerm("");
                                                                    setModalCategoryFilter("ALL");
                                                                }}
                                                                className="flex-1 text-xs font-black py-2.5 px-3 rounded-xl border transition flex items-center justify-center gap-1.5 bg-white hover:bg-blue-50 text-slate-700 hover:text-blue-700 border-slate-200 hover:border-blue-300 shadow-xs group"
                                                            >
                                                                <span>📦 Asortyment ({assignedItems.length})</span>
                                                                <span className="text-slate-400 group-hover:text-blue-600 group-hover:translate-x-0.5 transition-transform">➡️</span>
                                                            </button>

                                                            {(isAlert || isCritical) && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => handleSendCapacityAlert(loc)}
                                                                    disabled={sendingAlertLocationId === loc.id}
                                                                    className="px-3 py-2.5 rounded-xl border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-black transition flex items-center gap-1 shadow-xs disabled:opacity-50"
                                                                    title="Wyślij natychmiastowe powiadomienie e-mail dla tej strefy"
                                                                >
                                                                    <span>{sendingAlertLocationId === loc.id ? "⏳" : "🚨"}</span>
                                                                    <span className="hidden sm:inline">Alert</span>
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* 1. PANEL MAGAZYNU GŁÓWNEGO */}
                    {isWarehouse && (
                        <div className="space-y-4">
                            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest pl-2">📦 Panel Magazynu Głównego</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                                <Link href="/dashboard/protocols" className="bg-white hover:bg-slate-50 border p-6 rounded-2xl shadow-sm transition-all flex items-center justify-between group">
                                    <div>
                                        <p className="text-slate-400 text-xs font-bold uppercase">Oczekujące Zwroty (App)</p>
                                        <p className="text-4xl font-black text-purple-600 mt-2">{pendingProtocolsCount}</p>
                                        <p className="text-[10px] text-slate-400 font-bold mt-2 uppercase">Weryfikacja i przyjęcie</p>
                                    </div>
                                    <span className="text-2xl opacity-50 group-hover:translate-x-2 transition-transform">➡️</span>
                                </Link>

                                <Link href="/dashboard/inventory" className="bg-white hover:bg-slate-50 border p-6 rounded-2xl shadow-sm transition-all flex items-center justify-between group">
                                    <div>
                                        <p className="text-slate-400 text-xs font-bold uppercase">Sprzęt w naprawie / serwisie</p>
                                        <p className="text-4xl font-black text-yellow-600 mt-2">{itemsInRepair.length}</p>
                                        <p className="text-[10px] text-slate-400 font-bold mt-2 uppercase">Wymaga uwagi</p>
                                    </div>
                                    <span className="text-2xl opacity-50 group-hover:translate-x-2 transition-transform">➡️</span>
                                </Link>

                                <div className="bg-white border p-6 rounded-2xl shadow-sm">
                                    <p className="text-slate-400 text-xs font-bold uppercase">Aktywne projekty budowlane</p>
                                    <p className="text-4xl font-black text-slate-800 mt-2">{activeSites.length}</p>
                                    <p className="text-[10px] text-slate-400 font-bold mt-2 uppercase">Trwające budowy</p>
                                </div>

                                <Link href="/dashboard/wz-approvals" className="bg-white hover:bg-slate-50 border p-6 rounded-2xl shadow-sm transition-all flex items-center justify-between group">
                                    <div>
                                        <p className="text-slate-400 text-xs font-bold uppercase">Pozycje z WZ do przypisania</p>
                                        <p className="text-4xl font-black text-blue-600 mt-2">{pendingWzCount}</p>
                                        <p className="text-[10px] text-slate-400 font-bold mt-2 uppercase">Weryfikacja i stan budowy</p>
                                    </div>
                                    <span className="text-2xl opacity-50 group-hover:translate-x-2 transition-transform">➡️</span>
                                </Link>

                                {canManageCloseouts && (
                                    <Link href="/dashboard/closeouts" className="bg-white hover:bg-slate-50 border p-6 rounded-2xl shadow-sm transition-all flex items-center justify-between group">
                                        <div>
                                            <p className="text-slate-400 text-xs font-bold uppercase">Rozliczanie Budów</p>
                                            <p className="text-4xl font-black text-slate-700 mt-2">🏁</p>
                                            <p className="text-[10px] text-slate-400 font-bold mt-2 uppercase">Audyt i zamknięcie</p>
                                        </div>
                                        <span className="text-2xl opacity-50 group-hover:translate-x-2 transition-transform">➡️</span>
                                    </Link>
                                )}
                            </div>

                            {/* ALERTY NISKIEGO STANU BHP/DROBNICY */}
                            {lowStockAlerts.length > 0 && (
                                <div className="bg-red-50 border border-red-200 rounded-2xl p-5 shadow-sm">
                                    <h4 className="text-xs font-black text-red-800 uppercase tracking-wider mb-3">🚨 ALERTY MAGAZYNU: Kończy się drobny sprzęt!</h4>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                        {lowStockAlerts.map(i => (
                                            <div key={i.id} className="bg-white border border-red-100 p-3 rounded-xl flex justify-between items-center shadow-sm">
                                                <span className="font-bold text-slate-800 text-sm">{i.name}</span>
                                                <span className="bg-red-100 text-red-700 text-xs font-black px-2.5 py-1 rounded-lg">Pozostało tylko: {i.availableQuantity} szt.</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* 2. PANEL FINANSOWO-ZAKUPOWY */}
                    {isAccountant && (
                        <div className="space-y-4">
                            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest pl-2">💼 Panel Finansowo-Zakupowy (Biuro)</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="bg-slate-950 text-white p-6 rounded-3xl shadow-lg relative overflow-hidden border border-slate-800">
                                    <div className="relative z-10">
                                        <p className="text-blue-400 text-[10px] font-black uppercase tracking-wider">Wartość sprzętu pracującego w terenie</p>
                                        <p className="text-4xl font-black mt-2 font-mono">{totalFieldAssetsValue.toLocaleString("pl-PL")} zł</p>
                                        <p className="text-slate-400 text-xs mt-3">Sumaryczna wartość netto unikalnych narzędzi przypisanych aktualnie do budów.</p>
                                    </div>
                                    <div className="absolute right-[-5%] top-[-20%] text-[8rem] opacity-5 select-none pointer-events-none">📈</div>
                                </div>

                                <Link href="/dashboard/admin/workers/add-to-site" className="bg-blue-50 hover:bg-blue-100 border border-blue-200 p-6 rounded-3xl shadow-sm transition-all flex flex-col justify-center relative group">
                                    <p className="text-blue-800 font-black text-lg mb-1">🚚 Wprowadź zakup bezpośredni na budowę (WZ)</p>
                                    <p className="text-blue-600 text-xs">Zasil stan budowy omijając magazyn centralny bezpośrednio na podstawie faktury.</p>
                                    <span className="absolute right-6 text-2xl opacity-50 group-hover:translate-x-2 transition-transform">➡️</span>
                                </Link>
                            </div>
                        </div>
                    )}

                    {/* 3. DYNAMICZNY PANEL OPERACYJNY KIEROWNIKA BUDOWY */}
                    {isManager && activeManagerSiteId && (
                        <div className="space-y-4">
                            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 pl-2">
                                <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">
                                    🏢 AKTYWNY PROJEKT: {managerSite?.name} {managerSite?.location ? `— ${managerSite.location}` : ""}
                                </h3>

                                {managerSites.length > 1 && (
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-slate-500 font-bold">Zmień budowę:</span>
                                        <select
                                            value={activeManagerSiteId}
                                            onChange={e => setActiveManagerSiteId(e.target.value)}
                                            className="p-2.5 bg-white border border-slate-300 rounded-xl font-bold text-blue-700 text-xs shadow-sm outline-none cursor-pointer transition hover:bg-slate-50"
                                        >
                                            {managerSites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                        </select>
                                    </div>
                                )}
                            </div>

                            {statsLoading ? (
                                <div className="p-10 text-center text-xs text-slate-400 animate-pulse">Przeliczanie statystyk dla wybranej budowy...</div>
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                                    <Link href="/dashboard/my-site?view=INVENTORY" className="bg-white hover:bg-slate-50 border p-6 rounded-2xl shadow-sm transition-all flex items-center justify-between group">
                                        <div>
                                            <p className="text-slate-400 text-[10px] font-black uppercase">Magazyn Podręczny</p>
                                            <p className="text-4xl font-black text-blue-600 mt-2">{itemsOnManagerSite.length}</p>
                                            <p className="text-[10px] text-slate-400 font-bold mt-2 uppercase">Liczba pozycji na placu</p>
                                        </div>
                                        <span className="text-xl opacity-50 group-hover:translate-x-2 transition-transform">➡️</span>
                                    </Link>

                                    <Link href="/dashboard/my-site?view=HISTORY" className="bg-white hover:bg-slate-50 border p-6 rounded-2xl shadow-sm transition-all flex items-center justify-between group">
                                        <div>
                                            <p className="text-slate-400 text-[10px] font-black uppercase">Wydania z Magazynu (7 dni)</p>
                                            <p className="text-4xl font-black text-slate-800 mt-2">{managerRecentIssues.length}</p>
                                            <p className="text-[10px] text-slate-400 font-bold mt-2 uppercase">Nowe protokoły wejściowe</p>
                                        </div>
                                        <span className="text-xl opacity-50 group-hover:translate-x-2 transition-transform">➡️</span>
                                    </Link>

                                    <Link href="/dashboard/my-site?view=HISTORY" className="bg-white hover:bg-slate-50 border p-6 rounded-2xl shadow-sm transition-all flex items-center justify-between group">
                                        <div>
                                            <p className="text-slate-400 text-[10px] font-black uppercase">Zakupy bezpośrednie (7 dni)</p>
                                            <p className="text-4xl font-black text-orange-600 mt-2">{managerRecentDirectPurchases.length}</p>
                                            <p className="text-[10px] text-slate-400 font-bold mt-2 uppercase">Faktury / WZ od księgowej</p>
                                        </div>
                                        <span className="text-xl opacity-50 group-hover:translate-x-2 transition-transform">➡️</span>
                                    </Link>

                                    <Link href="/dashboard/my-site?view=HISTORY" className="bg-white hover:bg-slate-50 border p-6 rounded-2xl shadow-sm transition-all flex items-center justify-between group">
                                        <div>
                                            <p className="text-slate-400 text-[10px] font-black uppercase">Wysłane Zwroty (Oczekujące)</p>
                                            <p className="text-4xl font-black text-purple-600 mt-2">{managerPendingReturns.length}</p>
                                            <p className="text-[10px] text-slate-400 font-bold mt-2 uppercase">Czeka na akceptację bazy</p>
                                        </div>
                                        <span className="text-xl opacity-50 group-hover:translate-x-2 transition-transform">➡️</span>
                                    </Link>
                                </div>
                            )}

                            {/* RAPORT SĄDOWY KIEROWNIKA */}
                            <div className="pt-2">
                                {managerActiveClaimsCount > 0 ? (
                                    <Link href="/dashboard/claims" className="bg-red-50 hover:bg-red-100 border-2 border-red-200 rounded-3xl p-5 shadow-md flex items-center justify-between animate-pulse transition-all group">
                                        <div className="flex items-center gap-4">
                                            <span className="text-3xl">⚖️</span>
                                            <div>
                                                <h4 className="text-sm font-black text-red-800 uppercase tracking-wider">Uwaga: Twoje aktywne postępowania szkodowe!</h4>
                                                <p className="text-xs text-red-700 mt-0.5">Wewnętrzny Sąd PESAM prowadzi obecnie <b>{managerActiveClaimsCount} Twoich aktywnych spraw</b> dotyczących zniszczonego sprzętu.</p>
                                            </div>
                                        </div>
                                        <span className="bg-red-600 text-white text-[10px] font-black px-4 py-2 rounded-xl shadow-md uppercase tracking-wider group-hover:scale-105 transition-transform">
                                            Otwórz Sąd ➡️
                                        </span>
                                    </Link>
                                ) : (
                                    <div className="bg-green-50 border border-green-200 rounded-3xl p-4 flex items-center gap-3 shadow-sm text-xs text-green-800 font-bold">
                                        <span className="text-lg">🛡️</span>
                                        <span>Brak aktywnych postępowań szkodowych na Twoim koncie. Dbasz o sprzęt – gratulacje!</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            ) : (
                /* ========================================================================= */
                /* OPCJA B: UŻYTKOWNIK BEZ UPRAWNIEŃ OPERACYJNYCH (STAN POWITALNY / PROSTY) */
                /* ========================================================================= */
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-4">
                    {/* Przyjazna karta informacyjna */}
                    <div className="bg-white border rounded-3xl p-8 shadow-sm flex flex-col justify-between">
                        <div>
                            <span className="text-4xl">🛡️</span>
                            <h3 className="text-lg font-black text-slate-800 uppercase tracking-wide mt-4">Twój profil jest aktywny</h3>
                            <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                                Posiadasz podstawowe uprawnienia do systemu magazynowego PESAM. Możesz bezpiecznie przeglądać zasoby narzędziowe oraz asortyment firmy w interaktywnym Katalogu Sprzętu.
                            </p>
                        </div>
                        {canViewCatalog && (
                            <Link href="/dashboard/inventory" className="mt-8 bg-blue-600 hover:bg-blue-700 text-white font-black text-xs uppercase tracking-wider py-4 px-6 rounded-2xl shadow-md hover:shadow-lg transition-all flex items-center justify-between group">
                                <span>📦 Przejdź do Katalogu Sprzętu</span>
                                <span className="group-hover:translate-x-1.5 transition-transform">➡️</span>
                            </Link>
                        )}
                    </div>

                    {/* Karta wsparcia administratora */}
                    <div className="bg-slate-50 border border-dashed border-slate-300 rounded-3xl p-8 flex flex-col justify-between">
                        <div>
                            <span className="text-4xl">⚙️</span>
                            <h3 className="text-lg font-black text-slate-700 uppercase tracking-wide mt-4">Potrzebujesz więcej opcji?</h3>
                            <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                                Jeśli Twoje codzienne obowiązki wymagają wystawiania protokołów WZ, zgłaszania zwrotów maszyn, rozliczania zakupów lub zarządzania pracownikami fizycznymi – skontaktuj się z administratorem systemu w celu nadania odpowiednich ról i uprawnień.
                            </p>
                        </div>
                        <div className="mt-8 pt-4 border-t border-slate-200/60 text-[11px] text-slate-400 font-semibold">
                            System Zarządzania Magazynem PESAM
                        </div>
                    </div>
                </div>
            )}

            {/* ========================================================================= */}
            {/* MODAL: PRZEGLĄDANIE ASORTYMENTU STREFY SKŁADOWANIA (PLAC / HALE)        */}
            {/* ========================================================================= */}
            {activeLocationModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-fade-in">
                    <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-scale-up">
                        {/* Nagłówek modala */}
                        <div className="p-6 bg-slate-900 text-white flex justify-between items-start gap-4">
                            <div>
                                <div className="flex items-center gap-2">
                                    <span className="text-2xl">📍</span>
                                    <h3 className="text-xl font-black tracking-tight">{activeLocationModal.name}</h3>
                                    <span className="bg-blue-600/80 text-white text-[10px] font-black px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                                        Asortyment Strefy
                                    </span>
                                </div>
                                {activeLocationModal.description && (
                                    <p className="text-xs text-slate-300 mt-1 max-w-2xl">{activeLocationModal.description}</p>
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={() => setActiveLocationModal(null)}
                                className="text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 w-9 h-9 rounded-full flex items-center justify-center font-bold text-lg transition"
                                title="Zamknij"
                            >
                                ✕
                            </button>
                        </div>

                        {/* Pasek podsumowania strefy */}
                        <div className="bg-slate-50 border-b border-slate-200 px-6 py-4 flex flex-wrap items-center justify-between gap-4">
                            <div className="flex items-center gap-4 text-xs">
                                <div>
                                    <span className="text-slate-500 font-bold block text-[10px] uppercase">Zajętość:</span>
                                    <span className="font-mono font-black text-slate-800 text-sm">
                                        {Number((activeLocationModal.currentOccupied || 0).toFixed(2))} / {Number((activeLocationModal.totalCapacity || 0).toFixed(2))} JPP
                                    </span>
                                </div>
                                <div className="border-l pl-4 border-slate-300">
                                    <span className="text-slate-500 font-bold block text-[10px] uppercase">Wolne sloty:</span>
                                    <span className="font-mono font-black text-emerald-700 text-sm">
                                        {Math.round(Math.max(0, (activeLocationModal.totalCapacity || 0) - (activeLocationModal.currentOccupied || 0)) * 100) / 100} JPP
                                    </span>
                                </div>
                                <div className="border-l pl-4 border-slate-300">
                                    <span className="text-slate-500 font-bold block text-[10px] uppercase">Kategorie strefy:</span>
                                    <div className="flex flex-wrap gap-1 mt-0.5">
                                        {activeLocationModal.categories.map(c => (
                                            <span key={c} className="bg-white border text-[10px] font-bold text-slate-700 px-2 py-0.5 rounded-md">
                                                {c}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => handleSendCapacityAlert(activeLocationModal)}
                                    disabled={sendingAlertLocationId === activeLocationModal.id}
                                    className="text-xs font-black text-amber-900 bg-amber-100 hover:bg-amber-200 border border-amber-300 px-3 py-1.5 rounded-xl transition flex items-center gap-1.5 shadow-xs disabled:opacity-50"
                                    title="Wyślij powiadomienie e-mail o stanie tej strefy"
                                >
                                    <span>{sendingAlertLocationId === activeLocationModal.id ? "⏳ Wysyłanie..." : "🚨 Wyślij Alert E-mail"}</span>
                                </button>
                                <Link
                                    href="/dashboard/inventory"
                                    className="text-xs font-black text-blue-600 hover:text-blue-800 bg-white hover:bg-blue-50 border border-blue-200 px-3 py-1.5 rounded-xl transition"
                                >
                                    📦 Katalog Sprzętu ➡️
                                </Link>
                            </div>
                        </div>

                        {/* Filtry wyszukiwania */}
                        <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row gap-3 bg-white">
                            <div className="relative flex-1">
                                <span className="absolute left-3 top-2.5 text-slate-400 text-xs">🔍</span>
                                <input
                                    type="text"
                                    value={modalSearchTerm}
                                    onChange={e => setModalSearchTerm(e.target.value)}
                                    placeholder="Szukaj po nazwie materiału, numerze katalogowym..."
                                    className="w-full pl-8 pr-3 py-2 text-xs border border-slate-300 rounded-xl focus:border-blue-500 outline-none"
                                />
                            </div>
                            <div className="sm:w-56">
                                <select
                                    value={modalCategoryFilter}
                                    onChange={e => setModalCategoryFilter(e.target.value)}
                                    className="w-full py-2 px-3 text-xs border border-slate-300 rounded-xl focus:border-blue-500 outline-none font-bold text-slate-700 cursor-pointer"
                                >
                                    <option value="ALL">Wszystkie kategorie strefy</option>
                                    {activeLocationModal.categories.map(cat => (
                                        <option key={cat} value={cat}>{cat}</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        {/* Spis asortymentu */}
                        <div className="flex-1 overflow-y-auto p-6 bg-slate-50/50">
                            {(() => {
                                // Filtrujemy przedmioty pasujące do strefy
                                const allZoneItems = items.filter(it => {
                                    const isResidual = it.category === "Pozostałości budowlane" || it.inventoryNumber === "RESZTKI" || it.subType === "SUB_ITEM";
                                    if (!isResidual) return false;
                                    return activeLocationModal.categories.some(catId => {
                                        const catIdLower = catId.toLowerCase();
                                        return (it.category && it.category.toLowerCase().includes(catIdLower)) ||
                                               (it.subcategory && it.subcategory.toLowerCase().includes(catIdLower)) ||
                                               (it.name && it.name.toLowerCase().includes(catIdLower));
                                    });
                                });

                                const filteredItems = allZoneItems.filter(it => {
                                    if (modalCategoryFilter !== "ALL") {
                                        const catLower = modalCategoryFilter.toLowerCase();
                                        const match = (it.category && it.category.toLowerCase().includes(catLower)) ||
                                                      (it.subcategory && it.subcategory.toLowerCase().includes(catLower)) ||
                                                      (it.name && it.name.toLowerCase().includes(catLower));
                                        if (!match) return false;
                                    }
                                    if (modalSearchTerm.trim()) {
                                        const q = modalSearchTerm.toLowerCase();
                                        return (
                                            it.name?.toLowerCase().includes(q) ||
                                            it.inventoryNumber?.toLowerCase().includes(q) ||
                                            it.subcategory?.toLowerCase().includes(q)
                                        );
                                    }
                                    return true;
                                });

                                if (filteredItems.length === 0) {
                                    return (
                                        <div className="text-center py-16">
                                            <span className="text-4xl block mb-2">📦</span>
                                            <p className="text-sm font-bold text-slate-700">
                                                {allZoneItems.length === 0
                                                    ? "Brak zarejestrowanego asortymentu w tej strefie magazynu."
                                                    : "Brak pozycji spełniających kryteria wyszukiwania."}
                                            </p>
                                            <p className="text-xs text-slate-400 mt-1">
                                                Towary i resztki budowlane pojawią się tutaj po przyjęciu zwrotu lub wprowadzeniu pozycji w Katalogu Sprzętu.
                                            </p>
                                        </div>
                                    );
                                }

                                return (
                                    <div className="space-y-3">
                                        <div className="flex justify-between items-center text-xs text-slate-500 font-bold px-1">
                                            <span>Pozycje na stanie ({filteredItems.length}):</span>
                                            <span>Stan dostępny / Jednostka</span>
                                        </div>
                                        <div className="grid grid-cols-1 gap-2.5">
                                            {filteredItems.map(item => (
                                                <div
                                                    key={item.id}
                                                    className="bg-white border border-slate-200 hover:border-blue-300 p-3.5 rounded-2xl shadow-xs transition flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                                                >
                                                    <div className="flex items-center gap-3">
                                                        {item.imageUrl ? (
                                                            <img
                                                                src={item.imageUrl}
                                                                alt={item.name}
                                                                className="w-12 h-12 rounded-xl object-cover border border-slate-200 shrink-0"
                                                            />
                                                        ) : (
                                                            <div className="w-12 h-12 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-xl shrink-0">
                                                                📦
                                                            </div>
                                                        )}
                                                        <div>
                                                            <div className="flex items-center gap-2">
                                                                <h5 className="font-black text-slate-800 text-sm">{item.name}</h5>
                                                                {item.inventoryNumber && (
                                                                    <span className="bg-slate-100 text-slate-600 font-mono text-[10px] px-2 py-0.5 rounded font-bold">
                                                                        #{item.inventoryNumber}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="flex items-center gap-2 text-xs text-slate-500 mt-0.5">
                                                                <span>{item.category}</span>
                                                                {item.subcategory && (
                                                                    <>
                                                                        <span>•</span>
                                                                        <span className="text-blue-700 font-semibold">{item.subcategory}</span>
                                                                    </>
                                                                )}
                                                                <span>•</span>
                                                                <span className="text-slate-400">{item.currentLocation || "MAGAZYN PESAM"}</span>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="flex items-center justify-between sm:justify-end gap-4 border-t sm:border-t-0 pt-2 sm:pt-0">
                                                        <div className="text-right">
                                                            <span className="text-[10px] text-slate-400 uppercase font-bold block">Dostępne:</span>
                                                            <span className="font-mono font-black text-slate-900 text-sm">
                                                                {item.availableQuantity ?? item.totalQuantity ?? 0} {item.unit || "szt."}
                                                            </span>
                                                        </div>
                                                        <Link
                                                            href="/dashboard/inventory"
                                                            className="text-xs font-bold text-slate-400 hover:text-blue-600 p-2 hover:bg-slate-100 rounded-xl transition"
                                                            title="Otwórz w katalogu"
                                                        >
                                                            🔍
                                                        </Link>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })()}
                        </div>

                        {/* Stopka modala */}
                        <div className="p-4 bg-white border-t border-slate-200 flex justify-end">
                            <button
                                type="button"
                                onClick={() => setActiveLocationModal(null)}
                                className="bg-slate-800 hover:bg-slate-900 text-white font-black text-xs px-6 py-2.5 rounded-xl shadow-sm transition uppercase tracking-wider"
                            >
                                Zamknij okno
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}