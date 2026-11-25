// src/app/(dashboard)/dashboard/biuro/page.tsx
'use client';

import React, { useState, useRef, useEffect } from 'react';
import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { db } from '@/lib/firebase/config';
import AgentObservabilityConsole from '@/components/biuro/AgentObservabilityConsole';
import BiuroSettingsPanel from '@/components/biuro/BiuroSettingsPanel';
import type { CanonicalIngestPayload } from '@/types/biuro/canonicalDocument';
import type { ReconciledDelivery } from '@/types/biuro/reconciledDelivery.types';
import type { VendorCatalogItem } from '@/types/biuro/vendorCatalog.types';
import { sanitizePolishErpArtifacts } from '@/lib/pdf/pdf-fast-extractor';

type MainTab = 'ingest_lab' | 'saved_wz' | 'vendors' | 'materials_catalog' | 'settings' | 'architecture';

interface SiteOption {
  id: string;
  name: string;
  location?: string;
  status?: string;
}

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

  // Rzeczywiste dane z Firestore (bez sztucznych baz)
  const [savedDeliveries, setSavedDeliveries] = useState<ReconciledDelivery[]>([]);
  const [expandedWzId, setExpandedWzId] = useState<string | null>(null);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [vendors, setVendors] = useState<Array<{ nip: string; name?: string }>>([]);
  const [vendorRules, setVendorRules] = useState<VendorCatalogItem[]>([]);
  const [selectedVendorNip, setSelectedVendorNip] = useState<string>('');

  // Formularz dodawania nowej reguły dialektu
  const [newVendorNip, setNewVendorNip] = useState('');
  const [newVendorName, setNewVendorName] = useState('');
  const [newRawName, setNewRawName] = useState('');
  const [newCanonicalName, setNewCanonicalName] = useState('');
  const [newMultiplier, setNewMultiplier] = useState(1);
  const [newUnit, setNewUnit] = useState('m2');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Pobranie zapisanych WZ, bazy dostawców i listy budów z Firestore
  const loadAppData = async () => {
    // 1. Zapisane WZ
    try {
      const resDeliveries = await fetch('/api/biuro/reconciled-deliveries');
      const txtD = await resDeliveries.text();
      if (txtD.startsWith('{')) {
        const jsonD = JSON.parse(txtD);
        if (jsonD.success && Array.isArray(jsonD.data)) {
          setSavedDeliveries(jsonD.data);
        }
      }
    } catch {
      setSavedDeliveries([]);
    }

    // 2. Baza Dostawców & Dialektów
    try {
      const resVendors = await fetch('/api/biuro/vendor-catalog');
      const txtV = await resVendors.text();
      if (txtV.startsWith('{')) {
        const jsonV = JSON.parse(txtV);
        if (jsonV.success) {
          setVendors(jsonV.vendors || []);
          setVendorRules(jsonV.data || []);
          if (!selectedVendorNip && jsonV.vendors?.length > 0) {
            setSelectedVendorNip(jsonV.vendors[0].nip);
          }
        }
      }
    } catch {
      setVendors([]);
      setVendorRules([]);
    }

    // 3. Lista budów z Firestore (sites)
    try {
      const q = query(collection(db, 'sites'), orderBy('name', 'asc'));
      const sitesSnap = await getDocs(q);
      const loadedSites: SiteOption[] = sitesSnap.docs.map(d => ({
        id: d.id,
        name: (d.data() as any).name || d.id,
        location: (d.data() as any).location,
        status: (d.data() as any).status,
      }));
      setSites(loadedSites);
    } catch (err) {
      console.warn('Nie udało się pobrać listy budów:', err);
    }
  };

  useEffect(() => {
    loadAppData();
  }, []);

  // Przetwarzanie pliku z pełną automatyczną orkiestracją A2A
  const processFileOrBlob = async (fileBlob: Blob, fileName: string) => {
    setIsProcessing(true);
    setUploadError(null);
    setSelectedFileName(fileName);

    try {
      const formData = new FormData();
      formData.append('file', fileBlob, fileName);

      const res = await fetch('/api/biuro/process-document', {
        method: 'POST',
        body: formData
      });

      const responseText = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(responseText);
      } catch {
        throw new Error(`Serwer zwrócił nieoczekiwaną odpowiedź: ${responseText.slice(0, 120)}...`);
      }

      if (!res.ok || !json.success) {
        throw new Error(json.error || json.details || 'Błąd podczas przetwarzania dokumentu przez agentów A2A.');
      }

      const payload = json.data as CanonicalIngestPayload;
      if (payload.document?.seller?.name) {
        payload.document.seller.name = sanitizePolishErpArtifacts(payload.document.seller.name);
      }
      if (payload.document?.buyer?.name) {
        payload.document.buyer.name = sanitizePolishErpArtifacts(payload.document.buyer.name);
      }
      payload.items = (payload.items || []).map(it => ({
        ...it,
        raw_name: sanitizePolishErpArtifacts(it.raw_name)
      }));

      setCurrentPayload(payload);
      setCurrentReconciled(json.reconciled_delivery || null);
      setA2aMeta(json.a2a_meta);

      // Odśwież dane z Firestore (zapisane WZ oraz nowo nauczone reguły dostawców)
      await loadAppData();
    } catch (err: any) {
      setUploadError(err.message || 'Wystąpił błąd podczas analizy pliku.');
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

  const handlePasteSubmit = async () => {
    if (!pastedJsonText.trim()) return;
    setIsPasteModalOpen(false);
    const blob = new Blob([pastedJsonText.trim()], { type: 'application/json' });
    await processFileOrBlob(blob, 'wklejony_dokument_ksef.json');
  };

  // Usunięcie WZ z Firestore
  const handleDeleteWz = async (reconciliationId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Czy na pewno chcesz trwale usunąć dokument WZ (${reconciliationId})?`)) return;

    try {
      const res = await fetch(`/api/biuro/reconciled-deliveries?id=${encodeURIComponent(reconciliationId)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setSavedDeliveries(prev => prev.filter(d => d.reconciliation_id !== reconciliationId));
        if (expandedWzId === reconciliationId) setExpandedWzId(null);
      }
    } catch (err) {
      console.error('Błąd podczas usuwania WZ:', err);
    }
  };

  // Zmiana przypisanej budowy dla WZ
  const handleChangeWzSite = async (reconciliationId: string, siteId: string, e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation();
    const chosenSite = sites.find(s => s.id === siteId);
    const targetSiteName = chosenSite ? chosenSite.name : 'Nie przypisano';

    // Optymistyczna aktualizacja UI
    setSavedDeliveries(prev => prev.map(d => {
      if (d.reconciliation_id === reconciliationId) {
        return {
          ...d,
          parties: {
            ...d.parties,
            target_site_id: siteId || null,
            target_site: targetSiteName,
          }
        };
      }
      return d;
    }));

    try {
      await fetch('/api/biuro/reconciled-deliveries', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reconciliation_id: reconciliationId,
          target_site_id: siteId || null,
          target_site: targetSiteName,
        }),
      });
    } catch (err) {
      console.error('Błąd aktualizacji budowy:', err);
    }
  };

  // Dodanie nowej reguły dialektu
  const handleAddVendorRule = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetNip = (newVendorNip || selectedVendorNip).replace(/\D/g, '');
    if (!targetNip || !newRawName || !newCanonicalName) return;

    const newRule: VendorCatalogItem = {
      vendor_nip: targetNip,
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
        body: JSON.stringify({ ...newRule, vendorName: newVendorName || undefined })
      });
      setNewRawName('');
      setNewCanonicalName('');
      setNewVendorNip('');
      setNewVendorName('');
      await loadAppData();
      setSelectedVendorNip(targetNip);
    } catch (err) {
      console.error('Błąd zapisu reguły:', err);
    }
  };

  // Usunięcie reguły dialektu z Firestore
  const handleDeleteVendorRule = async (nip: string, cleanLookupKey: string) => {
    if (!confirm(`Czy na pewno chcesz usunąć regułę "${cleanLookupKey}" dla NIP ${nip}?`)) return;

    try {
      const res = await fetch(`/api/biuro/vendor-catalog?nip=${encodeURIComponent(nip)}&key=${encodeURIComponent(cleanLookupKey)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await loadAppData();
      }
    } catch (err) {
      console.error('Błąd usuwania reguły:', err);
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
              Czysta Baza Produkcyjna
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1 max-w-3xl">
            Mózg logistyczno-finansowy: automatyczne przetwarzanie dokumentów WZ, dopasowanie do listy budów, normalizacja dwutorowa oraz przygotowanie pod parowanie z fakturami KSeF.
          </p>
        </div>
      </div>

      {/* ── ZAKŁADKI SYSTEMU ── */}
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
          <span>1. Ingestia & Agenci A2A</span>
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
          <span>3. Baza Dostawców & Dialektów ({vendors.length})</span>
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
          <span>4. Reguły Normalizacji</span>
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

      {/* ── WIDOK 1: INGESTIA & AGENT OBSERVABILITY ── */}
      {activeTab === 'ingest_lab' && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
            <div>
              <h2 className="text-base font-extrabold text-slate-900">
                Wprowadź dokument WZ lub fakturę (Automatyczny Potok 8 Agentów)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Upuść plik PDF, skan z telefonu lub XML/JSON KSeF. System automatycznie rozpozna pozycje, dopasuje budowę z Twojej listy, przeliczy jednostki i zapisze WZ w bazie.
              </p>
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
                  Przeciągnij plik WZ tutaj lub wybierz z dysku
                </h3>
                <p className="text-[11px] text-slate-500 max-w-md mx-auto">
                  PDF cyfrowy (Fast-Path), skan z kabiny (Vision), XML KSeF lub notatka audio kierowcy.
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
                <label
                  htmlFor="biuro-file-input"
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow cursor-pointer transition flex items-center gap-1.5 active:scale-95"
                >
                  <span>📁</span>
                  <span>Wybierz plik z dysku</span>
                </label>

                <button
                  type="button"
                  onClick={() => setIsPasteModalOpen(true)}
                  className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs rounded-xl shadow cursor-pointer transition flex items-center gap-1.5 active:scale-95 border border-slate-700"
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

          {currentPayload && (
            <AgentObservabilityConsole
              payload={currentPayload}
              reconciledDelivery={currentReconciled}
              a2aMeta={a2aMeta}
            />
          )}
        </div>
      )}

      {/* ── WIDOK 2: ZAPISANE WZ & DOSTAWY (MASTER-DETAIL Z ROZWIJANIEM) ── */}
      {activeTab === 'saved_wz' && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
                  <span>📦</span> Zapisane Dokumenty WZ (`reconciled_deliveries`)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Kliknij wybrany wiersz WZ, aby rozwinąć wszystkie szczegóły pozycji, przeliczników oraz audytu. Możesz także zmienić przypisaną budowę lub usunąć WZ.
                </p>
              </div>
              <span className="px-3 py-1 bg-emerald-100 text-emerald-800 rounded-full font-mono text-xs font-bold">
                W bazie: {savedDeliveries.length} WZ
              </span>
            </div>

            {savedDeliveries.length === 0 ? (
              <div className="p-10 text-center bg-slate-50 border border-dashed border-slate-200 rounded-xl space-y-2">
                <span className="text-3xl block">📭</span>
                <div className="font-bold text-slate-700 text-sm">Brak zapisanych dokumentów WZ w bazie</div>
                <p className="text-xs text-slate-500">
                  Wgraj pierwszy plik WZ w zakładce <b>1. Ingestia & Agenci A2A</b>, a pojawi się on tutaj automatycznie.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-100 text-slate-600 font-bold uppercase text-[10px] border-b border-slate-200">
                      <th className="p-3 w-8"></th>
                      <th className="p-3">Dostawca</th>
                      <th className="p-3">Numer WZ</th>
                      <th className="p-3 text-center">Pozycje</th>
                      <th className="p-3 text-right">Kwota Netto / Brutto</th>
                      <th className="p-3">Budowa (Lista Budów)</th>
                      <th className="p-3 text-center">Nagranie Kierowcy</th>
                      <th className="p-3 text-center">Dopasowanie do FV</th>
                      <th className="p-3 text-center">Podpis Kierownika</th>
                      <th className="p-3 text-center">Akcje</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {savedDeliveries.map((del) => {
                      const isExpanded = expandedWzId === del.reconciliation_id;
                      const hasAudio = Boolean(del.driver_audit?.is_physically_confirmed || del.driver_audit?.driver_audio_text);
                      const isSigned = Boolean(del.manager_signature?.is_signed);

                      return (
                        <React.Fragment key={del.reconciliation_id}>
                          {/* GŁÓWNY WIERSZ WZ */}
                          <tr
                            onClick={() => setExpandedWzId(isExpanded ? null : del.reconciliation_id)}
                            className={`cursor-pointer transition ${isExpanded ? 'bg-blue-50/60' : 'hover:bg-slate-50'}`}
                          >
                            <td className="p-3 text-center text-slate-400 font-bold">
                              {isExpanded ? '▼' : '▶'}
                            </td>
                            <td className="p-3">
                              <div className="font-bold text-slate-900 truncate max-w-[200px]">
                                {del.parties.vendor.name}
                              </div>
                              <div className="font-mono text-slate-400 text-[10px]">
                                NIP: {del.parties.vendor.nip || 'Brak'}
                              </div>
                            </td>
                            <td className="p-3 font-mono font-bold text-blue-700">
                              {del.metadata.source_wz_id}
                            </td>
                            <td className="p-3 text-center font-mono font-bold text-slate-700">
                              {del.items?.length || 0} poz.
                            </td>
                            <td className="p-3 text-right font-mono">
                              <div className="font-bold text-slate-900">{del.financial_summary.total_net_wz.toFixed(2)} zł</div>
                              <div className="text-[10px] text-emerald-700 font-bold">{del.financial_summary.total_gross_wz.toFixed(2)} zł br.</div>
                            </td>
                            <td className="p-3" onClick={(e) => e.stopPropagation()}>
                              <select
                                value={del.parties.target_site_id || ''}
                                onChange={(e) => handleChangeWzSite(del.reconciliation_id, e.target.value, e)}
                                className="px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs font-semibold text-slate-800 max-w-[180px] truncate cursor-pointer"
                              >
                                <option value="">{del.parties.target_site ? `${del.parties.target_site} (Wykryto)` : '-- Wybierz budowę --'}</option>
                                {sites.map(site => (
                                  <option key={site.id} value={site.id}>
                                    {site.name} {site.location ? `(${site.location})` : ''}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="p-3 text-center font-mono">
                              {hasAudio ? (
                                <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded text-[10px] font-bold">
                                  🎙️ Powiązano
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-bold">
                                  🔇 Brak nagrania
                                </span>
                              )}
                            </td>
                            <td className="p-3 text-center font-mono text-[10px]">
                              {del.financial_summary.ksef_matched_invoice_no ? (
                                <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded font-bold">
                                  {del.financial_summary.ksef_matched_invoice_no}
                                </span>
                              ) : (
                                <span className="text-slate-400 italic">— Oczekuje na FV</span>
                              )}
                            </td>
                            <td className="p-3 text-center font-mono">
                              {isSigned ? (
                                <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded text-[10px] font-bold">
                                  ✍️ Podpisano
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded text-[10px] font-bold">
                                  ⏳ Brak podpisu
                                </span>
                              )}
                            </td>
                            <td className="p-3 text-center">
                              <button
                                type="button"
                                onClick={(e) => handleDeleteWz(del.reconciliation_id, e)}
                                className="px-2.5 py-1 bg-rose-50 hover:bg-rose-600 text-rose-600 hover:text-white border border-rose-200 rounded-lg text-[11px] font-bold transition cursor-pointer"
                                title="Usuń WZ z bazy"
                              >
                                🗑️ Usuń
                              </button>
                            </td>
                          </tr>

                          {/* ROZWINIĘTE SZCZEGÓŁY PO KLIKNIĘCIU W WIERSZ WZ */}
                          {isExpanded && (
                            <tr className="bg-slate-50/90">
                              <td colSpan={10} className="p-5 border-b border-slate-200">
                                <div className="space-y-4">
                                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
                                    <div className="text-xs font-mono text-slate-600">
                                      ID Rekordu: <b className="text-slate-900">{del.reconciliation_id}</b> | Data utworzenia: <b>{new Date(del.metadata.created_at).toLocaleString('pl-PL')}</b>
                                    </div>
                                    <div className="text-xs font-semibold text-slate-700">
                                      Status weryfikacji: <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded font-mono">{del.metadata.status}</span>
                                    </div>
                                  </div>

                                  {/* Audyt głosu kierowcy w szczegółach */}
                                  <div className="p-3 bg-white border border-slate-200 rounded-xl text-xs">
                                    <span className="font-bold text-slate-800 block mb-1">🎙️ Szczegóły Powiązania z Nagraniem Kierowcy:</span>
                                    <span className="text-slate-600">{del.driver_audit?.verdict_reason || 'Brak powiązanej notatki audio dla tej dostawy.'}</span>
                                  </div>

                                  {/* Tabela pozycji dwutorowych (RAW vs NORMALIZED) */}
                                  <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white">
                                    <table className="w-full text-left text-xs border-collapse">
                                      <thead>
                                        <tr className="bg-slate-100 text-slate-700 font-bold uppercase text-[10px] border-b border-slate-200">
                                          <th className="p-2.5 w-10 text-center">Lp</th>
                                          <th className="p-2.5 bg-amber-50/60 border-r border-slate-200">TOR 1: Dane z WZ (RAW)</th>
                                          <th className="p-2.5 border-r border-slate-200">Przelicznik</th>
                                          <th className="p-2.5 bg-emerald-50/60">TOR 2: Znormalizowane PESAM (NORMALIZED)</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-100">
                                        {del.items?.map(it => (
                                          <tr key={it.lp}>
                                            <td className="p-2.5 text-center font-mono text-slate-400">{it.lp}</td>
                                            <td className="p-2.5 bg-amber-50/20 border-r border-slate-200">
                                              <div className="font-semibold text-slate-800">{it.raw.name}</div>
                                              <div className="font-mono text-amber-800 text-[11px]">
                                                {it.raw.quantity} {it.raw.unit} × {it.raw.unit_price_net.toFixed(2)} zł = <b>{it.raw.total_net.toFixed(2)} zł</b>
                                              </div>
                                            </td>
                                            <td className="p-2.5 border-r border-slate-200 font-mono text-[11px] text-blue-700 font-bold">
                                              {it.conversion.formula}
                                            </td>
                                            <td className="p-2.5 bg-emerald-50/20">
                                              <div className="font-semibold text-emerald-900">{it.normalized.standard_name}</div>
                                              <div className="font-mono text-emerald-800 text-[11px]">
                                                {it.normalized.quantity} {it.normalized.unit} × {it.normalized.unit_price_net.toFixed(2)} zł/{it.normalized.unit} = <b>{it.normalized.total_net.toFixed(2)} zł</b>
                                              </div>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── WIDOK 3: BAZA DOSTAWCÓW & DIALEKTÓW PER NIP (CZYSTA BAZA) ── */}
      {activeTab === 'vendors' && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
                  <span>🏢</span> Pamięć Dialektów Dostawców (Firestore: vendor_catalogs/&#123;nip&#125;)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Lista zawiera wyłącznie rzeczywiste hurtownie i reguły zapisane podczas pracy systemu lub dodane ręcznie. Możesz usunąć dowolną regułę.
                </p>
              </div>

              {/* Dynamiczne przyciski dostawców z Firestore */}
              {vendors.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setSelectedVendorNip('')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                      selectedVendorNip === '' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    Wszyscy ({vendorRules.length})
                  </button>
                  {vendors.map(v => (
                    <button
                      key={v.nip}
                      onClick={() => setSelectedVendorNip(v.nip)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                        selectedVendorNip === v.nip ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {v.name ? `${v.name.slice(0, 22)}...` : 'Dostawca'} ({v.nip})
                    </button>
                  ))}
                </div>
              )}
            </div>

            {vendorRules.length === 0 ? (
              <div className="p-10 text-center bg-slate-50 border border-dashed border-slate-200 rounded-xl space-y-2">
                <span className="text-3xl block">🗄️</span>
                <div className="font-bold text-slate-700 text-sm">Baza dialektów dostawców jest czysta</div>
                <p className="text-xs text-slate-500">
                  Gdy przeprocesujesz pierwsze WZ lub dodasz regułę poniżej, hurtownia i jej indeksy pojawią się w tym katalogu.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-50 text-slate-600 font-bold uppercase text-[10px] border-b border-slate-200">
                      <th className="p-3">NIP Dostawcy</th>
                      <th className="p-3">Lokalna Nazwa w Hurtowni</th>
                      <th className="p-3">Jedn. Fakturowa</th>
                      <th className="p-3">Kanon PESAM</th>
                      <th className="p-3">Reguła Przeliczenia</th>
                      <th className="p-3 text-center">Użycia</th>
                      <th className="p-3 text-center">Akcje</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {vendorRules.filter(r => !selectedVendorNip || r.vendor_nip === selectedVendorNip).map((r, idx) => (
                      <tr key={`${r.vendor_nip}-${r.clean_lookup_key}-${idx}`} className="hover:bg-slate-50/80">
                        <td className="p-3 font-mono text-slate-500 font-bold">{r.vendor_nip}</td>
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
                        <td className="p-3 text-center">
                          <button
                            type="button"
                            onClick={() => handleDeleteVendorRule(r.vendor_nip, r.clean_lookup_key)}
                            className="px-2.5 py-1 bg-rose-50 hover:bg-rose-600 text-rose-600 hover:text-white border border-rose-200 rounded-lg text-[11px] font-bold transition cursor-pointer"
                          >
                            🗑️ Usuń
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Formularz dodawania nowej reguły */}
            <form onSubmit={handleAddVendorRule} className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
              <div className="font-bold text-xs text-slate-800 uppercase tracking-wider">
                Dodaj ręcznie nową regułę dialektu dostawcy
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-6 gap-3 text-xs">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 mb-1">NIP Dostawcy:</label>
                  <input
                    type="text"
                    placeholder={selectedVendorNip || 'np. 8722410651'}
                    value={newVendorNip || selectedVendorNip}
                    onChange={e => setNewVendorNip(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-slate-900 font-mono"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 mb-1">Nazwa Dostawcy (opcj.):</label>
                  <input
                    type="text"
                    placeholder="np. CMB Dębica"
                    value={newVendorName}
                    onChange={e => setNewVendorName(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-slate-900"
                  />
                </div>
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
                  <label className="block text-[10px] font-bold text-slate-500 mb-1">Nazwa standardowa PESAM:</label>
                  <input
                    type="text"
                    placeholder="np. Profil C-50 4m"
                    value={newCanonicalName}
                    onChange={e => setNewCanonicalName(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-slate-900"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 mb-1">Mnożnik:</label>
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
                    <label className="block text-[10px] font-bold text-slate-500 mb-1">Jedn. PESAM:</label>
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
                <span>📐</span> Zasady Normalizacji Geometrycznej PESAM
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Wzory fizyczne używane przez Podagenta Odkrywania Geometrii do automatycznego przeliczania jednostek hurtowni na jednostki kosztorysowe budowy.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                <span className="font-bold text-sm text-slate-800 flex items-center gap-2">
                  <span>📏</span> Profile Stalowe &rarr; mb
                </span>
                <p className="text-slate-600 text-xs">
                  Hurtownie sprzedają profile w sztukach, ale inżynierowie rozliczają podwykonawców w <strong>metrach bieżących (mb)</strong>.
                </p>
                <div className="font-mono text-emerald-800 bg-emerald-50 p-2 rounded text-[11px] font-bold">
                  Formuła: sztuki × długość w metrach
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
                  Formuła: szerokość (m) × długość (m)
                </div>
              </div>

              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                <span className="font-bold text-sm text-slate-800 flex items-center gap-2">
                  <span>🔩</span> Wkręty i Kołki &rarr; szt
                </span>
                <p className="text-slate-600 text-xs">
                  Hurtownia fakturowała w paczkach (np. po 200 szt.). Na budowie ewidencja prowadzona jest w <strong>sztukach</strong>.
                </p>
                <div className="font-mono text-emerald-800 bg-emerald-50 p-2 rounded text-[11px] font-bold">
                  Formuła: opakowania × ilość w paczce
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── WIDOK 5: USTAWIENIA & REGUŁY DECYZYJNE ── */}
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
                Pamięć Firestore mapująca specyficzne nazwy hurtowni na standard PESAM za 0 zł kosztu API.
              </p>
            </div>

            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 space-y-2">
              <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                <span>🎙️</span>
                <span>4. VoiceAnchorMatcher (SOP 4s)</span>
              </div>
              <p className="text-slate-600">
                Dwuetapowa weryfikacja meldunku kierowcy z konfigurowalnymi progami tolerancji i dopasowaniem budów.
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
              placeholder='{\n  "document": {\n    "type": "WZ",\n    ...\n  },\n  "items": [...]\n}'
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
