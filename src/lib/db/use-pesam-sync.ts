// src/lib/db/use-pesam-sync.ts
// =============================================================================
// React Hook — zarządza synchronizacją i udostępnia dane komponentom
// Użycie: const { vehicles, repairs, isSyncing, forceSync } = usePesamSync()
// =============================================================================
'use client';

import { useState, useEffect, useCallback } from 'react';
import { localGetAllVehicles, localGetAllRepairs, LocalVehicle, LocalRepair } from './pesam-db';
import { syncWithFirestore, forceFullResync, SyncResult } from './sync-service';

interface UsePesamSyncReturn {
    vehicles: LocalVehicle[];
    repairs: LocalRepair[];
    isSyncing: boolean;
    syncStatus: string;
    lastSyncResult: SyncResult | null;
    forceSync: () => Promise<void>;
    refreshLocal: () => Promise<void>; // Odświeża dane z IndexedDB bez Firestore
}

export function usePesamSync(): UsePesamSyncReturn {
    const [vehicles, setVehicles] = useState<LocalVehicle[]>([]);
    const [repairs, setRepairs] = useState<LocalRepair[]>([]);
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncStatus, setSyncStatus] = useState('Inicjalizacja...');
    const [lastSyncResult, setLastSyncResult] = useState<SyncResult | null>(null);

    // Odświeżenie danych z lokalnej IndexedDB (bez zapytań do Firestore)
    const refreshLocal = useCallback(async () => {
        const [v, r] = await Promise.all([
            localGetAllVehicles(),
            localGetAllRepairs()
        ]);
        setVehicles(v);
        setRepairs(r);
    }, []);

    // Pełna synchronizacja z Firestore (przyrostowa)
    const runSync = useCallback(async (force = false) => {
        setIsSyncing(true);
        try {
            const syncFn = force ? forceFullResync : syncWithFirestore;
            const result = await syncFn((msg) => setSyncStatus(msg));

            setLastSyncResult(result);
            setSyncStatus(
                result.wasFullSync
                    ? `✓ Pierwsze pobieranie: ${result.vehiclesAdded} pojazdów, ${result.repairsAdded} napraw`
                    : result.vehiclesAdded + result.repairsAdded > 0
                        ? `✓ Zaktualizowano: +${result.vehiclesAdded} pojazdów, +${result.repairsAdded} napraw`
                        : '✓ Dane aktualne'
            );

            // Załaduj świeże dane z IndexedDB do stanu React
            await refreshLocal();
        } catch (err: any) {
            console.error('[usePesamSync]', err);
            setSyncStatus(`❌ Błąd synchronizacji: ${err.message}`);
            // Nawet przy błędzie syncu — załaduj co jest lokalnie
            await refreshLocal();
        } finally {
            setIsSyncing(false);
        }
    }, [refreshLocal]);

    // Publiczna funkcja wymuszenia pełnego resyncu (np. przycisk w UI)
    const forceSync = useCallback(() => runSync(true), [runSync]);

    // Uruchom sync automatycznie przy montowaniu komponentu
    useEffect(() => {
        runSync(false);
    }, [runSync]);

    return { vehicles, repairs, isSyncing, syncStatus, lastSyncResult, forceSync, refreshLocal };
}