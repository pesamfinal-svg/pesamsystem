// src/components/biuro/BiuroSettingsPanel.tsx
'use client';

import React, { useState, useEffect } from 'react';
import { BiuroMatchingPolicy, DEFAULT_BIURO_MATCHING_POLICY } from '@/types/biuro/matchingPolicy.types';

interface BiuroSettingsPanelProps {
  onPolicyUpdated?: (policy: BiuroMatchingPolicy) => void;
}

export default function BiuroSettingsPanel({ onPolicyUpdated }: BiuroSettingsPanelProps) {
  const [policy, setPolicy] = useState<BiuroMatchingPolicy>(DEFAULT_BIURO_MATCHING_POLICY);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Stan symulatora na żywo (Live Simulator)
  const [simWzNet, setSimWzNet] = useState<number>(250.0);
  const [simHasAudio, setSimHasAudio] = useState<boolean>(true);
  const [simDeclaredRows, setSimDeclaredRows] = useState<number>(7);
  const [simActualRows, setSimActualRows] = useState<number>(8);
  const [simAnchorMatched, setSimAnchorMatched] = useState<boolean>(true);

  // Załadowanie aktualnej polityki z API
  useEffect(() => {
    const fetchPolicy = async () => {
      try {
        const res = await fetch('/api/biuro/matching-policy');
        const text = await res.text();
        if (text.startsWith('{')) {
          const json = JSON.parse(text);
          if (json.success && json.data) {
            setPolicy(json.data);
          }
        }
      } catch (err) {
        console.warn('Używam domyślnej polityki lokalnej:', err);
      }
    };
    fetchPolicy();
  }, []);

  // Zapis do Firestore
  const handleSavePolicy = async () => {
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch('/api/biuro/matching-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      });

      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        // fallback
      }

      if (res.ok && json && json.success) {
        setSaveMessage({ text: '✅ Ustawienia i reguły tolerancji zostały trwale zapisane w Firestore.', type: 'success' });
        if (onPolicyUpdated) onPolicyUpdated(policy);
      } else {
        setSaveMessage({ text: '⚠️ Ustawienia zastosowano lokalnie w bieżącej sesji.', type: 'success' });
        if (onPolicyUpdated) onPolicyUpdated(policy);
      }
    } catch {
      setSaveMessage({ text: '⚠️ Zapisano lokalnie w pamięci RAM.', type: 'success' });
      if (onPolicyUpdated) onPolicyUpdated(policy);
    } finally {
      setIsSaving(false);
      setTimeout(() => setSaveMessage(null), 4000);
    }
  };

  // Przywrócenie domyślnych
  const handleResetDefaults = () => {
    setPolicy(DEFAULT_BIURO_MATCHING_POLICY);
    setSaveMessage({ text: 'Przywrócono fabryczne wytyczne PESAM. Kliknij Zapisz, aby utrwalić.', type: 'success' });
  };

  // Obliczenie symulacji na żywo
  const evaluateSimulation = () => {
    const noAudioLimit = policy.voice_rules.auto_approve_without_driver_note_below_pln ?? 300.0;
    const maxDiscrepancy = policy.voice_rules.max_row_count_discrepancy ?? 1;

    // Przypadek 1: Brak nagrania kierowcy
    if (!simHasAudio) {
      if (simWzNet <= noAudioLimit) {
        return {
          verdict: 'AUTO_RECONCILED',
          statusText: '✅ ZATWIERDZENIE AUTOMATYCZNE',
          badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-300',
          explanation: `Kwota WZ (${simWzNet.toFixed(2)} zł) nie przekracza zdefiniowanego limitu ${noAudioLimit.toFixed(2)} zł. Dokument zostaje przyjęty i rozliczony z automatu bez nagrania kierowcy.`,
        };
      } else {
        return {
          verdict: 'PENDING_HITL_VOICE',
          statusText: '⚠️ BLOKADA DO WERYFIKACJI (HITL)',
          badgeClass: 'bg-amber-100 text-amber-800 border-amber-300',
          explanation: `Kwota WZ (${simWzNet.toFixed(2)} zł) przekracza próg ${noAudioLimit.toFixed(2)} zł, a brakuje nagrania kierowcy. System wymaga ręcznego potwierdzenia odbioru przez kierownika budowy.`,
        };
      }
    }

    // Przypadek 2: Jest nagranie kierowcy
    const diff = Math.abs(simActualRows - simDeclaredRows);
    const rowsOk = diff <= maxDiscrepancy;

    if (!rowsOk) {
      return {
        verdict: 'PENDING_HITL_VOICE',
        statusText: '⚠️ BŁĄD SUMY WIERSZY (HITL)',
        badgeClass: 'bg-red-100 text-red-800 border-red-300',
        explanation: `Różnica wierszy wynosi ${diff} (kierowca podał ${simDeclaredRows}, na kwicie jest ${simActualRows}). Przekroczono dozwolony margines tolerancji (maks. ±${maxDiscrepancy} wierszy).`,
      };
    }

    if (!simAnchorMatched && policy.voice_rules.require_anchor_match) {
      return {
        verdict: 'PENDING_HITL_VOICE',
        statusText: '⚠️ ROZBIEŻNOŚĆ KOTWICY (HITL)',
        badgeClass: 'bg-red-100 text-red-800 border-red-300',
        explanation: 'Kierowca zgłosił towar główny, którego brakuje na kwicie WZ lub ilość nie zgadza się w tolerancji.',
      };
    }

    return {
      verdict: 'AUTO_RECONCILED',
      statusText: '✅ ZATWIERDZENIE AUTOMATYCZNE',
      badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-300',
      explanation: `Meldunek poprawny. Różnica ${diff} wierszy mieści się w tolerancji ±${maxDiscrepancy}. Towar kotwiczący potwierdzony. Dokument wchodzi prosto na stan budowy.`,
    };
  };

  const simResult = evaluateSimulation();

  return (
    <div className="space-y-6">
      {/* Nagłówek zakładki */}
      <div className="bg-slate-900 text-slate-100 p-6 rounded-2xl border border-slate-800 shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">⚙️</span>
              <h2 className="text-lg font-black text-white tracking-wide">
                Konfiguracja Reguł Decyzyjnych & Tolerancji Biuro AI
              </h2>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30">
                Firestore: settings/biuro_matching_policy
              </span>
            </div>
            <p className="text-xs text-slate-300 mt-1 max-w-3xl">
              Zarządzaj twardymi zasadami automatyzacji. Ustal progi kwotowe dla WZ bez nagrania kierowcy,
              dopuszczalny błąd w zliczaniu pozycji przez kierowców oraz tolerancje cenowe dla faktur KSeF.
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleResetDefaults}
              className="px-3.5 py-2 rounded-xl text-xs font-bold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 transition cursor-pointer border border-slate-700"
            >
              ↺ Przywróć Domyślne
            </button>
            <button
              type="button"
              onClick={handleSavePolicy}
              disabled={isSaving}
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-emerald-950/40 transition cursor-pointer flex items-center gap-2 disabled:opacity-50"
            >
              {isSaving ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                  <span>Zapisywanie...</span>
                </>
              ) : (
                <>
                  <span>💾</span>
                  <span>Zapisz Ustawienia</span>
                </>
              )}
            </button>
          </div>
        </div>

        {saveMessage && (
          <div className="p-3 bg-emerald-950/80 border border-emerald-500/50 rounded-xl text-emerald-300 text-xs font-mono flex items-center gap-2">
            <span>{saveMessage.text}</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Lewa kolumna: Formularz ustawień (2/3 szerokości) */}
        <div className="lg:col-span-2 space-y-6">
          {/* SEKCJA 1: MELDUNEK KIEROWCY I PROGI KWOTOWE */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-5">
            <div className="border-b border-slate-100 pb-3">
              <h3 className="font-extrabold text-slate-900 text-sm flex items-center gap-2">
                <span>🎙️</span> 1. Reguły Weryfikacji Głosu Kierowcy & Kwoty WZ
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Konfiguruj, kiedy dokument WZ przechodzi automatycznie do rozliczeń, a kiedy wymaga potwierdzenia człowieka.
              </p>
            </div>

            <div className="space-y-4 text-xs">
              {/* Reguła 1: Próg kwotowy bez nagrania */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <label className="font-bold text-slate-800 text-xs block">
                      Maksymalna kwota WZ auto-zatwierdzana bez głosu kierowcy (PLN netto)
                    </label>
                    <span className="text-[11px] text-slate-500">
                      Jeśli kierowca nie nagrał meldunku, a kwota WZ nie przekracza tej wartości, WZ jest zatwierdzana z automatu.
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      type="number"
                      step="50"
                      min="0"
                      max="10000"
                      value={policy.voice_rules.auto_approve_without_driver_note_below_pln}
                      onChange={(e) => setPolicy({
                        ...policy,
                        voice_rules: {
                          ...policy.voice_rules,
                          auto_approve_without_driver_note_below_pln: parseFloat(e.target.value) || 0
                        }
                      })}
                      className="w-28 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-slate-900 font-mono font-bold text-right"
                    />
                    <span className="font-bold text-slate-700">PLN</span>
                  </div>
                </div>
              </div>

              {/* Reguła 2: Dopuszczalna różnica wierszy (Tolerancja Checksum) */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <label className="font-bold text-slate-800 text-xs block">
                      Dopuszczalna różnica w liczbie pozycji (Checksum Tolerance)
                    </label>
                    <span className="text-[11px] text-slate-500">
                      O ile pozycji kierowca może się pomylić w meldunku (np. zapomnieć policzyć wkręty czy taśmę), aby WZ nadal weszła z automatu.
                    </span>
                  </div>
                  <select
                    value={policy.voice_rules.max_row_count_discrepancy}
                    onChange={(e) => setPolicy({
                      ...policy,
                      voice_rules: {
                        ...policy.voice_rules,
                        max_row_count_discrepancy: parseInt(e.target.value, 10)
                      }
                    })}
                    className="w-36 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-slate-900 font-bold"
                  >
                    <option value={0}>0 (Ścisła równość)</option>
                    <option value={1}>±1 wiersz</option>
                    <option value={2}>±2 wiersze</option>
                    <option value={3}>±3 wiersze</option>
                    <option value={5}>±5 wierszy</option>
                  </select>
                </div>
              </div>

              {/* Reguła 3: Brak podania liczby pozycji */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between gap-4">
                <div>
                  <label className="font-bold text-slate-800 text-xs block">
                    Zezwalaj na brak podania liczby pozycji w nagraniu
                  </label>
                  <span className="text-[11px] text-slate-500">
                    Kierowca powiedział tylko: <i>„CMB na Kielce, wziąłem 6 płyt OSB”</i> (nie podał sumy wierszy). Czy akceptować, jeśli towar główny się zgadza?
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={policy.voice_rules.allow_missing_row_count_declaration}
                  onChange={(e) => setPolicy({
                    ...policy,
                    voice_rules: {
                      ...policy.voice_rules,
                      allow_missing_row_count_declaration: e.target.checked
                    }
                  })}
                  className="w-5 h-5 accent-emerald-600 rounded cursor-pointer shrink-0"
                />
              </div>

              {/* Reguła 4: Tolerancja ilościowa towaru kotwiczącego */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <label className="font-bold text-slate-800 text-xs block">
                      Tolerancja ilościowa towaru kotwiczącego (Anchor Quantity Margin)
                    </label>
                    <span className="text-[11px] text-slate-500">
                      Dopuszczalny margines odchyłki ilości towaru głównego (np. kierowca podał 100 mb, na WZ jest 98 mb).
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      type="number"
                      step="1"
                      min="0"
                      max="20"
                      value={policy.voice_rules.anchor_quantity_tolerance_pct}
                      onChange={(e) => setPolicy({
                        ...policy,
                        voice_rules: {
                          ...policy.voice_rules,
                          anchor_quantity_tolerance_pct: parseFloat(e.target.value) || 0
                        }
                      })}
                      className="w-20 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-slate-900 font-mono font-bold text-right"
                    />
                    <span className="font-bold text-slate-700">%</span>
                  </div>
                </div>
              </div>

              {/* Reguła 5: Próg drobnicy montażowej */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <label className="font-bold text-slate-800 text-xs block">
                      Próg drobnicy montażowej (Low Value Threshold)
                    </label>
                    <span className="text-[11px] text-slate-500">
                      Pozycje poniżej tej kwoty (np. taśmy, wiertła, kołki) są traktowane jako drobnica i nie blokują odbioru.
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      type="number"
                      step="10"
                      min="0"
                      max="500"
                      value={policy.voice_rules.low_value_item_threshold_pln}
                      onChange={(e) => setPolicy({
                        ...policy,
                        voice_rules: {
                          ...policy.voice_rules,
                          low_value_item_threshold_pln: parseFloat(e.target.value) || 0
                        }
                      })}
                      className="w-24 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-slate-900 font-mono font-bold text-right"
                    />
                    <span className="font-bold text-slate-700">PLN</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* SEKCJA 2: REGUŁY KSEF & ROZBIEŻNOŚCI CENOWYCH */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-5">
            <div className="border-b border-slate-100 pb-3">
              <h3 className="font-extrabold text-slate-900 text-sm flex items-center gap-2">
                <span>🔍</span> 2. Reguły Parowania Faktur Zbiorczych KSeF
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Określ progi tolerancji dla cichych podwyżek cen hurtowni oraz zasady akceptacji rabatów.
              </p>
            </div>

            <div className="space-y-4 text-xs">
              {/* Maksymalna podwyżka ceny hurtowni */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <label className="font-bold text-slate-800 text-xs block">
                      Maksymalna dopuszczalna podwyżka ceny hurtowni w KSeF
                    </label>
                    <span className="text-[11px] text-slate-500">
                      Podwyżka do tej wartości przechodzi z logiem audytowym. Powyżej tego progu faktura jest blokowana i kierowana do panelu HITL.
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      max="30"
                      value={policy.ksef_reconciliation_rules.max_price_variance_pct}
                      onChange={(e) => setPolicy({
                        ...policy,
                        ksef_reconciliation_rules: {
                          ...policy.ksef_reconciliation_rules,
                          max_price_variance_pct: parseFloat(e.target.value) || 0
                        }
                      })}
                      className="w-20 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-slate-900 font-mono font-bold text-right"
                    />
                    <span className="font-bold text-slate-700">%</span>
                  </div>
                </div>
              </div>

              {/* Auto akceptacja rabatów */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between gap-4">
                <div>
                  <label className="font-bold text-slate-800 text-xs block">
                    Automatycznie zatwierdzaj ceny niższe niż na WZ (rabaty hurtowni)
                  </label>
                  <span className="text-[11px] text-slate-500">
                    Gdy cena na fakturze KSeF jest korzystniejsza niż na papierowym kwicie WZ, nie pytaj człowieka – akceptuj natychmiast.
                  </span>
                </div>
                <input
                  type="checkbox"
                  checked={policy.ksef_reconciliation_rules.auto_approve_discounts}
                  onChange={(e) => setPolicy({
                    ...policy,
                    ksef_reconciliation_rules: {
                      ...policy.ksef_reconciliation_rules,
                      auto_approve_discounts: e.target.checked
                    }
                  })}
                  className="w-5 h-5 accent-emerald-600 rounded cursor-pointer shrink-0"
                />
              </div>

              {/* Próg eskalacji do Zarządu */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <label className="font-bold text-slate-800 text-xs block">
                      Wymóg akceptacji Dyrektora/Zarządu powyżej kwoty
                    </label>
                    <span className="text-[11px] text-slate-500">
                      Rozbieżności finansowe powyżej tej kwoty wymagają autoryzacji zarządczej.
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      type="number"
                      step="500"
                      min="500"
                      max="100000"
                      value={policy.approvals.require_director_above_pln}
                      onChange={(e) => setPolicy({
                        ...policy,
                        approvals: {
                          ...policy.approvals,
                          require_director_above_pln: parseFloat(e.target.value) || 0
                        }
                      })}
                      className="w-28 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-slate-900 font-mono font-bold text-right"
                    />
                    <span className="font-bold text-slate-700">PLN</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Prawa kolumna: Interaktywny Symulator Decyzyjny (Live Tester) */}
        <div className="space-y-6">
          <div className="bg-gradient-to-br from-slate-900 to-indigo-950 p-6 rounded-2xl border border-indigo-500/30 text-white shadow-xl space-y-5 sticky top-6">
            <div className="border-b border-indigo-500/20 pb-3">
              <span className="text-[10px] font-mono uppercase tracking-wider text-indigo-300 block font-bold">
                Interaktywny Tester
              </span>
              <h3 className="font-black text-base text-white flex items-center gap-2 mt-0.5">
                <span>🧪</span> Symulator Decyzji Automatu
              </h3>
              <p className="text-[11px] text-slate-300 mt-1">
                Zmieniaj parametry po lewej stronie lub w formularzu poniżej, aby na żywo zobaczyć jak zadziała automat PESAM.
              </p>
            </div>

            {/* Kontrolki symulacji */}
            <div className="space-y-3.5 text-xs">
              <div>
                <label className="block text-[11px] font-bold text-slate-300 mb-1">
                  Wartość netto dokumentu WZ:
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min="50"
                    max="1500"
                    step="25"
                    value={simWzNet}
                    onChange={(e) => setSimWzNet(parseFloat(e.target.value))}
                    className="flex-1 accent-indigo-400 cursor-pointer"
                  />
                  <span className="font-mono font-bold text-indigo-300 w-20 text-right">
                    {simWzNet.toFixed(0)} zł
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between p-2.5 bg-slate-800/80 rounded-xl border border-slate-700">
                <span className="text-[11px] font-bold">Czy kierowca nagrał notatkę?</span>
                <input
                  type="checkbox"
                  checked={simHasAudio}
                  onChange={(e) => setSimHasAudio(e.target.checked)}
                  className="w-4 h-4 accent-indigo-400 cursor-pointer"
                />
              </div>

              {simHasAudio && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2.5 bg-slate-800/80 rounded-xl border border-slate-700">
                      <span className="text-[10px] text-slate-400 block">Kierowca zgłosił:</span>
                      <input
                        type="number"
                        min="1"
                        max="30"
                        value={simDeclaredRows}
                        onChange={(e) => setSimDeclaredRows(parseInt(e.target.value, 10) || 1)}
                        className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-white font-mono font-bold mt-1 text-center"
                      />
                      <span className="text-[9px] text-slate-400 block text-center mt-0.5">pozycji</span>
                    </div>

                    <div className="p-2.5 bg-slate-800/80 rounded-xl border border-slate-700">
                      <span className="text-[10px] text-slate-400 block">Na kwicie WZ jest:</span>
                      <input
                        type="number"
                        min="1"
                        max="30"
                        value={simActualRows}
                        onChange={(e) => setSimActualRows(parseInt(e.target.value, 10) || 1)}
                        className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-white font-mono font-bold mt-1 text-center"
                      />
                      <span className="text-[9px] text-slate-400 block text-center mt-0.5">pozycji</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between p-2.5 bg-slate-800/80 rounded-xl border border-slate-700">
                    <span className="text-[11px] font-bold">Towar kotwiczący (płyty) zgodny:</span>
                    <input
                      type="checkbox"
                      checked={simAnchorMatched}
                      onChange={(e) => setSimAnchorMatched(e.target.checked)}
                      className="w-4 h-4 accent-indigo-400 cursor-pointer"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Wynik symulatora */}
            <div className="p-4 bg-slate-950/90 rounded-xl border border-indigo-500/40 space-y-2">
              <span className="text-[10px] font-mono text-slate-400 uppercase font-bold block">
                Werdykt Mózgu PESAM na Żywo:
              </span>
              <div className="flex items-center justify-between">
                <span className={`px-2.5 py-1 rounded-lg text-xs font-bold border font-mono ${simResult.badgeClass}`}>
                  {simResult.statusText}
                </span>
                <span className="text-[11px] font-mono text-slate-400">
                  Status: <b>{simResult.verdict}</b>
                </span>
              </div>
              <p className="text-[11px] text-slate-300 leading-snug pt-1">
                {simResult.explanation}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
