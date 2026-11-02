"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
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

// ── AI Identify Result ────────────────────────────────────────────────────────
interface AiIdentifyResult {
    name: string;
    category: string;
    unit: string;
    confidence: number;
    description: string;
    additionalInfo: string;
}

// ── Kompresja zdjęć ───────────────────────────────────────────────────────────
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
                    (blob) => { if (blob) resolve(blob); else resolve(file); },
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

// ── fileToBase64 ──────────────────────────────────────────────────────────────
async function fileToBase64(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ── Pomocnik: kolor paska zapełnienia ─────────────────────────────────────────
function getOccupancyColor(pct: number) {
    if (pct >= 90) return { bar: "bg-red-500", text: "text-red-400", border: "border-red-700/60" };
    if (pct >= 70) return { bar: "bg-amber-500", text: "text-amber-400", border: "border-amber-700/60" };
    return { bar: "bg-emerald-500", text: "text-emerald-400", border: "border-emerald-700/60" };
}

// =============================================================================
export default function PlacResidualsPage() {
    const { user, loading, signOut } = useAuth();
    const router = useRouter();

    // ── Dane ─────────────────────────────────────────────────────────────────
    const [items, setItems] = useState<ResidualItem[]>([]);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<"ALL" | "NO_PHOTO" | "LOW_STOCK">("ALL");
    const [activeTab, setActiveTab] = useState<"resztki" | "strefy">("resztki");
    const [isOnline, setIsOnline] = useState(true);
    const [uploadingId, setUploadingId] = useState<string | null>(null);
    const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
    const [isPwaModalOpen, setIsPwaModalOpen] = useState(false);
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [toast, setToast] = useState<string | null>(null);
    const [isSubmittingNew, setIsSubmittingNew] = useState(false);
    const [pendingPhotos, setPendingPhotos] = useState<PendingPhotoUpload[]>([]);
    const [isSyncingPhotos, setIsSyncingPhotos] = useState(false);

    // ── Kategorie i strefy ────────────────────────────────────────────────────
    const [categoriesList, setCategoriesList] = useState<ResidualCategoryDef[]>(RESIDUAL_MAIN_CATEGORIES);
    const [storageLocations, setStorageLocations] = useState<StorageLocation[]>(DEFAULT_STORAGE_LOCATIONS);
    const [isSavingZones, setIsSavingZones] = useState(false);

    // ── AI: Scan & Identify ───────────────────────────────────────────────────
    const [aiModalItem, setAiModalItem] = useState<ResidualItem | null>(null);
    const [aiResult, setAiResult] = useState<AiIdentifyResult | null>(null);
    const [isAiLoading, setIsAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);

    // ── AI: Auto-kategoryzacja w formularzu ───────────────────────────────────
    const [isAiCategorizingName, setIsAiCategorizingName] = useState(false);
    const autoCategTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ── Formularz nowej resztki ───────────────────────────────────────────────
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

    // ── Toast ─────────────────────────────────────────────────────────────────
    const showToast = (msg: string) => {
        setToast(msg);
        setTimeout(() => setToast(null), 3500);
    };

    // ── Kolejka offline ───────────────────────────────────────────────────────
    const refreshPendingQueue = async () => {
        try {
            const list = await getPendingPhotos();
            setPendingPhotos(list);
            return list;
        } catch { return []; }
    };

    const syncPendingPhotos = async () => {
        if (!navigator.onLine) { showToast("⚠️ Brak połączenia z internetem."); return; }
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
                        allocations: {},
                        createdAt: entry.createdAt || new Date().toISOString()
                    };
                    const docRef = await addDoc(collection(db, "inventory"), docData);
                    setItems(prev => prev.map(i => i.id === entry.itemId
                        ? { ...i, id: docRef.id, imageUrl: downloadURL, isPendingUpload: false, category: docData.category, subcategory: docData.subcategory, currentLocation: docData.currentLocation }
                        : i));
                } else {
                    await updateDoc(doc(db, "inventory", entry.itemId), { imageUrl: downloadURL, updatedAt: new Date().toISOString() });
                    setItems(prev => prev.map(i => i.id === entry.itemId ? { ...i, imageUrl: downloadURL, isPendingUpload: false } : i));
                }
                await deletePendingPhoto(entry.id);
                successCount++;
            } catch (syncErr) { console.warn(`Błąd synchronizacji ${entry.id}:`, syncErr); }
        }
        await refreshPendingQueue();
        setIsSyncingPhotos(false);
        if (successCount > 0) { showToast(`✅ Zsynchronizowano ${successCount} zdjęć!`); fetchFreshData(); }
    };

    // ── Inicjalizacja ─────────────────────────────────────────────────────────
    useEffect(() => {
        setIsOnline(navigator.onLine);
        let manifestLink = document.querySelector<HTMLLinkElement>("link[rel~='manifest']");
        if (manifestLink) { manifestLink.href = "/manifest-plac.json"; }
        else { manifestLink = document.createElement("link"); manifestLink.rel = "manifest"; manifestLink.href = "/manifest-plac.json"; document.head.appendChild(manifestLink); }
        document.title = "PESAM Plac & Resztki";
        refreshPendingQueue();

        const cachedItems = localStorage.getItem("pesam_residuals_cache");
        if (cachedItems) { try { setItems(JSON.parse(cachedItems)); } catch (e) { console.error(e); } }
        const cachedCats = localStorage.getItem("pesam_residual_categories_cache");
        if (cachedCats) { try { setCategoriesList(JSON.parse(cachedCats)); } catch (e) { console.error(e); } }
        const cachedLocs = localStorage.getItem("pesam_storage_locations_cache");
        if (cachedLocs) { try { setStorageLocations(JSON.parse(cachedLocs)); } catch (e) { console.error(e); } }

        const handleOnline = () => { setIsOnline(true); showToast("🟢 Połączono z siecią"); fetchFreshData(); syncPendingPhotos(); };
        const handleOffline = () => { setIsOnline(false); showToast("🟠 Tryb offline"); };
        window.addEventListener("online", handleOnline);
        window.addEventListener("offline", handleOffline);

        if (!loading && !user && localStorage.getItem("pesam_logged_in") !== "true") {
            router.push("/login?redirect=/plac");
        } else if (user) {
            localStorage.setItem("pesam_logged_in", "true");
            fetchFreshData();
        }
        return () => { window.removeEventListener("online", handleOnline); window.removeEventListener("offline", handleOffline); };
    }, [loading, user, router]);

    const fetchFreshData = async () => {
        try {
            const [querySnapshot, catSnap, capacitySnap] = await Promise.all([
                getDocs(query(collection(db, "inventory"), orderBy("name"))),
                getDoc(doc(db, "settings", "residual_categories")),
                getDoc(doc(db, "settings", "warehouse_capacity"))
            ]);
            const filteredItems = querySnapshot.docs
                .map(docSnap => ({ id: docSnap.id, ...docSnap.data() } as ResidualItem))
                .filter(item => item.category === "Pozostałości budowlane" || item.inventoryNumber === "RESZTKI" || item.isResidual);
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
        } catch (error) { console.warn("Błąd pobierania danych:", error); }
    };

    // ── Zdjęcie aparatem (istniejąca pozycja) ────────────────────────────────
    const handleCameraCapture = async (item: ResidualItem, file: File) => {
        try {
            setUploadingId(item.id);
            showToast("⏳ Zapisywanie zdjęcia z placu...");
            const compressedBlob = await compressImage(file, 1200, 0.8);
            const previewUrl = await blobToDataUrl(compressedBlob);
            if (!navigator.onLine) {
                await savePendingPhoto({ id: `PHOTO_${item.id}_${Date.now()}`, itemId: item.id, itemName: item.name, photoBlob: compressedBlob, previewDataUrl: previewUrl, createdAt: new Date().toISOString(), status: "PENDING" });
                const updatedItems = items.map(i => i.id === item.id ? { ...i, imageUrl: previewUrl, isPendingUpload: true } : i);
                setItems(updatedItems);
                localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));
                await refreshPendingQueue();
                showToast("💾 Zdjęcie zapisane offline!");
                return;
            }
            const uploadPromise = async () => {
                const storageRef = ref(storage, `inventory/residuals_${item.id}_${Date.now()}.jpg`);
                await uploadBytes(storageRef, compressedBlob);
                return await getDownloadURL(storageRef);
            };
            const downloadURL = await Promise.race([
                uploadPromise(),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 7000))
            ]);
            await updateDoc(doc(db, "inventory", item.id), { imageUrl: downloadURL, updatedAt: new Date().toISOString() });
            const updatedItems = items.map(i => i.id === item.id ? { ...i, imageUrl: downloadURL, isPendingUpload: false } : i);
            setItems(updatedItems);
            localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));
            showToast("✅ Zdjęcie zaktualizowane!");
        } catch (error: any) {
            try {
                const compressedBlob = await compressImage(file, 1200, 0.8);
                const previewUrl = await blobToDataUrl(compressedBlob);
                await savePendingPhoto({ id: `PHOTO_${item.id}_${Date.now()}`, itemId: item.id, itemName: item.name, photoBlob: compressedBlob, previewDataUrl: previewUrl, createdAt: new Date().toISOString(), status: "PENDING" });
                const updatedItems = items.map(i => i.id === item.id ? { ...i, imageUrl: previewUrl, isPendingUpload: true } : i);
                setItems(updatedItems);
                localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));
                await refreshPendingQueue();
                showToast("💾 Słaby zasięg – zapisano offline!");
            } catch (saveErr) { alert("Błąd zapisu zdjęcia: " + saveErr); }
        } finally { setUploadingId(null); }
    };

    // ── +/- ilość ────────────────────────────────────────────────────────────
    const handleQuickDelta = async (item: ResidualItem, delta: number) => {
        try {
            const newAvail = Math.max(0, (Number(item.availableQuantity) || 0) + delta);
            const newTotal = Math.max(0, (Number(item.totalQuantity) || 0) + delta);
            await updateDoc(doc(db, "inventory", item.id), { availableQuantity: newAvail, totalQuantity: newTotal, updatedAt: new Date().toISOString() });
            const updatedItems = items.map(i => i.id === item.id ? { ...i, availableQuantity: newAvail, totalQuantity: newTotal } : i);
            setItems(updatedItems);
            localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));
            showToast(`Zaktualizowano: ${newAvail} ${item.unit || "szt."}`);
        } catch (error: any) { alert("Błąd aktualizacji: " + (error?.message || error)); }
    };

    const handleExactQty = async (item: ResidualItem) => {
        const promptVal = prompt(`Podaj aktualny stan:\n${item.name}\n(Obecnie: ${item.availableQuantity} ${item.unit || "szt."})`, String(item.availableQuantity ?? 0));
        if (promptVal !== null) {
            const parsed = parseFloat(promptVal.replace(",", "."));
            if (!isNaN(parsed) && parsed >= 0) {
                try {
                    await updateDoc(doc(db, "inventory", item.id), { availableQuantity: parsed, totalQuantity: parsed, updatedAt: new Date().toISOString() });
                    const updatedItems = items.map(i => i.id === item.id ? { ...i, availableQuantity: parsed, totalQuantity: parsed } : i);
                    setItems(updatedItems);
                    localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));
                    showToast(`✅ Zapisano: ${parsed} ${item.unit || "szt."}`);
                } catch (error: any) { alert("Błąd: " + error.message); }
            }
        }
    };

    // ═════════════════════════════════════════════════════════════════════════
    // 🤖 AI SCAN & IDENTIFY — rozpoznaj materiał ze zdjęcia
    // ═════════════════════════════════════════════════════════════════════════
    const handleAiIdentify = async (imageFile: File | Blob, hint?: string) => {
        setIsAiLoading(true);
        setAiResult(null);
        setAiError(null);
        try {
            const base64 = await fileToBase64(imageFile);
            const res = await fetch("/api/ai-identify-material", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ imageBase64: base64, hint })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setAiResult(data as AiIdentifyResult);
        } catch (err: any) {
            setAiError(err?.message || "Błąd rozpoznawania");
        } finally {
            setIsAiLoading(false);
        }
    };

    // Otwórz modal AI dla istniejącej pozycji (ma zdjęcie → od razu identyfikuj)
    const openAiModal = async (item: ResidualItem) => {
        setAiModalItem(item);
        setAiResult(null);
        setAiError(null);
        // Jeśli ma zdjęcie, pobierz je i wyślij do AI
        if (item.imageUrl) {
            setIsAiLoading(true);
            try {
                const res = await fetch(item.imageUrl);
                const blob = await res.blob();
                await handleAiIdentify(blob, item.name);
            } catch {
                setIsAiLoading(false);
                setAiError("Nie udało się pobrać zdjęcia. Zrób nowe zdjęcie poniżej.");
            }
        }
    };

    // ═════════════════════════════════════════════════════════════════════════
    // 🏷️ AUTO-KATEGORYZACJA — AI sugeruje kategorię po wpisaniu nazwy
    // ═════════════════════════════════════════════════════════════════════════
    const handleAutoCategorizeName = useCallback(async (name: string) => {
        if (name.trim().length < 4) return;
        if (autoCategTimeout.current) clearTimeout(autoCategTimeout.current);
        autoCategTimeout.current = setTimeout(async () => {
            setIsAiCategorizingName(true);
            try {
                const res = await fetch("/api/ai-identify-material", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        imageBase64: "",
                        hint: `Tylko na podstawie nazwy: "${name}". Nie masz zdjęcia. Zaproponuj kategorię i jednostkę miary.`
                    })
                });
                if (!res.ok) return;
                const data = await res.json();
                if (data.category) {
                    setNewItem(prev => ({
                        ...prev,
                        category: prev.category || data.category,
                        unit: prev.unit !== "szt." ? prev.unit : (data.unit || prev.unit)
                    }));
                    showToast(`🤖 AI sugeruje: ${data.category}`);
                }
            } catch { /* cicho ignoruj */ }
            finally { setIsAiCategorizingName(false); }
        }, 1200);
    }, []);

    // ── AI identyfikacja ze zdjęcia w formularzu Dodaj nową resztkę ──────────
    const handleAiIdentifyForForm = useCallback(async (file: File) => {
        try {
            const base64 = await fileToBase64(file);
            const response = await fetch("/api/ai-identify-material", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ imageBase64: base64 })
            });
            if (!response.ok) return;
            const data: AiIdentifyResult = await response.json();
            if (data.name || data.category) {
                setNewItem(prev => ({
                    ...prev,
                    name: prev.name.trim() ? prev.name : (data.name || prev.name),
                    category: prev.category || data.category || "",
                    unit: prev.unit !== "szt." ? prev.unit : (data.unit || prev.unit),
                    notes: prev.notes || data.additionalInfo || ""
                }));
                showToast(`🤖 AI rozpoznało: ${data.name} (${Math.round(data.confidence * 100)}% pewności)`);
            }
        } catch { /* cicho ignoruj */ }
    }, []);

    // ═════════════════════════════════════════════════════════════════════════
    // 🎚️ STREFY MAGAZYNOWE — zapis suwaków do Firebase
    // ═════════════════════════════════════════════════════════════════════════
    const handleZoneSliderChange = (zoneId: string, newOccupied: number) => {
        setStorageLocations(prev =>
            prev.map(loc => loc.id === zoneId ? { ...loc, currentOccupied: newOccupied } : loc)
        );
    };

    const saveZonesToFirebase = async () => {
        setIsSavingZones(true);
        try {
            await setDoc(doc(db, "settings", "warehouse_capacity"), {
                locations: storageLocations,
                updatedAt: new Date().toISOString()
            });
            localStorage.setItem("pesam_storage_locations_cache", JSON.stringify(storageLocations));
            showToast("✅ Zapełnienie stref zapisane!");
            // Alert jeśli jakaś strefa > 80%
            const overloaded = storageLocations.filter(l =>
                l.totalCapacity && l.currentOccupied !== undefined &&
                (l.currentOccupied / l.totalCapacity) >= 0.8
            );
            if (overloaded.length > 0) {
                showToast(`⚠️ Uwaga: ${overloaded.map(l => l.name).join(", ")} przekracza 80% pojemności!`);
            }
        } catch (err: any) {
            showToast("❌ Błąd zapisu: " + err.message);
        } finally {
            setIsSavingZones(false);
        }
    };

    // ── Dodanie nowej pozycji ─────────────────────────────────────────────────
    const handleCreateNew = async () => {
        if (!newItem.name.trim()) { alert("Podaj nazwę resztki!"); return; }
        try {
            setIsSubmittingNew(true);
            let finalImageUrl = "";
            let photoBlobToSave: Blob | null = null;
            let previewUrl = "";
            if (newItem.photoFile) {
                showToast("⏳ Zapisywanie zdjęcia...");
                photoBlobToSave = await compressImage(newItem.photoFile, 1200, 0.8);
                previewUrl = await blobToDataUrl(photoBlobToSave);
            }
            if (!navigator.onLine) {
                const tempId = `OFFLINE_${Date.now()}`;
                if (photoBlobToSave) {
                    await savePendingPhoto({ id: `PHOTO_NEW_${Date.now()}`, itemId: tempId, itemName: newItem.name.trim(), photoBlob: photoBlobToSave, previewDataUrl: previewUrl, isNewItem: true, newItemData: { name: newItem.name.trim(), qty: Number(newItem.qty) || 1, unit: newItem.unit || "szt.", location: newItem.location || "Plac Zewnętrzny", category: newItem.category || "Pozostałości budowlane", subcategory: newItem.subcategory || "", notes: newItem.notes || "" }, createdAt: new Date().toISOString(), status: "PENDING" });
                    await refreshPendingQueue();
                }
                const createdItem: ResidualItem = { id: tempId, name: newItem.name.trim(), availableQuantity: Number(newItem.qty) || 1, totalQuantity: Number(newItem.qty) || 1, unit: newItem.unit || "szt.", currentLocation: newItem.location || "Plac Zewnętrzny", category: newItem.category || "Pozostałości budowlane", subcategory: newItem.subcategory || "", additionalInfo: newItem.notes || "", imageUrl: previewUrl || "", inventoryNumber: "RESZTKI", isResidual: true, isPendingUpload: !!photoBlobToSave, createdAt: new Date().toISOString() };
                const updatedItems = [createdItem, ...items].sort((a, b) => a.name.localeCompare(b.name));
                setItems(updatedItems);
                localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));
                showToast("💾 Nowa resztka zapisana offline!");
                resetAddForm();
                return;
            }
            if (photoBlobToSave) {
                const uploadPromise = async () => {
                    const storageRef = ref(storage, `inventory/residuals_new_${Date.now()}.jpg`);
                    await uploadBytes(storageRef, photoBlobToSave!);
                    return await getDownloadURL(storageRef);
                };
                finalImageUrl = await Promise.race([uploadPromise(), new Promise<string>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 7000))]);
            }
            const docData = { name: newItem.name.trim(), availableQuantity: Number(newItem.qty) || 1, totalQuantity: Number(newItem.qty) || 1, unit: newItem.unit || "szt.", currentLocation: newItem.location || "Plac Zewnętrzny", category: newItem.category || "Pozostałości budowlane", subcategory: newItem.subcategory || "", additionalInfo: newItem.notes || "", imageUrl: finalImageUrl, inventoryNumber: "RESZTKI", isResidual: true, type: "BULK", subType: "MANUAL", status: "DOSTĘPNY", allocations: {}, createdAt: new Date().toISOString() };
            const docRef = await addDoc(collection(db, "inventory"), docData);
            const createdItem: ResidualItem = { id: docRef.id, ...docData };
            const updatedItems = [createdItem, ...items].sort((a, b) => a.name.localeCompare(b.name));
            setItems(updatedItems);
            localStorage.setItem("pesam_residuals_cache", JSON.stringify(updatedItems));
            showToast("🎉 Nowa resztka dodana!");
            resetAddForm();
        } catch (error: any) {
            console.warn("Błąd handleCreateNew:", error);
            showToast("❌ Błąd zapisu: " + (error?.message || error));
        } finally { setIsSubmittingNew(false); }
    };

    const resetAddForm = () => {
        setIsAddModalOpen(false);
        setNewItem({ name: "", qty: 1, unit: "szt.", location: storageLocations[0]?.name || "Plac Zewnętrzny", category: "", subcategory: "", notes: "", photoFile: null, photoPreview: null });
    };

    // ── Filtry ────────────────────────────────────────────────────────────────
    const filteredItems = useMemo(() => {
        const q = search.toLowerCase().trim();
        return items.filter(item => {
            const matchesSearch = !q || (item.name && item.name.toLowerCase().includes(q)) || (item.currentLocation && item.currentLocation.toLowerCase().includes(q)) || (item.additionalInfo && item.additionalInfo.toLowerCase().includes(q));
            if (!matchesSearch) return false;
            if (filter === "NO_PHOTO") return !item.imageUrl;
            if (filter === "LOW_STOCK") return (item.availableQuantity || 0) <= 1;
            return true;
        });
    }, [items, search, filter]);

    const countNoPhoto = useMemo(() => items.filter(i => !i.imageUrl).length, [items]);
    const countLowStock = useMemo(() => items.filter(i => (i.availableQuantity || 0) <= 1).length, [items]);

    // ═════════════════════════════════════════════════════════════════════════
    // RENDER
    // ═════════════════════════════════════════════════════════════════════════
    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans pb-20 select-none">

            {/* ── STICKY HEADER ──────────────────────────────────────────────── */}
            <header className="sticky top-0 z-30 bg-slate-900/95 backdrop-blur border-b border-slate-800 shadow-xl px-4 py-3">
                <div className="flex justify-between items-center mb-3">
                    <div className="flex items-center gap-2">
                        <Link href="/plac" title="Wróć" className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center border border-slate-700 text-sm active:scale-95 transition">🔙</Link>
                        <span className="text-2xl">🏗️</span>
                        <div>
                            <h1 className="text-lg font-black tracking-wider text-amber-400 uppercase leading-none">PESAM PLAC</h1>
                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Magazyn Resztek & Pozostałości</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-black px-2 py-1 rounded-full uppercase tracking-wider border ${isOnline ? "bg-emerald-950/80 text-emerald-400 border-emerald-700/60" : "bg-amber-950/80 text-amber-400 border-amber-700/60"}`}>
                            {isOnline ? "🟢 Online" : "🟠 Pamięć"}
                        </span>
                        <button onClick={fetchFreshData} title="Odśwież" className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center border border-slate-700 text-sm active:scale-95 transition">🔄</button>
                        <button onClick={() => setIsPwaModalOpen(true)} title="Zainstaluj" className="h-9 px-2.5 rounded-xl bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 flex items-center gap-1 border border-blue-500/30 text-xs font-bold active:scale-95 transition">📱 <span className="hidden sm:inline">Na telefon</span></button>
                        <Link href="/dashboard/inventory" className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center border border-slate-700 text-sm active:scale-95 transition">🖥️</Link>
                    </div>
                </div>

                {/* Dodaj + Zakładki nawigacyjne */}
                <button
                    onClick={() => setIsAddModalOpen(true)}
                    className="w-full py-3.5 px-4 bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600 hover:from-amber-400 hover:to-orange-500 text-slate-950 font-black text-sm uppercase tracking-wider rounded-2xl shadow-lg shadow-orange-600/30 flex items-center justify-center gap-2 active:scale-[0.98] transition border border-amber-300/40"
                >
                    <span className="text-xl">➕</span>
                    <span>Dodaj nową pozycję z placu</span>
                </button>

                {/* Tabs: Resztki / Strefy */}
                <div className="mt-3 flex gap-1.5">
                    <button
                        onClick={() => setActiveTab("resztki")}
                        className={`flex-1 py-2 rounded-xl font-black text-xs uppercase tracking-wider transition ${activeTab === "resztki" ? "bg-amber-500 text-slate-950 shadow" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
                    >
                        🧱 Resztki ({items.length})
                    </button>
                    <button
                        onClick={() => setActiveTab("strefy")}
                        className={`flex-1 py-2 rounded-xl font-black text-xs uppercase tracking-wider transition ${activeTab === "strefy" ? "bg-amber-500 text-slate-950 shadow" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
                    >
                        🏭 Strefy ({storageLocations.length})
                    </button>
                </div>

                {/* Wyszukiwarka + Filtry — tylko w zakładce Resztki */}
                {activeTab === "resztki" && (
                    <>
                        <div className="mt-3 flex gap-2">
                            <div className="relative flex-1">
                                <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Szukaj resztki (np. Klej, Folia, 25x4)..." className="w-full bg-slate-800/90 border border-slate-700/80 rounded-xl px-3 py-2 pl-9 text-xs text-white placeholder-slate-400 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition" />
                                <span className="absolute left-3 top-2.5 text-xs text-slate-400">🔍</span>
                                {search && (<button onClick={() => setSearch("")} className="absolute right-2.5 top-2 text-xs text-slate-400 hover:text-white p-0.5">✕</button>)}
                            </div>
                        </div>
                        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1 text-[11px] no-scrollbar">
                            {(["ALL", "NO_PHOTO", "LOW_STOCK"] as const).map(f => (
                                <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1.5 rounded-xl font-bold whitespace-nowrap transition ${filter === f ? "bg-amber-500 text-slate-950 font-black shadow" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
                                    {f === "ALL" && `Wszystko (${items.length})`}
                                    {f === "NO_PHOTO" && `📷 Bez fotki (${countNoPhoto})`}
                                    {f === "LOW_STOCK" && `⚠️ Kończące się (${countLowStock})`}
                                </button>
                            ))}
                        </div>
                    </>
                )}

                {/* Baner offline */}
                {pendingPhotos.length > 0 && (
                    <div className="mt-3 bg-gradient-to-r from-amber-500/20 via-orange-500/20 to-amber-500/20 border border-amber-500/50 rounded-2xl p-3 flex items-center justify-between gap-2 shadow-lg animate-fade-in">
                        <div className="flex items-center gap-2.5 min-w-0">
                            <span className="text-2xl">📸</span>
                            <div className="min-w-0">
                                <p className="text-xs font-black text-amber-300 truncate">Zdjęcia w pamięci: {pendingPhotos.length}</p>
                                <p className="text-[10px] text-slate-300 truncate">{isOnline ? "Kliknij, aby zsynchronizować" : "Offline – wyślesz po powrocie zasięgu."}</p>
                            </div>
                        </div>
                        <button onClick={syncPendingPhotos} disabled={isSyncingPhotos || !isOnline} className="shrink-0 px-3 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs uppercase tracking-wider active:scale-95 transition disabled:opacity-50 flex items-center gap-1.5 shadow">
                            {isSyncingPhotos ? <><span className="inline-block animate-spin text-sm">🔄</span><span>Wysyłanie...</span></> : <span>🚀 Wyślij</span>}
                        </button>
                    </div>
                )}
            </header>

            {/* ── MAIN CONTENT ──────────────────────────────────────────────── */}
            <main className="flex-1 p-3 max-w-4xl mx-auto w-full">

                {/* ══ ZAKŁADKA: RESZTKI ══════════════════════════════════════ */}
                {activeTab === "resztki" && (
                    filteredItems.length === 0 ? (
                        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 text-center mt-6">
                            <span className="text-4xl block mb-2">🧱</span>
                            <h3 className="text-base font-black text-slate-200">Brak pozycji</h3>
                            <p className="text-xs text-slate-400 mt-1">Zmień wyszukiwaną frazę lub dodaj nową resztkę.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {filteredItems.map(item => {
                                const isThisUploading = uploadingId === item.id;
                                const hasPhoto = !!item.imageUrl;
                                const isPending = item.isPendingUpload || pendingPhotos.some(p => p.itemId === item.id);
                                return (
                                    <div key={item.id} className="bg-slate-900 border border-slate-800/90 rounded-2xl p-3.5 shadow-md flex flex-col justify-between relative overflow-hidden transition hover:border-slate-700">
                                        {isThisUploading && (
                                            <div className="absolute inset-0 bg-slate-950/85 z-20 flex flex-col items-center justify-center gap-2 backdrop-blur-sm animate-fade-in">
                                                <div className="w-8 h-8 border-4 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
                                                <span className="text-xs font-black text-amber-400 uppercase tracking-wider">Wgrywanie zdjęcia...</span>
                                            </div>
                                        )}

                                        <div className="flex gap-3 items-start">
                                            {/* Zdjęcie / aparat */}
                                            <div className="relative flex-shrink-0">
                                                {hasPhoto ? (
                                                    <div onClick={() => setLightboxUrl(item.imageUrl!)} className="w-18 h-18 sm:w-20 sm:h-20 rounded-xl overflow-hidden border border-slate-700 bg-slate-800 cursor-pointer shadow relative group">
                                                        <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover group-hover:scale-105 transition" />
                                                        {isPending && <span className="absolute top-1 left-1 bg-amber-500 text-slate-950 text-[8px] font-black px-1 py-0.5 rounded shadow">⏳ Offline</span>}
                                                        <span className="absolute bottom-0 right-0 bg-black/60 text-white text-[9px] px-1 rounded-tl font-bold">🔍</span>
                                                    </div>
                                                ) : (
                                                    <label htmlFor={`camera-${item.id}`} className="w-18 h-18 sm:w-20 sm:h-20 rounded-xl border-2 border-dashed border-amber-500/50 hover:border-amber-400 bg-amber-500/10 flex flex-col items-center justify-center cursor-pointer active:scale-95 transition">
                                                        <span className="text-2xl">📸</span>
                                                        <span className="text-[9px] font-black text-amber-300 uppercase tracking-tighter mt-0.5">Zrób foto</span>
                                                    </label>
                                                )}
                                                <input id={`camera-${item.id}`} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { if (e.target.files?.[0]) handleCameraCapture(item, e.target.files[0]); }} />
                                            </div>

                                            {/* Info */}
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                    <span className="bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider">🧱 Resztki</span>
                                                    <span className="text-[10px] text-slate-400 truncate">📍 {item.currentLocation || "Plac"}</span>
                                                </div>
                                                <h3 className="font-black text-sm text-slate-100 mt-1 leading-snug line-clamp-2">{item.name}</h3>
                                                {item.additionalInfo && <p className="text-[10px] text-slate-400 mt-0.5 italic line-clamp-1">{item.additionalInfo}</p>}

                                                {/* Przyciski pod nazwą */}
                                                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                                    {hasPhoto && (
                                                        <label htmlFor={`camera-${item.id}`} className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-400 hover:text-amber-300 cursor-pointer active:scale-95 transition">
                                                            <span>📸 Zmień zdjęcie</span>
                                                        </label>
                                                    )}
                                                    {/* 🤖 ZAPYTAJ AI — przycisk przy każdej pozycji */}
                                                    <button
                                                        onClick={() => openAiModal(item)}
                                                        className="inline-flex items-center gap-1 text-[10px] font-black text-purple-400 hover:text-purple-300 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 px-2 py-0.5 rounded-lg active:scale-95 transition"
                                                    >
                                                        🤖 Zapytaj AI
                                                    </button>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Dolny wiersz: stan + przyciski */}
                                        <div className="mt-3 pt-2.5 border-t border-slate-800 flex items-center justify-between gap-2">
                                            <div onClick={() => handleExactQty(item)} className="cursor-pointer group flex flex-col" title="Kliknij, aby wpisać stan">
                                                <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Stan na placu:</span>
                                                <div className="flex items-baseline gap-1">
                                                    <span className="text-base font-black text-amber-400 group-hover:underline">{item.availableQuantity}</span>
                                                    <span className="text-xs font-bold text-slate-300">{item.unit || "szt."}</span>
                                                    <span className="text-[10px] text-slate-500">✏️</span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1.5">
                                                <button onClick={() => handleQuickDelta(item, -1)} className="w-11 h-11 rounded-xl bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-red-400 border border-slate-700 font-black text-lg flex items-center justify-center active:scale-90 transition shadow-sm" title="Odejmij 1">−</button>
                                                <button onClick={() => handleExactQty(item)} className="h-11 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-amber-300 border border-slate-700 font-bold text-xs flex items-center justify-center active:scale-90 transition shadow-sm" title="Wpisz stan">Wpisz</button>
                                                <button onClick={() => handleQuickDelta(item, 1)} className="w-11 h-11 rounded-xl bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-emerald-400 border border-slate-700 font-black text-lg flex items-center justify-center active:scale-90 transition shadow-sm" title="Dodaj 1">+</button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )
                )}

                {/* ══ ZAKŁADKA: STREFY ═══════════════════════════════════════ */}
                {activeTab === "strefy" && (
                    <div className="space-y-4 mt-2">
                        <div className="flex items-center justify-between">
                            <div>
                                <h2 className="text-base font-black text-white">🏭 Zapełnienie Stref</h2>
                                <p className="text-[10px] text-slate-400">Przesuń suwak, aby zaktualizować poziom zapełnienia strefy</p>
                            </div>
                            <button
                                onClick={saveZonesToFirebase}
                                disabled={isSavingZones}
                                className="px-4 py-2.5 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl shadow-lg disabled:opacity-50 flex items-center gap-1.5 active:scale-95 transition"
                            >
                                {isSavingZones ? <><span className="animate-spin inline-block">🔄</span> Zapis...</> : "💾 Zapisz"}
                            </button>
                        </div>

                        {storageLocations.map(loc => {
                            const cap = loc.totalCapacity || 1;
                            const occ = loc.currentOccupied ?? 0;
                            const pct = Math.round((occ / cap) * 100);
                            const colors = getOccupancyColor(pct);
                            return (
                                <div key={loc.id} className={`bg-slate-900 border rounded-2xl p-4 shadow-md ${colors.border}`}>
                                    {/* Nagłówek strefy */}
                                    <div className="flex items-center justify-between mb-3">
                                        <div>
                                            <h3 className="font-black text-sm text-white">{loc.name}</h3>
                                            {loc.description && <p className="text-[10px] text-slate-400">{loc.description}</p>}
                                        </div>
                                        <div className={`text-right ${colors.text}`}>
                                            <span className="text-2xl font-black">{pct}%</span>
                                            <p className="text-[10px] font-bold">{occ} / {cap} jedn.</p>
                                        </div>
                                    </div>

                                    {/* Pasek postępu */}
                                    <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden mb-3">
                                        <div
                                            className={`h-full rounded-full transition-all duration-300 ${colors.bar}`}
                                            style={{ width: `${Math.min(100, pct)}%` }}
                                        />
                                    </div>

                                    {/* Suwak */}
                                    <div className="flex items-center gap-3">
                                        <span className="text-[10px] text-slate-500 w-4 text-right">0</span>
                                        <input
                                            type="range"
                                            min={0}
                                            max={cap}
                                            step={1}
                                            value={occ}
                                            onChange={e => handleZoneSliderChange(loc.id, Number(e.target.value))}
                                            className="flex-1 h-2 accent-amber-500 cursor-pointer"
                                        />
                                        <span className="text-[10px] text-slate-500 w-8">{cap}</span>
                                    </div>

                                    {/* Szybkie przyciski 25/50/75/100% */}
                                    <div className="flex gap-1.5 mt-3 flex-wrap">
                                        {[0, 25, 50, 75, 100].map(p => (
                                            <button
                                                key={p}
                                                onClick={() => handleZoneSliderChange(loc.id, Math.round((p / 100) * cap))}
                                                className={`px-2.5 py-1 rounded-lg text-[10px] font-black transition active:scale-90 border ${pct === p ? "bg-amber-500 text-slate-950 border-amber-400" : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"}`}
                                            >
                                                {p}%
                                            </button>
                                        ))}
                                    </div>

                                    {/* Alert > 80% */}
                                    {pct >= 80 && (
                                        <div className="mt-3 bg-red-950/60 border border-red-700/50 rounded-xl px-3 py-2 text-[10px] text-red-300 font-bold flex items-center gap-2">
                                            <span>⚠️</span>
                                            <span>Strefa {pct >= 100 ? "PEŁNA" : "prawie pełna"}! Rozważ przeniesienie materiałów.</span>
                                        </div>
                                    )}

                                    {/* Kategorie strefy */}
                                    {loc.categories && loc.categories.length > 0 && (
                                        <div className="mt-2 flex flex-wrap gap-1">
                                            {loc.categories.map(cat => (
                                                <span key={cat} className="bg-slate-800 text-slate-400 border border-slate-700 text-[9px] px-1.5 py-0.5 rounded font-bold">
                                                    {cat}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}

                        <p className="text-[10px] text-slate-500 text-center pb-2">
                            Zmiany zapisują się do Firebase po kliknięciu „Zapisz" 💾
                        </p>
                    </div>
                )}
            </main>

            {/* ══ MODAL: Dodaj nową resztkę ════════════════════════════════════ */}
            {isAddModalOpen && (
                <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade-in">
                    <div className="bg-slate-900 border border-slate-800 w-full max-w-lg rounded-t-3xl sm:rounded-3xl p-5 shadow-2xl max-h-[92vh] overflow-y-auto">
                        <div className="flex justify-between items-center pb-3 border-b border-slate-800">
                            <div className="flex items-center gap-2">
                                <span className="text-2xl">🧱</span>
                                <h2 className="text-base font-black text-white uppercase tracking-wider">Nowa resztka z placu</h2>
                            </div>
                            <button onClick={resetAddForm} className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center font-bold">✕</button>
                        </div>

                        <form onSubmit={e => { e.preventDefault(); handleCreateNew(); }} className="mt-4 space-y-3.5">

                            {/* Nazwa + auto-kategoryzacja */}
                            <div>
                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                    Nazwa resztki / materiału *
                                    {isAiCategorizingName && <span className="ml-2 text-purple-400 animate-pulse">🤖 AI analizuje...</span>}
                                </label>
                                <input
                                    type="text"
                                    required
                                    value={newItem.name}
                                    onChange={e => {
                                        const val = e.target.value;
                                        setNewItem({ ...newItem, name: val, category: newItem.category }); // nie resetuj kategorii
                                        handleAutoCategorizeName(val);
                                    }}
                                    placeholder="np. Klej Sopro S (25kg), Bednarka 25x4..."
                                    className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-white placeholder-slate-500 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
                                />
                                <p className="text-[10px] text-slate-500 mt-0.5">🤖 AI automatycznie zaproponuje kategorię po wpisaniu nazwy</p>
                            </div>

                            {/* Ilość i Jednostka */}
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Ilość *</label>
                                    <input type="number" step="any" required min="0" value={newItem.qty} onChange={e => setNewItem({ ...newItem, qty: parseFloat(e.target.value) || 0 })} className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm font-black text-amber-400 outline-none focus:border-amber-500" />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Jednostka</label>
                                    <select value={newItem.unit} onChange={e => setNewItem({ ...newItem, unit: e.target.value })} className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-white font-bold outline-none focus:border-amber-500">
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

                            {/* Zdjęcie + przycisk Zapytaj AI z formularza */}
                            <div>
                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Zdjęcie z placu</label>
                                <div className="flex items-center gap-3">
                                    <label htmlFor="new-item-camera" className="flex-1 py-3 px-4 rounded-xl border-2 border-dashed border-amber-500/50 hover:border-amber-400 bg-amber-500/10 text-amber-300 font-bold text-xs flex items-center justify-center gap-2 cursor-pointer active:scale-98 transition">
                                        <span className="text-xl">📸</span>
                                        <span>{newItem.photoFile ? "Zmień zdjęcie" : "Zrób zdjęcie aparatem"}</span>
                                    </label>
                                    <input id="new-item-camera" type="file" accept="image/*" capture="environment" className="hidden"
                                        onChange={e => {
                                            if (e.target.files?.[0]) {
                                                const file = e.target.files[0];
                                                setNewItem({ ...newItem, photoFile: file, photoPreview: URL.createObjectURL(file) });
                                                // Auto-identyfikacja ze zdjęcia w formularzu
                                                handleAiIdentifyForForm(file);
                                            }
                                        }}
                                    />
                                    {newItem.photoPreview && (
                                        <div className="w-14 h-14 rounded-xl overflow-hidden border border-slate-700 bg-slate-800 flex-shrink-0 relative">
                                            <img src={newItem.photoPreview} alt="Podgląd" className="w-full h-full object-cover" />
                                        </div>
                                    )}
                                </div>
                                {newItem.photoFile && (
                                    <p className="text-[10px] text-purple-400 mt-1 flex items-center gap-1">
                                        🤖 AI rozpoznaje materiał ze zdjęcia...
                                    </p>
                                )}
                            </div>

                            {/* Kategoria + Podkategoria */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                        Kategoria Główna
                                        {newItem.category && <span className="ml-1 text-purple-400 text-[9px]">✨ AI</span>}
                                    </label>
                                    <select value={newItem.category} onChange={e => setNewItem({ ...newItem, category: e.target.value, subcategory: "" })} className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-white font-semibold outline-none focus:border-amber-500">
                                        <option value="">-- Wybierz kategorię --</option>
                                        {categoriesList.map(cat => <option key={cat.id || cat.name} value={cat.name}>{cat.icon || "📦"} {cat.name}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Podkategoria</label>
                                    {(() => {
                                        const selectedCatDef = categoriesList.find(c => c.name === newItem.category || c.id === newItem.category);
                                        const subList = selectedCatDef?.subcategories || [];
                                        return (
                                            <select value={newItem.subcategory} disabled={!newItem.category || subList.length === 0} onChange={e => setNewItem({ ...newItem, subcategory: e.target.value })} className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-white font-semibold outline-none focus:border-amber-500 disabled:opacity-40 disabled:bg-slate-900">
                                                <option value="">{!newItem.category ? "-- Najpierw kategoria --" : subList.length === 0 ? "-- Brak podkategorii --" : "-- Wybierz podkategorię --"}</option>
                                                {subList.map(sub => <option key={sub} value={sub}>{sub}</option>)}
                                            </select>
                                        );
                                    })()}
                                </div>
                            </div>

                            {/* Strefa */}
                            <div>
                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Strefa składowania</label>
                                <select value={newItem.location} onChange={e => setNewItem({ ...newItem, location: e.target.value })} className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-sm text-white font-bold outline-none focus:border-amber-500">
                                    {storageLocations.map(loc => <option key={loc.id} value={loc.name}>📍 {loc.name} {loc.description ? `(${loc.description})` : ""}</option>)}
                                    {newItem.location && !storageLocations.some(l => l.name === newItem.location) && <option value={newItem.location}>📍 {newItem.location}</option>}
                                    <option value="Plac Główny">📍 Inne: Plac Główny</option>
                                </select>
                            </div>

                            {/* Uwagi */}
                            <div>
                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Uwagi</label>
                                <textarea value={newItem.notes} onChange={e => setNewItem({ ...newItem, notes: e.target.value })} placeholder="np. Zwrot z budowy Grunwaldzka, otwarty worek..." rows={2} className="w-full bg-slate-800 border border-slate-700 rounded-xl p-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-amber-500" />
                            </div>

                            {/* Przyciski */}
                            <div className="pt-3 flex gap-2">
                                <button type="button" onClick={resetAddForm} className="py-3 px-4 rounded-xl border border-slate-700 text-slate-300 font-bold text-xs">Anuluj</button>
                                <button type="submit" disabled={isSubmittingNew} className="flex-1 py-3 px-4 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl shadow-lg disabled:opacity-50 flex items-center justify-center gap-2">
                                    {isSubmittingNew ? "ZAPISYWANIE..." : "✅ Zapisz na placu"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* ══ MODAL: AI Scan & Identify ════════════════════════════════════ */}
            {aiModalItem && (
                <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade-in">
                    <div className="bg-slate-900 border border-purple-700/50 w-full max-w-lg rounded-t-3xl sm:rounded-3xl p-5 shadow-2xl max-h-[90vh] overflow-y-auto">
                        <div className="flex justify-between items-center pb-3 border-b border-slate-800">
                            <div className="flex items-center gap-2">
                                <span className="text-2xl">🤖</span>
                                <div>
                                    <h2 className="text-base font-black text-white uppercase tracking-wider">Zapytaj AI</h2>
                                    <p className="text-[10px] text-slate-400 truncate max-w-[200px]">{aiModalItem.name}</p>
                                </div>
                            </div>
                            <button onClick={() => { setAiModalItem(null); setAiResult(null); setAiError(null); }} className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center font-bold">✕</button>
                        </div>

                        <div className="mt-4 space-y-4">
                            {/* Stan ładowania AI */}
                            {isAiLoading && (
                                <div className="flex flex-col items-center justify-center py-8 gap-3">
                                    <div className="w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                                    <p className="text-sm font-black text-purple-400 animate-pulse uppercase tracking-wider">Gemini AI analizuje zdjęcie...</p>
                                    <p className="text-[10px] text-slate-500">Rozpoznawanie materiału budowlanego</p>
                                </div>
                            )}

                            {/* Błąd */}
                            {aiError && !isAiLoading && (
                                <div className="bg-red-950/60 border border-red-700/50 rounded-2xl p-4 text-center">
                                    <span className="text-3xl block mb-2">❌</span>
                                    <p className="text-xs font-bold text-red-300">{aiError}</p>
                                </div>
                            )}

                            {/* Wynik identyfikacji */}
                            {aiResult && !isAiLoading && (
                                <div className="bg-purple-950/30 border border-purple-700/40 rounded-2xl p-4 space-y-3">
                                    <div className="flex items-center gap-2">
                                        <span className="text-2xl">✨</span>
                                        <div>
                                            <p className="text-[10px] font-bold text-purple-400 uppercase tracking-wider">AI Rozpoznał:</p>
                                            <p className="font-black text-white text-sm leading-tight">{aiResult.name}</p>
                                        </div>
                                        {/* Wskaźnik pewności */}
                                        <div className="ml-auto text-right">
                                            <p className="text-[10px] text-slate-400">Pewność</p>
                                            <p className={`font-black text-sm ${aiResult.confidence >= 0.8 ? "text-emerald-400" : aiResult.confidence >= 0.5 ? "text-amber-400" : "text-red-400"}`}>
                                                {Math.round(aiResult.confidence * 100)}%
                                            </p>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="bg-slate-800/60 rounded-xl p-2.5">
                                            <p className="text-[9px] text-slate-400 uppercase tracking-wider">Kategoria</p>
                                            <p className="font-black text-xs text-purple-300 mt-0.5">📦 {aiResult.category}</p>
                                        </div>
                                        <div className="bg-slate-800/60 rounded-xl p-2.5">
                                            <p className="text-[9px] text-slate-400 uppercase tracking-wider">Jednostka</p>
                                            <p className="font-black text-xs text-purple-300 mt-0.5">📐 {aiResult.unit}</p>
                                        </div>
                                    </div>

                                    {aiResult.description && (
                                        <div className="bg-slate-800/40 rounded-xl p-3">
                                            <p className="text-[9px] text-slate-400 uppercase tracking-wider mb-1">Opis</p>
                                            <p className="text-xs text-slate-200 leading-relaxed">{aiResult.description}</p>
                                        </div>
                                    )}

                                    {aiResult.additionalInfo && (
                                        <div className="bg-amber-950/30 border border-amber-700/30 rounded-xl p-3">
                                            <p className="text-[9px] text-amber-400 uppercase tracking-wider mb-1">💡 Uwagi AI</p>
                                            <p className="text-xs text-amber-200 leading-relaxed">{aiResult.additionalInfo}</p>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Zrób nowe zdjęcie do analizy (gdy brak zdjęcia lub chcesz przeskanować inaczej) */}
                            <div>
                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                                    {aiResult ? "🔄 Zrób nowe zdjęcie do ponownej analizy" : "📸 Zrób zdjęcie, aby AI rozpoznało materiał"}
                                </label>
                                <label htmlFor="ai-modal-camera" className="w-full py-3 px-4 rounded-xl border-2 border-dashed border-purple-500/50 hover:border-purple-400 bg-purple-500/10 text-purple-300 font-bold text-xs flex items-center justify-center gap-2 cursor-pointer active:scale-98 transition">
                                    <span className="text-xl">📸</span>
                                    <span>Zrób zdjęcie aparatem</span>
                                </label>
                                <input id="ai-modal-camera" type="file" accept="image/*" capture="environment" className="hidden"
                                    onChange={e => {
                                        if (e.target.files?.[0]) {
                                            handleAiIdentify(e.target.files[0]);
                                        }
                                    }}
                                />
                            </div>

                            <button
                                onClick={() => { setAiModalItem(null); setAiResult(null); setAiError(null); }}
                                className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs rounded-xl transition"
                            >
                                Zamknij
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ══ LIGHTBOX ══════════════════════════════════════════════════════ */}
            {lightboxUrl && (
                <div onClick={() => setLightboxUrl(null)} className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center p-4 cursor-pointer animate-fade-in">
                    <button onClick={() => setLightboxUrl(null)} className="absolute top-4 right-4 text-white font-bold bg-slate-800/80 px-4 py-2 rounded-full text-sm">✕ Zamknij</button>
                    <img src={lightboxUrl} alt="Powiększenie" className="max-w-full max-h-[85vh] object-contain rounded-2xl border border-slate-800 shadow-2xl" />
                </div>
            )}

            {/* ══ MODAL PWA ═════════════════════════════════════════════════════ */}
            {isPwaModalOpen && (
                <div onClick={() => setIsPwaModalOpen(false)} className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
                    <div onClick={e => e.stopPropagation()} className="bg-slate-900 border border-slate-800 w-full max-w-sm rounded-3xl p-5 shadow-2xl text-left">
                        <div className="flex items-center gap-2 mb-3">
                            <span className="text-3xl">📱</span>
                            <div>
                                <h3 className="font-black text-sm text-white uppercase">Aplikacja na telefon</h3>
                                <p className="text-[10px] text-slate-400">Instalacja ikony na pulpicie</p>
                            </div>
                        </div>
                        <div className="space-y-3 text-xs text-slate-300 bg-slate-800/60 p-3.5 rounded-2xl border border-slate-700/60 leading-relaxed">
                            <div>
                                <p className="font-bold text-amber-400 mb-0.5">🍏 iPhone (Safari):</p>
                                <p>1. Kliknij ikonę <b>Udostępnij</b> (kwadrat ze strzałką).</p>
                                <p>2. Wybierz <b>„Do ekranu początkowego"</b>.</p>
                            </div>
                            <div className="border-t border-slate-700/60 pt-2">
                                <p className="font-bold text-amber-400 mb-0.5">🤖 Android (Chrome):</p>
                                <p>1. Kliknij <b>trzy kropki</b> w prawym górnym rogu.</p>
                                <p>2. Wybierz <b>„Dodaj do ekranu głównego"</b>.</p>
                            </div>
                        </div>
                        <button onClick={() => setIsPwaModalOpen(false)} className="w-full mt-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl transition">Rozumiem</button>
                    </div>
                </div>
            )}

            {/* ══ TOAST ═════════════════════════════════════════════════════════ */}
            {toast && (
                <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 z-50 bg-amber-500 text-slate-950 font-black text-xs py-2.5 px-4 rounded-2xl shadow-xl flex items-center justify-between animate-bounce">
                    <span>{toast}</span>
                    <button onClick={() => setToast(null)} className="ml-3 font-bold text-slate-900">✕</button>
                </div>
            )}
        </div>
    );
}


