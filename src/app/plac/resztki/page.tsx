"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { useAuth } from "@/lib/auth/AuthContext";
import { useRouter } from "next/navigation";
import { collection, getDocs, doc, setDoc, updateDoc, addDoc, query, orderBy, getDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "@/lib/firebase/config";
import Link from "next/link";
import { RESIDUAL_MAIN_CATEGORIES, ResidualCategoryDef } from "@/lib/constants/residualCategories";
import {
    savePendingPhoto,
    getPendingPhotos,
    deletePendingPhoto,
    blobToDataUrl,
    PendingPhotoUpload
} from "@/lib/db/offline-plac-photos";

interface StorageLocation {
    id: string;
    name: string;
    description?: string;
    totalCapacity?: number;
    currentOccupied?: number;
    categories?: string[];
}

const DEFAULT_STORAGE_LOCATIONS: StorageLocation[] = [
    { id: "loc_plac", name: "Plac Zewnętrzny", totalCapacity: 30, currentOccupied: 12, categories: ["pustaki", "kable-elektryka", "szalunki", "stal-ogrodzenia", "kanalizacja-odwodnienia"] },
    { id: "loc_chemia", name: "Magazyn Farb i Chemii", totalCapacity: 10, currentOccupied: 4, categories: ["farby-chemia", "pianki-silikony"] },
    { id: "loc_hala_sucha", name: "Hala Główna - Regały Suche", totalCapacity: 25, currentOccupied: 16, categories: ["kleje", "plyty-gk", "gipsy-gladzie", "izolacje-folie"] }
];

interface ResidualItem {
    id: string;
    name: string;
    availableQuantity: number;
    totalQuantity: number;
    unit?: string;
    currentLocation?: string;
    imageUrl?: string;
    category?: string;
    subcategory?: string;
    inventoryNumber?: string;
    isResidual?: boolean;
    additionalInfo?: string;
    updatedAt?: string;
    createdAt?: string;
    isPendingUpload?: boolean;
}

// Funkcja kompresji zdjęć z aparatu telefonu przed wysłaniem na Firebase Storage
async function compressImage(file: File, maxWidth = 1200, quality = 0.8): Promise<Blob> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const imgElement = new Image();
            imgElement.src = event.target?.result as string;
            imgElement.onload = () => {
                const canvas = document.createElement("canvas");
                const context = canvas.getContext("2d");
                let width = imgElement.width;
                let height = imgElement.height;

                if (width > maxWidth) {
                    height = Math.round((height * maxWidth) / width);
                    width = maxWidth;
                }

                canvas.width = width;
                canvas.height = height;
                context?.drawImage(imgElement, 0, 0, width, height);
                canvas.toBlob(
                    (blob) => {
                        if (blob) resolve(blob);
                        else resolve(file);
                    },
                    "image/jpeg",
                    quality
                );
            };
            imgElement.onerror = () => resolve(file);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export default function PlacResidualsPage() {
    const { user, loading, signOut } = useAuth();
    const router = useRouter();
    const [items, setItems] = useState<ResidualItem[]>([]);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<"ALL" | "NO_PHOTO" | "LOW_STOCK">("ALL");
    const [isOnline, setIsOnline] = useState(true);
    const [uploadingId, setUploadingId] = useState<string | null>(null);
    const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
    const [isPwaModalOpen, setIsPwaModalOpen] = useState(false);
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [toast, setToast] = useState<string | null>(null);
    const [isSubmittingNew, setIsSubmittingNew] = useState(false);
    const [pendingPhotos, setPendingPhotos] = useState<PendingPhotoUpload[]>([]);
    const [isSyncingPhotos, setIsSyncingPhotos] = useState(false);

    // Dynamiczne kategorie i strefy z Firestore / konfiguracji
    const [categoriesList, setCategoriesList] = useState<ResidualCategoryDef[]>(RESIDUAL_MAIN_CATEGORIES);
    const [storageLocations, setStorageLocations] = useState<StorageLocation[]>(DEFAULT_STORAGE_LOCATIONS);

    // Formularz nowej resztki
    const [newItem, setNewItem] = useState<{
        name: string;
        qty: number;
        unit: string;
        location: string;
        category: string;
        subcategory: string;
        notes: string;
        photoFile: File | null;
        photoPreview: string | null;
    }>({
        name: "",
        qty: 1,
        unit: "szt.",
        location: DEFAULT_STORAGE_LOCATIONS[0]?.name || "Plac Zewnętrzny",
        category: "",
        subcategory: "",
        notes: "",
        photoFile: null,
        photoPreview: null
    });

    // Pokaż toast
    const showToast = (msg: string) => {
        setToast(msg);
        setTimeout(() => setToast(null), 3500);
    };

    // Odśwież listę oczekujących zdjęć w telefonie
    const refreshPendingQueue = async () => {
        try {
            const list = await getPendingPhotos();
            setPendingPhotos(list);
            return list;
        } catch {
            return [];
        }
    };

    // Synchronizacja oczekujących zdjęć z chmurą
    const syncPendingPhotos = async () => {
        if (!navigator.onLine) {
            showToast("⚠️ Brak połączenia z internetem – połącz się z siecią, aby wysłać zdjęcia.");
            return;
        }

        const queue = await getPendingPhotos();
        if (queue.length === 0) return;

        setIsSyncingPhotos(true);
        showToast(`🚀 Wysyłanie ${queue.length} zdjęć z pamięci telefonu...`);

        let successCount = 0;
        for (const entry of queue) {
            try {
                const storageRef = ref(storage, `inventory/residuals_${entry.itemId}_${Date.now()}.jpg`);
                await uploadBytes(storageRef, entry.photoBlob);
                const downloadURL = await getDownloadURL(storageRef);

                if (entry.isNewItem && entry.newItemData) {
                    const docData = {
                        name: entry.newItemData.name,
                        availableQuantity: Number(entry.newItemData.qty) || 1,
                        totalQuantity: Number(entry.newItemData.qty) || 1,
                        unit: entry.newItemData.unit || "szt.",
                        currentLocation: entry.newItemData.location || "Plac Zewnętrzny",
                        category: entry.newItemData.category || "Pozostałości budowlane",
                        subcategory: entry.newItemData.subcategory || "",
                        additionalInfo: entry.newItemData.notes || "",
                        imageUrl: downloadURL,
                        inventoryNumber: "RESZTKI",
                        isResidual: true,
                        type: "BULK",
                        subType: "MANUAL",
                        status: "DOSTĘPNY",
                        createdAt: entry.createdAt || new Date().toISOString()
                    };
                    const docRef = await addDoc(collection(db, "inventory"), docData);
                    setItems(prev => prev.map(i => i.id === entry.itemId ? { ...i, id: docRef.id, imageUrl: downloadURL, isPendingUpload: false, category: docData.category, subcategory: docData.subcategory, currentLocation: docData.currentLocation } : i));
                } else {
                    await updateDoc(doc(db, "inventory", entry.itemId), {
                        imageUrl: downloadURL,
                        updatedAt: new Date().toISOString()
                    });
                    setItems(prev => prev.map(i => i.id === entry.itemId ? { ...i, imageUrl: downloadURL, isPendingUpload: false } : i));
                }

                await deletePendingPhoto(entry.id);
                successCount++;
            } catch (syncErr) {
                console.warn(`Błąd synchronizacji zdjęcia ${entry.id}:`, syncErr);
            }
        }

        await refreshPendingQueue();
        setIsSyncingPhotos(false);
        if (successCount > 0) {
            showToast(`✅ Zsynchronizowano ${successCount} zdjęć z chmurą!`);
            fetchFreshData();
        }
    };

    // 1. Ładowanie danych i obsługa offline cache
    useEffect(() => {
        setIsOnline(navigator.onLine);

        // Dynamiczne ustawienie manifestu PWA dla Placu
        let manifestLink = document.querySelector<HTMLLinkElement>("link[rel~='manifest']");
        if (manifestLink) {
            manifestLink.href = "/manifest-plac.json";
        } else {
            manifestLink = document.createElement("link");
            manifestLink.rel = "manifest";
            manifestLink.href = "/manifest-plac.json";
            document.head.appendChild(manifestLink);
        }
        document.title = "PESAM Plac & Resztki";

        // Załaduj oczekujące zdjęcia z IndexedDB
        refreshPendingQueue();

        // Natychmiastowe załadowanie z pamięci telefonu (0 ms opóźnienia na placu)
        const cachedItems = localStorage.getItem("pesam_residuals_cache");
        if (cachedItems) {
            try {
                setItems(JSON.parse(cachedItems));
            } catch (e) {
                console.error("Błąd odczytu cache:", e);
            }
        }
        const cachedCats = localStorage.getItem("pesam_residual_categories_cache");
        if (cachedCats) {
            try {
                setCategoriesList(JSON.parse(cachedCats));
            } catch (e) {
                console.error("Błąd odczytu cache kategorii:", e);
            }
        }
        const cachedLocs = localStorage.getItem("pesam_storage_locations_cache");
        if (cachedLocs) {
            try {
                setStorageLocations(JSON.parse(cachedLocs));
            } catch (e) {
                console.error("Błąd odczytu cache stref:", e);
            }
        }

        const handleOnline = () => {
            setIsOnline(true);
            showToast("🟢 Połączono z siecią (Online)");
            fetchFreshData();
            syncPendingPhotos();
        };
        const handleOffline = () => {
            setIsOnline(false);
            showToast("🟠 Tryb offline - korzystasz z pamięci telefonu");
        };

        window.addEventListener("online", handleOnline);
        window.addEventListener("offline", handleOffline);

        if (!loading && !user && localStorage.getItem("pesam_logged_in") !== "true") {
            router.push("/login?redirect=/plac");
        } else if (user) {
            localStorage.setItem("pesam_logged_in", "true");
            fetchFreshData();
        }

        return () => {
            window.removeEventListener("online", handleOnline);
            window.removeEventListener("offline", handleOffline);
        };
    }, [loading, user, router]);

    const fetchFreshData = async () => {
        try {
            const [querySnapshot, catSnap, capacitySnap] = await Promise.all([
                getDocs(query(collection(db, "inventory"), orderBy("name"))),
                getDoc(doc(db, "settings", "residual_categories")),
                getDoc(doc(db, "settings", "warehouse_capacity"))
            ]);

            const filteredItems = querySnapshot.docs
                .map(docSnap => ({
                    id: docSnap.id,
                    ...docSnap.data()
                } as ResidualItem))
                .filter(item =>
                    item.category === "Pozostałości budowlane" ||
                    item.inventoryNumber === "RESZTKI" ||
                    item.isResidual
                );

            setItems(filteredItems);
            localStorage.setItem("pesam_residuals_cache", JSON.stringify(filteredItems));

            if (catSnap.exists() && Array.isArray(catSnap.data().categories) && catSnap.data().categories.length > 0) {
                setCategoriesList(catSnap.data().categories);
                localStorage.setItem("pesam_residual_categories_cache", JSON.stringify(catSnap.data().categories));
            }

            if (capacitySnap.exists() && Array.isArray(capacitySnap.data().locations) && capacitySnap.data().locations.length > 0) {
                setStorageLocations(capacitySnap.data().locations);
                localStorage.setItem("pesam_storage_locations_cache", JSON.stringify(capacitySnap.data().locations));
            }
        } catch (error) {
            console.warn("Błąd pobierania danych (możliwy brak sieci):", error);
        }
    };

    // 2. Bezpośrednie zrobienie zdjęcia aparatem telefonu dla danej pozycji (z obsługą offline!)
    const handleCameraCapture = async (item: ResidualItem, file: File) => {
        try {
            setUploadingId(item.id);
            showToast("⏳ Zapisywanie zdjęcia z placu...");
            const compressedBlob = await compressImage(file, 1200, 0.8);
            const previewUrl = await blobToDataUrl(compressedBlob);

            // TRYB OFFLINE: Jeśli brak sieci, od razu zapisujemy do IndexedDB i pokazujemy podgląd!
            if (!navigator.onLine) {
                await savePendingPhoto({
                    id: `PHOTO_${item.id}_${Date.now()}`,
                    itemId: item.id,
                    itemName: item.name,
                    photoBlob: compressedBlob,
                    previewDataUrl: previewUrl,
                    createdAt: new Date().toISOString(),
                    status: "PENDING"
                });

                const updatedItems = items.map(i =>
                    i.id === item.id ? { ...i, imageUrl: previewUrl, isPendingUpload: true } : i
                );
                setItems(updatedItems);
                localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));
                await refreshPendingQueue();
                showToast("💾 Zdjęcie zapisane w telefonie (offline)! Wyśle się po powrocie zasięgu.");
                return;
            }

            // TRYB ONLINE: Próba wysłania z limitem czasu 7s (aby wolny zasięg nie wieszał ekranu)
            const uploadPromise = async () => {
                const storageRef = ref(storage, `inventory/residuals_${item.id}_${Date.now()}.jpg`);
                await uploadBytes(storageRef, compressedBlob);
                return await getDownloadURL(storageRef);
            };

            const downloadURL = await Promise.race([
                uploadPromise(),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 7000))
            ]);

            await updateDoc(doc(db, "inventory", item.id), {
                imageUrl: downloadURL,
                updatedAt: new Date().toISOString()
            });

            const updatedItems = items.map(i => (i.id === item.id ? { ...i, imageUrl: downloadURL, isPendingUpload: false } : i));
            setItems(updatedItems);
            localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));
            showToast("✅ Zdjęcie materiału zaktualizowane!");
        } catch (error: any) {
            console.warn("Wgrywanie online nie powiodło się, zapisuję do kolejki offline:", error);
            // Awaryjny fallback do pamięci telefonu IndexedDB
            try {
                const compressedBlob = await compressImage(file, 1200, 0.8);
                const previewUrl = await blobToDataUrl(compressedBlob);
                await savePendingPhoto({
                    id: `PHOTO_${item.id}_${Date.now()}`,
                    itemId: item.id,
                    itemName: item.name,
                    photoBlob: compressedBlob,
                    previewDataUrl: previewUrl,
                    createdAt: new Date().toISOString(),
                    status: "PENDING"
                });

                const updatedItems = items.map(i =>
                    i.id === item.id ? { ...i, imageUrl: previewUrl, isPendingUpload: true } : i
                );
                setItems(updatedItems);
                localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));
                await refreshPendingQueue();
                showToast("💾 Słaby zasięg – zdjęcie zapisano w telefonie! Zostanie wysłane po powrocie zasięgu.");
            } catch (saveErr) {
                alert("Błąd zapisu zdjęcia: " + saveErr);
            }
        } finally {
            setUploadingId(null);
        }
    };

    // 3. Szybka zmiana stanu na placu (+ / -)
    const handleQuickDelta = async (item: ResidualItem, delta: number) => {
        try {
            const currentAvail = Number(item.availableQuantity) || 0;
            const currentTotal = Number(item.totalQuantity) || 0;
            const newAvail = Math.max(0, currentAvail + delta);
            const newTotal = Math.max(0, currentTotal + delta);

            await updateDoc(doc(db, "inventory", item.id), {
                availableQuantity: newAvail,
                totalQuantity: newTotal,
                updatedAt: new Date().toISOString()
            });

            const updatedItems = items.map(i =>
                i.id === item.id ? { ...i, availableQuantity: newAvail, totalQuantity: newTotal } : i
            );
            setItems(updatedItems);
            localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));
            showToast(`Zaktualizowano stan: ${newAvail} ${item.unit || "szt."}`);
        } catch (error: any) {
            console.error("Błąd aktualizacji ilości: ", error);
            alert("Błąd aktualizacji ilości: " + (error?.message || error));
        }
    };

    // 4. Wpisanie dokładnego stanu (np. po inwentaryzacji placowej)
    const handleExactQty = async (item: ResidualItem) => {
        const promptVal = prompt(
            `Podaj aktualny stan dla:\n${item.name}\n(Obecnie: ${item.availableQuantity} ${item.unit || "szt."}):`,
            String(item.availableQuantity ?? 0)
        );
        if (promptVal !== null) {
            const parsed = parseFloat(promptVal.replace(",", "."));
            if (!isNaN(parsed) && parsed >= 0) {
                try {
                    await updateDoc(doc(db, "inventory", item.id), {
                        availableQuantity: parsed,
                        totalQuantity: parsed,
                        updatedAt: new Date().toISOString()
                    });

                    const updatedItems = items.map(i =>
                        i.id === item.id ? { ...i, availableQuantity: parsed, totalQuantity: parsed } : i
                    );
                    setItems(updatedItems);
                    localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));
                    showToast(`✅ Zapisano stan: ${parsed} ${item.unit || "szt."}`);
                } catch (error: any) {
                    alert("Błąd zapisu ilości: " + error.message);
                }
            }
        }
    };

    // 5. Utworzenie nowej pozycji bezpośrednio z placu (z obsługą offline!)
    const handleCreateNew = async () => {
        if (!newItem.name.trim()) {
            alert("Podaj nazwę resztki budowlanej!");
            return;
        }

        try {
            setIsSubmittingNew(true);
            let finalImageUrl = "";
            let photoBlobToSave: Blob | null = null;
            let previewUrl = "";

            if (newItem.photoFile) {
                showToast("⏳ Zapisywanie zdjęcia z aparatu...");
                photoBlobToSave = await compressImage(newItem.photoFile, 1200, 0.8);
                previewUrl = await blobToDataUrl(photoBlobToSave);
            }

            // Jeśli brak sieci: natychmiast zapisz do IndexedDB w telefonie i dodaj do listy
            if (!navigator.onLine) {
                const tempId = `OFFLINE_${Date.now()}`;
                if (photoBlobToSave) {
                    await savePendingPhoto({
                        id: `PHOTO_NEW_${Date.now()}`,
                        itemId: tempId,
                        itemName: newItem.name.trim(),
                        photoBlob: photoBlobToSave,
                        previewDataUrl: previewUrl,
                        isNewItem: true,
                        newItemData: {
                            name: newItem.name.trim(),
                            qty: Number(newItem.qty) || 1,
                            unit: newItem.unit || "szt.",
                            location: newItem.location || "Plac Zewnętrzny",
                            category: newItem.category || "Pozostałości budowlane",
                            subcategory: newItem.subcategory || "",
                            notes: newItem.notes || ""
                        },
                        createdAt: new Date().toISOString(),
                        status: "PENDING"
                    });
                    await refreshPendingQueue();
                }

                const createdItem: ResidualItem = {
                    id: tempId,
                    name: newItem.name.trim(),
                    availableQuantity: Number(newItem.qty) || 1,
                    totalQuantity: Number(newItem.qty) || 1,
                    unit: newItem.unit || "szt.",
                    currentLocation: newItem.location || "Plac Zewnętrzny",
                    category: newItem.category || "Pozostałości budowlane",
                    subcategory: newItem.subcategory || "",
                    additionalInfo: newItem.notes || "",
                    imageUrl: previewUrl || "",
                    inventoryNumber: "RESZTKI",
                    isResidual: true,
                    isPendingUpload: !!photoBlobToSave,
                    createdAt: new Date().toISOString()
                };

                const updatedItems = [createdItem, ...items].sort((a, b) => a.name.localeCompare(b.name));
                setItems(updatedItems);
                localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));

                showToast("💾 Nowa resztka zapisana w telefonie! Zostanie zsynchronizowana po uzyskaniu zasięgu.");
                setIsAddModalOpen(false);
                setNewItem({
                    name: "",
                    qty: 1,
                    unit: "szt.",
                    location: storageLocations[0]?.name || "Plac Zewnętrzny",
                    category: "",
                    subcategory: "",
                    notes: "",
                    photoFile: null,
                    photoPreview: null
                });
                return;
            }

            // Tryb Online:
            if (photoBlobToSave) {
                const uploadPromise = async () => {
                    const storageRef = ref(storage, `inventory/residuals_new_${Date.now()}.jpg`);
                    await uploadBytes(storageRef, photoBlobToSave!);
                    return await getDownloadURL(storageRef);
                };

                finalImageUrl = await Promise.race([
                    uploadPromise(),
                    new Promise<string>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 7000))
                ]);
            }

            const docData = {
                name: newItem.name.trim(),
                availableQuantity: Number(newItem.qty) || 1,
                totalQuantity: Number(newItem.qty) || 1,
                unit: newItem.unit || "szt.",
                currentLocation: newItem.location || "Plac Zewnętrzny",
                category: newItem.category || "Pozostałości budowlane",
                subcategory: newItem.subcategory || "",
                additionalInfo: newItem.notes || "",
                imageUrl: finalImageUrl,
                inventoryNumber: "RESZTKI",
                isResidual: true,
                type: "BULK",
                subType: "MANUAL",
                status: "DOSTĘPNY",
                createdAt: new Date().toISOString()
            };

            const docRef = await addDoc(collection(db, "inventory"), docData);
            const createdItem: ResidualItem = { id: docRef.id, ...docData };

            const updatedItems = [createdItem, ...items].sort((a, b) => a.name.localeCompare(b.name));
            setItems(updatedItems);
            localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));

            showToast("🎉 Nowa resztka dodana do bazy placu!");
            setIsAddModalOpen(false);
            setNewItem({
                name: "",
                qty: 1,
                unit: "szt.",
                location: storageLocations[0]?.name || "Plac Zewnętrzny",
                category: "",
                subcategory: "",
                notes: "",
                photoFile: null,
                photoPreview: null
            });
        } catch (error: any) {
            console.warn("Błąd online w handleCreateNew, zapis do offline:", error);
            // Fallback: dodaj lokalnie z kolejką offline
            const tempId = `OFFLINE_${Date.now()}`;
            try {
                if (newItem.photoFile) {
                    const photoBlobToSave = await compressImage(newItem.photoFile, 1200, 0.8);
                    const previewUrl = await blobToDataUrl(photoBlobToSave);
                    await savePendingPhoto({
                        id: `PHOTO_NEW_${Date.now()}`,
                        itemId: tempId,
                        itemName: newItem.name.trim(),
                        photoBlob: photoBlobToSave,
                        previewDataUrl: previewUrl,
                        isNewItem: true,
                        newItemData: {
                            name: newItem.name.trim(),
                            qty: Number(newItem.qty) || 1,
                            unit: newItem.unit || "szt.",
                            location: newItem.location || "Plac Zewnętrzny",
                            category: newItem.category || "Pozostałości budowlane",
                            subcategory: newItem.subcategory || "",
                            notes: newItem.notes || ""
                        },
                        createdAt: new Date().toISOString(),
                        status: "PENDING"
                    });
                    await refreshPendingQueue();

                    const createdItem: ResidualItem = {
                        id: tempId,
                        name: newItem.name.trim(),
                        availableQuantity: Number(newItem.qty) || 1,
                        totalQuantity: Number(newItem.qty) || 1,
                        unit: newItem.unit || "szt.",
                        currentLocation: newItem.location || "Plac Zewnętrzny",
                        category: newItem.category || "Pozostałości budowlane",
                        subcategory: newItem.subcategory || "",
                        additionalInfo: newItem.notes || "",
                        imageUrl: previewUrl,
                        inventoryNumber: "RESZTKI",
                        isResidual: true,
                        isPendingUpload: true,
                        createdAt: new Date().toISOString()
                    };

                    const updatedItems = [createdItem, ...items].sort((a, b) => a.name.localeCompare(b.name));
                    setItems(updatedItems);
                    localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));
                }
                showToast("💾 Zapisano w pamięci telefonu (offline)! Wyślemy po powrocie zasięgu.");
                setIsAddModalOpen(false);
            } catch (fallbackErr) {
                alert("Błąd: " + fallbackErr);
            }
        } finally {
            setIsSubmittingNew(false);
        }
    };

    // 6. Przefiltrowane elementy (wyszukiwarka + filtry)
    const filteredItems = useMemo(() => {
        const queryLower = search.toLowerCase().trim();
        return items.filter(item => {
            const matchesSearch =
                !queryLower ||
                (item.name && item.name.toLowerCase().includes(queryLower)) ||
                (item.currentLocation && item.currentLocation.toLowerCase().includes(queryLower)) ||
                (item.additionalInfo && item.additionalInfo.toLowerCase().includes(queryLower));

            if (!matchesSearch) return false;

            if (filter === "NO_PHOTO") return !item.imageUrl;
            if (filter === "LOW_STOCK") return (item.availableQuantity || 0) <= 1;
            return true;
        });
    }, [items, search, filter]);

    const countNoPhoto = useMemo(() => items.filter(i => !i.imageUrl).length, [items]);
    const countLowStock = useMemo(() => items.filter(i => (i.availableQuantity || 0) <= 1).length, [items]);

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans pb-20 select-none">
            {/* Sticky Header dostosowany do pracy w słońcu na placu */}
            <header className="sticky top-0 z-30 bg-slate-900/95 backdrop-blur border-b border-slate-800 shadow-xl px-4 py-3">
                <div className="flex justify-between items-center mb-3">
                    <div className="flex items-center gap-2">
                        <Link
                            href="/plac"
                            title="Wróć do menu głównego"
                            className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center border border-slate-700 text-sm active:scale-95 transition"
                        >
                            🔙
                        </Link>
                        <span className="text-2xl">🏗️</span>
                        <div>
                            <h1 className="text-lg font-black tracking-wider text-amber-400 uppercase leading-none">
                                PESAM PLAC
                            </h1>
                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                                Magazyn Resztek & Pozostałości
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <span
                            className={`text-[10px] font-black px-2 py-1 rounded-full uppercase tracking-wider border ${
                                isOnline
                                    ? "bg-emerald-950/80 text-emerald-400 border-emerald-700/60"
                                    : "bg-amber-950/80 text-amber-400 border-amber-700/60"
                            }`}
                        >
                            {isOnline ? "🟢 Online" : "🟠 Pamięć"}
                        </span>

                        <button
                            onClick={fetchFreshData}
                            title="Odśwież dane"
                            className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center border border-slate-700 text-sm active:scale-95 transition"
                        >
                            🔄
                        </button>

                        <button
                            onClick={() => setIsPwaModalOpen(true)}
                            title="Zainstaluj na telefonie"
                            className="h-9 px-2.5 rounded-xl bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 flex items-center gap-1 border border-blue-500/30 text-xs font-bold active:scale-95 transition"
                        >
                            📱 <span className="hidden sm:inline">Na telefon</span>
                        </button>

                        <Link
                            href="/dashboard/inventory"
                            title="Przejdź do pełnego panelu na komputerze"
                            className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center border border-slate-700 text-sm active:scale-95 transition"
                        >
                            🖥️
                        </Link>
                    </div>
                </div>

                {/* Duży, kontrastowy przycisk: NOWA RESZTKA Z PLACU */}
                <button
                    onClick={() => setIsAddModalOpen(true)}
                    className="w-full py-3.5 px-4 bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600 hover:from-amber-400 hover:to-orange-500 text-slate-950 font-black text-sm uppercase tracking-wider rounded-2xl shadow-lg shadow-orange-600/30 flex items-center justify-center gap-2 active:scale-[0.98] transition border border-amber-300/40"
                >
                    <span className="text-xl">➕</span>
                    <span>Dodaj nową pozycję z placu</span>
                </button>

                {/* Szybka wyszukiwarka i filtry kafelkowe */}
                <div className="mt-3 flex gap-2">
                    <div className="relative flex-1">
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Szukaj resztki (np. Klej, Folia, 25x4)..."
                            className="w-full bg-slate-800/90 border border-slate-700/80 rounded-xl px-3 py-2 pl-9 text-xs text-white placeholder-slate-400 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition"
                        />
                        <span className="absolute left-3 top-2.5 text-xs text-slate-400">🔍</span>
                        {search && (
                            <button
                                onClick={() => setSearch("")}
                                className="absolute right-2.5 top-2 text-xs text-slate-400 hover:text-white p-0.5"
                            >
                                ✕
                            </button>
                        )}
                    </div>
                </div>

                {/* Filtry (Wszystko / Bez zdjęcia / Kończące się) */}
                <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1 text-[11px] no-scrollbar">
                    <button
                        onClick={() => setFilter("ALL")}
                        className={`px-3 py-1.5 rounded-xl font-bold whitespace-nowrap transition ${
                            filter === "ALL"
                                ? "bg-amber-500 text-slate-950 font-black shadow"
                                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                        }`}
                    >
                        Wszystko ({items.length})
                    </button>
                    <button
                        onClick={() => setFilter("NO_PHOTO")}
                        className={`px-3 py-1.5 rounded-xl font-bold whitespace-nowrap transition flex items-center gap-1 ${
                            filter === "NO_PHOTO"
                                ? "bg-amber-500 text-slate-950 font-black shadow"
                                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                        }`}
                    >
                        📷 Bez fotki ({countNoPhoto})
                    </button>
                    <button
                        onClick={() => setFilter("LOW_STOCK")}
                        className={`px-3 py-1.5 rounded-xl font-bold whitespace-nowrap transition flex items-center gap-1 ${
                            filter === "LOW_STOCK"
                                ? "bg-amber-500 text-slate-950 font-black shadow"
                                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                        }`}
                    >
                        ⚠️ Kończące się ({countLowStock})
                    </button>
                </div>

                {/* BANNER KOLEJKI OFFLINE (Gdy są zdjęcia oczekujące na wysłanie) */}
                {pendingPhotos.length > 0 && (
                    <div className="mt-3 bg-gradient-to-r from-amber-500/20 via-orange-500/20 to-amber-500/20 border border-amber-500/50 rounded-2xl p-3 flex items-center justify-between gap-2 shadow-lg animate-fade-in">
                        <div className="flex items-center gap-2.5 min-w-0">
                            <span className="text-2xl">📸</span>
                            <div className="min-w-0">
                                <p className="text-xs font-black text-amber-300 truncate">
                                    Zdjęcia w pamięci telefonu: {pendingPhotos.length}
                                </p>
                                <p className="text-[10px] text-slate-300 truncate">
                                    {isOnline
                                        ? "Zasięg dostępny – kliknij, aby zsynchronizować z chmurą"
                                        : "Zapisano bezpiecznie offline. Wyślesz po powrocie zasięgu."}
                                </p>
                            </div>
                        </div>
                        <button
                            onClick={syncPendingPhotos}
                            disabled={isSyncingPhotos || !isOnline}
                            className="shrink-0 px-3 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs uppercase tracking-wider active:scale-95 transition disabled:opacity-50 flex items-center gap-1.5 shadow"
                        >
                            {isSyncingPhotos ? (
                                <>
                                    <span className="inline-block animate-spin text-sm">🔄</span>
                                    <span>Wysyłanie...</span>
                                </>
                            ) : (
                                <>
                                    <span>🚀 Wyślij teraz</span>
                                </>
                            )}
                        </button>
                    </div>
                )}
            </header>

            {/* Lista kafelków resztek budowlanych */}
            <main className="flex-1 p-3 max-w-4xl mx-auto w-full">
                {filteredItems.length === 0 ? (
                    <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 text-center mt-6">
                        <span className="text-4xl block mb-2">🧱</span>
                        <h3 className="text-base font-black text-slate-200">Brak pozycji spełniających kryteria</h3>
                        <p className="text-xs text-slate-400 mt-1">
                            Zmień wyszukiwaną frazę lub dodaj nową resztkę przyciskiem powyżej.
                        </p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {filteredItems.map(item => {
                            const isThisUploading = uploadingId === item.id;
                            const hasPhoto = !!item.imageUrl;
                            const isPending = item.isPendingUpload || pendingPhotos.some(p => p.itemId === item.id);

                            return (
                                <div
                                    key={item.id}
                                    className="bg-slate-900 border border-slate-800/90 rounded-2xl p-3.5 shadow-md flex flex-col justify-between relative overflow-hidden transition hover:border-slate-700"
                                >
                                    {/* Loader podczas wgrywania fotki */}
                                    {isThisUploading && (
                                        <div className="absolute inset-0 bg-slate-950/85 z-20 flex flex-col items-center justify-center gap-2 backdrop-blur-sm animate-fade-in">
                                            <div className="w-8 h-8 border-4 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
                                            <span className="text-xs font-black text-amber-400 uppercase tracking-wider">
                                                Wgrywanie zdjęcia...
                                            </span>
                                        </div>
                                    )}

                                    {/* Górny wiersz kafelka: Miniaturka ze skrótem do aparatu + Nazwa + Badges */}
                                    <div className="flex gap-3 items-start">
                                        {/* Kontener zdjęcia */}
                                        <div className="relative flex-shrink-0">
                                            {hasPhoto ? (
                                                <div
                                                    onClick={() => setLightboxUrl(item.imageUrl!)}
                                                    className="w-18 h-18 sm:w-20 sm:h-20 rounded-xl overflow-hidden border border-slate-700 bg-slate-800 cursor-pointer shadow relative group"
                                                >
                                                    <img
                                                        src={item.imageUrl}
                                                        alt={item.name}
                                                        className="w-full h-full object-cover group-hover:scale-105 transition"
                                                    />
                                                    {isPending && (
                                                        <span className="absolute top-1 left-1 bg-amber-500 text-slate-950 text-[8px] font-black px-1 py-0.5 rounded shadow">
                                                            ⏳ Offline
                                                        </span>
                                                    )}
                                                    <span className="absolute bottom-0 right-0 bg-black/60 text-white text-[9px] px-1 rounded-tl font-bold">
                                                        🔍
                                                    </span>
                                                </div>
                                            ) : (
                                                <label
                                                    htmlFor={`camera-${item.id}`}
                                                    className="w-18 h-18 sm:w-20 sm:h-20 rounded-xl border-2 border-dashed border-amber-500/50 hover:border-amber-400 bg-amber-500/10 flex flex-col items-center justify-center cursor-pointer active:scale-95 transition"
                                                >
                                                    <span className="text-2xl">📸</span>
                                                    <span className="text-[9px] font-black text-amber-300 uppercase tracking-tighter mt-0.5">
                                                        Zrób foto
                                                    </span>
                                                </label>
                                            )}

                                            {/* Ukryty input aparatu telefonu */}
                                            <input
                                                id={`camera-${item.id}`}
                                                type="file"
                                                accept="image/*"
                                                capture="environment"
                                                className="hidden"
                                                onChange={e => {
                                                    if (e.target.files && e.target.files[0]) {
                                                        handleCameraCapture(item, e.target.files[0]);
                                                    }
                                                }}
                                            />
                                        </div>

                                        {/* Informacje o materiale */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <span className="bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider">
                                                    🧱 Resztki
                                                </span>
                                                <span className="text-[10px] text-slate-400 truncate">
                                                    📍 {item.currentLocation || "Plac"}
                                                </span>
                                            </div>

                                            <h3 className="font-black text-sm text-slate-100 mt-1 leading-snug line-clamp-2">
                                                {item.name}
                                            </h3>

                                            {item.additionalInfo && (
                                                <p className="text-[10px] text-slate-400 mt-0.5 italic line-clamp-1">
                                                    {item.additionalInfo}
                                                </p>
                                            )}

                                            {/* Przycisk zmiany/dodania zdjęcia jeśli już jakieś jest */}
                                            {hasPhoto && (
                                                <label
                                                    htmlFor={`camera-${item.id}`}
                                                    className="inline-flex items-center gap-1 mt-1 text-[10px] font-bold text-amber-400 hover:text-amber-300 cursor-pointer active:scale-95 transition"
                                                >
                                                    <span>📸 Zmień zdjęcie</span>
                                                </label>
                                            )}
                                        </div>
                                    </div>

                                    {/* Dolny wiersz: Duży stan magazynowy + Przyciski szybkiej korekty na placu */}
                                    <div className="mt-3 pt-2.5 border-t border-slate-800 flex items-center justify-between gap-2">
                                        <div
                                            onClick={() => handleExactQty(item)}
                                            className="cursor-pointer group flex flex-col"
                                            title="Kliknij, aby wpisać dokładną liczbę"
                                        >
                                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                                                Stan na placu:
                                            </span>
                                            <div className="flex items-baseline gap-1">
                                                <span className="text-base font-black text-amber-400 group-hover:underline">
                                                    {item.availableQuantity}
                                                </span>
                                                <span className="text-xs font-bold text-slate-300">
                                                    {item.unit || "szt."}
                                                </span>
                                                <span className="text-[10px] text-slate-500">✏️</span>
                                            </div>
                                        </div>

                                        {/* Kontrolki dotykowe min 44px wysokości dla wygodnej obsługi jedną ręką */}
                                        <div className="flex items-center gap-1.5">
                                            <button
                                                onClick={() => handleQuickDelta(item, -1)}
                                                className="w-11 h-11 rounded-xl bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-red-400 border border-slate-700 font-black text-lg flex items-center justify-center active:scale-90 transition shadow-sm"
                                                title="Odejmij 1"
                                            >
                                                −
                                            </button>
                                            <button
                                                onClick={() => handleExactQty(item)}
                                                className="h-11 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-amber-300 border border-slate-700 font-bold text-xs flex items-center justify-center active:scale-90 transition shadow-sm"
                                                title="Wpisz stan"
                                            >
                                                Wpisz
                                            </button>
                                            <button
                                                onClick={() => handleQuickDelta(item, 1)}
                                                className="w-11 h-11 rounded-xl bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-emerald-400 border border-slate-700 font-black text-lg flex items-center justify-center active:scale-90 transition shadow-sm"
                                                title="Dodaj 1"
                                            >
                                                +
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </main>

            {/* MODAL: Dodawanie nowej pozycji z placu */}
            {isAddModalOpen && (
                <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade-in">
                    <div className="bg-slate-900 border border-slate-800 w-full max-w-lg rounded-t-3xl sm:rounded-3xl p-5 shadow-2xl max-h-[92vh] overflow-y-auto">
                        <div className="flex justify-between items-center pb-3 border-b border-slate-800">
                            <div className="flex items-center gap-2">
                                <span className="text-2xl">🧱</span>
                                <h2 className="text-base font-black text-white uppercase tracking-wider">
                                    Nowa resztka z placu
                                </h2>
                            </div>
                            <button
                                onClick={() => setIsAddModalOpen(false)}
                                className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center font-bold"
                            >
                                ✕
                            </button>
                        </div>

                        <form
                            onSubmit={e => {
                                e.preventDefault();
                                handleCreateNew();
                            }}
                            className="mt-4 space-y-3.5"
                        >
                            {/* Nazwa materiału */}
                            <div>
                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                    Nazwa resztki / materiału *
                                </label>
                                <input
                                    type="text"
                                    required
                                    value={newItem.name}
                                    onChange={e => setNewItem({ ...newItem, name: e.target.value })}
                                    placeholder="np. Klej Sopro S (25kg), Bednarka 25x4..."
                                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-white placeholder-slate-500 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
                                />
                            </div>

                            {/* Ilość i Jednostka w 2 kolumnach */}
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                        Ilość na stanie *
                                    </label>
                                    <input
                                        type="number"
                                        step="any"
                                        required
                                        min="0"
                                        value={newItem.qty}
                                        onChange={e => setNewItem({ ...newItem, qty: parseFloat(e.target.value) || 0 })}
                                        className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm font-black text-amber-400 outline-none focus:border-amber-500"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                        Jednostka
                                    </label>
                                    <select
                                        value={newItem.unit}
                                        onChange={e => setNewItem({ ...newItem, unit: e.target.value })}
                                        className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-white font-bold outline-none focus:border-amber-500"
                                    >
                                        <option value="szt.">szt. (sztuki)</option>
                                        <option value="worki">worki / worek</option>
                                        <option value="rolki">rolki / rolka</option>
                                        <option value="krąg">krąg / zwoje</option>
                                        <option value="mb">mb (metry bieżące)</option>
                                        <option value="m2">m2 (metry kw.)</option>
                                        <option value="op.">op. (opakowania)</option>
                                        <option value="kg">kg (kilogramy)</option>
                                        <option value="litry">litry</option>
                                        <option value="paleta">paleta</option>
                                    </select>
                                </div>
                            </div>

                            {/* Zdjęcie z aparatu telefonu */}
                            <div>
                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                    Zdjęcie z placu (Aparat telefonu)
                                </label>
                                <div className="flex items-center gap-3">
                                    <label
                                        htmlFor="new-item-camera"
                                        className="flex-1 py-3 px-4 rounded-xl border-2 border-dashed border-amber-500/50 hover:border-amber-400 bg-amber-500/10 text-amber-300 font-bold text-xs flex items-center justify-center gap-2 cursor-pointer active:scale-98 transition"
                                    >
                                        <span className="text-xl">📸</span>
                                        <span>{newItem.photoFile ? "Zmień zdjęcie" : "Zrób zdjęcie aparatem"}</span>
                                    </label>
                                    <input
                                        id="new-item-camera"
                                        type="file"
                                        accept="image/*"
                                        capture="environment"
                                        className="hidden"
                                        onChange={e => {
                                            if (e.target.files && e.target.files[0]) {
                                                const file = e.target.files[0];
                                                setNewItem({
                                                    ...newItem,
                                                    photoFile: file,
                                                    photoPreview: URL.createObjectURL(file)
                                                });
                                            }
                                        }}
                                    />

                                    {newItem.photoPreview && (
                                        <div className="w-14 h-14 rounded-xl overflow-hidden border border-slate-700 bg-slate-800 flex-shrink-0 relative">
                                            <img
                                                src={newItem.photoPreview}
                                                alt="Podgląd"
                                                className="w-full h-full object-cover"
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Kategoria i Podkategoria */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                        Kategoria Główna
                                    </label>
                                    <select
                                        value={newItem.category}
                                        onChange={e => {
                                            const newCatName = e.target.value;
                                            setNewItem({
                                                ...newItem,
                                                category: newCatName,
                                                subcategory: "" // reset podkategorii przy zmianie kategorii
                                            });
                                        }}
                                        className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-white font-semibold outline-none focus:border-amber-500"
                                    >
                                        <option value="">-- Wybierz kategorię --</option>
                                        {categoriesList.map(cat => (
                                            <option key={cat.id || cat.name} value={cat.name}>
                                                {cat.icon || "📦"} {cat.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                        Podkategoria
                                    </label>
                                    {(() => {
                                        const selectedCatDef = categoriesList.find(c => c.name === newItem.category || c.id === newItem.category);
                                        const subList = selectedCatDef?.subcategories || [];

                                        return (
                                            <select
                                                value={newItem.subcategory}
                                                disabled={!newItem.category || subList.length === 0}
                                                onChange={e => setNewItem({ ...newItem, subcategory: e.target.value })}
                                                className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-white font-semibold outline-none focus:border-amber-500 disabled:opacity-40 disabled:bg-slate-900"
                                            >
                                                <option value="">
                                                    {!newItem.category
                                                        ? "-- Najpierw wybierz kategorię --"
                                                        : subList.length === 0
                                                        ? "-- Brak zdefiniowanych podkategorii --"
                                                        : "-- Wybierz podkategorię --"}
                                                </option>
                                                {subList.map(sub => (
                                                    <option key={sub} value={sub}>{sub}</option>
                                                ))}
                                            </select>
                                        );
                                    })()}
                                </div>
                            </div>

                            {/* Strefa składowania / Lokalizacja na placu */}
                            <div>
                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                    Strefa składowania / Sektor
                                </label>
                                <select
                                    value={newItem.location}
                                    onChange={e => setNewItem({ ...newItem, location: e.target.value })}
                                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-white font-bold outline-none focus:border-amber-500"
                                >
                                    {storageLocations.map(loc => (
                                        <option key={loc.id} value={loc.name}>
                                            📍 {loc.name} {loc.description ? `(${loc.description})` : ""}
                                        </option>
                                    ))}
                                    {newItem.location && !storageLocations.some(l => l.name === newItem.location) && (
                                        <option value={newItem.location}>📍 {newItem.location}</option>
                                    )}
                                    <option value="Plac Główny">📍 Inne: Plac Główny</option>
                                </select>
                            </div>

                            {/* Uwagi / notatka */}
                            <div>
                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                    Uwagi (np. skąd zjechało, stan materiału)
                                </label>
                                <textarea
                                    value={newItem.notes}
                                    onChange={e => setNewItem({ ...newItem, notes: e.target.value })}
                                    placeholder="np. Zwrot z budowy Grunwaldzka, otwarty worek, ok. 15kg..."
                                    rows={2}
                                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-amber-500"
                                />
                            </div>

                            {/* Przyciski Zapisu */}
                            <div className="pt-3 flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => setIsAddModalOpen(false)}
                                    className="py-3 px-4 rounded-xl border border-slate-700 text-slate-300 font-bold text-xs"
                                >
                                    Anuluj
                                </button>
                                <button
                                    type="submit"
                                    disabled={isSubmittingNew}
                                    className="flex-1 py-3 px-4 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
                                >
                                    {isSubmittingNew ? "ZAPISYWANIE..." : "✅ Zapisz na placu"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* LIGHTBOX: Pełnoekranowy podgląd zdjęcia */}
            {lightboxUrl && (
                <div
                    onClick={() => setLightboxUrl(null)}
                    className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center p-4 cursor-pointer animate-fade-in"
                >
                    <button
                        onClick={() => setLightboxUrl(null)}
                        className="absolute top-4 right-4 text-white font-bold bg-slate-800/80 px-4 py-2 rounded-full text-sm"
                    >
                        ✕ Zamknij
                    </button>
                    <img
                        src={lightboxUrl}
                        alt="Powiększenie"
                        className="max-w-full max-h-[85vh] object-contain rounded-2xl border border-slate-800 shadow-2xl"
                    />
                </div>
            )}

            {/* MODAL: Instrukcja PWA (Dodaj do ekranu telefonu) */}
            {isPwaModalOpen && (
                <div
                    onClick={() => setIsPwaModalOpen(false)}
                    className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
                >
                    <div
                        onClick={e => e.stopPropagation()}
                        className="bg-slate-900 border border-slate-800 w-full max-w-sm rounded-3xl p-5 shadow-2xl text-left"
                    >
                        <div className="flex items-center gap-2 mb-3">
                            <span className="text-3xl">📱</span>
                            <div>
                                <h3 className="font-black text-sm text-white uppercase">Aplikacja na telefon</h3>
                                <p className="text-[10px] text-slate-400">Instalacja ikony na pulpicie telefonu</p>
                            </div>
                        </div>

                        <div className="space-y-3 text-xs text-slate-300 bg-slate-800/60 p-3.5 rounded-2xl border border-slate-700/60 leading-relaxed">
                            <div>
                                <p className="font-bold text-amber-400 mb-0.5">🍏 iPhone (Safari):</p>
                                <p>1. Kliknij ikonę <b>Udostępnij</b> (kwadrat ze strzałką w górę).</p>
                                <p>2. Wybierz <b>„Do ekranu początkowego”</b>.</p>
                            </div>
                            <div className="border-t border-slate-700/60 pt-2">
                                <p className="font-bold text-amber-400 mb-0.5">🤖 Android (Chrome):</p>
                                <p>1. Kliknij <b>trzy kropki</b> w prawym górnym rogu.</p>
                                <p>2. Wybierz <b>„Dodaj do ekranu głównego”</b> lub <b>„Zainstaluj aplikację”</b>.</p>
                            </div>
                        </div>

                        <button
                            onClick={() => setIsPwaModalOpen(false)}
                            className="w-full mt-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl transition"
                        >
                            Rozumiem
                        </button>
                    </div>
                </div>
            )}

            {/* Powiadomienie Toast na dole ekranu */}
            {toast && (
                <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 z-50 bg-amber-500 text-slate-950 font-black text-xs py-2.5 px-4 rounded-2xl shadow-xl flex items-center justify-between animate-bounce">
                    <span>{toast}</span>
                    <button onClick={() => setToast(null)} className="ml-3 font-bold text-slate-900">
                        ✕
                    </button>
                </div>
            )}
        </div>
    );
}
