// src/lib/auth/permissions.ts

// Słownik wszystkich uprawnień w systemie PESAM
export const ALL_PERMISSIONS = {
    viewMySite: "Widok: Twoja budowa (stan Twoich budów)",
    manageUsers: "Zarządzanie pracownikami (Dodawanie/Edycja)",
    manageRoles: "Zarządzanie rolami i uprawnieniami",
    manageSites: "Zarządzanie budowami",
    viewInventory: "Katalog: Przeglądanie sprzętu",
    manageInventory: "Katalog: Dodawanie i edycja sprzętu",
    createOrder: "Sklep: Składanie zamówień na budowę",
    manageOrders: "Magazyn: Realizacja zamówień",

    protocolsIssue: "Protokoły: Wydania z magazynu",
    protocolsReturnApp: "Protokoły: Zwrot elektroniczny",
    protocolsReturnPaper: "Protokoły: Zwrot z papieru",
    acceptReturns: "Protokoły: Akceptacja zwrotów",
    viewProtocolHistory: "Protokoły: Historia i zaawansowana wyszukiwarka",

    viewSiteState: "Podgląd: Stany na budowach",
    manageProjectCloseouts: "Zarządzanie: Rozliczanie i zamykanie budów", // <-- NOWE UPRAWNIENIE
    approveProjectCloseouts: "Podpisywanie i akceptacja zamknięć budów (Kierownik / Dyrekcja)", // <-- NOWE UPRAWNIENIE

    viewClaims: "Sąd: Dostęp do panelu (Widzi tylko swoje sprawy)",
    viewAllClaims: "Sąd: Widok wszystkich spraw w firmie",
    manageClaims: "Sąd: Wydawanie wyroków i przypisywanie winnych (Dyrektor / Szef)",
    manageClaimsFinal: "Sąd: Ostateczna akceptacja i zmiana wyroków (Szef)",
    manageSettings: "Zarządzanie: Globalne ustawienia systemu (Sklep, Sąd CLS)",
    manageImport: "System: Import danych z arkusza",
    viewVehicles: "Flota: Podgląd bazy pojazdów i historii napraw",
    manageVehicles: "Flota: Zarządzanie (dodawanie/edycja pojazdów i napraw)",

    // --- NOWE UPRAWNIENIA DLA PRACOWNIKÓW FIZYCZNYCH ---
    workersManage: "Pracownicy fizyczni: Zarządzanie kartoteką (Dodaj/Edytuj)",
    workersIssueWarehouse: "Pracownicy fizyczni: Wydawanie z Magazynu Głównego",
    workersIssueSite: "Pracownicy fizyczni: Wydawanie ze swoich budów",
    workersAddToSite: "Wprowadź na stan budowy"
};

export type PermissionKey = keyof typeof ALL_PERMISSIONS;

export function hasPermission(
    permissionKey: PermissionKey,
    rolePermissions: Record<string, boolean> = {},
    permissionOverrides: Record<string, boolean> = {}
): boolean {
    if (permissionKey in permissionOverrides) {
        return permissionOverrides[permissionKey];
    }
    if (permissionKey in rolePermissions) {
        return rolePermissions[permissionKey];
    }
    return false;
}