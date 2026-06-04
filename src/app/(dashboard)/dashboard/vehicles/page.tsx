"use client";

import React, { useState, useEffect } from "react";
import { collection, getDocs, getDoc, doc, setDoc, deleteDoc, query, orderBy, where } from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";
import Link from "next/link";

// --- INTERFEJSY ---
interface Vehicle {
    id: string; brand: string; model: string; year: number; registration: string;
    summerTires: "Tak" | "Nie"; winterTires: "Tak" | "Nie"; currentTires: "Letnie" | "Zimowe";
    inspectionDate: string; dateAdded: string; initialMileage: number;
}

interface Repair {
    id: string; vehicleId: string; date: string; cost: number; accountingNumber: string;
    mileage: number; comments: string; location: string;
    repairType?: string;
    category: string;
    invoiceUrl?: string; legacyId?: string;
    partsList?: string[];
    registrationNumberFromInvoice?: string;
}

export default function VehiclesHub() {
    const { user } = useAuth();
    const [vehicles, setVehicles] = useState<Vehicle[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState("");

    // Uprawnienia
    const canManage = user ? hasPermission("manageVehicles", user.rolePermissions, user.permissionOverrides) : false;

    // --- STANY DLA POJAZDÓW ---
    const [isVehicleModalOpen, setIsVehicleModalOpen] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [vehicleForm, setVehicleForm] = useState<Partial<Vehicle>>({
        summerTires: "Tak", winterTires: "Tak", currentTires: "Letnie",
        dateAdded: new Date().toISOString().split("T")[0], initialMileage: 0
    });
    const [isSubmitting, setIsSubmitting] = useState(false);

    // --- STANY DLA NAPRAW ---
    const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
    const [repairs, setRepairs] = useState<Repair[]>([]);
    const [isRepairsLoading, setIsRepairsLoading] = useState(false);

    const [isEditingRepair, setIsEditingRepair] = useState(false);
    const [editingRepairId, setEditingRepairId] = useState<string | null>(null);

    const [repairForm, setRepairForm] = useState<Partial<Repair>>({
        date: new Date().toISOString().split("T")[0], cost: 0, accountingNumber: "",
        mileage: 0, comments: "", location: "", category: "",
        partsList: []
    });
    const [invoiceFiles, setInvoiceFiles] = useState<File[]>([]);
    const [isAiParsing, setIsAiParsing] = useState(false);
    const [showAiSuccessBanner, setShowAiSuccessBanner] = useState(false);

    // --- STANY IMPORTERA CSV ---
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [vehiclesCsv, setVehiclesCsv] = useState("");
    const [repairsCsv, setRepairsCsv] = useState("");

    // --- STANY MASOWEGO IMPORTERA SKANÓW ---
    const [isBulkUploading, setIsBulkUploading] = useState(false);
    const [bulkUploadProgress, setBulkUploadProgress] = useState("");

    // --- STANY MASOWEGO AUTOMATU UZUPEŁNIANIA AI ---
    const [isProcessingEnrich, setIsProcessingEnrich] = useState(false);
    const [enrichIndex, setEnrichIndex] = useState(0);
    const [enrichTotal, setEnrichTotal] = useState(0);
    const [enrichLogs, setEnrichLogs] = useState<string[]>([]);

    // ==========================================
    // LOGIKA BAZODANOWA (POBIERANIE)
    // ==========================================
    const fetchVehicles = async () => {
        setLoading(true);
        try {
            const q = query(collection(db, "vehicles"), orderBy("brand", "asc"));
            const querySnapshot = await getDocs(q);
            setVehicles(querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as Vehicle[]);
        } catch (error) {
            console.error("Błąd podczas pobierania pojazdów:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchVehicles(); }, []);

    const filteredVehicles = vehicles.filter(v =>
        `${v.brand} ${v.model} ${v.registration}`.toLowerCase().replace(/\s/g, '').includes(searchQuery.toLowerCase().replace(/\s/g, ''))
    );

    const handleSaveVehicle = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            if (vehicleForm.currentTires === "Letnie" && vehicleForm.summerTires === "Nie") throw new Error("Pojazd nie posiada opon letnich.");
            if (vehicleForm.currentTires === "Zimowe" && vehicleForm.winterTires === "Nie") throw new Error("Pojazd nie posiada opon zimowych.");

            let docRef = isEditing && vehicleForm.id ? doc(db, "vehicles", vehicleForm.id) : doc(collection(db, "vehicles"));

            await setDoc(docRef, {
                brand: vehicleForm.brand, model: vehicleForm.model, year: Number(vehicleForm.year),
                registration: vehicleForm.registration, summerTires: vehicleForm.summerTires,
                winterTires: vehicleForm.winterTires, currentTires: vehicleForm.currentTires,
                inspectionDate: vehicleForm.inspectionDate, dateAdded: vehicleForm.dateAdded,
                initialMileage: Number(vehicleForm.initialMileage),
                updatedAt: new Date().toISOString() // 🔄 DODANO: updatedAt dla Dexie Sync
            }, { merge: true });

            alert(isEditing ? "Pojazd zaktualizowany." : "Pojazd dodany.");
            setIsVehicleModalOpen(false);
            fetchVehicles();
        } catch (error: any) { alert("Błąd: " + error.message); }
        finally { setIsSubmitting(false); }
    };

    const handleDeleteVehicle = async (vehicleId: string, vehicleName: string) => {
        if (!confirm(`⚠️ Czy na pewno chcesz trwale usunąć pojazd ${vehicleName} z bazy?`)) return;
        try {
            await deleteDoc(doc(db, "vehicles", vehicleId));
            alert("Pojazd usunięty.");
            fetchVehicles();
        } catch (error: any) { alert("Błąd usuwania: " + error.message); }
    };

    const openAddModal = () => {
        setVehicleForm({
            brand: "", model: "", year: new Date().getFullYear(), registration: "",
            summerTires: "Tak", winterTires: "Tak", currentTires: "Letnie",
            inspectionDate: "", dateAdded: new Date().toISOString().split("T")[0], initialMileage: 0
        });
        setIsEditing(false); setIsVehicleModalOpen(true);
    };

    const openEditModal = (vehicle: Vehicle) => {
        setVehicleForm(vehicle); setIsEditing(true); setIsVehicleModalOpen(true);
    };

    const fetchRepairs = async (vehicleId: string) => {
        setIsRepairsLoading(true);
        try {
            const q = query(collection(db, "repairs"), where("vehicleId", "==", vehicleId));
            const querySnapshot = await getDocs(q);
            const loadedRepairs = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as Repair[];
            loadedRepairs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            setRepairs(loadedRepairs);
        } catch (error) {
            console.error("Błąd pobierania napraw:", error);
        } finally {
            setIsRepairsLoading(false);
        }
    };

    const openHistoryModal = (vehicle: Vehicle) => {
        setSelectedVehicle(vehicle);
        setRepairForm({
            date: new Date().toISOString().split("T")[0],
            cost: 0, accountingNumber: "", mileage: vehicle.initialMileage,
            comments: "", location: "", category: "",
            partsList: []
        });
        setInvoiceFiles([]);
        fetchRepairs(vehicle.id);
    };

    const closeHistoryModal = () => {
        setSelectedVehicle(null);
        setRepairs([]);
        handleCancelEditRepair();
    };

    const handleStartEditRepair = (repair: Repair) => {
        setIsEditingRepair(true);
        setEditingRepairId(repair.id);
        setRepairForm({
            date: repair.date,
            cost: repair.cost,
            accountingNumber: repair.accountingNumber,
            mileage: repair.mileage,
            comments: repair.comments,
            location: repair.location,
            category: repair.category || repair.repairType || "",
            invoiceUrl: repair.invoiceUrl,
            legacyId: repair.legacyId,
            partsList: repair.partsList || []
        });
        setInvoiceFiles([]);
        setShowAiSuccessBanner(false);
    };

    const handleCancelEditRepair = () => {
        setIsEditingRepair(false);
        setEditingRepairId(null);
        setRepairForm({
            date: new Date().toISOString().split("T")[0],
            cost: 0, accountingNumber: "", mileage: selectedVehicle ? selectedVehicle.initialMileage : 0,
            comments: "", location: "", category: "",
            partsList: []
        });
        setInvoiceFiles([]);
        setShowAiSuccessBanner(false);
    };

    const handleClipboardPaste = (e: React.ClipboardEvent) => {
        const items = e.clipboardData.items;
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf("image") !== -1) {
                const blob = items[i].getAsFile();
                if (blob) {
                    const pastedFile = new File([blob], `Screenshot_${new Date().toISOString().replace(/[:.]/g, "-")}.png`, { type: blob.type });
                    setInvoiceFiles(prev => [...prev, pastedFile]);
                }
            }
        }
    };

    // ==========================================
    // POJEDYNCZE DODAWANIE NAPRAWY - AI
    // ==========================================
    const handleParseInvoiceWithAI = async () => {
        if (invoiceFiles.length === 0) return alert("Najpierw dodaj przynajmniej jeden plik (lub wklej zrzut ekranu)!");
        setIsAiParsing(true);
        setShowAiSuccessBanner(false);

        try {
            const filePromises = invoiceFiles.map(async (file) => {
                const base64: string = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.readAsDataURL(file);
                    reader.onload = () => resolve((reader.result as string).split(',')[1]);
                    reader.onerror = error => reject(error);
                });
                return { fileBase64: base64, mimeType: file.type };
            });

            const processedFiles = await Promise.all(filePromises);

            const response = await fetch('/api/parse-invoice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: processedFiles })
            });

            const data = await response.json();

            if (!response.ok) throw new Error(data.error || "Nieudana analiza plików przez AI");

            setRepairForm(prev => ({
                ...prev,
                date: data.date || prev.date,
                cost: data.cost || prev.cost,
                accountingNumber: data.accountingNumber || prev.accountingNumber,
                mileage: data.mileage || prev.mileage,
                comments: data.comments || prev.comments,
                category: data.category || prev.category,
                location: data.location || prev.location,
                partsList: data.partsList || []
            }));

            setShowAiSuccessBanner(true);
        } catch (error: any) {
            alert("Błąd analizy AI: " + error.message);
        } finally {
            setIsAiParsing(false);
        }
    };

    // ==========================================
    // ZAPIS NAPRAWY DO BAZY (DODAWANIE/EDYCJA)
    // ==========================================
    const handleSaveRepair = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedVehicle) return;
        setIsSubmitting(true);

        try {
            const storage = getStorage();
            let finalInvoiceUrl = repairForm.invoiceUrl || "";

            if (invoiceFiles.length > 0) {
                let fileToUpload: Blob;
                let fileNameToUpload: string;

                if (invoiceFiles.length === 1 && invoiceFiles[0].type === "application/pdf") {
                    fileToUpload = invoiceFiles[0];
                    fileNameToUpload = invoiceFiles[0].name;
                } else {
                    const filePromises = invoiceFiles.map(async (file) => {
                        const base64: string = await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.readAsDataURL(file);
                            reader.onload = () => resolve((reader.result as string).split(',')[1]);
                            reader.onerror = error => reject(error);
                        });
                        return { fileBase64: base64, mimeType: file.type };
                    });

                    const processedFiles = await Promise.all(filePromises);

                    const mergeResponse = await fetch('/api/merge-attachments', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ files: processedFiles })
                    });

                    const mergeData = await mergeResponse.json();
                    if (!mergeResponse.ok) throw new Error(mergeData.error || "Błąd łączenia plików");

                    const byteCharacters = atob(mergeData.pdfBase64);
                    const byteNumbers = new Array(byteCharacters.length);
                    for (let i = 0; i < byteCharacters.length; i++) {
                        byteNumbers[i] = byteCharacters.charCodeAt(i);
                    }
                    const byteArray = new Uint8Array(byteNumbers);
                    fileToUpload = new Blob([byteArray], { type: 'application/pdf' });
                    fileNameToUpload = `Polaczone_Dokumenty_${Date.now()}.pdf`;
                }

                const fileRef = ref(storage, `vehicles/invoices/${Date.now()}_${fileNameToUpload}`);
                await uploadBytes(fileRef, fileToUpload);
                finalInvoiceUrl = await getDownloadURL(fileRef);
            }

            let repairRef;
            if (isEditingRepair && editingRepairId) {
                repairRef = doc(db, "repairs", editingRepairId);
            } else {
                repairRef = doc(collection(db, "repairs"));
            }

            await setDoc(repairRef, {
                vehicleId: selectedVehicle.id,
                date: repairForm.date,
                cost: Number(repairForm.cost),
                accountingNumber: repairForm.accountingNumber,
                mileage: Number(repairForm.mileage),
                comments: repairForm.comments,
                location: repairForm.location,
                category: repairForm.category || "Inne",
                invoiceUrl: finalInvoiceUrl,
                partsList: repairForm.partsList || [],
                updatedAt: new Date().toISOString(), // 🔄 DODANO: updatedAt dla Dexie Sync
                ...(repairForm.legacyId && { legacyId: repairForm.legacyId })
            }, { merge: true });

            alert(isEditingRepair ? "Wpis naprawy został pomyślnie zaktualizowany." : "Naprawa została pomyślnie zapisana w systemie!");

            handleCancelEditRepair();

            if (!isEditingRepair) {
                closeHistoryModal();
                fetchVehicles();
            } else {
                fetchRepairs(selectedVehicle.id);
            }
        } catch (error: any) {
            alert("Błąd podczas zapisywania naprawy: " + error.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDeleteRepair = async (repairId: string) => {
        if (!confirm("⚠️ Czy na pewno chcesz trwale usunąć ten wpis o naprawie?")) return;
        setIsSubmitting(true);
        try {
            const repairRef = doc(db, "repairs", repairId);
            const repairSnap = await getDoc(repairRef);

            if (repairSnap.exists()) {
                const repairData = repairSnap.data();
                const invoiceUrl = repairData.invoiceUrl;

                if (invoiceUrl && invoiceUrl.includes("firebasestorage.googleapis.com")) {
                    const storage = getStorage();
                    const fileRef = ref(storage, invoiceUrl);
                    await deleteObject(fileRef);
                }
            }

            await deleteDoc(repairRef);
            alert("Wpis naprawy oraz powiązany skan PDF zostały trwale usunięte z systemu.");
            if (selectedVehicle) fetchRepairs(selectedVehicle.id);
        } catch (error: any) {
            alert("Błąd podczas usuwania: " + error.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleUploadLegacyInvoice = async (repairDocId: string, legacyId: string, file: File) => {
        setIsSubmitting(true);
        try {
            const storage = getStorage();
            const fileRef = ref(storage, `vehicles/invoices/legacy_Naprawa_${legacyId}_${file.name}`);
            await uploadBytes(fileRef, file);
            const downloadUrl = await getDownloadURL(fileRef);

            await setDoc(doc(db, "repairs", repairDocId), {
                invoiceUrl: downloadUrl,
                updatedAt: new Date().toISOString() // 🔄 DODANO: updatedAt dla Dexie Sync
            }, { merge: true });

            alert(`Skan faktury dla starego wpisu Naprawa_${legacyId} został pomyślnie wgrany i podpięty!`);
            if (selectedVehicle) fetchRepairs(selectedVehicle.id);
        } catch (e: any) {
            alert("Błąd wgrywania skanu: " + e.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleBulkUploadInvoices = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        if (!confirm(`Wybrano ${files.length} plików.\nCzy chcesz rozpocząć masowe wgrywanie? System dopasuje pliki "Naprawa_X.pdf" do odpowiednich wpisów w bazie.\n\nPROSZĘ NIE ZAMYKAĆ ZAKŁADKI W TRAKCIE PROCESU!`)) {
            e.target.value = "";
            return;
        }

        setIsBulkUploading(true);
        let successCount = 0;
        let notFoundCount = 0;

        const storage = getStorage();

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            setBulkUploadProgress(`Wgrywanie: ${i + 1} z ${files.length} (${file.name})...`);

            const match = file.name.match(/Naprawa_(\d+)/i);
            if (!match) {
                console.warn(`Plik ${file.name} pominięty - nie pasuje do schematu "Naprawa_X"`);
                continue;
            }

            const legacyId = match[1];

            try {
                const q = query(collection(db, "repairs"), where("legacyId", "==", legacyId));
                const snap = await getDocs(q);

                if (snap.empty) {
                    notFoundCount++;
                    continue;
                }

                const fileRef = ref(storage, `vehicles/invoices/legacy_${file.name}`);
                await uploadBytes(fileRef, file);
                const downloadUrl = await getDownloadURL(fileRef);

                for (const docSnap of snap.docs) {
                    await setDoc(doc(db, "repairs", docSnap.id), {
                        invoiceUrl: downloadUrl,
                        updatedAt: new Date().toISOString() // 🔄 DODANO: updatedAt dla Dexie Sync
                    }, { merge: true });
                }

                successCount++;
            } catch (err) {
                console.error(`Błąd wgrywania pliku ${file.name}:`, err);
            }
        }

        setIsBulkUploading(false);
        setBulkUploadProgress("");
        e.target.value = "";
        alert(`✅ Masowy import skanów zakończony!\n\nPodpięto poprawnie: ${successCount} plików.\nNie znaleziono naprawy w bazie dla: ${notFoundCount} plików.`);

        if (selectedVehicle) fetchRepairs(selectedVehicle.id);
    };

    const handleImportCSV = async () => {
        if (!vehiclesCsv.trim()) return alert("Wklej przynajmniej dane pojazdów!");
        setIsSubmitting(true);

        const parseCSV = (text: string, delimiter: string): string[][] => {
            const lines: string[][] = [];
            let row: string[] = [""];
            let inQuotes = false;

            for (let i = 0; i < text.length; i++) {
                const c = text[i];
                const next = text[i + 1];

                if (c === '"') {
                    if (inQuotes && next === '"') {
                        row[row.length - 1] += '"';
                        i++;
                    } else {
                        inQuotes = !inQuotes;
                    }
                } else if (c === delimiter && !inQuotes) {
                    row.push("");
                } else if ((c === '\r' || c === '\n') && !inQuotes) {
                    if (c === '\r' && next === '\n') i++;
                    lines.push(row);
                    row = [""];
                } else {
                    row[row.length - 1] += c;
                }
            }
            if (row.length > 1 || row[0] !== "") {
                lines.push(row);
            }
            return lines;
        };

        try {
            const storage = getStorage();
            const vDelimiter = vehiclesCsv.includes(';') ? ';' : ',';
            const vehicleRows = parseCSV(vehiclesCsv, vDelimiter);

            const idMap: Record<string, string> = {};

            // 1. IMPORT POJAZDÓW
            for (let i = 1; i < vehicleRows.length; i++) {
                const cols = vehicleRows[i].map(c => c.trim());
                if (cols.length < 5 || !cols[0]) continue;

                const oldId = cols[0];
                const brand = cols[1];
                const model = cols[2];
                const year = Number(cols[3]) || 2000;
                const registration = cols[4];
                const summerTires = (cols[5] === "Tak" || cols[5] === "TAK" || cols[5] === "Tak") ? "Tak" : "Nie";
                const winterTires = (cols[6] === "Tak" || cols[6] === "TAK" || cols[6] === "Tak") ? "Tak" : "Nie";
                const currentTires = cols[7] === "Zimowe" ? "Zimowe" : "Letnie";
                const inspectionDate = cols[8] || "";
                const dateAdded = cols[9] || new Date().toISOString().split("T")[0];
                const initialMileage = Number(cols[10]) || 0;

                const vehicleRef = doc(collection(db, "vehicles"));
                await setDoc(vehicleRef, {
                    brand, model, year, registration, summerTires, winterTires, currentTires, inspectionDate, dateAdded, initialMileage,
                    updatedAt: new Date().toISOString() // 🔄 DODANO: updatedAt dla Dexie Sync
                });

                idMap[oldId] = vehicleRef.id;
            }

            // 2. IMPORT NAPRAW
            if (repairsCsv.trim()) {
                const rDelimiter = repairsCsv.includes(';') ? ';' : ',';
                const repairRows = parseCSV(repairsCsv, rDelimiter);

                for (let i = 1; i < repairRows.length; i++) {
                    const cols = repairRows[i].map(c => c.trim());
                    if (cols.length < 3 || !cols[0]) continue;

                    const legacyId = cols[0];
                    const oldVehicleId = cols[1];
                    const dateRaw = cols[2];
                    const date = dateRaw ? dateRaw.split(" ")[0] : "";
                    const cost = parseFloat(cols[3]?.replace(',', '.')) || 0;
                    const accountingNumber = cols[4] || "";
                    const mileage = Number(cols[5]) || 0;
                    const comments = cols[6] || "";
                    const location = cols[7] || "";
                    const category = cols[8] || cols[9] || "Inne";

                    const newVehicleId = idMap[oldVehicleId];
                    if (!newVehicleId) {
                        continue;
                    }

                    let invoiceUrl = "";
                    try {
                        const fileRef = ref(storage, `vehicles/invoices/legacy_Naprawa_${legacyId}.pdf`);
                        invoiceUrl = await getDownloadURL(fileRef);
                    } catch (err) { }

                    const repairRef = doc(collection(db, "repairs"));
                    await setDoc(repairRef, {
                        vehicleId: newVehicleId,
                        date, cost, accountingNumber, mileage, comments, location, category, legacyId,
                        ...(invoiceUrl && { invoiceUrl }),
                        updatedAt: new Date().toISOString() // 🔄 DODANO: updatedAt dla Dexie Sync
                    });
                }
            }

            alert("✅ Import zakończony pomyślnie! Baza pojazdów i napraw została zmigrowana, a istniejące pliki PDF zostały automatycznie zlinkowane.");
            setIsImportModalOpen(false);
            setVehiclesCsv("");
            setRepairsCsv("");
            fetchVehicles();
        } catch (e: any) {
            alert("Błąd podczas importu: " + e.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    // =========================================================================
    // MASOWY AUTOMAT UZUPEŁNIANIA DANYCH AI BEZPOŚREDNIO W IMPORTERZE
    // =========================================================================
    const handleStartEnrichment = async () => {
        setIsProcessingEnrich(true);
        setEnrichLogs(["[START] Skanowanie bazy danych..."]);

        try {
            const q = query(collection(db, "repairs"), where("legacyId", "!=", ""));
            const snap = await getDocs(q);

            const allRepairs = snap.docs.map(d => ({ id: d.id, ...d.data() })) as Repair[];
            const targets = allRepairs.filter(r => !!r.invoiceUrl);

            setEnrichTotal(targets.length);

            if (targets.length === 0) {
                addEnrichLog("✓ Wszystkie zaimportowane naprawy mają już wyodrębnione części i opisy! Brak pracy.");
                setIsProcessingEnrich(false);
                return;
            }

            addEnrichLog(`Znaleziono ${targets.length} napraw wymagających analizy i uzupełnienia.`);

            for (let i = 0; i < targets.length; i++) {
                const repair = targets[i];
                setEnrichIndex(i + 1);
                addEnrichLog(`⚙️ [${i + 1}/${targets.length}] Pobieranie i analiza faktury o starym ID: ${repair.legacyId}...`);

                try {
                    const fileRes = await fetch(repair.invoiceUrl!);
                    const blob = await fileRes.blob();

                    const base64: string = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.readAsDataURL(blob);
                        reader.onload = () => resolve((reader.result as string).split(',')[1]);
                        reader.onerror = error => reject(error);
                    });

                    const response = await fetch('/api/parse-invoice', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ files: [{ fileBase64: base64, mimeType: blob.type }] })
                    });

                    const data = await response.json();
                    if (!response.ok) throw new Error(data.error || "Błąd API Gemini");

                    await setDoc(doc(db, "repairs", repair.id), {
                        comments: data.comments || repair.comments,
                        category: data.category || repair.category || repair.repairType || "Inne",
                        partsList: data.partsList || [],
                        registrationNumberFromInvoice: data.registrationNumber || "",
                        hasAiData: true,
                        updatedAt: new Date().toISOString() // 🔄 DODANO: updatedAt dla Dexie Sync
                    }, { merge: true });

                    const partsFound = data.partsList && data.partsList.length > 0 ? data.partsList.join(", ") : "brak";
                    addEnrichLog(`✅ [SUKCES] Kategoria: ${data.category} | Wykryte części: [${partsFound}]`);

                    await new Promise(resolve => setTimeout(resolve, 3000));
                } catch (err: any) {
                    addEnrichLog(`❌ [BŁĄD] Naprawa o starym ID ${repair.legacyId}: ${err.message}`);
                }
            }

            addEnrichLog("🎉 [ZAKOŃCZONO] Wszystkie naprawy zostały pomyślnie uaktualnione przez AI!");
        } catch (err: any) {
            addEnrichLog("❌ Błąd krytyczny skanowania bazy: " + err.message);
        } finally {
            setIsProcessingEnrich(false);
        }
    };

    const addEnrichLog = (msg: string) => {
        setEnrichLogs(prev => [msg, ...prev]);
    };

    if (loading) return <div className="p-10 text-center animate-pulse">Ładowanie modułu floty...</div>;

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto animate-fade-in space-y-8">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-200 pb-6">
                <div>
                    <h1 className="text-3xl font-black text-slate-800 tracking-tight">Flota i Pojazdy</h1>
                    <p className="text-sm text-slate-500 mt-1">Zarządzanie samochodami firmowymi, przeglądami i naprawami.</p>
                </div>
                <div className="flex items-center gap-3 w-full md:w-auto">
                    <input
                        type="text" placeholder="Szukaj (marka, rejestracja)..."
                        value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                        className="p-3 bg-white border border-slate-200 rounded-xl shadow-sm outline-none focus:border-blue-500 font-medium w-full md:w-64"
                    />
                    <Link href="/dashboard/vehicles/reports" className="bg-purple-50 hover:bg-purple-100 text-purple-800 border border-purple-200 px-5 py-3 rounded-xl font-bold transition flex items-center gap-1.5 shadow-sm">
                        📊 Raporty Floty
                    </Link>
                    {canManage && (
                        <>
                            <button onClick={() => setIsImportModalOpen(true)} className="bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 px-5 py-3 rounded-xl font-bold transition">
                                📥 Import z Excela (CSV)
                            </button>
                            <button onClick={openAddModal} className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-3 rounded-xl font-bold shadow-md transition whitespace-nowrap">
                                + Dodaj Pojazd
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* LISTA POJAZDÓW */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredVehicles.length === 0 ? (
                    <div className="col-span-full p-10 text-center text-slate-400 bg-slate-50 rounded-2xl border border-dashed">
                        Brak pojazdów spełniających kryteria.
                    </div>
                ) : (
                    filteredVehicles.map(vehicle => {
                        const today = new Date();
                        const inspDate = new Date(vehicle.inspectionDate);
                        const daysToInspection = Math.ceil((inspDate.getTime() - today.getTime()) / (1000 * 3600 * 24));
                        const needsInspectionSoon = daysToInspection <= 60 && daysToInspection >= 0;
                        const inspectionOverdue = daysToInspection < 0;

                        return (
                            <div key={vehicle.id} className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md transition flex flex-col justify-between group relative overflow-hidden">
                                {inspectionOverdue && <div className="absolute top-0 left-0 w-full h-1.5 bg-red-600"></div>}
                                {needsInspectionSoon && <div className="absolute top-0 left-0 w-full h-1.5 bg-orange-400"></div>}

                                <div>
                                    <div className="flex justify-between items-start mb-4">
                                        <div>
                                            <h3 className="text-lg font-black text-slate-800 leading-tight">{vehicle.brand} {vehicle.model}</h3>
                                            <span className="inline-block mt-1 bg-slate-100 border border-slate-200 text-slate-700 font-mono font-bold text-xs px-2 py-0.5 rounded uppercase tracking-widest">
                                                {vehicle.registration}
                                            </span>
                                        </div>
                                        <span className="text-3xl opacity-20">🚙</span>
                                    </div>

                                    <div className="space-y-2 text-sm text-slate-600 mb-6">
                                        <div className="flex justify-between border-b pb-1">
                                            <span className="text-slate-400">Rok produkcji:</span>
                                            <span className="font-bold">{vehicle.year}</span>
                                        </div>
                                        <div className="flex justify-between border-b pb-1">
                                            <span className="text-slate-400">Założone opony:</span>
                                            <span className="font-bold flex items-center gap-1">
                                                {vehicle.currentTires === "Zimowe" ? "❄️ Zimowe" : "☀️ Letnie"}
                                            </span>
                                        </div>
                                        <div className="flex justify-between border-b pb-1">
                                            <span className="text-slate-400">Ważność przeglądu:</span>
                                            <span className={`font-bold ${inspectionOverdue ? 'text-red-600' : needsInspectionSoon ? 'text-orange-600' : 'text-green-600'}`}>
                                                {vehicle.inspectionDate}
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex gap-2 mt-auto pt-4 border-t border-slate-100">
                                    <button
                                        onClick={() => openHistoryModal(vehicle)}
                                        className="flex-1 bg-slate-100 hover:bg-purple-100 text-purple-700 font-bold py-2 rounded-lg text-xs transition border border-slate-200 hover:border-purple-300"
                                    >
                                        🛠️ Historia i Naprawy
                                    </button>

                                    {canManage && (
                                        <>
                                            <button onClick={() => openEditModal(vehicle)} className="bg-slate-100 hover:bg-blue-100 text-blue-700 font-bold px-3 py-2 rounded-lg text-xs transition">
                                                Edytuj
                                            </button>
                                            <button onClick={() => handleDeleteVehicle(vehicle.id, `${vehicle.brand} ${vehicle.model}`)} className="bg-slate-100 hover:bg-red-100 text-red-600 font-bold px-3 py-2 rounded-lg text-xs transition">
                                                Usuń
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {/* MODAL: HISTORIA I NAPRAWY */}
            {selectedVehicle && (
                <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden animate-fade-in border-t-8 border-purple-600">
                        <div className="p-6 bg-slate-50 border-b flex justify-between items-center">
                            <div>
                                <h2 className="text-2xl font-black text-slate-800">Karta Pojazdu: {selectedVehicle.brand} {selectedVehicle.model}</h2>
                                <p className="text-sm text-slate-500 font-mono font-bold mt-1">Nr rej: <span className="text-blue-600">{selectedVehicle.registration}</span> | Baza od: {selectedVehicle.dateAdded}</p>
                            </div>
                            <button onClick={closeHistoryModal} className="text-4xl text-slate-400 hover:text-slate-900 leading-none">&times;</button>
                        </div>

                        <div className="flex-1 flex overflow-hidden">
                            {/* LEWA STRONA: Lista napraw */}
                            <div className="w-2/3 border-r flex flex-col bg-slate-50/50">
                                <div className="p-4 border-b bg-white flex justify-between items-center">
                                    <span className="text-xs font-black text-slate-500 uppercase tracking-wider">Historia serwisowa ({repairs.length})</span>
                                </div>
                                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                                    {isRepairsLoading ? (
                                        <div className="text-center p-10 text-slate-400 animate-pulse">Pobieranie historii napraw...</div>
                                    ) : repairs.length === 0 ? (
                                        <div className="text-center p-10 bg-white border-2 border-dashed rounded-2xl text-slate-400">
                                            Brak wpisów o naprawach dla tego pojazdu.
                                        </div>
                                    ) : (
                                        repairs.map(repair => (
                                            <div key={repair.id} className="bg-white p-5 border border-slate-200 rounded-2xl shadow-sm hover:shadow-md transition">
                                                <div className="flex justify-between items-start mb-3 border-b border-slate-100 pb-3">
                                                    <div>
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-black text-lg text-slate-800">{repair.date}</span>
                                                            <span className="bg-slate-100 text-slate-600 text-[10px] font-black px-2 py-0.5 rounded uppercase">{repair.category || repair.repairType || "Nieznany typ"}</span>
                                                            {repair.legacyId && <span className="bg-yellow-100 text-yellow-800 text-[10px] font-black px-2 py-0.5 rounded uppercase border border-yellow-200">Stare ID: {repair.legacyId} (Migracja)</span>}
                                                        </div>
                                                        <span className="text-xs font-bold text-slate-400 uppercase mt-1 block">
                                                            Przebieg: <span className="text-blue-600">{repair.mileage.toLocaleString()} km</span>
                                                        </span>
                                                    </div>
                                                    <div className="text-right">
                                                        <span className="block font-black text-xl text-red-600">{repair.cost.toLocaleString()} PLN</span>
                                                        {repair.accountingNumber && <span className="text-[10px] text-slate-400 font-mono">Faktura: {repair.accountingNumber}</span>}
                                                    </div>
                                                </div>

                                                <div className="text-sm text-slate-700 leading-relaxed bg-slate-50 p-3 rounded-lg border border-slate-100 mb-3">
                                                    <span className="font-bold text-slate-500 text-xs uppercase block mb-1">Opis prac / Wymienione części:</span>
                                                    {repair.comments || <i className="text-slate-400">Brak opisu</i>}
                                                </div>

                                                {/* --- LISTA CZĘŚCI (TAGI) W HISTORII LEWEGO PANELU --- */}
                                                {repair.partsList && repair.partsList.length > 0 && (
                                                    <div className="flex flex-wrap gap-1.5 mb-3">
                                                        {repair.partsList.map((part, index) => (
                                                            <span key={index} className="bg-slate-100 border border-slate-200 text-slate-600 font-semibold px-2 py-0.5 rounded-full text-[10px] flex items-center gap-1">
                                                                ⚙️ {part}
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}

                                                <div className="flex flex-col gap-2">
                                                    <div className="flex justify-between items-center">
                                                        <div className="text-xs text-slate-500 font-semibold flex items-center gap-1">
                                                            <span>📍 Warsztat:</span> {repair.location || "Nieznany"}
                                                        </div>
                                                        <div className="flex gap-2">
                                                            {repair.invoiceUrl && (
                                                                <a href={repair.invoiceUrl} target="_blank" rel="noreferrer" className="bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition border border-blue-200">
                                                                    📄 Zobacz Skan
                                                                </a>
                                                            )}
                                                            {canManage && (
                                                                <button onClick={() => handleStartEditRepair(repair)} className="bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition border border-blue-200">
                                                                    Edytuj
                                                                </button>
                                                            )}
                                                            {canManage && (
                                                                <button onClick={() => handleDeleteRepair(repair.id)} className="bg-red-50 text-red-600 hover:bg-red-100 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition border border-red-200">
                                                                    Usuń
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>

                                                    {/* ŻÓŁTY PANEL WGRYWANIA STARYCH SKANÓW DLA ZAIMPORTOWANYCH REKORDÓW */}
                                                    {repair.legacyId && !repair.invoiceUrl && canManage && (
                                                        <div className="mt-2 bg-yellow-50 p-3 rounded-xl border border-yellow-200 flex items-center justify-between gap-4 animate-pulse">
                                                            <div>
                                                                <p className="text-xs font-bold text-yellow-800">Brak skanu faktury</p>
                                                                <p className="text-[10px] text-yellow-600 mt-0.5">Wgraj plik: <code className="bg-yellow-100 px-1 py-0.5 rounded font-black font-mono">Naprawa_{repair.legacyId}</code></p>
                                                            </div>
                                                            <input
                                                                type="file"
                                                                accept=".pdf,.jpg,.jpeg,.png"
                                                                onChange={(e) => {
                                                                    const file = e.target.files?.[0];
                                                                    if (file) handleUploadLegacyInvoice(repair.id, repair.legacyId!, file);
                                                                }}
                                                                className="text-xs text-slate-500 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-[10px] file:font-black file:bg-yellow-200 file:text-yellow-800 cursor-pointer"
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>

                            {/* PRAWA STRONA: Formularz nowej naprawy / Edycji */}
                            <div
                                onPaste={handleClipboardPaste}
                                className="w-1/3 flex flex-col bg-white relative"
                            >
                                {/* ASYSTENT ŁADOWANIA AI (OVERLAY) */}
                                {isAiParsing && (
                                    <div className="absolute inset-0 bg-white/90 backdrop-blur-sm z-50 flex flex-col items-center justify-center p-6 text-center animate-fade-in">
                                        <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mb-4"></div>
                                        <h4 className="text-sm font-black text-indigo-900 uppercase tracking-wider">Sztuczna Inteligencja czyta fakturę...</h4>
                                        <p className="text-xs text-indigo-600 mt-1 max-w-[200px]">Trwa wyciąganie danych OCR i mapowanie formularza. Proszę czekać.</p>
                                    </div>
                                )}

                                <div className={`p-4 border-b flex justify-between items-center ${isEditingRepair ? 'bg-orange-50' : 'bg-purple-50'}`}>
                                    <span className={`text-xs font-black uppercase tracking-wider ${isEditingRepair ? 'text-orange-800' : 'text-purple-800'}`}>
                                        {isEditingRepair ? "✏️ Edytuj Wpis Serwisowy" : "➕ Zarejestruj Naprawę"}
                                    </span>
                                    {isEditingRepair && (
                                        <button type="button" onClick={handleCancelEditRepair} className="text-[10px] font-bold text-orange-700 hover:underline">
                                            Anuluj edycję
                                        </button>
                                    )}
                                </div>
                                <div className="flex-1 overflow-y-auto p-6 space-y-4">
                                    {/* FIOLETOWY BANER SUKCESU AI */}
                                    {showAiSuccessBanner && (
                                        <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 text-xs text-indigo-950 font-bold flex items-start gap-3 shadow-sm animate-fade-in">
                                            <span className="text-lg">✨</span>
                                            <div>
                                                <p className="text-indigo-900 font-black uppercase text-[10px]">Sukces odczytu AI!</p>
                                                <p className="font-medium text-indigo-700 mt-0.5 leading-relaxed">Dane z załączników zostały automatycznie wczytane. Zweryfikuj ich poprawność przed kliknięciem Zapisz.</p>
                                            </div>
                                        </div>
                                    )}

                                    <form id="newRepairForm" onSubmit={handleSaveRepair} className="space-y-4">
                                        <div>
                                            <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">Data naprawy / FV</label>
                                            <input type="date" required value={repairForm.date} onChange={e => setRepairForm({ ...repairForm, date: e.target.value })} className="w-full p-2.5 bg-slate-50 border rounded-lg font-bold outline-none focus:border-purple-500" />
                                        </div>
                                        <div className="grid grid-cols-2 gap-3">
                                            <div>
                                                <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">Stan Licznika (km)</label>
                                                <input
                                                    type="number"
                                                    required
                                                    min="0"
                                                    value={repairForm.mileage !== undefined && repairForm.mileage !== null ? repairForm.mileage : ""}
                                                    onChange={e => setRepairForm({ ...repairForm, mileage: e.target.value === "" ? 0 : Number(e.target.value) })}
                                                    className="w-full p-2.5 bg-slate-50 border rounded-lg font-bold outline-none focus:border-purple-500"
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">Koszt Netto (PLN)</label>
                                                <input
                                                    type="number"
                                                    step="0.01"
                                                    required
                                                    value={repairForm.cost !== undefined && repairForm.cost !== null ? repairForm.cost : ""}
                                                    onChange={e => setRepairForm({ ...repairForm, cost: e.target.value === "" ? 0 : Number(e.target.value) })}
                                                    className="w-full p-2.5 bg-red-50 text-red-700 border border-red-200 rounded-lg font-black outline-none focus:border-red-500"
                                                />
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-2 gap-3">
                                            <div>
                                                <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">Numer Faktury</label>
                                                <input type="text" placeholder="np. FV 123/2026" value={repairForm.accountingNumber || ""} onChange={e => setRepairForm({ ...repairForm, accountingNumber: e.target.value })} className="w-full p-2.5 bg-slate-50 border rounded-lg font-bold outline-none focus:border-purple-500" />
                                            </div>
                                            <div>
                                                <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">Warsztat</label>
                                                <input type="text" placeholder="np. Auto-Serwis Jan" value={repairForm.location || ""} onChange={e => setRepairForm({ ...repairForm, location: e.target.value })} className="w-full p-2.5 bg-slate-50 border rounded-lg font-bold outline-none focus:border-purple-500" />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">Typ Usterki (Kategoria)</label>
                                            <select required value={repairForm.category} onChange={e => setRepairForm({ ...repairForm, category: e.target.value })} className="w-full p-2.5 bg-slate-50 border rounded-lg font-bold outline-none focus:border-purple-500">
                                                <option value="" disabled>Wybierz typ naprawy...</option>
                                                <option value="Mechaniczna">Mechaniczna (Skrzynia, Sprzęgło, Ogólne)</option>
                                                <option value="Silnik">Silnik (Rozrząd, Wydech, Turbina, DPF)</option>
                                                <option value="Układ hamulcowy">Układ hamulcowy (Klocki, Tarcze, Płyn)</option>
                                                <option value="Zawieszenie i Układ kierowniczy">Zawieszenie i Układ kierowniczy (Amortyzatory, Zbieżność)</option>
                                                <option value="Elektryczna i Elektronika">Elektryczna i Elektronika (Czujniki, Diagnostyka, Wiązki)</option>
                                                <option value="Klimatyzacja">Klimatyzacja (Serwis, Nabijanie, Kompresor)</option>
                                                <option value="Opony i Wulkanizacja">Opony i Wulkanizacja (Zakup, Wymiana, Wyważanie)</option>
                                                <option value="Akumulatory">Akumulatory (Zakup, Alternator, Rozruch)</option>
                                                <option value="Eksploatacyjna (Oleje / Filtry / Płyny)">Eksploatacyjna (Oleje / Filtry / Płyny)</option>
                                                <option value="Blacharsko-Lakiernicza">Blacharsko-Lakiernicza (Blacharka, Szyby, Lakierowanie)</option>
                                                <option value="Przeglądy i Badania">Przeglądy i Badania (Rejestracyjne, Tachograf)</option>
                                                <option value="Inne">Inne (Wycieraczki, Towar, Płyn spryskiwaczy)</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">Uwagi / Zakres prac</label>
                                            <textarea rows={3} placeholder="Co dokładnie zostało zrobione..." value={repairForm.comments || ""} onChange={e => setRepairForm({ ...repairForm, comments: e.target.value })} className="w-full p-2.5 bg-slate-50 border rounded-lg font-medium outline-none focus:border-purple-500 resize-none"></textarea>
                                        </div>

                                        {/* PODGLĄD CZĘŚCI WYKRYTYCH PRZEZ AI W FORMULARZU */}
                                        {repairForm.partsList && repairForm.partsList.length > 0 && (
                                            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
                                                <label className="block text-[9px] font-black text-slate-500 uppercase mb-2">⚙️ Wykryte części i usługi ({repairForm.partsList.length})</label>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {repairForm.partsList.map((part, index) => (
                                                        <span key={index} className="bg-white border text-[10px] font-bold text-slate-600 px-2 py-0.5 rounded-full shadow-sm">
                                                            {part}
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        <div
                                            onPaste={handleClipboardPaste}
                                            className="bg-slate-50 p-4 rounded-2xl border border-slate-200 focus-within:border-purple-300 transition-colors"
                                        >
                                            <label className="block text-[10px] font-black text-slate-500 uppercase mb-1">Załączniki (Skany / Zdjęcia)</label>
                                            <p className="text-[10px] text-slate-400 mb-3">Wybierz pliki z dysku lub **kliknij tu i wklej zrzut ekranu (Ctrl+V)**.</p>

                                            <input
                                                type="file" multiple accept=".pdf,.jpg,.jpeg,.png"
                                                onChange={e => {
                                                    if (e.target.files) {
                                                        setInvoiceFiles(prev => [...prev, ...Array.from(e.target.files!)]);
                                                    }
                                                }}
                                                className="block w-full text-xs text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-blue-100 file:text-blue-700 hover:file:bg-blue-200 cursor-pointer mb-3"
                                            />

                                            {/* LISTA PODGLĄDU ZAŁĄCZONYCH PLIKÓW / SCREENSHOTÓW */}
                                            {invoiceFiles.length > 0 && (
                                                <div className="space-y-1.5 mb-3">
                                                    {invoiceFiles.map((file, index) => (
                                                        <div key={index} className="flex justify-between items-center bg-white p-2 rounded-lg border text-xs shadow-sm">
                                                            <span className="truncate pr-2 font-semibold text-slate-700">📄 {file.name}</span>
                                                            <button
                                                                type="button"
                                                                onClick={() => setInvoiceFiles(prev => prev.filter((_, i) => i !== index))}
                                                                className="text-red-500 font-bold hover:text-red-700 px-1"
                                                            >
                                                                &times;
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}

                                            {/* PRZYCISK ANALIZY AI */}
                                            {invoiceFiles.length > 0 && (
                                                <button
                                                    type="button"
                                                    onClick={handleParseInvoiceWithAI}
                                                    disabled={isAiParsing}
                                                    className="w-full bg-indigo-100 hover:bg-indigo-200 text-indigo-800 border border-indigo-300 font-bold py-2.5 rounded-xl text-xs flex items-center justify-center gap-2 transition shadow-sm disabled:opacity-50"
                                                >
                                                    {isAiParsing ? (
                                                        <span className="animate-pulse">🤖 Czytanie z {invoiceFiles.length} plików...</span>
                                                    ) : (
                                                        <span>✨ Odczytaj dane z faktur (AI)</span>
                                                    )}
                                                </button>
                                            )}
                                        </div>
                                    </form>
                                </div>
                                <div className="p-4 border-t bg-slate-50">
                                    <button
                                        type="submit" form="newRepairForm" disabled={isSubmitting || !canManage}
                                        className="w-full py-4 bg-purple-600 hover:bg-purple-700 text-white font-black rounded-xl shadow-md disabled:bg-slate-300 transition"
                                    >
                                        {isSubmitting ? "Wgrywanie do bazy..." : "ZAPISZ NAPRAWĘ"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* MODAL: DODAJ / EDYTUJ POJAZD */}
            {isVehicleModalOpen && (
                <div className="fixed inset-0 bg-black/60 z-[70] flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden animate-fade-in border-t-8 border-blue-600">
                        <div className="p-6 bg-slate-50 border-b flex justify-between items-center">
                            <div>
                                <h2 className="text-xl font-black text-slate-800">{isEditing ? "Edytuj Pojazd" : "Dodaj Nowy Pojazd"}</h2>
                                <p className="text-xs text-slate-500 mt-1">Uzupełnij metrykę pojazdu firmowego.</p>
                            </div>
                            <button onClick={() => setIsVehicleModalOpen(false)} className="text-3xl text-slate-400 hover:text-slate-900 leading-none">&times;</button>
                        </div>

                        <form onSubmit={handleSaveVehicle} className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-black text-slate-500 uppercase mb-1">Marka</label>
                                    <input type="text" required value={vehicleForm.brand || ""} onChange={e => setVehicleForm({ ...vehicleForm, brand: e.target.value })} className="w-full p-2.5 bg-slate-50 border rounded-lg font-bold outline-none focus:border-blue-500" />
                                </div>
                                <div>
                                    <label className="block text-xs font-black text-slate-500 uppercase mb-1">Model</label>
                                    <input type="text" required value={vehicleForm.model || ""} onChange={e => setVehicleForm({ ...vehicleForm, model: e.target.value })} className="w-full p-2.5 bg-slate-50 border rounded-lg font-bold outline-none focus:border-blue-500" />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-black text-slate-500 uppercase mb-1">Numer Rejestracyjny</label>
                                    <input type="text" required value={vehicleForm.registration || ""} onChange={e => setVehicleForm({ ...vehicleForm, registration: e.target.value })} className="w-full p-2.5 bg-slate-50 border rounded-lg font-mono font-bold uppercase outline-none focus:border-blue-500" />
                                </div>
                                <div>
                                    <label className="block text-xs font-black text-slate-500 uppercase mb-1">Rok produkcji</label>
                                    <input type="number" required min="1990" max="2100" value={vehicleForm.year || ""} onChange={e => setVehicleForm({ ...vehicleForm, year: Number(e.target.value) })} className="w-full p-2.5 bg-slate-50 border rounded-lg font-bold outline-none focus:border-blue-500" />
                                </div>
                            </div>

                            <div className="grid grid-cols-3 gap-4 p-4 bg-blue-50 border border-blue-100 rounded-xl">
                                <div>
                                    <label className="block text-[10px] font-black text-blue-800 uppercase mb-1">Posiada opony letnie?</label>
                                    <select value={vehicleForm.summerTires} onChange={e => setVehicleForm({ ...vehicleForm, summerTires: e.target.value as any })} className="w-full p-2 border border-blue-200 rounded-lg text-sm font-bold bg-white">
                                        <option value="Tak">Tak</option>
                                        <option value="Nie">Nie</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-[10px] font-black text-blue-800 uppercase mb-1">Posiada opony zimowe?</label>
                                    <select value={vehicleForm.winterTires} onChange={e => setVehicleForm({ ...vehicleForm, winterTires: e.target.value as any })} className="w-full p-2 border border-blue-200 rounded-lg text-sm font-bold bg-white">
                                        <option value="Tak">Tak</option>
                                        <option value="Nie">Nie</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-[10px] font-black text-blue-800 uppercase mb-1">Aktualnie założone</label>
                                    <select value={vehicleForm.currentTires} onChange={e => setVehicleForm({ ...vehicleForm, currentTires: e.target.value as any })} className="w-full p-2 border border-blue-400 rounded-lg text-sm font-black bg-white text-blue-800 shadow-sm outline-none">
                                        <option value="Letnie">☀️ Letnie</option>
                                        <option value="Zimowe">❄️ Zimowe</option>
                                    </select>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-black text-slate-500 uppercase mb-1">Ważność przeglądu</label>
                                    <input type="date" required value={vehicleForm.inspectionDate || ""} onChange={e => setVehicleForm({ ...vehicleForm, inspectionDate: e.target.value })} className="w-full p-2.5 bg-slate-50 border rounded-lg font-bold outline-none focus:border-blue-500" />
                                </div>
                                <div>
                                    <label className="block text-xs font-black text-slate-500 uppercase mb-1">Data dodania do systemu</label>
                                    <input type="date" required value={vehicleForm.dateAdded || ""} onChange={e => setVehicleForm({ ...vehicleForm, dateAdded: e.target.value })} className="w-full p-2.5 bg-slate-50 border rounded-lg font-bold outline-none focus:border-blue-500" />
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-black text-slate-500 uppercase mb-1">Początkowy stan licznika (km)</label>
                                <input type="number" required min="0" value={vehicleForm.initialMileage || 0} onChange={e => setVehicleForm({ ...vehicleForm, initialMileage: Number(e.target.value) })} className="w-full p-2.5 bg-slate-50 border rounded-lg font-bold outline-none focus:border-blue-500" />
                            </div>

                            <div className="flex gap-3 pt-4 border-t mt-6">
                                <button type="button" onClick={() => setIsVehicleModalOpen(false)} className="px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition w-1/3">
                                    Anuluj
                                </button>
                                <button type="submit" disabled={isSubmitting} className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-xl shadow-md transition w-2/3 disabled:opacity-50">
                                    {isSubmitting ? "Zapisywanie..." : "Zapisz Pojazd w Bazie"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* MODAL: IMPORTER Z EXCELA (CSV) */}
            {isImportModalOpen && (
                <div className="fixed inset-0 bg-black/60 z-[80] flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl overflow-hidden animate-fade-in border-t-8 border-emerald-600">
                        <div className="p-6 bg-slate-50 border-b flex justify-between items-center">
                            <div>
                                <h2 className="text-xl font-black text-slate-800">📥 Masowy Importer z Excela / Google Sheets (CSV)</h2>
                                <p className="text-xs text-slate-500 mt-1">Szybka migracja danych floty ze starego systemu.</p>
                            </div>
                            <button onClick={() => setIsImportModalOpen(false)} className="text-3xl text-slate-400 hover:text-slate-900 leading-none">&times;</button>
                        </div>

                        <div className="p-6 space-y-5">
                            <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs p-4 rounded-xl leading-relaxed">
                                <span className="font-black">Jak zaimportować dane:</span>
                                <ol className="list-decimal pl-4 mt-1.5 space-y-1">
                                    <li>Wejdź w swój Arkusz Google.</li>
                                    <li>Wybierz <span className="font-bold">Plik ➔ Pobierz ➔ Wartości rozdzielane przecinkami (.csv)</span> - osobno dla zakładki <strong>Pojazdy</strong> i <strong>Naprawy</strong>.</li>
                                    <li>Otwórz pobrany plik CSV za pomocą zwykłego Notatnika (lub TextEdit), skopiuj całą zawartość i wklej w odpowiednie pola poniżej.</li>
                                </ol>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-black text-slate-500 uppercase mb-1">1. Dane z zakładki POJAZDY (CSV)</label>
                                    <textarea
                                        rows={8}
                                        placeholder="ID POJAZDU,MARKA,MODEL,ROK,REJESTRACJA..."
                                        value={vehiclesCsv}
                                        onChange={e => setVehiclesCsv(e.target.value)}
                                        className="w-full p-2.5 bg-slate-50 border rounded-lg font-mono text-[10px] outline-none focus:border-emerald-500 resize-none"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-black text-slate-500 uppercase mb-1">2. Dane z zakładki NAPRAWY (CSV)</label>
                                    <textarea
                                        rows={8}
                                        placeholder="ID NAPRAWY,ID POJAZDU,DATA NAPRAWY,KOSZT,NR KSIĘGOWY..."
                                        value={repairsCsv}
                                        onChange={e => setRepairsCsv(e.target.value)}
                                        className="w-full p-2.5 bg-slate-50 border rounded-lg font-mono text-[10px] outline-none focus:border-emerald-500 resize-none"
                                    />
                                </div>
                            </div>

                            <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl mt-4">
                                <label className="block text-xs font-black text-blue-800 uppercase mb-2">3. Masowy Import Skanów Faktur (Po wgraniu CSV)</label>
                                <p className="text-[10px] text-blue-600 mb-3">Zaznacz na dysku wszystkie pliki typu <b>"Naprawa_X.pdf"</b>. System sam przypisze je do odpowiednich napraw w bazie.</p>

                                {isBulkUploading ? (
                                    <div className="bg-blue-600 text-white font-bold p-3 rounded-lg text-center animate-pulse text-xs">
                                        {bulkUploadProgress}
                                    </div>
                                ) : (
                                    <input
                                        type="file"
                                        multiple
                                        accept=".pdf,.jpg,.jpeg,.png"
                                        onChange={handleBulkUploadInvoices}
                                        className="block w-full text-xs text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-blue-600 file:text-white hover:file:bg-blue-700 cursor-pointer"
                                    />
                                )}
                            </div>

                            {/* KROK 4: MASOWY AUTOMAT UZUPEŁNIANIA DANYCH AI (MIGRACJA) */}
                            <div className="p-4 bg-purple-50 border border-purple-200 rounded-xl mt-4 space-y-3">
                                <div className="flex justify-between items-center">
                                    <div>
                                        <label className="block text-xs font-black text-purple-800 uppercase">4. Inteligentne Uzupełnianie Bazy przez AI</label>
                                        <p className="text-[10px] text-purple-600 font-bold">Zaktualizuj opisy prac, części oraz poprawny typ usterki na podstawie wgranych wcześniej skanów faktur PDF.</p>
                                    </div>
                                    {!isProcessingEnrich && (
                                        <button
                                            type="button"
                                            onClick={handleStartEnrichment}
                                            className="bg-purple-600 hover:bg-purple-700 text-white font-black text-[10px] uppercase tracking-wider px-4 py-2.5 rounded-lg shadow-sm transition"
                                        >
                                            Uruchom Automat AI
                                        </button>
                                    )}
                                </div>

                                {isProcessingEnrich && (
                                    <div className="space-y-1 animate-pulse">
                                        <div className="flex justify-between text-[10px] font-bold text-purple-800">
                                            <span>Trwa analiza faktur przez Gemini 3...</span>
                                            <span>{enrichIndex} / {enrichTotal}</span>
                                        </div>
                                        <div className="w-full bg-purple-100 h-2 rounded-full overflow-hidden">
                                            <div
                                                className="bg-purple-600 h-full transition-all duration-300 rounded-full"
                                                style={{ width: `${enrichTotal > 0 ? (enrichIndex / enrichTotal) * 100 : 0}%` }}
                                            ></div>
                                        </div>
                                    </div>
                                )}

                                {enrichLogs.length > 0 && (
                                    <div className="bg-slate-900 text-slate-200 p-3 rounded-xl font-mono text-[10px] h-32 overflow-y-auto space-y-1 shadow-inner border border-slate-800">
                                        {enrichLogs.map((log, idx) => (
                                            <div key={idx} className={log.includes("❌") ? "text-red-400" : log.includes("✅") ? "text-emerald-400" : ""}>
                                                {log}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="flex gap-3 pt-4 border-t">
                                <button type="button" onClick={() => setIsImportModalOpen(false)} className="px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition w-1/3">
                                    Anuluj
                                </button>
                                <button
                                    onClick={handleImportCSV}
                                    disabled={isSubmitting || !vehiclesCsv.trim()}
                                    className="px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl shadow-md transition w-2/3 disabled:opacity-50"
                                >
                                    {isSubmitting ? "Przetwarzanie..." : "Rozpocznij Masowy Import"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}