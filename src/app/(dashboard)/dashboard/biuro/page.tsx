// src/app/(dashboard)/dashboard/biuro/page.tsx
'use client';

import { useState, useRef } from 'react';
import type { DetectionResult } from '@/lib/pdf/text-layer-detector';

type TabType = 'overview' | 'router' | 'uom_synonyms' | 'hitl' | 'pallets' | 'fuzzymatch' | 'architecture';

interface DocItem {
    id: string;
    source: 'PDF_OPTIMA' | 'PHOTO_CABIN' | 'VOICE_NOTE' | 'KSEF_XML';
    number: string;
    supplier: string;
    nip: string;
    date: string;
    totalNetto: number;
    pathUsed: 'FAST_PATH' | 'SLOW_PATH' | 'KSEF_STREAM';
    mathValid: boolean;
    confidenceScore: number;
    status: 'ZWALIDOWANY' | 'WYMAGA_HITL' | 'SPAROWANY_KSEF';
    itemsCount: number;
    details?: string;
}

const INITIAL_DOCS: DocItem[] = [
    {
        id: 'DOC-2026-001',
        source: 'PDF_OPTIMA',
        number: 'WZ/2026/11/0492',
        supplier: 'Hurtownia Materiałów CMB Sp. z o.o.',
        nip: '8732918231',
        date: '2026-11-23',
        totalNetto: 14850.00,
        pathUsed: 'FAST_PATH',
        mathValid: true,
        confidenceScore: 0.99,
        status: 'SPAROWANY_KSEF',
        itemsCount: 12,
        details: 'Warstwa tekstowa cyfrowa (pdfplumber) - 0.04s, koszt 0 zł'
    },
    {
        id: 'DOC-2026-002',
        source: 'PHOTO_CABIN',
        number: 'WZ-884/KRA',
        supplier: 'Beton-Stal Małopolska',
        nip: '6791029384',
        date: '2026-11-23',
        totalNetto: 6420.00,
        pathUsed: 'SLOW_PATH',
        mathValid: false,
        confidenceScore: 0.88,
        status: 'WYMAGA_HITL',
        itemsCount: 4,
        details: 'Zdjęcie z kabiny auta - rozbieżność w pozycji nr 3 (Bloczki betonowe: cena x ilosc != netto)'
    },
    {
        id: 'DOC-2026-003',
        source: 'VOICE_NOTE',
        number: 'GŁOS-KIEROWCA-014',
        supplier: 'Dostawa bezpośrednia producenta',
        nip: 'Nieznany (Głos)',
        date: '2026-11-23',
        totalNetto: 2150.00,
        pathUsed: 'FAST_PATH',
        mathValid: true,
        confidenceScore: 0.91,
        status: 'WYMAGA_HITL',
        itemsCount: 2,
        details: 'Notatka foniczna: "Przywiezione 20 palet bloczków, 7 palet uszkodzonych zwróconych na bazę"'
    },
    {
        id: 'DOC-2026-004',
        source: 'PDF_OPTIMA',
        number: 'WZ/2026/11/0498',
        supplier: 'Centrostal Kraków S.A.',
        nip: '6760012391',
        date: '2026-11-22',
        totalNetto: 38200.00,
        pathUsed: 'FAST_PATH',
        mathValid: true,
        confidenceScore: 0.98,
        status: 'SPAROWANY_KSEF',
        itemsCount: 18,
        details: 'Stal żebrowana fi 12 i fi 16 na Budowę Tuchów - zgodna z KSeF FV 1182/2026'
    },
    {
        id: 'DOC-2026-005',
        source: 'KSEF_XML',
        number: 'KSEF-FV-994821',
        supplier: 'Wkręt-Met Klimas',
        nip: '7721092841',
        date: '2026-11-22',
        totalNetto: 4120.00,
        pathUsed: 'KSEF_STREAM',
        mathValid: true,
        confidenceScore: 0.96,
        status: 'SPAROWANY_KSEF',
        itemsCount: 6,
        details: 'Faktura zbiorcza KSeF automatycznie przypięta do 2 WZ-tek po analizie Fuzzy Matchera'
    }
];

export default function BiuroPage() {
    const [activeTab, setActiveTab] = useState<TabType>('overview');
    const [docs, setDocs] = useState<DocItem[]>(INITIAL_DOCS);
    const [selectedDoc, setSelectedDoc] = useState<DocItem | null>(null);
    const [processingSimulation, setProcessingSimulation] = useState(false);
    const [simulatedResult, setSimulatedResult] = useState<string | null>(null);

    // Stan rzeczywistej analizy wgrywanego pliku (Smart Router Live Detector)
    const [analyzingFile, setAnalyzingFile] = useState(false);
    const [detectionResult, setDetectionResult] = useState<DetectionResult | null>(null);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setAnalyzingFile(true);
        setUploadError(null);
        setDetectionResult(null);

        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch('/api/biuro/detect-text-layer', {
                method: 'POST',
                body: formData
            });

            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Błąd podczas weryfikacji warstwy tekstowej pliku');
            }

            setDetectionResult(data.data as DetectionResult);
        } catch (err: any) {
            setUploadError(err.message || 'Nie udało się przeanalizować pliku');
        } finally {
            setAnalyzingFile(false);
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        }
    };

    const handleAcceptDetectedDoc = () => {
        if (!detectionResult) return;

        const newId = `DOC-${new Date().getFullYear()}-${String(docs.length + 1).padStart(3, '0')}`;
        const isFast = detectionResult.recommendedPath === 'FAST_PATH';

        const newDoc: DocItem = {
            id: newId,
            source: detectionResult.fileType === 'pdf' ? 'PDF_OPTIMA' : detectionResult.fileType === 'audio' ? 'VOICE_NOTE' : 'PHOTO_CABIN',
            number: detectionResult.detectedMetadata?.docNumberFound || `WZ-${Math.floor(1000 + Math.random() * 9000)}/2026`,
            supplier: detectionResult.detectedMetadata?.isComarchOptima ? 'Dostawca ERP Optima (Wykryty)' : 'PHU Materiały Budowlane',
            nip: detectionResult.detectedMetadata?.nipFound || '8732804815',
            date: new Date().toISOString().split('T')[0],
            totalNetto: isFast ? 8950.00 : 4320.00,
            pathUsed: isFast ? 'FAST_PATH' : 'SLOW_PATH',
            mathValid: isFast,
            confidenceScore: isFast ? 0.99 : 0.89,
            status: isFast ? 'ZWALIDOWANY' : 'WYMAGA_HITL',
            itemsCount: isFast ? 8 : 3,
            details: `Automatyczna detekcja: ${detectionResult.reason} (Czas: ${detectionResult.executionTimeMs} ms)`
        };

        setDocs(prev => [newDoc, ...prev]);
        setDetectionResult(null);
        setActiveTab('overview');
    };

    // Statystyki
    const totalDocs = docs.length;
    const hitlCount = docs.filter(d => d.status === 'WYMAGA_HITL').length;
    const ksefPaired = docs.filter(d => d.status === 'SPAROWANY_KSEF').length;
    const fastPathCount = docs.filter(d => d.pathUsed === 'FAST_PATH').length;
    const slowPathCount = docs.filter(d => d.pathUsed === 'SLOW_PATH').length;

    const handleApproveHitl = (docId: string) => {
        setDocs(prev => prev.map(d => d.id === docId ? { ...d, status: 'ZWALIDOWANY', mathValid: true, confidenceScore: 1.0 } : d));
        if (selectedDoc?.id === docId) {
            setSelectedDoc(null);
        }
    };

    const handleSimulateRouter = (type: 'pdf' | 'photo' | 'voice') => {
        setProcessingSimulation(true);
        setSimulatedResult(null);
        setTimeout(() => {
            setProcessingSimulation(false);
            if (type === 'pdf') {
                setSimulatedResult('⚡ FAST PATH (Python / pdfplumber): Wykryto warstwę tekstową cyfrową Comarch Optima. Wyekstrahowano 8 pozycji, walidacja matematyczna: OK. Czas: 0.04s, Koszt LLM: 0.00 zł.');
            } else if (type === 'photo') {
                setSimulatedResult('👁️ SLOW PATH (Vision LLM / Gemini 3.5 Flash): Obraz z telefonu kierowcy. Wykryto pognieciony nagłówek WZ, OCR wizualny odczytał 4 pozycje. Walidacja matematyczna: OK. Czas: 1.42s.');
            } else {
                setSimulatedResult('🎙️ SPEECH-TO-TEXT + FAST PATH: Notatka foniczna kierowcy przetworzona przez Whisper. Agent pamięci epizodycznej zarejestrował ruch 15 palet EUR dla Bazy Centralnej.');
            }
        }, 800);
    };

    return (
        <div className="p-6 max-w-7xl mx-auto space-y-6">
            {/* Nagłówek modułu */}
            <div className="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-slate-200 gap-4">
                <div>
                    <div className="flex items-center gap-2">
                        <span className="text-2xl">🏢</span>
                        <h1 className="text-2xl font-black text-slate-800 tracking-tight">
                            PESAM-DOC: Biuro i Inteligentny Obieg Dokumentów
                        </h1>
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-700">
                            v2.0 Produkcyjna
                        </span>
                    </div>
                    <p className="text-slate-500 text-sm mt-1">
                        System automatyzacji WZ/WZT, logistyki palet oraz rozliczania faktur centralnych KSeF bez ręcznej biurokracji
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-semibold">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                        Smart Router Aktywny
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-semibold">
                        KSeF Strumień: Online
                    </span>
                </div>
            </div>

            {/* Zakładki */}
            <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
                <button
                    onClick={() => setActiveTab('overview')}
                    className={`px-4 py-2 rounded-lg font-medium text-sm transition flex items-center gap-2 ${activeTab === 'overview'
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                        }`}
                >
                    📊 Pulpit Główny
                </button>
                <button
                    onClick={() => setActiveTab('router')}
                    className={`px-4 py-2 rounded-lg font-medium text-sm transition flex items-center gap-2 ${activeTab === 'router'
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                        }`}
                >
                    🚦 Smart Router & Wprowadzanie
                </button>
                <button
                    onClick={() => setActiveTab('uom_synonyms')}
                    className={`px-4 py-2 rounded-lg font-medium text-sm transition flex items-center gap-2 ${activeTab === 'uom_synonyms'
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                        }`}
                >
                    ⚖️ Normalizator UoM & Synonimy
                </button>
                <button
                    onClick={() => setActiveTab('hitl')}
                    className={`px-4 py-2 rounded-lg font-medium text-sm transition flex items-center gap-2 relative ${activeTab === 'hitl'
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                        }`}
                >
                    ⚠️ Bufor HITL (Księgowość)
                    {hitlCount > 0 && (
                        <span className="px-1.5 py-0.2 bg-rose-500 text-white text-xs font-bold rounded-full">
                            {hitlCount}
                        </span>
                    )}
                </button>
                <button
                    onClick={() => setActiveTab('pallets')}
                    className={`px-4 py-2 rounded-lg font-medium text-sm transition flex items-center gap-2 ${activeTab === 'pallets'
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                        }`}
                >
                    🪵 Logistyka Palet
                </button>
                <button
                    onClick={() => setActiveTab('fuzzymatch')}
                    className={`px-4 py-2 rounded-lg font-medium text-sm transition flex items-center gap-2 ${activeTab === 'fuzzymatch'
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                        }`}
                >
                    🧩 Fuzzy Matcher KSeF
                </button>
                <button
                    onClick={() => setActiveTab('architecture')}
                    className={`px-4 py-2 rounded-lg font-medium text-sm transition flex items-center gap-2 ${activeTab === 'architecture'
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                        }`}
                >
                    📐 Architektura PESAM-DOC
                </button>
            </div>

            {/* TAB 1: OVERVIEW */}
            {activeTab === 'overview' && (
                <div className="space-y-6">
                    {/* Karty statystyk */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                            <div className="flex items-center justify-between text-slate-500 text-xs font-bold uppercase tracking-wider">
                                <span>Wszystkie Dokumenty</span>
                                <span className="p-2 bg-blue-50 text-blue-600 rounded-lg">📄</span>
                            </div>
                            <div className="mt-3 text-3xl font-extrabold text-slate-800">{totalDocs}</div>
                            <div className="mt-2 text-xs text-slate-500 flex items-center gap-1">
                                <span className="text-emerald-600 font-bold">100%</span> cyfrowego przepływu
                            </div>
                        </div>

                        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                            <div className="flex items-center justify-between text-slate-500 text-xs font-bold uppercase tracking-wider">
                                <span>Fast Path vs Vision LLM</span>
                                <span className="p-2 bg-emerald-50 text-emerald-600 rounded-lg">⚡</span>
                            </div>
                            <div className="mt-3 text-3xl font-extrabold text-emerald-600">{fastPathCount} / {slowPathCount}</div>
                            <div className="mt-2 text-xs text-slate-500">
                                Koszt AI: <b className="text-emerald-600">0.00 zł</b> dla Fast Path (Regex)
                            </div>
                        </div>

                        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                            <div className="flex items-center justify-between text-slate-500 text-xs font-bold uppercase tracking-wider">
                                <span>Sparowane z KSeF</span>
                                <span className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">🧩</span>
                            </div>
                            <div className="mt-3 text-3xl font-extrabold text-indigo-600">{ksefPaired}</div>
                            <div className="mt-2 text-xs text-slate-500">
                                Confidence Score <b className="text-indigo-600">&ge; 0.95</b>
                            </div>
                        </div>

                        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                            <div className="flex items-center justify-between text-slate-500 text-xs font-bold uppercase tracking-wider">
                                <span>Bufor Human-in-the-Loop</span>
                                <span className="p-2 bg-amber-50 text-amber-600 rounded-lg">⚠️</span>
                            </div>
                            <div className="mt-3 text-3xl font-extrabold text-amber-600">{hitlCount}</div>
                            <div className="mt-2 text-xs text-slate-500">
                                Wymaga decyzji księgowej / kierownika
                            </div>
                        </div>
                    </div>

                    {/* Schemat Pipeline Ingestion */}
                    <div className="bg-gradient-to-br from-slate-900 to-slate-800 text-white p-6 rounded-2xl shadow-lg space-y-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <h2 className="text-lg font-bold">Strumień Przetwarzania Dokumentów PESAM-DOC</h2>
                                <p className="text-xs text-slate-300">Deterministyczna walidacja matematyczna, optymalizacja kosztów AI oraz parowanie z KSeF</p>
                            </div>
                            <span className="px-3 py-1 bg-blue-500/20 text-blue-300 text-xs font-semibold rounded-lg border border-blue-400/30">
                                Architektura Hybrydowa
                            </span>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs pt-2">
                            <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-2">
                                <div className="font-bold text-blue-400 flex items-center gap-2">
                                    <span>1️⃣ Ingestion</span>
                                </div>
                                <p className="text-slate-300">
                                    • PDF z maila (Optima)<br />
                                    • Notatka foniczna kierowcy<br />
                                    • Zdjęcie WZ z telefonu<br />
                                    • Strumień XML KSeF
                                </p>
                            </div>

                            <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-2">
                                <div className="font-bold text-emerald-400 flex items-center gap-2">
                                    <span>2️⃣ Smart Router</span>
                                </div>
                                <p className="text-slate-300">
                                    • <b>Fast Path:</b> pdfplumber + Regex (0.05s, 0 zł)<br />
                                    • <b>Slow Path:</b> Gemini Flash Vision tylko przy braku warstwy tekstowej
                                </p>
                            </div>

                            <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-2">
                                <div className="font-bold text-amber-400 flex items-center gap-2">
                                    <span>3️⃣ Walidacja & HITL</span>
                                </div>
                                <p className="text-slate-300">
                                    • Sprawdzenie: Ilość x Cena = Netto<br />
                                    • Auto-przekazanie do bufora akceptacji księgowej przy rozbieżnościach
                                </p>
                            </div>

                            <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 space-y-2">
                                <div className="font-bold text-indigo-400 flex items-center gap-2">
                                    <span>4️⃣ Fuzzy Match & ERP</span>
                                </div>
                                <p className="text-slate-300">
                                    • Parowanie faktur zbiorczych KSeF z WZ<br />
                                    • Aktualizacja stanów palet w Firestore<br />
                                    • Streaming do BigQuery
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Ostatnie przetworzone dokumenty */}
                    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
                            <h3 className="font-bold text-slate-800 text-sm">Ostatnio przetworzone dokumenty w Biurze</h3>
                            <button
                                onClick={() => setActiveTab('hitl')}
                                className="text-xs text-blue-600 hover:underline font-semibold"
                            >
                                Zobacz wymagające decyzji ({hitlCount}) &rarr;
                            </button>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-xs text-slate-600">
                                <thead className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200 uppercase tracking-wider">
                                    <tr>
                                        <th className="p-3">ID / Nr WZ</th>
                                        <th className="p-3">Dostawca</th>
                                        <th className="p-3">Ścieżka Parsera</th>
                                        <th className="p-3">Wartość Netto</th>
                                        <th className="p-3">Pewność</th>
                                        <th className="p-3">Status</th>
                                        <th className="p-3 text-right">Akcja</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {docs.map(doc => (
                                        <tr key={doc.id} className="hover:bg-slate-50 transition">
                                            <td className="p-3 font-semibold text-slate-900">{doc.number}</td>
                                            <td className="p-3">{doc.supplier}</td>
                                            <td className="p-3">
                                                <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${doc.pathUsed === 'FAST_PATH' ? 'bg-emerald-100 text-emerald-800' :
                                                    doc.pathUsed === 'SLOW_PATH' ? 'bg-amber-100 text-amber-800' :
                                                        'bg-indigo-100 text-indigo-800'
                                                    }`}>
                                                    {doc.pathUsed}
                                                </span>
                                            </td>
                                            <td className="p-3 font-mono font-bold text-slate-800">
                                                {doc.totalNetto.toLocaleString('pl-PL', { minimumFractionDigits: 2 })} zł
                                            </td>
                                            <td className="p-3">
                                                <span className={`font-semibold ${doc.confidenceScore >= 0.95 ? 'text-emerald-600' : 'text-amber-600'}`}>
                                                    {(doc.confidenceScore * 100).toFixed(0)}%
                                                </span>
                                            </td>
                                            <td className="p-3">
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${doc.status === 'SPAROWANY_KSEF' ? 'bg-indigo-50 text-indigo-700 border border-indigo-200' :
                                                    doc.status === 'ZWALIDOWANY' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
                                                        'bg-rose-50 text-rose-700 border border-rose-200'
                                                    }`}>
                                                    {doc.status}
                                                </span>
                                            </td>
                                            <td className="p-3 text-right">
                                                <button
                                                    onClick={() => { setSelectedDoc(doc); setActiveTab('hitl'); }}
                                                    className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded transition text-[11px]"
                                                >
                                                    Szczegóły
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {/* TAB 2: SMART ROUTER & WPROWADZANIE */}
            {activeTab === 'router' && (
                <div className="space-y-6">
                    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-6">
                        <div>
                            <div className="flex items-center justify-between">
                                <h2 className="text-lg font-bold text-slate-800">Smart Router Dokumentów (Optymalizacja Kosztów AI)</h2>
                                <span className="px-2.5 py-1 bg-emerald-50 text-emerald-700 text-xs font-bold rounded-lg border border-emerald-200">
                                    Deterministyczny Detektor Tekstu
                                </span>
                            </div>
                            <p className="text-sm text-slate-500 mt-1">
                                System automatycznie bada strukturę binarną pliku przed wysłaniem go do API. Jeśli plik posiada cyfrową warstwę tekstową — kieruje go do <b>Fast Path</b> (czas ~0.05s, koszt 0 zł). Modele wizyjne <b>Slow Path</b> (Gemini 3.5 / 3.8 Flash) są uruchamiane tylko wtedy, gdy plik to skan lub fotografia ze smartfona.
                            </p>
                        </div>

                        {/* RZECZYWISTY UPLOAD I DETEKCJA WARSTWY TEKSTOWEJ */}
                        <div className="border-2 border-dashed border-blue-200 hover:border-blue-400 bg-blue-50/20 rounded-2xl p-6 transition text-center space-y-4">
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".pdf,.jpg,.jpeg,.png,.webp,.mp3,.m4a,.wav"
                                onChange={handleFileUpload}
                                className="hidden"
                                id="biuro-file-input"
                            />
                            <div className="space-y-2">
                                <span className="text-4xl block">📤</span>
                                <h3 className="font-extrabold text-slate-800 text-base">
                                    Sprawdź dowolny dokument (PDF, Skan JPG/PNG, Notatkę Audio)
                                </h3>
                                <p className="text-xs text-slate-500 max-w-md mx-auto">
                                    Wybierz plik z dysku. System w ułamku sekundy sprawdzi, czy dokument posiada cyfrową warstwę tekstową, czy to „martwe” zdjęcie wymagające modelu wizyjnego.
                                </p>
                            </div>

                            <div className="flex items-center justify-center gap-3">
                                <label
                                    htmlFor="biuro-file-input"
                                    className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-sm cursor-pointer transition flex items-center gap-2"
                                >
                                    📁 Wybierz plik z dysku
                                </label>
                                <span className="text-xs text-slate-400 font-medium">lub upuść plik tutaj</span>
                            </div>

                            {uploadError && (
                                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold rounded-lg max-w-lg mx-auto">
                                    ⚠️ {uploadError}
                                </div>
                            )}

                            {analyzingFile && (
                                <div className="p-4 bg-white border border-blue-200 rounded-xl max-w-md mx-auto shadow-sm space-y-2 animate-pulse">
                                    <div className="flex items-center justify-center gap-2 text-xs font-bold text-blue-700">
                                        <span className="animate-spin">⏳</span>
                                        Badanie struktury binarnej i strumieni tekstu w pamięci RAM...
                                    </div>
                                    <p className="text-[11px] text-slate-500">Dekompresja zlib & weryfikacja czcionek</p>
                                </div>
                            )}
                        </div>

                        {/* WYNIK RZECZYWISTEJ DETEKCJI SMART ROUTERA */}
                        {detectionResult && (
                            <div className={`p-5 rounded-xl border space-y-4 transition shadow-sm ${
                                detectionResult.recommendedPath === 'FAST_PATH'
                                    ? 'bg-emerald-50/60 border-emerald-300'
                                    : detectionResult.recommendedPath === 'SPEECH_TO_TEXT'
                                    ? 'bg-indigo-50/60 border-indigo-300'
                                    : 'bg-amber-50/60 border-amber-300'
                            }`}>
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b pb-3 border-slate-200/60">
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <span className="font-mono font-bold text-slate-900 text-sm">
                                                {detectionResult.fileName}
                                            </span>
                                            <span className={`px-2.5 py-0.5 rounded-full text-xs font-black uppercase tracking-wider ${
                                                detectionResult.recommendedPath === 'FAST_PATH'
                                                    ? 'bg-emerald-600 text-white'
                                                    : detectionResult.recommendedPath === 'SPEECH_TO_TEXT'
                                                    ? 'bg-indigo-600 text-white'
                                                    : 'bg-amber-600 text-white'
                                            }`}>
                                                {detectionResult.recommendedPath}
                                            </span>
                                        </div>
                                        <p className="text-xs text-slate-600 mt-1">
                                            {detectionResult.reason}
                                        </p>
                                    </div>
                                    <div className="text-right flex sm:flex-col items-center sm:items-end justify-between gap-1 text-xs">
                                        <span className="text-slate-500">Czas detekcji: <b className="text-slate-800">{detectionResult.executionTimeMs} ms</b></span>
                                        <span className="text-slate-500">Koszt sprawdzenia: <b className="text-emerald-700 font-mono">0.00 zł</b></span>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                                    <div className="bg-white p-3 rounded-lg border border-slate-200">
                                        <div className="text-[11px] font-bold text-slate-500 uppercase">Warstwa Tekstowa</div>
                                        <div className="mt-1 font-bold text-slate-800 text-sm flex items-center gap-1.5">
                                            {detectionResult.hasTextLayer ? (
                                                <>
                                                    <span className="text-emerald-600">✅ Wykryto</span>
                                                    <span className="text-xs font-normal text-slate-500">({detectionResult.extractedCharactersCount} znaków)</span>
                                                </>
                                            ) : (
                                                <>
                                                    <span className="text-amber-600">❌ Brak</span>
                                                    <span className="text-xs font-normal text-slate-500">(Obraz / Skan)</span>
                                                </>
                                            )}
                                        </div>
                                    </div>

                                    <div className="bg-white p-3 rounded-lg border border-slate-200">
                                        <div className="text-[11px] font-bold text-slate-500 uppercase">Rekomendowany Silnik</div>
                                        <div className="mt-1 font-bold text-slate-800 text-sm">
                                            {detectionResult.recommendedPath === 'FAST_PATH'
                                                ? '⚡ Python pdfplumber (0 zł)'
                                                : detectionResult.recommendedPath === 'SPEECH_TO_TEXT'
                                                ? '🎙️ Whisper Audio'
                                                : '👁️ Gemini 3.5 / 3.8 Flash Vision'}
                                        </div>
                                    </div>

                                    <div className="bg-white p-3 rounded-lg border border-slate-200">
                                        <div className="text-[11px] font-bold text-slate-500 uppercase">Wykryte Metadane</div>
                                        <div className="mt-1 font-medium text-slate-700 text-xs">
                                            {detectionResult.detectedMetadata?.isComarchOptima && '🏢 Szablon Comarch Optima | '}
                                            {detectionResult.detectedMetadata?.nipFound && `NIP: ${detectionResult.detectedMetadata.nipFound} | `}
                                            {detectionResult.detectedMetadata?.docNumberFound && `Nr: ${detectionResult.detectedMetadata.docNumberFound}`}
                                            {!detectionResult.detectedMetadata?.nipFound && !detectionResult.detectedMetadata?.isComarchOptima && 'Brak szablonu ERP'}
                                        </div>
                                    </div>
                                </div>

                                {detectionResult.extractedTextSample && (
                                    <div className="bg-slate-900 text-slate-200 p-3 rounded-lg text-xs font-mono border border-slate-800 space-y-1">
                                        <div className="text-[10px] text-slate-400 uppercase font-bold">Próbka odczytanego tekstu z warstwy cyfrowej:</div>
                                        <div className="text-emerald-300 break-all">{detectionResult.extractedTextSample}</div>
                                    </div>
                                )}

                                <div className="flex items-center justify-end gap-3 pt-1">
                                    <button
                                        onClick={() => setDetectionResult(null)}
                                        className="px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg transition"
                                    >
                                        Zamknij podgląd
                                    </button>
                                    <button
                                        onClick={handleAcceptDetectedDoc}
                                        className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg transition shadow-sm flex items-center gap-1.5"
                                    >
                                        <span>📥 Zaakceptuj i włącz do obiegu Biura</span>
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* SZYBKIE TESTY DEMONSTRACYJNE (BEZ PLIKU) */}
                        <div className="pt-2 space-y-2">
                            <h4 className="text-xs font-extrabold text-slate-600 uppercase tracking-wider">
                                Lub wykonaj test demonstracyjny (gotowe próbki):
                            </h4>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div className="border border-slate-200 p-4 rounded-xl hover:border-blue-400 transition flex flex-col justify-between space-y-3 bg-white">
                                    <div>
                                        <span className="text-2xl">📄</span>
                                        <h3 className="font-bold text-slate-800 mt-1 text-xs">PDF z maila (Comarch ERP Optima)</h3>
                                        <p className="text-[11px] text-slate-500 mt-0.5">
                                            Plik cyfrowy wygenerowany z ERP hurtowni z pełną warstwą tekstu.
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => handleSimulateRouter('pdf')}
                                        disabled={processingSimulation}
                                        className="w-full py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-lg transition"
                                    >
                                        ⚡ Symuluj Fast Path (0 zł)
                                    </button>
                                </div>

                                <div className="border border-slate-200 p-4 rounded-xl hover:border-blue-400 transition flex flex-col justify-between space-y-3 bg-white">
                                    <div>
                                        <span className="text-2xl">👁️</span>
                                        <h3 className="font-bold text-slate-800 mt-1 text-xs">Zdjęcie z kabiny auta</h3>
                                        <p className="text-[11px] text-slate-500 mt-0.5">
                                            Fotografia WZ wykonana smartfonem na budowie (brak tekstu).
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => handleSimulateRouter('photo')}
                                        disabled={processingSimulation}
                                        className="w-full py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs rounded-lg transition"
                                    >
                                        👁️ Symuluj Slow Path (Vision)
                                    </button>
                                </div>

                                <div className="border border-slate-200 p-4 rounded-xl hover:border-blue-400 transition flex flex-col justify-between space-y-3 bg-white">
                                    <div>
                                        <span className="text-2xl">🎙️</span>
                                        <h3 className="font-bold text-slate-800 mt-1 text-xs">Notatka foniczna kierowcy</h3>
                                        <p className="text-[11px] text-slate-500 mt-0.5">
                                            Nagranie mowy z trasy: status dostawy, zwroty palet.
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => handleSimulateRouter('voice')}
                                        disabled={processingSimulation}
                                        className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-lg transition"
                                    >
                                        🗣️ Symuluj Whisper + Pamięć
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Wynik symulacji */}
                        {processingSimulation && (
                            <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-700 font-semibold animate-pulse flex items-center gap-2">
                                <span className="animate-spin">⏳</span>
                                Smart Router analizuje warstwę tekstową pliku i uruchamia odpowiedni procesor...
                            </div>
                        )}

                        {simulatedResult && (
                            <div className="p-3.5 bg-slate-900 text-white rounded-xl text-xs font-mono border border-slate-800 space-y-1">
                                <div className="text-slate-400 font-bold uppercase text-[10px]">Raport Smart Routera:</div>
                                <div className="text-emerald-400">{simulatedResult}</div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* TAB: NORMALIZATOR UOM & SYNONIMY */}
            {activeTab === 'uom_synonyms' && (
                <div className="space-y-6">
                    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-5">
                        <div>
                            <div className="flex items-center gap-2">
                                <span className="text-xl">⚖️</span>
                                <h2 className="text-lg font-bold text-slate-800">Moduł Walidacji i Normalizacji (UoM & Synonimy)</h2>
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-700">
                                    Embeddings + Słownik
                                </span>
                            </div>
                            <p className="text-sm text-slate-500 mt-1">
                                Kierowca mówi <i>„15 sztuk płyt”</i>, a w KSeF widnieje <i>„37.5 m²”</i> pod nazwą <i>„Płyta G-K 12.5mm”</i> zamiast <i>„regipsy”</i>. Normalizator eliminuje fałszywe alarmy rozbieżności.
                            </p>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50 space-y-3">
                                <h3 className="text-xs font-extrabold uppercase text-slate-600 tracking-wider">
                                    📏 1. Przelicznik Jednostek Miar (UoM)
                                </h3>
                                <div className="space-y-2 text-xs">
                                    <div className="bg-white p-3 rounded-lg border border-slate-200 flex items-center justify-between">
                                        <div>
                                            <span className="font-bold text-slate-800">Płyta Gipsowo-Kartonowa 2.5m x 1.2m</span>
                                            <div className="text-slate-500 text-[11px]">Współczynnik: 1 szt = 2.50 m²</div>
                                        </div>
                                        <div className="font-mono font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded">
                                            15 szt &rarr; 37.5 m²
                                        </div>
                                    </div>
                                    <div className="bg-white p-3 rounded-lg border border-slate-200 flex items-center justify-between">
                                        <div>
                                            <span className="font-bold text-slate-800">Wełna Mineralna 15cm (Paczka)</span>
                                            <div className="text-slate-500 text-[11px]">Współczynnik: 1 paczka = 3.60 m²</div>
                                        </div>
                                        <div className="font-mono font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded">
                                            20 paczek &rarr; 72.0 m²
                                        </div>
                                    </div>
                                    <div className="bg-white p-3 rounded-lg border border-slate-200 flex items-center justify-between">
                                        <div>
                                            <span className="font-bold text-slate-800">Stal Zbrojeniowa fi 12mm (Sztangi 12m)</span>
                                            <div className="text-slate-500 text-[11px]">Współczynnik: 1 sztanga = 10.66 kg</div>
                                        </div>
                                        <div className="font-mono font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded">
                                            50 szt &rarr; 533 kg (0.53 t)
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50 space-y-3">
                                <h3 className="text-xs font-extrabold uppercase text-slate-600 tracking-wider">
                                    🧩 2. Dopasowywanie Synonimów (Przestrzenie Wektorowe)
                                </h3>
                                <div className="space-y-2 text-xs">
                                    <div className="bg-white p-3 rounded-lg border border-slate-200 space-y-1">
                                        <div className="flex items-center justify-between">
                                            <span className="text-slate-500 text-[11px]">Mowa kierowcy / potoczne:</span>
                                            <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">Zgodność: 99%</span>
                                        </div>
                                        <div className="font-bold text-rose-600">„regipsy białe 12-tka”</div>
                                        <div className="text-slate-400 text-[11px]">&darr; Dopasowanie wektorowe do KSeF:</div>
                                        <div className="font-semibold text-emerald-700">„Płyta GKB Knauf A 12,5 mm 1200x2600”</div>
                                    </div>
                                    <div className="bg-white p-3 rounded-lg border border-slate-200 space-y-1">
                                        <div className="flex items-center justify-between">
                                            <span className="text-slate-500 text-[11px]">Mowa kierowcy / potoczne:</span>
                                            <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">Zgodność: 97%</span>
                                        </div>
                                        <div className="font-bold text-rose-600">„wkręty do regipsów pchełki”</div>
                                        <div className="text-slate-400 text-[11px]">&darr; Dopasowanie wektorowe do KSeF:</div>
                                        <div className="font-semibold text-emerald-700">„Wkręt samowiercący do blachy 3.5x9.5 mm PH2”</div>
                                    </div>
                                    <div className="bg-white p-3 rounded-lg border border-slate-200 space-y-1">
                                        <div className="flex items-center justify-between">
                                            <span className="text-slate-500 text-[11px]">Mowa kierowcy / potoczne:</span>
                                            <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">Zgodność: 96%</span>
                                        </div>
                                        <div className="font-bold text-rose-600">„styropian podłoga setka”</div>
                                        <div className="text-slate-400 text-[11px]">&darr; Dopasowanie wektorowe do KSeF:</div>
                                        <div className="font-semibold text-emerald-700">„Styropian EPS 100 Dach/Podłoga gr. 10 cm”</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* TAB 3: BUFOR HITL (Human-in-the-loop) */}
            {activeTab === 'hitl' && (
                <div className="space-y-6">
                    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                            <div>
                                <h2 className="text-lg font-bold text-slate-800">Pulpit Human-in-the-loop (Decyzje Księgowej / Kierownika)</h2>
                                <p className="text-sm text-slate-500">
                                    Dokumenty, w których wykryto błędy walidacji matematycznej lub wskaźnik pewności parowania (Confidence Score) jest niższy niż 95%.
                                </p>
                            </div>
                            <span className="px-3 py-1 bg-amber-100 text-amber-800 text-xs font-bold rounded-lg self-start">
                                Do weryfikacji: {hitlCount}
                            </span>
                        </div>

                        {hitlCount === 0 ? (
                            <div className="text-center py-12 border-2 border-dashed border-slate-200 rounded-xl text-slate-500 text-sm">
                                🎉 Brak dokumentów oczekujących w buforze HITL! Wszystkie pozycje zwalidowane poprawnie.
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {docs.filter(d => d.status === 'WYMAGA_HITL').map(doc => (
                                    <div key={doc.id} className="border border-amber-200 bg-amber-50/40 rounded-xl p-5 space-y-3">
                                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-amber-200/60 pb-3">
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <span className="font-extrabold text-slate-900 text-sm">{doc.number}</span>
                                                    <span className="text-xs text-slate-500 font-mono">({doc.id})</span>
                                                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-200 text-amber-900">
                                                        Score: {(doc.confidenceScore * 100).toFixed(0)}%
                                                    </span>
                                                </div>
                                                <div className="text-xs text-slate-600 mt-0.5">
                                                    Dostawca: <b>{doc.supplier}</b> | NIP: {doc.nip} | Data: {doc.date}
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <span className="text-xs text-slate-500">Kwota netto:</span>
                                                <div className="font-mono font-black text-slate-900 text-base">
                                                    {doc.totalNetto.toLocaleString('pl-PL', { minimumFractionDigits: 2 })} zł
                                                </div>
                                            </div>
                                        </div>

                                        <div className="text-xs text-slate-700 bg-white p-3 rounded-lg border border-amber-200">
                                            <b className="text-amber-800">Powód skierowania do HITL:</b> {doc.details}
                                        </div>

                                        <div className="flex items-center justify-end gap-3 pt-1">
                                            <button
                                                onClick={() => alert(`Otwieranie podglądu skanu dla ${doc.number}`)}
                                                className="px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg transition"
                                            >
                                                🔍 Podgląd Skanu / Notatki
                                            </button>
                                            <button
                                                onClick={() => handleApproveHitl(doc.id)}
                                                className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg transition shadow-sm"
                                            >
                                                ✅ Zatwierdź i Zamknij Koszt
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* TAB 4: LOGISTYKA PALET */}
            {activeTab === 'pallets' && (
                <div className="space-y-6">
                    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                        <div>
                            <h2 className="text-lg font-bold text-slate-800">Moduł Logistyki Palet (Pamięć Epizodyczna i Stan)</h2>
                            <p className="text-sm text-slate-500">
                                Śledzenie rotacji palet kaucjonowanych i zwrotnych bez obciążania kierowców sztywnymi formularzami — zdarzenia rejestrowane głosowo lub z WZ z automatycznym bilansowaniem.
                            </p>
                        </div>

                        {/* Bilans lokalizacji */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                                <div className="text-xs font-bold text-slate-500 uppercase">Budowa Tuchów</div>
                                <div className="mt-2 text-2xl font-black text-slate-800">142 szt.</div>
                                <div className="text-xs text-slate-500 mt-1">Palety EUR (Stan czynny)</div>
                            </div>
                            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                                <div className="text-xs font-bold text-slate-500 uppercase">Baza Centralna</div>
                                <div className="mt-2 text-2xl font-black text-blue-600">88 szt.</div>
                                <div className="text-xs text-slate-500 mt-1">W buforze magazynowym</div>
                            </div>
                            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                                <div className="text-xs font-bold text-slate-500 uppercase">W Hurtowniach (CMB / Producent)</div>
                                <div className="mt-2 text-2xl font-black text-amber-600">26 szt.</div>
                                <div className="text-xs text-slate-500 mt-1">Kaucja do odzyskania</div>
                            </div>
                        </div>

                        {/* Ostatnie zdarzenia w pamięci epizodycznej */}
                        <div className="space-y-2 pt-2">
                            <h3 className="font-bold text-slate-800 text-xs uppercase tracking-wider">Ostatnie zdarzenia w pamięci epizodycznej agenta:</h3>
                            <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden text-xs">
                                <div className="p-3 bg-white flex items-center justify-between">
                                    <div>
                                        <span className="font-bold text-slate-800">Kierowca Jan K. (Notatka foniczna):</span>
                                        <p className="text-slate-600">"Wydano 20 palet z Tuchowa, przyjęto 13 w CMB, 7 wróciło na Bazę Centralną."</p>
                                    </div>
                                    <span className="text-[11px] text-slate-400">23.11, 11:45</span>
                                </div>
                                <div className="p-3 bg-white flex items-center justify-between">
                                    <div>
                                        <span className="font-bold text-slate-800">WZ-492/CMB (Parser Fast Path):</span>
                                        <p className="text-slate-600">Automatyczny odpis 12 palet kaucjonowanych z faktury dostawcy.</p>
                                    </div>
                                    <span className="text-[11px] text-slate-400">23.11, 09:30</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* TAB 5: FUZZY MATCHER KSEF */}
            {activeTab === 'fuzzymatch' && (
                <div className="space-y-6">
                    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                        <div>
                            <h2 className="text-lg font-bold text-slate-800">Agent Dopasowujący (Fuzzy Matcher KSeF vs WZ)</h2>
                            <p className="text-sm text-slate-500">
                                Automatyczne powiązywanie faktur zbiorczych ze strumienia KSeF z pojedynczymi dostawami na budowach po NIP, zbliżonych kwotach, oknie czasowym i kontekście pozycji.
                            </p>
                        </div>

                        <div className="border border-indigo-100 bg-indigo-50/30 p-5 rounded-xl space-y-3">
                            <div className="flex items-center justify-between text-xs">
                                <span className="font-bold text-indigo-950">Przykładowe sparowanie automatyczne:</span>
                                <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold">Confidence Score: 0.98</span>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                                <div className="bg-white p-3 rounded-lg border border-indigo-200 space-y-1">
                                    <div className="font-bold text-slate-800">🧾 Faktura Zbiorcza KSeF (XML)</div>
                                    <div className="text-slate-600">Nr: FV/KSEF/2026/8812</div>
                                    <div className="text-slate-600">Pozycja: "Wkręty do drewna i mocowania konstrukcyjne"</div>
                                    <div className="font-mono font-bold text-slate-900">Kwota: 4 120,00 zł</div>
                                </div>
                                <div className="bg-white p-3 rounded-lg border border-indigo-200 space-y-1">
                                    <div className="font-bold text-slate-800">📄 WZ z Budowy + Głos Kierowcy</div>
                                    <div className="text-slate-600">Nr WZ: WZ/11/0498 + Notatka kierowcy</div>
                                    <div className="text-slate-600">Kontekst: "wkręty budowlane do więźby dachowej"</div>
                                    <div className="font-mono font-bold text-slate-900">Zgodność kwoty: 100%</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* TAB 6: ARCHITEKTURA SYSTEMU */}
            {activeTab === 'architecture' && (
                <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-6">
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="text-xl">📐</span>
                            <h2 className="text-lg font-bold text-slate-800">Dokumentacja Architektoniczna PESAM-DOC v2.0 / PESAM 3.0</h2>
                            <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">
                                Ewolucja i Optymalizacja
                            </span>
                        </div>
                        <p className="text-sm text-slate-500 mt-1">
                            Szczegółowa analiza: gdzie były błędy w starym planie, co zmieniliśmy i dlaczego nowa architektura eliminuje zbędne koszty i błędy.
                        </p>
                    </div>

                    {/* 4 Kluczowe zmiany i korekty starego planu */}
                    <div className="space-y-4">
                        <h3 className="text-sm font-extrabold text-slate-800 uppercase tracking-wider flex items-center gap-2">
                            <span>🔍 Gdzie były błędy w starym planie i co zmieniamy?</span>
                        </h3>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                            {/* Punkt 1 */}
                            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 space-y-2">
                                <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                                    <span className="text-base">1️⃣</span>
                                    <span>Pułapka „Wszystko przez ciężki OCR/Vision”</span>
                                </div>
                                <div className="text-rose-700 bg-rose-50 p-2.5 rounded-lg border border-rose-200">
                                    <b>Stary plan:</b> Każdy dokument PDF przepuszczany przez kosztowne modele wizyjne.<br />
                                    <b>Problem:</b> Marnowanie budżetu na API i wolne działanie przy czystych plikach z ERP.
                                </div>
                                <div className="text-emerald-800 bg-emerald-50 p-2.5 rounded-lg border border-emerald-200">
                                    <b>Nowe rozwiązanie:</b> Skrypt Pythona (<code>pdfplumber</code> + <code>regex</code>), który dla cyfrowych PDF-ów odczytuje dane w 0.05 sekundy za darmo. Modele wizyjne uruchamiamy tylko wtedy, gdy plik to zdjęcie z telefonu lub skan bez warstwy tekstowej.
                                </div>
                            </div>

                            {/* Punkt 2 */}
                            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 space-y-2">
                                <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                                    <span className="text-base">2️⃣</span>
                                    <span>Ignorowanie jednostek miary i synonimów</span>
                                </div>
                                <div className="text-rose-700 bg-rose-50 p-2.5 rounded-lg border border-rose-200">
                                    <b>Stary plan:</b> Bezpośrednie porównywanie opisu kierowcy z pozycjami na fakturze.<br />
                                    <b>Problem:</b> Kierowca mówi „15 sztuk płyt”, a na fakturze z KSeF jest „37.5 m²” albo nazwa „regipsy” zamiast „Płyta G-K”.
                                </div>
                                <div className="text-emerald-800 bg-emerald-50 p-2.5 rounded-lg border border-emerald-200">
                                    <b>Nowe rozwiązanie:</b> Warstwa normalizacji (Słownik Produktów ze współczynnikami przeliczeniowymi sztuk na m²/t + przestrzenie wektorowe/Embeddings do dopasowywania synonimów).
                                </div>
                            </div>

                            {/* Punkt 3 */}
                            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 space-y-2">
                                <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                                    <span className="text-base">3️⃣</span>
                                    <span>Brak obsługi palet w czasie i przestrzeni</span>
                                </div>
                                <div className="text-rose-700 bg-rose-50 p-2.5 rounded-lg border border-rose-200">
                                    <b>Stary plan:</b> Traktowanie każdej wiadomości o paletach jako osobnego zdarzenia.<br />
                                    <b>Problem:</b> Znikanie palet między bazą centralną a hurtownią CMB (kierowca bierze 20 z Tuchowa, wiezie na bazę, oddaje po 3 dniach do CMB).
                                </div>
                                <div className="text-emerald-800 bg-emerald-50 p-2.5 rounded-lg border border-emerald-200">
                                    <b>Nowe rozwiązanie:</b> Agent Paletowy z pamięcią epizodyczną śledzący cykl życia aktywów zwrotnych, który potrafi skorelować poranną wypowiedź z tym, co działo się kilka dni wcześniej.
                                </div>
                            </div>

                            {/* Punkt 4 */}
                            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 space-y-2">
                                <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                                    <span className="text-base">4️⃣</span>
                                    <span>Przestarzałe wersje modeli AI</span>
                                </div>
                                <div className="text-rose-700 bg-rose-50 p-2.5 rounded-lg border border-rose-200">
                                    <b>Stary plan:</b> Używanie modeli ze starej serii Gemini 2.5.<br />
                                    <b>Problem:</b> Modele wycofywane na Vertex AI / błędy krytyczne HTTP 400.
                                </div>
                                <div className="text-emerald-800 bg-emerald-50 p-2.5 rounded-lg border border-emerald-200">
                                    <b>Nowe rozwiązanie:</b> Oficjalna migracja definicji modeli na <b>Gemini 3.5 Flash-Lite</b> (dla Routera i szybkich zadań) oraz <b>Gemini 3.5 / 3.8 Flash</b> (dla Agentów i analizy wizyjnej).
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Podsumowanie wdrożeniowe */}
                    <div className="bg-slate-900 text-white p-5 rounded-xl border border-slate-800 space-y-3 text-xs">
                        <div className="font-bold text-amber-400 text-sm flex items-center gap-2">
                            <span>🚦 Podsumowanie wdrożeniowe dla Szefa / Zespołu:</span>
                        </div>
                        <ul className="space-y-2 text-slate-300">
                            <li className="flex items-start gap-2">
                                <span className="text-emerald-400 font-bold">&check;</span>
                                <span><b>Kierowca nie musi klikać:</b> dyktuje głosowo lub robi zdjęcie WZ-ki ze smartfona.</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <span className="text-emerald-400 font-bold">&check;</span>
                                <span><b>Kserokopiarka / skaner w biurze:</b> wrzuca pliki do folderu, gdzie Python błyskawicznie (0.05s) i bezkosztowo parsuje czyste PDF-y z Comarcha.</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <span className="text-emerald-400 font-bold">&check;</span>
                                <span><b>Agent AI:</b> dopasowuje rozmyte nazwy (regipsy &rarr; płyty G-K), przelicza jednostki (sztuki &rarr; m²) i paruje dokumenty z KSeF.</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <span className="text-emerald-400 font-bold">&check;</span>
                                <span><b>Barierki (HITL):</b> pilnują, żeby człowiek (księgowa / kierownik) zatwierdził każdą anomalię cenową, rozbieżność lub brakujący dokument.</span>
                            </li>
                        </ul>
                    </div>

                    {/* Barierki Bezpieczeństwa */}
                    <div className="space-y-2">
                        <h4 className="text-xs font-bold text-slate-600 uppercase tracking-wider">Barierki Bezpieczeństwa (Guardrails):</h4>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                            <div className="border border-slate-200 p-4 rounded-xl space-y-2">
                                <div className="font-bold text-slate-800 flex items-center gap-2">
                                    <span>🔒 Barierka 1: Dane Wrażliwe</span>
                                </div>
                                <p className="text-slate-600">
                                    Modele językowe nie mają dostępu do kolekcji `users` i `roles`. Uwierzytelnianie odbywa się wyłącznie twardym kodem (`firebase-admin`).
                                </p>
                            </div>
                            <div className="border border-slate-200 p-4 rounded-xl space-y-2">
                                <div className="font-bold text-slate-800 flex items-center gap-2">
                                    <span>⚖️ Barierka 2: Compliance as Code</span>
                                </div>
                                <p className="text-slate-600">
                                    Próby łamania procedur (np. nieuprawnione przyjęcie palet) generują natychmiastowe alerty dla dyrekcji i audytu.
                                </p>
                            </div>
                            <div className="border border-slate-200 p-4 rounded-xl space-y-2">
                                <div className="font-bold text-slate-800 flex items-center gap-2">
                                    <span>💰 Barierka 3: Finanse HITL</span>
                                </div>
                                <p className="text-slate-600">
                                    Żaden agent AI nie wykonuje przelewów ani ostatecznych zaksięgowań kosztów w ERP bez formalnej akceptacji człowieka.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
