"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth/AuthContext";
import { hasPermission } from "@/lib/auth/permissions";
import { useRouter } from "next/navigation";

// ─── TYPY DANYCH DLA KOSZTORYSOWANIA ─────────────────────────────────────────

interface EstimateItem {
    id: string;
    code?: string;
    name: string;
    type: "R" | "M" | "S"; // Robocizna, Materiał, Sprzęt
    quantity: number;
    unit: string;
    basePrice: number; // Cena bezpośrednia (Direct)
    unitPrice: number; // Korygowana cena
}

interface EstimateSection {
    id: string;
    name: string; // np. "Dział 1. Roboty ziemne i przygotowawcze"
    items: EstimateItem[];
}

interface ProjectInfo {
    name: string;
    length: string;
    width: string;
    depthHeight: string;
    soilType: string;
    additionalNotes: string;
}

interface MarketTrends {
    laborAdjustment: number;
    materialAdjustment: number;
    equipmentAdjustment: number;
    kp: number;
    zysk: number;
}

export default function EstimatorPage() {
    const { user } = useAuth();
    const router = useRouter();

    // ── Zabezpieczenie Uprawnień ──
    const canUseEstimator = hasPermission("useEstimatingPanel", user?.rolePermissions, user?.permissionOverrides);

    useEffect(() => {
        if (canUseEstimator === false) {
            alert("Brak uprawnień do profesjonalnego panelu kosztorysowania.");
            router.push("/dashboard/shop");
        }
    }, [canUseEstimator, router]);

    // ── Główne Parametry Przedmiaru ──
    const [project, setProject] = useState<ProjectInfo>({
        name: "Budowa Przedszkola Samorządowego",
        length: "40.0",
        width: "25.0",
        depthHeight: "1.20",
        soilType: "Grunt średni (kat. III)",
        additionalNotes: "Zbrojenie dołem i górą siatką fi 12, podbudowa z chudego betonu 10cm"
    });

    // ── Suwaki i Wycena Rynkowa (Narzuty) ──
    const [trends, setTrends] = useState<MarketTrends>({
        laborAdjustment: -5,
        materialAdjustment: 12,
        equipmentAdjustment: 3,
        kp: 65,
        zysk: 12
    });

    // ── Struktura Działów Przedmiarowych (RMS) ──
    const [sections, setSections] = useState<EstimateSection[]>([
        {
            id: "sec-1",
            name: "Dział 1. Roboty ziemne i przygotowawcze",
            items: [
                { id: "item-1-1", code: "KNR 2-01 0110-01", name: "Ręczne ścinanie krzaków i poszycia leśnego", type: "R", quantity: 180, unit: "m²", basePrice: 12, unitPrice: 12 },
                { id: "item-1-2", code: "KNR 2-01 0210-02", name: "Roboty ziemne koparką kołową z odwozem", type: "S", quantity: 1200, unit: "m³", basePrice: 28, unitPrice: 28 },
                { id: "item-1-3", code: "KNR 2-01 0510-04", name: "Transport nadmiaru urobku wywrotkami na 10 km", type: "S", quantity: 80, unit: "kurs", basePrice: 150, unitPrice: 150 }
            ]
        },
        {
            id: "sec-2",
            name: "Dział 2. Stan zero (Konstrukcje betonowe i fundamenty)",
            items: [
                { id: "item-2-1", code: "KNR 2-02 0102-02", name: "Zbrojarz - przygotowanie i montaż stali B500SP", type: "R", quantity: 120, unit: "r-g", basePrice: 55, unitPrice: 55 },
                { id: "item-2-2", code: "KNR 2-02 0110-01", name: "Stal zbrojeniowa prętowa fi 12mm", type: "M", quantity: 8400, unit: "kg", basePrice: 4.10, unitPrice: 4.10 },
                { id: "item-2-3", code: "KNR 2-02 0105-04", name: "Beton towarowy konstrukcyjny C25/30 wodoszczelny (np. C30/37 W8)", type: "M", quantity: 145, unit: "m³", basePrice: 390, unitPrice: 390 }
            ]
        }
    ]);

    // ── Stany Czatu i Wgrywania Dokumentacji ──
    const [messages, setMessages] = useState<{ role: 'user' | 'ai'; content: string }[]>([
        { 
            role: 'ai', 
            content: "Cześć! Jestem Twoim Agentem Wyceny i Sprawdzania Ryzyka. Przeciągnij i upuść paczkę ZIP z dokumentacją przetargową lub ślepy kosztorys do pola po lewej stronie, aby automatycznie zbudować strukturę i wycenić projekt." 
        }
    ]);
    const [inputText, setInputText] = useState("");
    const [isLoading, setIsLoading] = useState(false);

    // Stany Drag & Drop
    const [isDragging, setIsDragging] = useState(false);
    const [uploadedFile, setUploadedFile] = useState<File | null>(null);
    const [isUploading, setIsUploading] = useState(false);

    const [activeTab, setActiveTab] = useState<"R" | "M" | "S" | "ALL">("ALL");
    const chatEndRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isLoading]);

    if (!canUseEstimator) return null;

    // ── OBSŁUGA PLIKÓW PRZETARGOWYCH (UPLOAD) ────────────────────────────────

    const handleFileUpload = async (file: File) => {
        setUploadedFile(file);
        setIsUploading(true);
        setIsLoading(true);

        setMessages(prev => [...prev, { 
            role: 'user', 
            content: `Wgrałem plik przetargowy: ${file.name}. Rozpocznij pełną analizę i wycenę.` 
        }]);

        try {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("trends", JSON.stringify(trends));

            const res = await fetch("/api/kosztorysant/upload-parser", {
                method: "POST",
                body: formData,
            });

            if (!res.ok) throw new Error("Błąd podczas analizy pliku");
            const data = await res.json();

            setMessages(prev => [...prev, { 
                role: 'ai', 
                content: data.reply 
            }]);

            if (data.generatedSections && data.generatedSections.length > 0) {
                setSections(data.generatedSections);
            }

        } catch (err) {
            alert("Błąd połączenia z parserem dokumentacji.");
        } finally {
            setIsUploading(false);
            setIsLoading(false);
        }
    };

    // ── METODY OBLICZANIA KOSZTORYSU (TRENDY I NARZUTY) ──────────────────────

    const calculateRowValue = (item: EstimateItem) => {
        let price = item.basePrice;

        if (item.type === "R") {
            price = price * (1 + trends.laborAdjustment / 100);
        } else if (item.type === "M") {
            price = price * (1 + trends.materialAdjustment / 100);
        } else if (item.type === "S") {
            price = price * (1 + trends.equipmentAdjustment / 100);
        }

        const directCost = item.quantity * price;

        if (item.type === "R" || item.type === "S") {
            const kpVal = directCost * (trends.kp / 100);
            const zVal = (directCost + kpVal) * (trends.zysk / 100);
            return directCost + kpVal + zVal;
        }

        return directCost;
    };

    const getEstimateTotals = () => {
        let totalBase = 0;
        let totalMarket = 0;

        sections.forEach(sec => {
            sec.items.forEach(item => {
                totalBase += item.quantity * item.basePrice;
                totalMarket += calculateRowValue(item);
            });
        });

        return { totalBase, totalMarket };
    };

    const { totalBase, totalMarket } = getEstimateTotals();

    // Ręczna modyfikacja ilości/ceny bezpośrednio w tabeli
    const updateItemValue = (sectionId: string, itemId: string, field: "quantity" | "basePrice", value: number) => {
        setSections(prev => prev.map(sec => {
            if (sec.id !== sectionId) return sec;
            return {
                ...sec,
                items: sec.items.map(item => 
                    item.id === itemId ? { ...item, [field]: value } : item
                )
            };
        }));
    };

    // Usunięcie pozycji
    const removeItem = (sectionId: string, itemId: string) => {
        setSections(prev => prev.map(sec => {
            if (sec.id !== sectionId) return sec;
            return { ...sec, items: sec.items.filter(item => item.id !== itemId) };
        }));
    };

    // Obsługa zapytań i korekt inżynieryjnych na czacie
    const handleAskEstimator = async () => {
        if (!inputText.trim()) return;

        const userMsg = inputText;
        setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
        setInputText("");
        setIsLoading(true);

        try {
            const res = await fetch("/api/kosztorysant/rms-engine", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ 
                    request: userMsg, 
                    currentTrends: trends,
                    currentSections: sections
                })
            });

            if (!res.ok) throw new Error("Błąd silnika RMS");
            const data = await res.json();

            setMessages(prev => [...prev, { role: 'ai', content: data.reply }]);

            if (data.generatedSections && data.generatedSections.length > 0) {
                setSections(data.generatedSections);
            }

        } catch (err) {
            alert("Błąd połączenia z silnikiem kosztorysowym.");
        } finally {
            setIsLoading(false);
        }
    };

    const handleLoadTemplate = (type: string) => {
        if (type === "PL_FUNDAMENT") {
            setProject({
                name: "Budowa Przedszkola Samorządowego",
                length: "40.0",
                width: "25.0",
                depthHeight: "1.20",
                soilType: "Grunt średni (kat. III)",
                additionalNotes: "Zbrojenie dołem i górą siatką fi 12, podbudowa z chudego betonu 10cm"
            });
        }
    };

    const exportToCsv = () => {
        const headers = "Kod KNR,Nazwa pozycji,Typ (R/M/S),Ilość,J.m.,Cena bezpośrednia (zł),Wycena rynkowa (zł)\n";
        const rows = sections.flatMap(sec => 
            sec.items.map(i => 
                `"${i.code || ''}","${i.name}","${i.type}",${i.quantity},"${i.unit}",${i.basePrice},${calculateRowValue(i) / i.quantity}`
            )
        ).join("\n");
        const blob = new Blob([headers + rows], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `Wycena_${project.name.replace(/\s+/g, '_')}.csv`);
        link.click();
    };

    return (
        <div className="p-4 md:p-6 max-w-[1800px] mx-auto h-[90vh] flex flex-col relative animate-fade-in overflow-hidden text-slate-800 bg-slate-50">
            
            {/* ── Nagłówek ── */}
            <div className="flex justify-between items-center mb-4 border-b pb-4 bg-white p-4 rounded-3xl shadow-sm">
                <div>
                    <div className="flex items-center gap-2">
                        <span className="text-2xl">📊</span>
                        <h1 className="text-2xl font-black text-slate-800 tracking-tighter uppercase italic leading-none">Zaawansowany Panel Kosztorysowania & Analiz Wyceny</h1>
                    </div>
                    <p className="text-xs text-slate-500 mt-1.5 font-semibold">
                        Projekt: <span className="font-bold text-slate-700">{project.name}</span> · Status: <span className="text-blue-600 font-black">PROGNOZOWANIE RMS 2026/2027</span>
                    </p>
                </div>
                <div className="flex gap-4 items-center">
                    <div className="text-right">
                        <span className="text-[9px] font-black text-slate-400 uppercase block">Cena Bazowa (Direct)</span>
                        <span className="text-sm font-bold text-slate-500 line-through">{totalBase.toLocaleString()} PLN</span>
                    </div>
                    <div className="text-right bg-blue-600 text-white px-5 py-2.5 rounded-2xl shadow-md">
                        <span className="text-[9px] font-black text-blue-200 uppercase block">Budżet Ofertowy (z Narzutami & Trendem)</span>
                        <span className="text-xl font-black tracking-tight">{Math.round(totalMarket).toLocaleString()} PLN</span>
                    </div>
                </div>
            </div>

            {/* ── Trzykolumnowy Layout ── */}
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-5 overflow-hidden min-h-0">
                
                {/* ── LEWA KOLUMNA: Suwaki Trendów + Dropzone Przetargowy (3/12) ── */}
                <div className="lg:col-span-3 bg-white border border-slate-200 rounded-3xl p-5 flex flex-col justify-between shadow-sm overflow-y-auto">
                    <div className="space-y-4">
                        <div className="border-b pb-3">
                            <h3 className="font-black text-xs text-slate-500 uppercase tracking-wider">📐 Przedmiar i Parametry</h3>
                            <p className="text-[10px] text-slate-400 mt-0.5">Dane wejściowe pod zaawansowane formuły matematyczne</p>
                        </div>

                        {/* Dropzone Przetargowy */}
                        <div className="space-y-2">
                            <label className="text-[10px] font-black uppercase text-slate-400">Paczka Przetargowa (ZIP/PDF/Excel):</label>
                            <div 
                                onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                                onDragLeave={() => setIsDragging(false)}
                                onDrop={async e => {
                                    e.preventDefault();
                                    setIsDragging(false);
                                    const file = e.dataTransfer.files[0];
                                    if (file) handleFileUpload(file);
                                }}
                                onClick={() => document.getElementById("tender-file-input")?.click()}
                                className={`border-2 border-dashed rounded-3xl p-4 text-center transition-all cursor-pointer flex flex-col items-center justify-center min-h-[110px] relative ${
                                    isDragging ? "border-blue-500 bg-blue-50/50" : "border-slate-200 hover:border-slate-300 bg-slate-50/50"
                                }`}
                            >
                                {isUploading ? (
                                    <div className="flex flex-col items-center gap-2">
                                        <span className="animate-spin text-lg text-blue-600">⏳</span>
                                        <span className="text-[9px] font-black uppercase text-blue-600 animate-pulse">Analiza dokumentacji...</span>
                                    </div>
                                ) : uploadedFile ? (
                                    <div className="flex flex-col items-center gap-1.5">
                                        <span className="text-xl">📄</span>
                                        <span className="text-[10px] font-bold text-slate-700 truncate max-w-[180px]" title={uploadedFile.name}>
                                            {uploadedFile.name}
                                        </span>
                                        <button 
                                            onClick={e => { e.stopPropagation(); setUploadedFile(null); }}
                                            className="text-[9px] font-black text-red-500 hover:underline uppercase z-10"
                                        >Usuń plik</button>
                                    </div>
                                ) : (
                                    <div className="flex flex-col items-center gap-1.5">
                                        <span className="text-xl">📥</span>
                                        <p className="text-[10px] font-bold text-slate-500">Przeciągnij plik ZIP lub kliknij</p>
                                        <p className="text-[8px] text-slate-400 font-semibold">SWZ, ślepy kosztorys, rzuty</p>
                                    </div>
                                )}
                                <input 
                                    type="file" 
                                    onChange={e => {
                                        const file = e.target.files?.[0];
                                        if (file) handleFileUpload(file);
                                    }}
                                    className="hidden" 
                                    id="tender-file-input"
                                    accept=".zip,.pdf,.xlsx,.xls"
                                />
                            </div>
                        </div>

                        {/* Szybkie Szablony */}
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black uppercase text-slate-400">Szybkie Szablony Robót:</label>
                            <button 
                                onClick={() => handleLoadTemplate("PL_FUNDAMENT")}
                                className="w-full bg-slate-50 hover:bg-blue-50 text-slate-600 hover:text-blue-700 border border-slate-200 hover:border-blue-200 p-2 text-[10px] font-bold rounded-lg text-left transition-all"
                            >
                                🏗️ Wczytaj Rzut Przedszkola (Makieta)
                            </button>
                        </div>

                        {/* Suwaki Trendów i Wyceny */}
                        <div className="space-y-4 pt-2 border-t">
                            <div>
                                <div className="flex justify-between text-[10px] font-black uppercase text-amber-600 mb-1">
                                    <span>Korekta Robocizny (R):</span>
                                    <span>{trends.laborAdjustment}%</span>
                                </div>
                                <input 
                                    type="range" min="-20" max="20" step="1"
                                    value={trends.laborAdjustment}
                                    onChange={e => setTrends({...trends, laborAdjustment: Number(e.target.value)})}
                                    className="w-full accent-amber-500 cursor-pointer h-1 bg-slate-100 rounded-lg appearance-none"
                                />
                            </div>

                            <div>
                                <div className="flex justify-between text-[10px] font-black uppercase text-green-600 mb-1">
                                    <span>Korekta Materiałów (M):</span>
                                    <span>+{trends.materialAdjustment}%</span>
                                </div>
                                <input 
                                    type="range" min="-10" max="30" step="1"
                                    value={trends.materialAdjustment}
                                    onChange={e => setTrends({...trends, materialAdjustment: Number(e.target.value)})}
                                    className="w-full accent-green-500 cursor-pointer h-1 bg-slate-100 rounded-lg appearance-none"
                                />
                            </div>

                            <div className="border-t pt-3 space-y-3">
                                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block">Narzuty kosztorysowe (KNR)</span>
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="text-[8px] font-black text-slate-500 uppercase">Koszty Pośrednie (Kp %):</label>
                                        <input 
                                            type="number" 
                                            value={trends.kp}
                                            onChange={e => setTrends({...trends, kp: Number(e.target.value)})}
                                            className="w-full mt-1 p-2 border rounded-xl text-xs bg-slate-50 font-black text-center outline-none"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[8px] font-black text-slate-500 uppercase">Zysk (Z %):</label>
                                        <input 
                                            type="number" 
                                            value={trends.zysk}
                                            onChange={e => setTrends({...trends, zysk: Number(e.target.value)})}
                                            className="w-full mt-1 p-2 border rounded-xl text-xs bg-slate-50 font-black text-center outline-none"
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="pt-4 border-t border-slate-200">
                        <div className="flex gap-2">
                            <button onClick={exportToCsv} className="flex-1 bg-slate-800 text-white text-[10px] font-black py-2.5 rounded-xl transition-all">CSV</button>
                            <button onClick={() => window.print()} className="flex-1 bg-blue-600 text-white text-[10px] font-black py-2.5 rounded-xl transition-all">DRUK PDF</button>
                        </div>
                    </div>
                </div>

                {/* ── ŚRODKOWA KOLUMNA: Konsola Czatu z AI (4/12) ── */}
                <div className="lg:col-span-4 bg-slate-900 rounded-3xl flex flex-col overflow-hidden shadow-sm">
                    <div className="p-4 bg-slate-950 border-b border-slate-800 flex items-center gap-3">
                        <div className="w-9 h-9 bg-blue-600 rounded-full flex items-center justify-center text-lg shadow-inner">👷</div>
                        <div>
                            <h3 className="font-black text-white text-xs uppercase tracking-wider leading-none">Konsola Inżyniera Kontraktu</h3>
                            <p className="text-[9px] text-blue-400 mt-1 font-bold">Wsparcie KNR, KNNR oraz Python Code Execution</p>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-950/40">
                        {messages.map((msg, idx) => (
                            <div key={idx} className={`flex flex-col max-w-[90%] ${msg.role === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'}`}>
                                <div className={`p-3 rounded-2xl text-xs leading-relaxed ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-br-none font-semibold' : 'bg-slate-800 text-slate-200 border border-slate-700/80 rounded-bl-none'}`}>
                                    {msg.content}
                                </div>
                            </div>
                        ))}
                        {isLoading && (
                            <div className="flex items-center gap-2 text-slate-400 bg-slate-800 p-3 rounded-2xl w-fit rounded-bl-none">
                                <span className="animate-spin text-sm">⏳</span> <span className="text-[10px] font-black uppercase tracking-wider">Inżynier przelicza wskaźniki...</span>
                            </div>
                        )}
                        <div ref={chatEndRef} />
                    </div>

                    <div className="p-3 bg-slate-950 border-t border-slate-800 flex gap-2">
                        <input 
                            type="text"
                            value={inputText}
                            onChange={e => setInputText(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleAskEstimator()}
                            placeholder="Wprowadź instrukcję lub zapytanie o pozycję..."
                            className="flex-1 bg-slate-800 text-white border border-slate-700 rounded-xl px-3 py-2.5 text-xs outline-none focus:border-blue-500 font-semibold"
                        />
                        <button 
                            onClick={handleAskEstimator}
                            disabled={!inputText.trim() || isLoading}
                            className="bg-blue-600 hover:bg-blue-500 text-white font-black text-xs px-4 rounded-xl transition-all"
                        >
                            OBLICZ
                        </button>
                    </div>
                </div>

                {/* ── PRAWA KOLUMNA: Tabela Kosztorysu Przedmiarowego (5/12) ── */}
                <div className="lg:col-span-5 bg-white border border-slate-200 rounded-3xl p-5 flex flex-col justify-between shadow-sm overflow-hidden">
                    <div className="flex flex-col h-full overflow-hidden">
                        
                        <div className="border-b pb-3 mb-4">
                            <h3 className="font-black text-xs text-slate-500 uppercase tracking-wider">📝 Podgląd Kosztorysu / Przedmiaru</h3>
                            <p className="text-[10px] text-slate-400 mt-0.5">Działy kosztorysu oparte o tabele KNR/KNNR</p>
                        </div>

                        {/* Filtrowanie zakładkami RMS */}
                        <div className="flex bg-slate-100 p-1 rounded-xl border mb-3 flex-shrink-0">
                            <button 
                                onClick={() => setActiveTab("ALL")}
                                className={`flex-1 py-1 rounded-lg text-[8px] font-black uppercase transition-all ${activeTab === "ALL" ? "bg-white text-blue-600 shadow-sm" : "text-slate-500"}`}
                            >WSZYSTKO</button>
                            <button 
                                onClick={() => setActiveTab("R")}
                                className={`flex-1 py-1 rounded-lg text-[8px] font-black uppercase transition-all ${activeTab === "R" ? "bg-white text-amber-600 shadow-sm" : "text-slate-500"}`}
                            >👷 Robocizna</button>
                            <button 
                                onClick={() => setActiveTab("M")}
                                className={`flex-1 py-1 rounded-lg text-[8px] font-black uppercase transition-all ${activeTab === "M" ? "bg-white text-green-600 shadow-sm" : "text-slate-500"}`}
                            >🧱 Materiały</button>
                            <button 
                                onClick={() => setActiveTab("S")}
                                className={`flex-1 py-1 rounded-lg text-[8px] font-black uppercase transition-all ${activeTab === "S" ? "bg-white text-purple-600 shadow-sm" : "text-slate-500"}`}
                            >🚜 Sprzęt</button>
                        </div>

                        {/* Lista działów i pozycji */}
                        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-1">
                            {sections.map(sec => {
                                const filteredItems = sec.items.filter(item => activeTab === "ALL" || item.type === activeTab);
                                if (filteredItems.length === 0) return null;
                                
                                return (
                                    <div key={sec.id} className="space-y-2">
                                        <div className="bg-slate-100 px-3 py-1.5 rounded-xl flex justify-between items-center border border-slate-200">
                                            <span className="text-[9px] font-black uppercase text-slate-600 tracking-tight">{sec.name}</span>
                                            <span className="text-[9px] font-black text-blue-600">
                                                {Math.round(filteredItems.reduce((sum, item) => sum + calculateRowValue(item), 0)).toLocaleString()} zł
                                            </span>
                                        </div>

                                        <div className="space-y-2 pl-2">
                                            {filteredItems.map(item => {
                                                const adjustedValue = calculateRowValue(item);
                                                const baseValue = item.quantity * item.basePrice;
                                                return (
                                                    <div key={item.id} className="border border-slate-100 p-3 rounded-2xl bg-white shadow-sm flex items-center justify-between gap-3 hover:border-slate-200 transition-colors">
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-1.5">
                                                                <span className={`text-[7px] font-black px-1.5 py-0.5 rounded ${
                                                                    item.type === "R" ? "bg-amber-100 text-amber-700" :
                                                                    item.type === "M" ? "bg-green-100 text-green-700" :
                                                                    "bg-purple-100 text-purple-700"
                                                                }`}>
                                                                    {item.type}
                                                                </span>
                                                                {item.code && <span className="text-[8px] text-slate-400 font-mono font-bold">{item.code}</span>}
                                                            </div>
                                                            <p className="text-[11px] font-bold text-slate-800 truncate mt-1 leading-tight uppercase" title={item.name}>{item.name}</p>
                                                            
                                                            <div className="text-[9px] font-semibold text-slate-400 mt-1 flex gap-2">
                                                                <span>Baza: {Math.round(baseValue).toLocaleString()} zł</span>
                                                                <span className="text-blue-500 font-bold">Po korekcie: {Math.round(adjustedValue).toLocaleString()} zł</span>
                                                            </div>
                                                        </div>

                                                        {/* Panel edycji na żywo */}
                                                        <div className="flex items-center gap-1.5 flex-shrink-0">
                                                            <div className="flex flex-col items-center">
                                                                <span className="text-[7px] font-black text-slate-400 uppercase leading-none mb-0.5">Ilość</span>
                                                                <div className="flex items-center gap-0.5 bg-slate-50 px-1.5 py-1 rounded-lg border">
                                                                    <input 
                                                                        type="number" step="1"
                                                                        value={item.quantity}
                                                                        onChange={e => updateItemValue(sec.id, item.id, "quantity", Number(e.target.value))}
                                                                        className="w-10 bg-transparent text-center font-black text-[10px] outline-none"
                                                                    />
                                                                    <span className="text-[7px] text-slate-400 font-bold">{item.unit}</span>
                                                                </div>
                                                            </div>

                                                            <div className="flex flex-col items-center">
                                                                <span className="text-[7px] font-black text-slate-400 uppercase leading-none mb-0.5">Cena b.</span>
                                                                <div className="flex items-center gap-0.5 bg-slate-50 px-1.5 py-1 rounded-lg border">
                                                                    <input 
                                                                        type="number"
                                                                        value={item.basePrice}
                                                                        onChange={e => updateItemValue(sec.id, item.id, "basePrice", Number(e.target.value))}
                                                                        className="w-10 bg-transparent text-center font-black text-[10px] outline-none"
                                                                    />
                                                                    <span className="text-[7px] text-slate-400 font-bold">zł</span>
                                                                </div>
                                                            </div>

                                                            <button 
                                                                onClick={() => removeItem(sec.id, item.id)}
                                                                className="text-red-400 hover:text-red-600 hover:bg-red-50 w-6 h-6 mt-2 rounded flex items-center justify-center text-sm font-bold transition-colors"
                                                            >
                                                                &times;
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>

            </div>

        </div>
    );
}