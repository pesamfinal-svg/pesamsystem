// src/app/(dashboard)/dashboard/biuro/page.tsx
'use client';

import { useState } from 'react';

type TabType = 'overview' | 'router' | 'hitl' | 'pallets' | 'fuzzymatch' | 'architecture';

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
                    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
                        <div>
                            <h2 className="text-lg font-bold text-slate-800">Smart Router Dokumentów (Optymalizacja Kosztów AI)</h2>
                            <p className="text-sm text-slate-500">
                                System sprawdza, czy plik posiada cyfrową warstwę tekstową. Jeśli tak — uruchamia <b>Fast Path</b> (Python/pdfplumber, czas 0.05s, koszt 0 zł). Modele wizyjne <b>Slow Path</b> (Gemini Flash) są wywoływane tylko dla pogniecionych zdjęć i skanów.
                            </p>
                        </div>

                        {/* Symulacja kanałów wejścia */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
                            <div className="border border-slate-200 p-5 rounded-xl hover:border-blue-400 transition flex flex-col justify-between space-y-3">
                                <div>
                                    <span className="text-3xl">📄</span>
                                    <h3 className="font-bold text-slate-800 mt-2">PDF z maila (Comarch ERP Optima)</h3>
                                    <p className="text-xs text-slate-500 mt-1">
                                        Plik cyfrowy wygenerowany z systemu ERP hurtowni z pełną warstwą wektorową tekstu.
                                    </p>
                                </div>
                                <button
                                    onClick={() => handleSimulateRouter('pdf')}
                                    disabled={processingSimulation}
                                    className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-lg transition"
                                >
                                    ⚡ Testuj Fast Path (0 zł)
                                </button>
                            </div>

                            <div className="border border-slate-200 p-5 rounded-xl hover:border-blue-400 transition flex flex-col justify-between space-y-3">
                                <div>
                                    <span className="text-3xl">👁️</span>
                                    <h3 className="font-bold text-slate-800 mt-2">Zdjęcie z kabiny auta</h3>
                                    <p className="text-xs text-slate-500 mt-1">
                                        Zdjęcie WZ-ki wykonane smartfonem kierowcy na budowie (brak warstwy tekstowej).
                                    </p>
                                </div>
                                <button
                                    onClick={() => handleSimulateRouter('photo')}
                                    disabled={processingSimulation}
                                    className="w-full py-2 bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs rounded-lg transition"
                                >
                                    👁️ Testuj Slow Path (Vision LLM)
                                </button>
                            </div>

                            <div className="border border-slate-200 p-5 rounded-xl hover:border-blue-400 transition flex flex-col justify-between space-y-3">
                                <div>
                                    <span className="text-3xl">🎙️</span>
                                    <h3 className="font-bold text-slate-800 mt-2">Notatka głosowa kierowcy</h3>
                                    <p className="text-xs text-slate-500 mt-1">
                                        Szybkie nagranie foniczne z trasy: status dostawy, zwroty palet, braki asortymentu.
                                    </p>
                                </div>
                                <button
                                    onClick={() => handleSimulateRouter('voice')}
                                    disabled={processingSimulation}
                                    className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-lg transition"
                                >
                                    🗣️ Testuj Whisper + Pamięć
                                </button>
                            </div>
                        </div>

                        {/* Wynik symulacji */}
                        {processingSimulation && (
                            <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-700 font-semibold animate-pulse flex items-center gap-2">
                                <span className="animate-spin">⏳</span>
                                Smart Router analizuje warstwę tekstową pliku i uruchamia odpowiedni procesor...
                            </div>
                        )}

                        {simulatedResult && (
                            <div className="p-4 bg-slate-900 text-white rounded-xl text-xs font-mono border border-slate-800 space-y-1">
                                <div className="text-slate-400 font-bold uppercase text-[10px]">Raport Smart Routera:</div>
                                <div className="text-emerald-400">{simulatedResult}</div>
                            </div>
                        )}
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
                        <h2 className="text-lg font-bold text-slate-800">Dokumentacja Architektoniczna PESAM-DOC v2.0</h2>
                        <p className="text-sm text-slate-500">Zatwierdzony model integracji i barierki bezpieczeństwa (Guardrails)</p>
                    </div>

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
            )}
        </div>
    );
}
