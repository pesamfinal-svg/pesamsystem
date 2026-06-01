// src/app/(dashboard)/dashboard/page.tsx
"use client";

import { useState, useEffect } from "react";
import { collection, getDocs, doc, query, where, orderBy, limit } from "firebase/firestore";
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
}

interface Site {
    id: string; name: string; status?: string; location?: string;
}

export default function DashboardPage() {
    const { user, firebaseUser, loading: authLoading } = useAuth();
    const router = useRouter();

    const [items, setItems] = useState<InventoryItem[]>([]);
    const [sites, setSites] = useState<Site[]>([]);
    const [pendingProtocolsCount, setPendingProtocolsCount] = useState(0);
    const [loading, setLoading] = useState(true);

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

    // Sprawdzamy czy użytkownik ma dostęp do przeglądania katalogu sprzętu
    const canViewCatalog = user ? hasPermission("viewInventory", user.rolePermissions, user.permissionOverrides) : false;

    // Sprawdzamy, czy użytkownik posiada JAKIEKOLWIEK uprawnienie do wyświetlenia sekcji operacyjnych (Magazyn, Biuro, Zarządzanie budową)
    const hasAnyOperationalPermission = isWarehouse || isAccountant || isManager || canManageCloseouts;

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

                                {canManageCloseouts && (
                                    <Link href="/dashboard/closeouts" className="bg-white hover:bg-slate-50 border p-6 rounded-2xl shadow-sm transition-all flex items-center justify-between group">
                                        <div>
                                            <p className="text-slate-400 text-xs font-bold uppercase">Rozliczanie Budów</p>
                                            <p className="text-4xl font-black text-blue-600 mt-2">🏁</p>
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
        </div>
    );
}