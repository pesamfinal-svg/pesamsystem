"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { collection, getDocs, addDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "@/lib/firebase/config";
import { useAuth } from "@/lib/auth/AuthContext";

interface Site {
  id: string;
  name: string;
  status?: string;
  location?: string;
  managerName?: string;
}

interface Accessory {
  id?: string;
  name: string;
  quantity: number;
  mustReturn: boolean;
}

interface InventoryItem {
  id: string;
  name: string;
  type: "UNIQUE" | "BULK";
  subType?: "MAIN_CAT" | "SUB_ITEM" | "MANUAL";
  inventoryNumber?: string;
  category?: string;
  unit?: string;
  status?: string;
  allocations: Record<string, number>;
  accessories?: Accessory[];
}

interface ReturnedAccessoryState {
  name: string;
  quantity: number;
  mustReturn: boolean;
  isReturning: boolean;
}

interface ManagerUser {
  uid: string;
  name: string;
  email?: string;
  assignedSites?: string[];
  canReturn: boolean;
}

export default function PlacProtokolPage() {
  const { user } = useAuth();
  const router = useRouter();

  // Data fetching states
  const [sites, setSites] = useState<Site[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [availableManagers, setAvailableManagers] = useState<ManagerUser[]>([]);
  const [loading, setLoading] = useState(true);

  // Form selections
  const [selectedSiteId, setSelectedSiteId] = useState<string>("");
  const [filterTab, setFilterTab] = useState<"ALL" | "UNIQUE" | "BULK">("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedManagerUids, setSelectedManagerUids] = useState<string[]>([]);

  // Checkbox selections for equipment on site
  // For UNIQUE: boolean (checked/unchecked)
  const [selectedUnique, setSelectedUnique] = useState<Record<string, boolean>>({});
  // For BULK: quantity to return (0 means not returning)
  const [selectedBulkQty, setSelectedBulkQty] = useState<Record<string, number>>({});
  // For accessories: itemId -> accessoryIndex -> isReturning
  const [selectedAccessories, setSelectedAccessories] = useState<Record<string, Record<number, boolean>>>({});

  // Audio recording states
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);

  // MediaRecorder refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Submission flow states
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStep, setSubmitStep] = useState<string>("");
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [transcribedResiduals, setTranscribedResiduals] = useState<any[]>([]);

  // 1. Fetch sites, inventory & managers based on protocolsReturnApp permission
  useEffect(() => {
    async function loadData() {
      try {
        setLoading(true);
        const [sitesSnap, invSnap, rolesSnap, usersSnap] = await Promise.all([
          getDocs(collection(db, "sites")),
          getDocs(collection(db, "inventory")),
          getDocs(collection(db, "roles")),
          getDocs(collection(db, "users"))
        ]);

        const loadedSites: Site[] = sitesSnap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter(s => s.status !== "ZAKOŃCZONA")
          .sort((a, b) => a.name.localeCompare(b.name, "pl"));

        const loadedInventory: InventoryItem[] = invSnap.docs.map(d => ({
          id: d.id,
          ...(d.data() as any)
        }));

        // Słownik uprawnień ról
        const rolesMap: Record<string, Record<string, boolean>> = {};
        rolesSnap.docs.forEach(d => {
          rolesMap[d.id] = d.data().permissions || {};
        });

        // Użytkownicy z uprawnieniem 'protocolsReturnApp' (Protokoły: Zwrot elektroniczny)
        const loadedManagers: ManagerUser[] = usersSnap.docs
          .map(d => {
            const data = d.data();
            const overrides = data.permissionOverrides || {};
            const rolePerms = (data.roleId && rolesMap[data.roleId]) || {};

            let canReturn = false;
            if ("protocolsReturnApp" in overrides) {
              canReturn = !!overrides.protocolsReturnApp;
            } else if (data.roleId && rolesMap[data.roleId]) {
              canReturn = !!rolePerms.protocolsReturnApp;
            } else if (data.roleName?.toLowerCase().includes("kierownik") || data.role?.toLowerCase().includes("kierownik")) {
              canReturn = true;
            }

            const name = `${data.firstName || ""} ${data.lastName || ""}`.trim() || data.email || "Kierownik";
            return {
              uid: d.id,
              name,
              email: data.email,
              assignedSites: data.assignedSites || [],
              canReturn
            };
          })
          .filter(u => u.canReturn)
          .sort((a, b) => a.name.localeCompare(b.name, "pl"));

        setSites(loadedSites);
        setInventory(loadedInventory);
        setAvailableManagers(loadedManagers);
      } catch (err: any) {
        console.error("Błąd ładowania danych dla protokołu:", err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  // Update selected managers and reset items when site is chosen
  useEffect(() => {
    if (!selectedSiteId) {
      setSelectedManagerUids([]);
      return;
    }

    // Auto-zaznacz kierowników przypisanych do tej budowy (jeśli są tacy)
    const siteManagers = availableManagers
      .filter(m => m.assignedSites && (m.assignedSites.includes("ALL") || m.assignedSites.includes(selectedSiteId)))
      .map(m => m.uid);

    setSelectedManagerUids(siteManagers);

    // Reset selections on site change
    setSelectedUnique({});
    setSelectedBulkQty({});
    setSelectedAccessories({});
  }, [selectedSiteId, availableManagers]);

  // Clean up audio blob URL on unmount
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    };
  }, [audioUrl]);

  // Filter inventory for the selected site
  const siteEquipment = useMemo(() => {
    if (!selectedSiteId) return [];
    return inventory.filter(item => {
      const qtyOnSite = item.allocations?.[selectedSiteId] || 0;
      return qtyOnSite > 0;
    });
  }, [inventory, selectedSiteId]);

  // Filter by tab and search
  const displayedEquipment = useMemo(() => {
    return siteEquipment.filter(item => {
      if (filterTab === "UNIQUE" && item.type !== "UNIQUE") return false;
      if (filterTab === "BULK" && item.type !== "BULK") return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = (item.name || "").toLowerCase().includes(q);
        const matchesInv = (item.inventoryNumber || "").toLowerCase().includes(q);
        if (!matchesName && !matchesInv) return false;
      }
      return true;
    });
  }, [siteEquipment, filterTab, searchQuery]);

  // Audio recording handlers
  const startRecording = async () => {
    setRecordingError(null);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Twoja przeglądarka nie obsługuje nagrywania dźwięku.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];

      // Detect supported mimeType
      let mimeType = "audio/webm";
      if (!MediaRecorder.isTypeSupported("audio/webm")) {
        if (MediaRecorder.isTypeSupported("audio/mp4")) mimeType = "audio/mp4";
        else if (MediaRecorder.isTypeSupported("audio/ogg")) mimeType = "audio/ogg";
      }

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        setAudioBlob(blob);
        const newUrl = URL.createObjectURL(blob);
        setAudioUrl(newUrl);

        // Stop all audio tracks to release microphone
        stream.getTracks().forEach(track => track.stop());
      };

      recorder.start(500); // chunk every 500ms
      setIsRecording(true);
      setRecordingSeconds(0);

      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = setInterval(() => {
        setRecordingSeconds(prev => prev + 1);
      }, 1000);

    } catch (err: any) {
      console.error("Błąd dostępu do mikrofonu:", err);
      setRecordingError(err.message || "Brak dostępu do mikrofonu.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  };

  const resetRecording = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null);
    setAudioUrl(null);
    setRecordingSeconds(0);
    setRecordingError(null);
  };

  const formatSeconds = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  // Toggle accessory return status
  const handleToggleAccessory = (itemId: string, accIndex: number, currentVal: boolean) => {
    setSelectedAccessories(prev => ({
      ...prev,
      [itemId]: {
        ...(prev[itemId] || {}),
        [accIndex]: !currentVal
      }
    }));
  };

  // Calculate summary counts
  const totalUniqueChecked = useMemo(() => {
    return Object.values(selectedUnique).filter(Boolean).length;
  }, [selectedUnique]);

  const totalBulkChecked = useMemo(() => {
    return Object.values(selectedBulkQty).filter(qty => qty > 0).length;
  }, [selectedBulkQty]);

  const totalItemsCount = totalUniqueChecked + totalBulkChecked;
  const canSubmit = selectedSiteId && (totalItemsCount > 0 || audioBlob !== null);

  // SUBMIT FLOW:
  // 1. Upload audio to Firebase Storage
  // 2. Transcribe residuals via AI (/api/parse-audio-residuals)
  // 3. Save protocol document to Firestore with status: "SZKIC_KIEROWCY"
  const handleSubmitProtocol = async () => {
    if (!selectedSiteId) {
      alert("Proszę wybrać budowę!");
      return;
    }

    if (totalItemsCount === 0 && !audioBlob) {
      alert("Wybierz przynajmniej jedno urządzenie do zwrotu lub nagraj notatkę głosową!");
      return;
    }

    setIsSubmitting(true);
    setSubmitStep("Inicjalizacja wysyłania protokołu...");

    try {
      const selectedSite = sites.find(s => s.id === selectedSiteId);
      const siteName = selectedSite?.name || "Nieznana budowa";
      const driverFullName = user?.firstName && user?.lastName 
        ? `${user.firstName} ${user.lastName}` 
        : (user?.firstName || "Kierowca");

      let uploadedAudioUrl: string | null = null;
      let parsedResiduals: any[] = [];

      // KROK 1 & 2: Obsługa nagrania audio i transkrypcji AI
      if (audioBlob) {
        setSubmitStep("Wysyłanie nagrania audio do serwera...");
        const timestamp = Date.now();
        const storagePath = `protocol_audio_drafts/${selectedSiteId}_${user?.uid || "driver"}_${timestamp}.webm`;
        const storageRef = ref(storage, storagePath);

        await uploadBytes(storageRef, audioBlob);
        uploadedAudioUrl = await getDownloadURL(storageRef);

        setSubmitStep("🤖 AI analizuje nagranie (wyciąganie resztek budowlanych)...");
        try {
          const aiResponse = await fetch("/api/parse-audio-residuals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audioUrl: uploadedAudioUrl })
          });

          if (aiResponse.ok) {
            const aiData = await aiResponse.json();
            if (aiData.residuals && Array.isArray(aiData.residuals)) {
              parsedResiduals = aiData.residuals;
              setTranscribedResiduals(aiData.residuals);
            }
          } else {
            console.warn("AI parse residuals returned non-200 status");
          }
        } catch (aiErr) {
          console.error("Błąd podczas wywołania AI parse-audio-residuals:", aiErr);
          // Nie blokujemy wysyłki protokołu, kierownik otrzyma szkic bez wstępnego parsowania
        }
      }

      // KROK 3: Przygotowanie listy zwracanego sprzętu
      setSubmitStep("Zapisywanie protokołu w systemie...");
      const finalItems: any[] = [];

      // Pozycje UNIQUE
      siteEquipment.forEach(item => {
        if (item.type === "UNIQUE" && selectedUnique[item.id]) {
          const itemAccessories: ReturnedAccessoryState[] = (item.accessories || []).map((acc, idx) => {
            const isChecked = selectedAccessories[item.id]?.[idx] ?? acc.mustReturn; // domyślnie zaznaczony jeśli mustReturn
            return {
              name: acc.name,
              quantity: acc.quantity || 1,
              mustReturn: acc.mustReturn,
              isReturning: isChecked
            };
          });

          finalItems.push({
            inventoryId: item.id,
            name: item.name,
            type: "UNIQUE",
            inventoryNumber: item.inventoryNumber || "",
            returnQty: 1,
            declaredQty: 1,
            declaredStatus: "sprawne",
            unit: item.unit || "szt.",
            accessories: itemAccessories
          });
        }
      });

      // Pozycje BULK
      siteEquipment.forEach(item => {
        if (item.type === "BULK") {
          const qty = selectedBulkQty[item.id] || 0;
          if (qty > 0) {
            finalItems.push({
              inventoryId: item.id,
              name: item.name,
              type: "BULK",
              inventoryNumber: item.inventoryNumber || "",
              returnQty: qty,
              declaredQty: qty,
              declaredStatus: "sprawne",
              unit: item.unit || "szt.",
              accessories: []
            });
          }
        }
      });

      const selectedManagerNames = availableManagers
        .filter(m => selectedManagerUids.includes(m.uid))
        .map(m => m.name);

      // KROK 4: Zapis do Firestore w kolekcji protocols
      const protocolDocData = {
        type: "ZWROT",
        status: "SZKIC_KIEROWCY",
        documentSource: "KIEROWCA",
        sourceId: selectedSiteId,
        sourceName: siteName,
        destinationId: "MAGAZYN",
        destinationName: "MAGAZYN GŁÓWNY",
        driverUid: user?.uid || "",
        driverName: driverFullName,
        targetManagerUids: selectedManagerUids,
        targetManagerNames: selectedManagerNames,
        targetManagerName: selectedManagerNames.join(", ") || null,
        createdAt: new Date().toISOString(),
        documentDate: new Date().toISOString().split("T")[0],
        audioNoteUrl: uploadedAudioUrl,
        residuals: parsedResiduals,
        items: finalItems
      };

      await addDoc(collection(db, "protocols"), protocolDocData);

      setSubmitSuccess(true);
    } catch (err: any) {
      console.error("Błąd podczas zapisywania protokołu:", err);
      alert("Wystąpił błąd podczas wysyłania: " + (err.message || err));
    } finally {
      setIsSubmitting(false);
    }
  };

  // EKRAN SUKCESU
  if (submitSuccess) {
    const selectedSite = sites.find(s => s.id === selectedSiteId);
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col justify-center items-center p-6 text-center animate-fade-in font-sans">
        <div className="w-full max-w-md rounded-3xl border border-emerald-500/40 bg-slate-900/90 p-8 shadow-2xl space-y-6">
          <div className="text-6xl animate-bounce" aria-hidden="true">
            ✅
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-black text-emerald-400">
              Protokół został wysłany!
            </h1>
            <p className="text-sm text-slate-300">
              Szkic zwrotu dla budowy{" "}
              <span className="font-bold text-amber-400">
                {selectedSite?.name || "wybranej budowy"}
              </span>{" "}
              został przekazany do Kierownika.
            </p>
          </div>

          {/* Podsumowanie AI resztek jeśli były */}
          {transcribedResiduals.length > 0 && (
            <div className="rounded-2xl border border-purple-500/30 bg-purple-950/40 p-4 text-left space-y-2">
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-purple-300">
                <span>🤖 AI rozpoznało z nagrania ({transcribedResiduals.length} poz.):</span>
              </div>
              <ul className="text-xs text-slate-200 space-y-1">
                {transcribedResiduals.map((r, i) => (
                  <li key={i} className="flex items-center justify-between border-b border-purple-900/40 pb-1">
                    <span>• {r.name}</span>
                    <span className="font-bold text-purple-300">{r.quantity} {r.unit} {r.isWaste ? "(odpad)" : ""}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="pt-2">
            <Link
              href="/plac"
              className="w-full block py-4 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 font-black text-base shadow-lg transition active:scale-95"
            >
              Wróć do menu głównego
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none pb-28">
      {/* Sticky Header */}
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900/95 backdrop-blur shadow-xl">
        <div className="max-w-xl mx-auto w-full px-4 py-3 flex items-center justify-between gap-3">
          <Link
            href="/plac"
            className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-300 hover:bg-slate-700 active:scale-95 transition min-h-[40px]"
          >
            <span>←</span>
            <span>Wróć</span>
          </Link>

          <div className="min-w-0 text-center flex-1">
            <h1 className="text-base font-black tracking-wider text-purple-400 leading-tight uppercase flex items-center justify-center gap-1.5">
              <span>📋</span>
              <span>Wypisz Protokół</span>
            </h1>
            <p className="text-[10px] font-bold text-slate-400 tracking-wide leading-tight truncate">
              Mobilny szkic zwrotu sprzętu i materiałów
            </p>
          </div>

          <div className="shrink-0 text-right">
            <span className="text-[10px] font-mono text-slate-400 block">Kierowca:</span>
            <span className="text-xs font-bold text-slate-200 block truncate max-w-[90px]">
              {user?.firstName || "Kierowca"}
            </span>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-xl mx-auto w-full p-4 flex-1 space-y-4">
        {/* KROK 1: Wybór Budowy */}
        <section className="rounded-3xl border border-purple-500/30 bg-gradient-to-br from-purple-950/20 via-slate-900 to-slate-950 p-4 shadow-lg space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-black tracking-wider text-purple-400 uppercase flex items-center gap-1.5">
              <span>1️⃣</span>
              <span>Wybierz Budowę (Skąd zabierasz)</span>
            </label>
            {selectedSiteId && (
              <span className="text-[10px] bg-purple-900/60 text-purple-300 px-2 py-0.5 rounded-full font-bold">
                Sprzęt na budowie: {siteEquipment.length}
              </span>
            )}
          </div>

          {loading ? (
            <div className="p-4 text-center text-xs text-slate-400 animate-pulse">
              Ładowanie listy budów...
            </div>
          ) : (
            <select
              value={selectedSiteId}
              onChange={(e) => setSelectedSiteId(e.target.value)}
              className="w-full p-3.5 rounded-2xl border-2 border-purple-500/40 bg-slate-900 text-white font-bold text-sm outline-none focus:border-purple-400 transition cursor-pointer shadow-inner"
            >
              <option value="" disabled>-- Wybierz budowę / cel zwrotu --</option>
              {sites.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.managerName ? `(Kierownik: ${s.managerName})` : ""}
                </option>
              ))}
            </select>
          )}

          {selectedSiteId && (
            <div className="pt-2 space-y-2 border-t border-purple-500/20">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold text-slate-300 uppercase flex items-center gap-1.5">
                  <span>👤</span>
                  <span>Kierownik na budowie (możesz wybrać kilku):</span>
                </label>
                {selectedManagerUids.length > 0 && (
                  <span className="text-[10px] font-black text-purple-300 bg-purple-900/80 px-2 py-0.5 rounded-full border border-purple-700">
                    Wybrano: {selectedManagerUids.length}
                  </span>
                )}
              </div>

              {availableManagers.length === 0 ? (
                <p className="text-xs text-slate-400 italic p-2 bg-slate-900 rounded-xl">
                  Brak w systemie osób z uprawnieniem do wystawiania zwrotów elektronicznych.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2 max-h-52 overflow-y-auto pr-1">
                  {availableManagers.map(m => {
                    const isSelected = selectedManagerUids.includes(m.uid);
                    return (
                      <button
                        key={m.uid}
                        type="button"
                        onClick={() => {
                          setSelectedManagerUids(prev =>
                            prev.includes(m.uid) ? prev.filter(id => id !== m.uid) : [...prev, m.uid]
                          );
                        }}
                        className={`p-2.5 rounded-xl border text-left text-xs font-bold transition flex items-center justify-between gap-1.5 active:scale-95 ${
                          isSelected
                            ? "bg-purple-600 text-white border-purple-400 shadow-md"
                            : "bg-slate-900 text-slate-300 border-slate-700 hover:border-slate-500"
                        }`}
                      >
                        <span className="truncate">{m.name}</span>
                        <span className={`text-xs shrink-0 ${isSelected ? "text-white font-black" : "text-slate-500"}`}>
                          {isSelected ? "✓" : "+"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>

        {/* KROK 2: Lista Sprzętu na Wybranej Budowie */}
        {selectedSiteId && (
          <section className="rounded-3xl border border-slate-800 bg-slate-900/90 p-4 shadow-lg space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-black tracking-wider text-amber-400 uppercase flex items-center gap-1.5">
                <span>2️⃣</span>
                <span>Sprzęt na budowie (Zaznacz co zabierasz)</span>
              </label>
              <span className="text-[11px] font-black text-emerald-400">
                Wybrano: {totalItemsCount}
              </span>
            </div>

            {/* Zakładki filtrów & Wyszukiwarka */}
            <div className="space-y-2">
              <div className="flex gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800">
                <button
                  type="button"
                  onClick={() => setFilterTab("ALL")}
                  className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition ${
                    filterTab === "ALL"
                      ? "bg-amber-500 text-slate-950 shadow"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  Wszystko ({siteEquipment.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterTab("UNIQUE")}
                  className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition ${
                    filterTab === "UNIQUE"
                      ? "bg-amber-500 text-slate-950 shadow"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  Narzędzia ({siteEquipment.filter(i => i.type === "UNIQUE").length})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterTab("BULK")}
                  className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition ${
                    filterTab === "BULK"
                      ? "bg-amber-500 text-slate-950 shadow"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  Masowe ({siteEquipment.filter(i => i.type === "BULK").length})
                </button>
              </div>

              <input
                type="text"
                placeholder="🔍 Szukaj sprzętu po nazwie lub nr inwentarzowym..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full p-2.5 rounded-xl border border-slate-700 bg-slate-950 text-xs text-slate-200 outline-none focus:border-amber-400"
              />
            </div>

            {/* Lista elementów */}
            {displayedEquipment.length === 0 ? (
              <div className="text-center p-8 text-slate-500 text-xs">
                {searchQuery ? "Brak wyników dla podanej frazy." : "Brak zarejestrowanego sprzętu na tej budowie."}
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[480px] overflow-y-auto pr-1">
                {displayedEquipment.map((item) => {
                  const qtyOnSite = item.allocations?.[selectedSiteId] || 0;
                  const isUnique = item.type === "UNIQUE";
                  const isCheckedUnique = selectedUnique[item.id] || false;
                  const currentBulkQty = selectedBulkQty[item.id] || 0;
                  const isItemChosen = isUnique ? isCheckedUnique : currentBulkQty > 0;

                  return (
                    <div
                      key={item.id}
                      className={`p-3.5 rounded-2xl border transition ${
                        isItemChosen
                          ? "border-amber-400/80 bg-amber-950/20 shadow-md"
                          : "border-slate-800 bg-slate-950/60 hover:border-slate-700"
                      }`}
                    >
                      {/* Nagłówek elementu */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-bold text-sm text-slate-100">
                              {item.name}
                            </span>
                            {item.inventoryNumber && (
                              <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-amber-300 font-bold">
                                #{item.inventoryNumber}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            Na budowie: <strong className="text-slate-200">{qtyOnSite} {item.unit || "szt."}</strong>
                          </p>
                        </div>

                        {/* Akcja wyboru: Checkbox dla UNIQUE, Stepper dla BULK */}
                        {isUnique ? (
                          <label className="flex items-center gap-2 cursor-pointer shrink-0 select-none bg-slate-900 border border-slate-700 px-3 py-2 rounded-xl active:scale-95 transition">
                            <input
                              type="checkbox"
                              checked={isCheckedUnique}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setSelectedUnique(prev => ({ ...prev, [item.id]: checked }));
                                // Inicjalizacja domyślnego zaznaczenia osprzętu
                                if (checked && item.accessories && item.accessories.length > 0) {
                                  const accState: Record<number, boolean> = {};
                                  item.accessories.forEach((a, idx) => {
                                    accState[idx] = a.mustReturn; // mustReturn domyślnie zaznaczony
                                  });
                                  setSelectedAccessories(prev => ({ ...prev, [item.id]: accState }));
                                }
                              }}
                              className="w-5 h-5 rounded text-amber-500 focus:ring-amber-400 border-slate-600 bg-slate-800 cursor-pointer"
                            />
                            <span className={`text-xs font-black ${isCheckedUnique ? "text-amber-400" : "text-slate-400"}`}>
                              {isCheckedUnique ? "Zabrane" : "Zabieram"}
                            </span>
                          </label>
                        ) : (
                          <div className="flex items-center gap-1.5 shrink-0 bg-slate-900 border border-slate-700 p-1 rounded-xl">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedBulkQty(prev => ({
                                  ...prev,
                                  [item.id]: Math.max(0, (prev[item.id] || 0) - 1)
                                }));
                              }}
                              className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-black text-sm flex items-center justify-center active:scale-90 transition"
                            >
                              -
                            </button>
                            <input
                              type="number"
                              min={0}
                              max={qtyOnSite}
                              value={currentBulkQty || ""}
                              placeholder="0"
                              onChange={(e) => {
                                const val = Math.min(qtyOnSite, Math.max(0, Number(e.target.value) || 0));
                                setSelectedBulkQty(prev => ({ ...prev, [item.id]: val }));
                              }}
                              className="w-12 text-center bg-transparent text-sm font-black text-amber-400 outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedBulkQty(prev => ({
                                  ...prev,
                                  [item.id]: Math.min(qtyOnSite, (prev[item.id] || 0) + 1)
                                }));
                              }}
                              className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-black text-sm flex items-center justify-center active:scale-90 transition"
                            >
                              +
                            </button>
                          </div>
                        )}
                      </div>

                      {/* SEKCJA OSPRZĘTU DLA WYBRANEJ MASZYNY */}
                      {isUnique && isCheckedUnique && item.accessories && item.accessories.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-slate-800/80 space-y-2">
                          <p className="text-[10px] font-black uppercase tracking-wider text-purple-400 flex items-center gap-1">
                            <span>📦</span>
                            <span>Osprzęt do tego urządzenia (odhacz co wraca):</span>
                          </p>
                          <div className="space-y-1.5">
                            {item.accessories.map((acc, accIdx) => {
                              const isAccChecked = selectedAccessories[item.id]?.[accIdx] ?? acc.mustReturn;
                              return (
                                <label
                                  key={accIdx}
                                  className={`flex items-center justify-between p-2 rounded-xl border text-xs cursor-pointer transition ${
                                    isAccChecked
                                      ? "bg-purple-950/30 border-purple-500/40 text-slate-200"
                                      : "bg-slate-900/60 border-slate-800 text-slate-500 line-through"
                                  }`}
                                >
                                  <div className="flex items-center gap-2">
                                    <input
                                      type="checkbox"
                                      checked={isAccChecked}
                                      onChange={() => handleToggleAccessory(item.id, accIdx, isAccChecked)}
                                      className="w-4 h-4 rounded text-purple-500 focus:ring-purple-400 border-slate-600 bg-slate-800 cursor-pointer"
                                    />
                                    <span className="font-semibold">{acc.name}</span>
                                    {acc.quantity && acc.quantity > 1 && (
                                      <span className="text-[10px] text-slate-400 font-mono">({acc.quantity} szt.)</span>
                                    )}
                                  </div>
                                  {acc.mustReturn && (
                                    <span className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-red-950/80 text-red-400 border border-red-800/60">
                                      ⚠️ Musi wrócić
                                    </span>
                                  )}
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* KROK 3: Resztki Budowlane - Notatka Głosowa (AI) */}
        {selectedSiteId && (
          <section className="rounded-3xl border border-blue-500/30 bg-gradient-to-br from-blue-950/20 via-slate-900 to-slate-950 p-4 shadow-lg space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-black tracking-wider text-blue-400 uppercase flex items-center gap-1.5">
                <span>3️⃣</span>
                <span>Resztki Budowlane i Odpady (Nagranie AI)</span>
              </label>
              <span className="text-[10px] bg-blue-900/60 text-blue-300 px-2 py-0.5 rounded-full font-bold">
                Auto-transkrypcja AI
              </span>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              Nie musisz nic pisać! Wciśnij mikrofon i powiedz co zabierasz (np. <em>&quot;dwa worki kleju do siatki, 5 profili 3m, wiaderko gruntu, ścinki kabli&quot;</em>).
              Kierownik otrzyma od razu gotową, wyczyszczoną listę pozycji.
            </p>

            {recordingError && (
              <div className="p-3 rounded-xl bg-red-950/80 border border-red-800 text-red-300 text-xs">
                ⚠️ {recordingError}
              </div>
            )}

            {/* Stan nagrywania */}
            <div className="flex flex-col items-center justify-center p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-3">
              {isRecording ? (
                // Trwa nagrywanie
                <div className="w-full text-center space-y-3">
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-950/80 border border-red-700 text-red-400 animate-pulse">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
                    <span className="text-xs font-black uppercase tracking-wider">Nagrywanie w toku...</span>
                  </div>

                  <div className="text-3xl font-mono font-black text-white">
                    {formatSeconds(recordingSeconds)}
                  </div>

                  <button
                    type="button"
                    onClick={stopRecording}
                    className="w-full py-3.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-black text-sm shadow-lg active:scale-95 transition flex items-center justify-center gap-2"
                  >
                    <span>⏹️</span>
                    <span>Zatrzymaj nagrywanie</span>
                  </button>
                </div>
              ) : audioUrl ? (
                // Nagranie gotowe
                <div className="w-full space-y-3">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span className="font-bold text-emerald-400 flex items-center gap-1">
                      <span>✓</span>
                      <span>Nagranie gotowe do wysłania</span>
                    </span>
                    <span className="font-mono">{formatSeconds(recordingSeconds)}</span>
                  </div>

                  <audio src={audioUrl} controls className="w-full rounded-lg" />

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={startRecording}
                      className="flex-1 py-2.5 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200 transition"
                    >
                      🔄 Nagraj ponownie
                    </button>
                    <button
                      type="button"
                      onClick={resetRecording}
                      className="py-2.5 px-4 rounded-xl border border-red-900/60 bg-red-950/40 hover:bg-red-900/60 text-xs font-bold text-red-400 transition"
                    >
                      🗑️ Usuń
                    </button>
                  </div>
                </div>
              ) : (
                // Czeka na nagranie
                <div className="w-full text-center space-y-2">
                  <button
                    type="button"
                    onClick={startRecording}
                    className="w-full py-4 rounded-2xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white font-black text-sm shadow-xl active:scale-95 transition flex items-center justify-center gap-2 min-h-[56px]"
                  >
                    <span className="text-xl">🎙️</span>
                    <span>NAGRAJ RESZTKI BUDOWLANE</span>
                  </button>
                  <p className="text-[11px] text-slate-500">
                    Kliknij i wymień pozostałości materiałowe
                  </p>
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      {/* Floating Bottom Bar: Podsumowanie & Wysyłka */}
      <footer className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-800 bg-slate-900/95 backdrop-blur shadow-2xl p-3">
        <div className="max-w-xl mx-auto w-full space-y-2">
          {/* Submitting progress status */}
          {isSubmitting && (
            <div className="p-3 rounded-2xl bg-purple-950/90 border border-purple-600 text-center space-y-1 animate-pulse">
              <div className="text-xs font-black text-purple-300">
                ⏳ {submitStep}
              </div>
              <p className="text-[10px] text-slate-400">
                Proszę nie zamykać aplikacji, trwa wysyłanie...
              </p>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold text-slate-400 uppercase">
                Podsumowanie:
              </div>
              <div className="text-xs font-black text-white truncate">
                {selectedSiteId ? (
                  <>
                    <span className="text-amber-400">{totalItemsCount}</span> poz. sprzętu
                    {audioBlob ? " · 🎙️ Notatka audio" : ""}
                  </>
                ) : (
                  <span className="text-slate-500">Wybierz budowę powyżej</span>
                )}
              </div>
            </div>

            <button
              type="button"
              disabled={!canSubmit || isSubmitting}
              onClick={handleSubmitProtocol}
              className="py-3.5 px-6 rounded-2xl bg-gradient-to-r from-purple-600 via-fuchsia-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-600 font-black text-sm text-white shadow-xl active:scale-95 transition flex items-center gap-2 min-h-[50px] shrink-0"
            >
              <span>🚀</span>
              <span>{isSubmitting ? "WYSYŁANIE..." : "WYŚLIJ PROTOKÓŁ"}</span>
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
