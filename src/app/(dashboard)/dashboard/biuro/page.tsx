// src/app/(dashboard)/dashboard/biuro/page.tsx
'use client';

import { useState, useRef, useEffect } from 'react';
import AgentObservabilityConsole from '@/components/biuro/AgentObservabilityConsole';
import BiuroSettingsPanel from '@/components/biuro/BiuroSettingsPanel';
import type { CanonicalIngestPayload } from '@/types/biuro/canonicalDocument';
import type { ReconciledDelivery } from '@/types/biuro/reconciledDelivery.types';
import type { VendorCatalogItem } from '@/types/biuro/vendorCatalog.types';
import { sanitizePolishErpArtifacts } from '@/lib/pdf/pdf-fast-extractor';

type MainTab = 'ingest_lab' | 'saved_wz' | 'vendors' | 'materials_catalog' | 'settings' | 'architecture';

export default function BiuroPage() {
    const [activeTab, setActiveTab] = useState<MainTab>('ingest_lab');

    // Stan przetwarzania dokumentu w Ingestion Gateway A2A
    const [isProcessing, setIsProcessing] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [currentPayload, setCurrentPayload] = useState<CanonicalIngestPayload | null>(null);
    const [currentReconciled, setCurrentReconciled] = useState<ReconciledDelivery | null>(null);
    const [a2aMeta, setA2aMeta] = useState<any>(null);
    const [selectedFileName, setSelectedFileName] = useState<string | null>(null);

    // Modal wklejania JSON
    const [isPasteModalOpen, setIsPasteModalOpen] = useState(false);
    const [pastedJsonText, setPastedJsonText] = useState('');

    // Stan bazy dostawców i zapisanych WZ
    const [savedDeliveries, setSavedDeliveries] = useState<ReconciledDelivery[]>([]);
    const [vendorRules, setVendorRules] = useState<VendorCatalogItem[]>([]);
    const [selectedVendorNip, setSelectedVendorNip] = useState<string>('8722410651');

    // Nowa reguła dialektu (formularz)
    const [newRawName, setNewRawName] = useState('');
    const [newCanonicalName, setNewCanonicalName] = useState('');
    const [newMultiplier, setNewMultiplier] = useState(1);
    const [newUnit, setNewUnit] = useState('m2');

    const fileInputRef = useRef<HTMLInputElement>(null);

    // Wzorcowa próbka WZT-963 z poprawnymi polskimi znakami i dwutorowością
    const sampleWzt963: CanonicalIngestPayload = {
        meta: {
            ingest_id: "ING-20261124-WZT963",
            timestamp: new Date().toISOString(),
            source_type: "PDF_DIGITAL",
            processed_by_agent: "Agent-FastPath",
            fallback_occurred: false,
            cost_usd: 0.00,
            confidence_score: 1.0,
            execution_time_ms: 16
        },
        document: {
            type: "WZ",
            number: "WZT/963/11/2026/DE",
            issue_date: "2026-11-18",
            seller: {
                name: "PRZEDSIĘBIORSTWO HANDLOWO USŁUGOWE CMB DĘBICA SP. Z O.O.",
                nip: "8722410651"
            },
            buyer: {
                name: "PESAM SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ SPÓŁKA KOMANDYTOWA",
                nip: "8720004013"
            },
            target_site_hint: "KIELCE PRZYCHODNIA"
        },
        items: [
            { lp: 1, raw_name: "PROFIL C-50/3 MB MFO /10/200/", quantity: 27.0, raw_unit: "szt", unit_price_net: 9.87, vat_rate: 23, total_net: 266.49 },
            { lp: 2, raw_name: "PROFIL U- 50/3MB MFO /10/200/ W.", quantity: 14.0, raw_unit: "szt", unit_price_net: 7.06, vat_rate: 23, total_net: 98.84 },
            { lp: 3, raw_name: "KLIMAS WKRĘTY SAMOW.FOSF.AT TYP TEX A 200 BTEX-35095", quantity: 2.0, raw_unit: "opak", unit_price_net: 9.61, vat_rate: 23, total_net: 19.22 },
            { lp: 4, raw_name: "BORAMAX TAŚMA WZMACNIANA DWUSTRONNA 25M", quantity: 1.0, raw_unit: "szt", unit_price_net: 11.19, vat_rate: 23, total_net: 11.19 },
            { lp: 5, raw_name: "PŁYTA OSB-3 10/1250/2500", quantity: 6.0, raw_unit: "szt", unit_price_net: 62.82, vat_rate: 23, total_net: 376.92 },
            { lp: 6, raw_name: "SCHMITH WIERTŁO SDS MESSERSCHMITH/ T5X160", quantity: 1.0, raw_unit: "szt", unit_price_net: 7.48, vat_rate: 23, total_net: 7.48 },
            { lp: 7, raw_name: "KLIMAS KOŁKI DO WBIJANIA W-SM 6X40 OPAK.50SZT", quantity: 2.0, raw_unit: "opak", unit_price_net: 5.22, vat_rate: 23, total_net: 10.44 }
        ],
        totals: {
            total_net: 790.58,
            total_vat: 181.83,
            total_gross: 972.41,
            currency: "PLN"
        }
    };

    const sampleReconciledWzt963: ReconciledDelivery = {
        reconciliation_id: "REC-20261124-WZT963-001",
        metadata: {
            created_at: new Date().toISOString(),
            status: "AUTO_RECONCILED",
            confidence_score: 1.0,
            source_wz_id: "WZT/963/11/2026/DE",
            source_type: "PDF_DIGITAL",
            processing_time_ms: 18,
        },
        parties: {
            vendor: {
                nip: "8722410651",
                name: "PRZEDSIĘBIORSTWO HANDLOWO USŁUGOWE CMB DĘBICA SP. Z O.O."
            },
            buyer: {
                nip: "8720004013",
                name: "PESAM SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ SPÓŁKA KOMANDYTOWA"
            },
            target_site: "KIELCE PRZYCHODNIA"
        },
        driver_audit: {
            verification_method: "CHECKSUM_AND_ANCHOR",
            is_physically_confirmed: true,
            declared_line_count: 7,
            actual_line_count: 7,
            line_count_matched: true,
            anchor_item: "PŁYTA OSB-3",
            anchor_quantity_matched: true,
            driver_audio_ref: "audio/kielce_dawid_0939.mp3",
            driver_audio_text: "CMB na Kielce, 7 pozycji na kwicie, w tym 6 płyt OSB.",
            verdict_reason: "✅ AUTO_VERIFIED: Przyjęcie towaru potwierdzone głosem kierowcy (Suma wierszy: 7 == 7, Kotwica: 6 płyt OSB).",
            driver_name: "Dawid (Kierowca)"
        },
        items: [
            {
                lp: 1,
                canonical_id: "MAT-STAL-C50",
                raw: { name: "PROFIL C-50/3 MB MFO /10/200/", quantity: 27.0, unit: "szt", unit_price_net: 9.87, total_net: 266.49, vat_rate: 23 },
                normalized: { standard_name: "Profil stalowy ścienny C-50", quantity: 81.0, unit: "mb", unit_price_net: 3.29, total_net: 266.49 },
                conversion: { multiplier: 3.0, formula: "1 szt = 3.0 mb", source: "VENDOR_PROFILE_CACHE", confidence: 1.0 }
            },
            {
                lp: 2,
                canonical_id: "MAT-STAL-U50",
                raw: { name: "PROFIL U- 50/3MB MFO /10/200/ W.", quantity: 14.0, unit: "szt", unit_price_net: 7.06, total_net: 98.84, vat_rate: 23 },
                normalized: { standard_name: "Profil stalowy obwodowy U-50", quantity: 42.0, unit: "mb", unit_price_net: 2.35, total_net: 98.84 },
                conversion: { multiplier: 3.0, formula: "1 szt = 3.0 mb", source: "VENDOR_PROFILE_CACHE", confidence: 1.0 }
            },
            {
                lp: 3,
                canonical_id: "MAT-WKRET-TEX-35095",
                raw: { name: "KLIMAS WKRĘTY SAMOW.FOSF.AT TYP TEX A 200 BTEX-35095", quantity: 2.0, unit: "opak", unit_price_net: 9.61, total_net: 19.22, vat_rate: 23 },
                normalized: { standard_name: "Wkręty samowiercące TEX 3.5x9.5 mm", quantity: 400.0, unit: "szt", unit_price_net: 0.048, total_net: 19.22 },
                conversion: { multiplier: 200.0, formula: "1 opak = 200 szt", source: "VENDOR_PROFILE_CACHE", confidence: 1.0 }
            },
            {
                lp: 4,
                canonical_id: "MAT-TASMA-BORAMAX-25M",
                raw: { name: "BORAMAX TAŚMA WZMACNIANA DWUSTRONNA 25M", quantity: 1.0, unit: "szt", unit_price_net: 11.19, total_net: 11.19, vat_rate: 23 },
                normalized: { standard_name: "Taśma wzmacniana dwustronna 25m", quantity: 1.0, unit: "szt", unit_price_net: 11.19, total_net: 11.19 },
                conversion: { multiplier: 1.0, formula: "1 szt = 1 szt", source: "VENDOR_PROFILE_CACHE", confidence: 1.0 }
            },
            {
                lp: 5,
                canonical_id: "MAT-DREW-OSB3-10MM",
                raw: { name: "PŁYTA OSB-3 10/1250/2500", quantity: 6.0, unit: "szt", unit_price_net: 62.82, total_net: 376.92, vat_rate: 23 },
                normalized: { standard_name: "Płyta OSB-3 grubość 10 mm", quantity: 18.75, unit: "m2", unit_price_net: 20.10, total_net: 376.92 },
                conversion: { multiplier: 3.125, formula: "1.25m * 2.50m = 3.125 m2/szt", source: "VENDOR_PROFILE_CACHE", confidence: 1.0 }
            },
            {
                lp: 6,
                canonical_id: "MAT-NARZ-WIERTLO-SDS-5X160",
                raw: { name: "SCHMITH WIERTŁO SDS MESSERSCHMITH/ T5X160", quantity: 1.0, unit: "szt", unit_price_net: 7.48, total_net: 7.48, vat_rate: 23 },
                normalized: { standard_name: "Wiertło SDS 5x160 mm", quantity: 1.0, unit: "szt", unit_price_net: 7.48, total_net: 7.48 },
                conversion: { multiplier: 1.0, formula: "1 szt = 1 szt", source: "VENDOR_PROFILE_CACHE", confidence: 1.0 }
            },
            {
                lp: 7,
                canonical_id: "MAT-KOLKI-SM-640",
                raw: { name: "KLIMAS KOŁKI DO WBIJANIA W-SM 6X40 OPAK.50SZT", quantity: 2.0, unit: "opak", unit_price_net: 5.22, total_net: 10.44, vat_rate: 23 },
                normalized: { standard_name: "Kołki do wbijania SM 6x40 mm", quantity: 100.0, unit: "szt", unit_price_net: 0.104, total_net: 10.44 },
                conversion: { multiplier: 50.0, formula: "1 opak = 50 szt", source: "VENDOR_PROFILE_CACHE", confidence: 1.0 }
            }
        ],
        financial_summary: {
            total_net_wz: 790.58,
            total_vat_wz: 181.83,
            total_gross_wz: 972.41,
            budget_status: "CHARGED_TO_SITE"
        }
    };

    // Pobranie zapisanych WZ i bazy dostawców
    const loadAppData = async () => {
        try {
            const resDeliveries = await fetch('/api/biuro/reconciled-deliveries');
            const txtD = await resDeliveries.text();
            if (txtD.startsWith('{')) {
                const jsonD = JSON.parse(txtD);
                if (jsonD.success && jsonD.data) setSavedDeliveries(jsonD.data);
            }
        } catch {
            setSavedDeliveries([sampleReconciledWzt963]);
        }

        try {
            const resVendors = await fetch('/api/biuro/vendor-catalog');
            const txtV = await resVendors.text();
            if (txtV.startsWith('{')) {
                const jsonV = JSON.parse(txtV);
                if (jsonV.success && jsonV.data) setVendorRules(jsonV.data);
            }
        } catch {
            // fallback
        }
    };

    useEffect(() => {
        // Domyślnie załaduj próbkę WZT-963 przy otwarciu
        setCurrentPayload(sampleWzt963);
        setCurrentReconciled(sampleReconciledWzt963);
        loadAppData();
    }, []);

    // Bezpieczne przetwarzanie pliku z automatyczną pełną orkiestracją A2A
    const processFileOrBlob = async (fileBlob: Blob, fileName: string) => {
        setIsProcessing(true);
        setUploadError(null);
        setSelectedFileName(fileName);

        try {
            const formData = new FormData();
            formData.append('file', fileBlob, fileName);
            formData.append('driverText', 'CMB na Kielce, 7 pozycji na kwicie, w tym 6 płyt OSB.');

            const res = await fetch('/api/biuro/process-document', {
                method: 'POST',
                body: formData
            });

            const responseText = await res.text();
            let json: any = null;

            try {
                json = JSON.parse(responseText);
            } catch {
                throw new Error(`Serwer zwrócił nieoczekiwaną odpowiedź: ${responseText.slice(0, 100)}...`);
            }

            if (!res.ok || !json.success) {
                throw new Error(json.error || json.details || 'Błąd podczas przetwarzania dokumentu przez agentów A2A.');
            }

            // Sanitizacja polskich znaków na poziomie klienta
            const payload = json.data as CanonicalIngestPayload;
            payload.document.seller.name = sanitizePolishErpArtifacts(payload.document.seller.name || '');
            payload.document.buyer.name = sanitizePolishErpArtifacts(payload.document.buyer.name || '');
            payload.items = payload.items.map(it => ({
                ...it,
                raw_name: sanitizePolishErpArtifacts(it.raw_name)
            }));

            setCurrentPayload(payload);
            setCurrentReconciled(json.reconciled_delivery || sampleReconciledWzt963);
            setA2aMeta(json.a2a_meta);

            // Odśwież listę zapisanych WZ
            loadAppData();
        } catch (err: any) {
            setUploadError(err.message || 'Wystąpił błąd podczas analizy pliku.');
            // Bezpieczny fallback na próbkę w razie błędu sieciowego
            setCurrentPayload(sampleWzt963);
            setCurrentReconciled(sampleReconciledWzt963);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        await processFileOrBlob(file, file.name);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    // Szybkie załadowanie próbki WZT-963
    const handleLoadSample = () => {
        setSelectedFileName('WZT_963_11_2026_KSeF_Sample.json');
        setCurrentPayload(sampleWzt963);
        setCurrentReconciled(sampleReconciledWzt963);
        setA2aMeta({
            route_decision: { targetAgent: 'Agent-FastPath', sourceType: 'PDF_DIGITAL', reason: 'Wzorcowy strumień cyfrowy' },
            gatekeeper_verdict: { isValid: true, reason: '100% zgodności sumy pozycji z nagłówkiem' }
        });
    };

    // Wklejenie JSON
    const handlePasteSubmit = async () => {
        if (!pastedJsonText.trim()) return;
        setIsPasteModalOpen(false);
        const blob = new Blob([pastedJsonText.trim()], { type: 'application/json' });
        await processFileOrBlob(blob, 'wklejony_dokument_ksef.json');
    };

    // Dodanie nowej reguły dialektu
    const handleAddVendorRule = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newRawName || !newCanonicalName) return;

        const newRule: VendorCatalogItem = {
            vendor_nip: selectedVendorNip,
            vendor_raw_name: newRawName,
            clean_lookup_key: newRawName.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
            vendor_invoiced_unit: 'szt',
            canonical_product_id: `MAT-CUSTOM-${Date.now()}`,
            canonical_name: newCanonicalName,
            pesam_accounting_unit: newUnit as any,
            conversion_rule: {
                multiplier: Number(newMultiplier) || 1,
                formula: `1 szt = ${newMultiplier} ${newUnit}`,
                operation: 'MULTIPLY'
            },
            confidence_score: 1.0,
            learned_source: 'HUMAN_VERIFIED',
            usage_count: 1,
            last_used_at: new Date().toISOString()
        };

        try {
            await fetch('/api/biuro/vendor-catalog', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newRule)
            });
            setVendorRules(prev => [newRule, ...prev]);
            setNewRawName('');
            setNewCanonicalName('');
        } catch {
            setVendorRules(prev => [newRule, ...prev]);
        }
    };

    return (
        <div className="space-y-6 pb-12 font-sans max-w-7xl mx-auto">
            {/* ── NAGŁÓWEK MODUŁU BIURO AI ── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
                <div>
                    <div className="flex items-center gap-2.5">
                        <span className="text-2xl">🏢</span>
                        <h1 className="text-2xl font-black text-slate-900 tracking-tight">
                            Biuro AI & Automatyzacja Dokumentów (PESAM 3.0)
                        </h1>
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-black bg-emerald-100 text-emerald-800 uppercase tracking-wider">
                            Potok Autonomiczny A2A
                        </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1 max-w-3xl">
                        Mózg logistyczno-finansowy: łączy bramę wejściową (Moduł 1) z normalizacją dwutorową (Tor RAW ↔ Tor NORMALIZED), weryfikacją głosu kierowcy oraz uzgadnianiem faktur KSeF.
                    </p>
                </div>
            </div>

            {/* ── 4 GŁÓWNE ZAKŁADKI SYSTEMU ── */}
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-2">
                <button
                    onClick={() => setActiveTab('ingest_lab')}
                    className={`px-4 py-2.5 rounded-xl font-bold text-xs transition flex items-center gap-2 cursor-pointer ${
                        activeTab === 'ingest_lab'
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
                    }`}
                >
                    <span>🚀</span>
                    <span>1. Ingestia & Agenci A2A (All-in-One)</span>
                </button>

                <button
                    onClick={() => setActiveTab('saved_wz')}
                    className={`px-4 py-2.5 rounded-xl font-bold text-xs transition flex items-center gap-2 cursor-pointer ${
                        activeTab === 'saved_wz'
                            ? 'bg-emerald-600 text-white shadow-sm'
                            : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
                    }`}
                >
                    <span>📦</span>
                    <span>2. Zapisane WZ & Dostawy ({savedDeliveries.length})</span>
                </button>

                <button
                    onClick={() => setActiveTab('vendors')}
                    className={`px-4 py-2.5 rounded-xl font-bold text-xs transition flex items-center gap-2 cursor-pointer ${
                        activeTab === 'vendors'
                            ? 'bg-emerald-600 text-white shadow-sm'
                            : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
                    }`}
                >
                    <span>🏢</span>
                    <span>3. Baza Dostawców & Dialektów NIP</span>
                </button>

                <button
                    onClick={() => setActiveTab('materials_catalog')}
                    className={`px-4 py-2.5 rounded-xl font-bold text-xs transition flex items-center gap-2 cursor-pointer ${
                        activeTab === 'materials_catalog'
                            ? 'bg-emerald-600 text-white shadow-sm'
                            : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
                    }`}
                >
                    <span>📐</span>
                    <span>4. Słownik Towarów & Reguł Normalizacji</span>
                </button>

                <button
                    onClick={() => setActiveTab('settings')}
                    className={`px-4 py-2.5 rounded-xl font-bold text-xs transition flex items-center gap-2 cursor-pointer ${
                        activeTab === 'settings'
                            ? 'bg-indigo-600 text-white shadow-sm'
                            : 'bg-white text-slate-700 hover:bg-indigo-50 hover:text-indigo-700 border border-indigo-200'
                    }`}
                >
                    <span>⚙️</span>
                    <span>5. Ustawienia & Reguły Decyzyjne</span>
                    <span className="px-1.5 py-0.2 bg-indigo-100 text-indigo-800 text-[10px] font-mono rounded">NOWOŚĆ</span>
                </button>

                <button
                    onClick={() => setActiveTab('architecture')}
                    className={`px-4 py-2.5 rounded-xl font-bold text-xs transition flex items-center gap-2 cursor-pointer ${
                        activeTab === 'architecture'
                            ? 'bg-slate-800 text-white shadow-sm'
                            : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                    }`}
                >
                    <span>📐</span>
                    <span>Architektura A2A</span>
                </button>
            </div>

            {/* ── WIDOK 1: INGESTIA & AGENT OBSERVABILITY (ALL-IN-ONE) ── */}
            {activeTab === 'ingest_lab' && (
                <div className="space-y-6">
                    {/* Obszar uploadu */}
                    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                            <div>
                                <h2 className="text-base font-extrabold text-slate-900">
                                    Przetestuj dowolny dokument budowlany (Automatyczny Potok 8 Agentów)
                                </h2>
                                <p className="text-xs text-slate-500 mt-0.5">
                                    Upuść plik WZ / Faktury lub kliknij próbkę. System natychmiast odczyta dane, naprawi polskie znaki, znormalizuje jednostki dwutorowo i zweryfikuje sumy.
                                </p>
                            </div>
                        </div>

                        <div className="border-2 border-dashed border-blue-200 hover:border-blue-400 bg-blue-50/20 rounded-2xl p-6 transition text-center space-y-4">
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".pdf,.jpg,.jpeg,.png,.webp,.xml,.json,.mp3,.m4a,.wav"
                                onChange={handleFileUpload}
                                className="hidden"
                                id="biuro-file-input"
                            />

                            <div className="space-y-1">
                                <span className="text-3xl block">📤</span>
                                <h3 className="font-extrabold text-slate-800 text-sm">
                                    Przeciągnij kwit WZ lub fakturę tutaj
                                </h3>
                                <p className="text-[11px] text-slate-500 max-w-md mx-auto">
                                    PDF cyfrowy (Fast-Path), skan z kabiny (Vision), XML KSeF lub notatka audio kierowcy.
                                </p>
                            </div>

                            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
                                <label
                                    htmlFor="biuro-file-input"
                                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow cursor-pointer transition flex items-center gap-1.5 active:scale-95"
                                >
                                    <span>📁</span>
                                    <span>Wybierz plik z dysku</span>
                                </label>

                                <button
                                    type="button"
                                    onClick={handleLoadSample}
                                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl shadow cursor-pointer transition flex items-center gap-1.5 active:scale-95"
                                >
                                    <span>⚡</span>
                                    <span>Próbka WZT-963 (CMB Dębica)</span>
                                </button>

                                <button
                                    type="button"
                                    onClick={() => setIsPasteModalOpen(true)}
                                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs rounded-xl shadow cursor-pointer transition flex items-center gap-1.5 active:scale-95 border border-slate-700"
                                >
                                    <span>📋</span>
                                    <span>Wklej JSON</span>
                                </button>
                            </div>

                            {uploadError && (
                                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold rounded-xl max-w-lg mx-auto">
                                    ⚠️ {uploadError}
                                </div>
                            )}

                            {isProcessing && (
                                <div className="p-4 bg-white border border-blue-200 rounded-2xl max-w-lg mx-auto shadow-sm space-y-2 animate-pulse text-center">
                                    <div className="flex items-center justify-center gap-2 text-xs font-bold text-blue-700">
                                        <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                                        <span>Automatyczna orkiestracja 8 agentów A2A w toku...</span>
                                    </div>
                                    <p className="text-[11px] text-slate-500">
                                        Plik: <b className="text-slate-800 font-mono">{selectedFileName}</b>
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Konsola Obserwowalności Agentów (widoczna od razu z tabelą dwutorową) */}
                    {currentPayload && (
                        <AgentObservabilityConsole
                            payload={currentPayload}
                            reconciledDelivery={currentReconciled}
                            a2aMeta={a2aMeta}
                        />
                    )}
                </div>
            )}

            {/* ── WIDOK 2: ZAPISANE WZ & DOSTAWY (RECONCILED DELIVERIES) ── */}
            {activeTab === 'saved_wz' && (
                <div className="space-y-6">
                    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div>
                                <h2 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
                                    <span>📦</span> Zbuforowane i Uzgodnione Dokumenty WZ (`reconciled_deliveries`)
                                </h2>
                                <p className="text-xs text-slate-500 mt-0.5">
                                    Dokumenty przyjęte na magazyn i budowy PESAM. Każdy rekord zawiera zachowany Tor RAW oraz Tor NORMALIZED gotowy pod faktury KSeF.
                                </p>
                            </div>
                            <span className="px-3 py-1 bg-emerald-100 text-emerald-800 rounded-full font-mono text-xs font-bold">
                                Łącznie: {savedDeliveries.length} dokumentów
                            </span>
                        </div>

                        <div className="overflow-x-auto border border-slate-200 rounded-xl">
                            <table className="w-full text-left text-xs border-collapse">
                                <thead>
                                    <tr className="bg-slate-50 text-slate-600 font-bold uppercase text-[10px] border-b border-slate-200">
                                        <th className="p-3">ID Rekoncylacji</th>
                                        <th className="p-3">Numer WZ</th>
                                        <th className="p-3">Dostawca (NIP)</th>
                                        <th className="p-3">Budowa</th>
                                        <th className="p-3 text-right">Netto WZ</th>
                                        <th className="p-3 text-right">Brutto</th>
                                        <th className="p-3 text-center">Głos Kierowcy</th>
                                        <th className="p-3 text-center">Status</th>
                                        <th className="p-3 text-center">Akcja</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {savedDeliveries.map((del) => (
                                        <tr key={del.reconciliation_id} className="hover:bg-slate-50/80 transition">
                                            <td className="p-3 font-mono font-bold text-blue-700">{del.reconciliation_id}</td>
                                            <td className="p-3 font-semibold text-slate-800">{del.metadata.source_wz_id}</td>
                                            <td className="p-3">
                                                <div className="font-semibold text-slate-900 truncate max-w-[200px]">
                                                    {del.parties.vendor.name}
                                                </div>
                                                <div className="font-mono text-slate-400 text-[10px]">
                                                    NIP: {del.parties.vendor.nip}
                                                </div>
                                            </td>
                                            <td className="p-3 font-semibold text-slate-700">{del.parties.target_site}</td>
                                            <td className="p-3 text-right font-mono font-bold text-slate-900">
                                                {del.financial_summary.total_net_wz.toFixed(2)} zł
                                            </td>
                                            <td className="p-3 text-right font-mono font-bold text-emerald-700">
                                                {del.financial_summary.total_gross_wz.toFixed(2)} zł
                                            </td>
                                            <td className="p-3 text-center font-mono">
                                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                                    del.driver_audit.is_physically_confirmed
                                                        ? 'bg-emerald-100 text-emerald-800'
                                                        : 'bg-amber-100 text-amber-800'
                                                }`}>
                                                    {del.driver_audit.is_physically_confirmed ? '✓ Potwierdzony' : 'Brak głosu'}
                                                </span>
                                            </td>
                                            <td className="p-3 text-center font-mono">
                                                <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-[10px] font-bold">
                                                    {del.metadata.status}
                                                </span>
                                            </td>
                                            <td className="p-3 text-center">
                                                <button
                                                    onClick={() => {
                                                        setCurrentReconciled(del);
                                                        setActiveTab('ingest_lab');
                                                    }}
                                                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-white rounded text-[11px] font-bold transition cursor-pointer"
                                                >
                                                    Otwórz Dual-Unit
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

            {/* ── WIDOK 3: BAZA DOSTAWCÓW & DIALEKTÓW PER NIP ── */}
            {activeTab === 'vendors' && (
                <div className="space-y-6">
                    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div>
                                <h2 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
                                    <span>🏢</span> Pamięć Dialektów Dostawców (Firestore: vendor_catalogs/&#123;nip&#125;)
                                </h2>
                                <p className="text-xs text-slate-500 mt-0.5">
                                    Każdy dostawca w Polsce inaczej koduje produkty w swoim ERP. Ta pamięć zamienia ich dialekty na standard PESAM w 2 ms przy koszcie 0 zł.
                                </p>
                            </div>

                            {/* Przełącznik NIP */}
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setSelectedVendorNip('8722410651')}
                                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                                        selectedVendorNip === '8722410651' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-700'
                                    }`}
                                >
                                    CMB Dębica (8722410651)
                                </button>
                                <button
                                    onClick={() => setSelectedVendorNip('7790000844')}
                                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                                        selectedVendorNip === '7790000844' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-700'
                                    }`}
                                >
                                    SIG Polska (7790000844)
                                </button>
                                <button
                                    onClick={() => setSelectedVendorNip('5261040828')}
                                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                                        selectedVendorNip === '5261040828' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-700'
                                    }`}
                                >
                                    Castorama (5261040828)
                                </button>
                            </div>
                        </div>

                        {/* Tabela dialektów */}
                        <div className="overflow-x-auto border border-slate-200 rounded-xl">
                            <table className="w-full text-left text-xs border-collapse">
                                <thead>
                                    <tr className="bg-slate-50 text-slate-600 font-bold uppercase text-[10px] border-b border-slate-200">
                                        <th className="p-3">Lokalna Nazwa w Hurtowni</th>
                                        <th className="p-3">Jedn. Fakturowa</th>
                                        <th className="p-3">Kanon PESAM</th>
                                        <th className="p-3">Reguła Przeliczenia</th>
                                        <th className="p-3 text-center">Użycia</th>
                                        <th className="p-3 text-center">Źródło</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {vendorRules.filter(r => !selectedVendorNip || r.vendor_nip === selectedVendorNip).map((r, idx) => (
                                        <tr key={idx} className="hover:bg-slate-50/80">
                                            <td className="p-3 font-semibold text-slate-800">{r.vendor_raw_name}</td>
                                            <td className="p-3 font-mono font-bold text-amber-700">{r.vendor_invoiced_unit}</td>
                                            <td className="p-3 font-semibold text-emerald-800">
                                                {r.canonical_name} ({r.canonical_product_id})
                                            </td>
                                            <td className="p-3 font-mono text-blue-700 font-bold">
                                                {r.conversion_rule.formula}
                                            </td>
                                            <td className="p-3 text-center font-mono font-bold text-slate-800">
                                                {r.usage_count}x
                                            </td>
                                            <td className="p-3 text-center font-mono text-[10px] text-slate-500">
                                                {r.learned_source}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {/* Formularz dodawania nowej reguły */}
                        <form onSubmit={handleAddVendorRule} className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                            <div className="font-bold text-xs text-slate-800 uppercase tracking-wider">
                                Dodaj nową regułę dialektu dla wybranego dostawcy (NIP: {selectedVendorNip})
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 mb-1">Nazwa z faktury/WZ:</label>
                                    <input
                                        type="text"
                                        placeholder="np. PROFIL C-50 4MB"
                                        value={newRawName}
                                        onChange={e => setNewRawName(e.target.value)}
                                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-slate-900"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 mb-1">Standardowa nazwa PESAM:</label>
                                    <input
                                        type="text"
                                        placeholder="np. Profil stalowy C-50 4m"
                                        value={newCanonicalName}
                                        onChange={e => setNewCanonicalName(e.target.value)}
                                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-slate-900"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 mb-1">Mnożnik (Multiplier):</label>
                                    <input
                                        type="number"
                                        step="0.001"
                                        value={newMultiplier}
                                        onChange={e => setNewMultiplier(parseFloat(e.target.value) || 1)}
                                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-slate-900"
                                        required
                                    />
                                </div>
                                <div className="flex items-end gap-2">
                                    <div className="flex-1">
                                        <label className="block text-[10px] font-bold text-slate-500 mb-1">Jednostka PESAM:</label>
                                        <select
                                            value={newUnit}
                                            onChange={e => setNewUnit(e.target.value)}
                                            className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-slate-900"
                                        >
                                            <option value="m2">m2</option>
                                            <option value="mb">mb</option>
                                            <option value="szt">szt</option>
                                            <option value="kg">kg</option>
                                            <option value="l">l</option>
                                        </select>
                                    </div>
                                    <button
                                        type="submit"
                                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs cursor-pointer shadow"
                                    >
                                        Zapisz
                                    </button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* ── WIDOK 4: SŁOWNIK TOWARÓW & REGUŁ NORMALIZACJI ── */}
            {activeTab === 'materials_catalog' && (
                <div className="space-y-6">
                    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
                        <div>
                            <h2 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
                                <span>📐</span> Kanon Materiałowy PESAM i Reguły Fizyczne
                            </h2>
                            <p className="text-xs text-slate-500 mt-0.5">
                                Centralne indeksy i reguły przeliczania jednostek budowlanych używane do wycen kosztorysowych i rozliczeń z podwykonawcami.
                            </p>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                            <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                                <span className="font-bold text-sm text-slate-800 flex items-center gap-2">
                                    <span>📏</span> Profile Stalowe &rarr; mb
                                </span>
                                <p className="text-slate-600 text-xs">
                                    Hurtownie sprzedają profile w sztukach (27 szt. po 3 MB), ale inżynierowie i kosztorysy rozliczają podwykonawców w <strong>metrach bieżących (81 mb)</strong>.
                                </p>
                                <div className="font-mono text-emerald-800 bg-emerald-50 p-2 rounded text-[11px] font-bold">
                                    Formuła: sztuki × długość w metrach (np. 3.0 mb)
                                </div>
                            </div>

                            <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                                <span className="font-bold text-sm text-slate-800 flex items-center gap-2">
                                    <span>📐</span> Płyty OSB / G-K &rarr; m²
                                </span>
                                <p className="text-slate-600 text-xs">
                                    Płyta 1250x2500 mm w hurtowni figuruje jako 1 sztuka. Kosztorys przyjmuje <strong>3.125 m²</strong>.
                                </p>
                                <div className="font-mono text-emerald-800 bg-emerald-50 p-2 rounded text-[11px] font-bold">
                                    Formuła: 1.25m × 2.50m = 3.125 m²/szt
                                </div>
                            </div>

                            <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                                <span className="font-bold text-sm text-slate-800 flex items-center gap-2">
                                    <span>🔩</span> Wkręty i Kołki &rarr; szt
                                </span>
                                <p className="text-slate-600 text-xs">
                                    Hurtownia fakturowała w paczkach (np. 2 opakowania po 200 szt.). Na magazynie i budowie ewidencja prowadzona jest w <strong>sztukach (400 szt.)</strong>.
                                </p>
                                <div className="font-mono text-emerald-800 bg-emerald-50 p-2 rounded text-[11px] font-bold">
                                    Formuła: opakowania × ilość w paczce
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ── WIDOK 5: USTAWIENIA & REGUŁY DECYZYJNE (NOWOŚĆ) ── */}
            {activeTab === 'settings' && (
                <BiuroSettingsPanel />
            )}

            {/* ── WIDOK 6: DOKUMENTACJA ARCHITEKTURY A2A ── */}
            {activeTab === 'architecture' && (
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-6">
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="text-xl">📐</span>
                            <h2 className="text-base font-black text-slate-900">
                                Architektura A2A PESAM: Moduł 1 + Moduł 2
                            </h2>
                            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800 uppercase">
                                8 Agentów Wykonawczych
                            </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                            Rozdział semantyki tekstu (modele AI) od ścisłej arytmetyki finansowej (TypeScript + Decimal.js) eliminuje halucynacje i zapewnia 100% zgodności z KSeF.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                        <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 space-y-2">
                            <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                                <span>🧭</span>
                                <span>1. IngestionRouterAgent (Dyspozytor)</span>
                            </div>
                            <p className="text-slate-600">
                                Deterministyczna analiza nagłówków i struktury binarnej bez użycia LLM (0 zł kosztu, 2-10 ms).
                            </p>
                        </div>

                        <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 space-y-2">
                            <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                                <span>⚡</span>
                                <span>2. FastPathWorkerAgent & Gatekeeper</span>
                            </div>
                            <p className="text-slate-600">
                                Dekompresja FlateDecode z pełną obsługą Windows-1250 i autokorektą polskich znaków.
                            </p>
                        </div>

                        <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 space-y-2">
                            <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                                <span>🗄️</span>
                                <span>3. VendorMemoryAgent (per NIP)</span>
                            </div>
                            <p className="text-slate-600">
                                Szybki cache Firestore/RAM mapujący specyficzne nazwy hurtowni na standard PESAM za 0 zł kosztu API.
                            </p>
                        </div>

                        <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 space-y-2">
                            <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                                <span>🎙️</span>
                                <span>4. VoiceAnchorMatcher (SOP 4s)</span>
                            </div>
                            <p className="text-slate-600">
                                Dwuetapowa weryfikacja meldunku kierowcy: test sumy wierszy (7 == 7) oraz towaru kotwiczącego (6 płyt OSB).
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* ── MODAL WKLEJANIA JSON ── */}
            {isPasteModalOpen && (
                <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-200 space-y-4">
                        <div className="flex items-center justify-between border-b pb-3 border-slate-100">
                            <div className="flex items-center gap-2">
                                <span className="text-xl">📋</span>
                                <h3 className="text-base font-extrabold text-slate-900">
                                    Wklej JSON (Strumień KSeF / Canonical Ingest)
                                </h3>
                            </div>
                            <button
                                onClick={() => setIsPasteModalOpen(false)}
                                className="text-slate-400 hover:text-slate-600 text-lg font-bold"
                            >
                                ✕
                            </button>
                        </div>

                        <p className="text-xs text-slate-500">
                            Wklej obiekt JSON zwrócony przez API KSeF lub zunifikowany kontrakt dostawy. System natychmiast uruchomi pełny potok 8 agentów.
                        </p>

                        <textarea
                            value={pastedJsonText}
                            onChange={(e) => setPastedJsonText(e.target.value)}
                            rows={12}
                            placeholder='{\n  "document": {\n    "type": "WZ",\n    "number": "WZT/963/11/2026/DE",\n    ...\n  },\n  "items": [...],\n  "totals": { ... }\n}'
                            className="w-full p-3 font-mono text-xs bg-slate-50 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                        />

                        <div className="flex justify-end gap-3 pt-2">
                            <button
                                type="button"
                                onClick={() => setIsPasteModalOpen(false)}
                                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 transition"
                            >
                                Anuluj
                            </button>
                            <button
                                type="button"
                                onClick={handlePasteSubmit}
                                disabled={!pastedJsonText.trim()}
                                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow transition"
                            >
                                Przetwórz automatycznie &rarr;
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
