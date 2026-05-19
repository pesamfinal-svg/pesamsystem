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

    viewSiteState: "Podgląd: Stany na budowach",
    viewClaims: "Sąd: Dostęp do panelu (Widzi tylko swoje sprawy)",
    viewAllClaims: "Sąd: Widok wszystkich spraw w firmie",
    manageClaims: "Sąd: Wydawanie wyroków i przypisywanie winnych (Dyrektor / Szef)",

    // --- NOWE UPRAWNIENIA DLA PRACOWNIKÓW FIZYCZNYCH ---
    workersManage: "Pracownicy fizyczni: Zarządzanie kartoteką (Dodaj/Edytuj)",
    workersIssueWarehouse: "Pracownicy fizyczni: Wydawanie z Magazynu Głównego",
    workersIssueSite: "Pracownicy fizyczni: Wydawanie ze swoich budów"
};

export type PermissionKey = keyof typeof ALL_PERMISSIONS;

/**
 * Główna funkcja sprawdzająca uprawnienia (Serce systemu)
 * 1. Sprawdza "wyjątki" danego pracownika (permissionOverrides).
 * 2. Jeśli nie ma wyjątku, bierze domyślne uprawnienie z Roli.
 */
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