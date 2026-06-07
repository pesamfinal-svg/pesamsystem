// ============================================================
// PESAM Brain – BrainFileUploader
// Drag & drop strefy wgrywania kosztorysów.
// Wysyła plik do API Ekstraktora i wyświetla wynik (preview).
// ============================================================

'use client';

import { useCallback, useState, useRef } from 'react';

type SourceType = 'PESAM_EXPORT' | 'EXTERNAL_PDF' | 'EXTERNAL_XLSX';

interface ExtractionPreview {
    uploadId: string;
    objectType: string;
    documentDate: string;
    totalCost_PLN: number | null;
    totalArea_m2: number | null;
    freshnessLevel: 'FRESH' | 'STALE' | 'EXPIRED';
    freshnessWarning: string | null;
    confidence: number;
    warnings: string[];
    priceItemCount: number;
    indicatorsPreview: { concretePerM2: string | null; steelPerM3: string | null };
}

const ACCEPTED_MIME: Record<string, SourceType> = {
    'application/json': 'PESAM_EXPORT',
    'application/pdf': 'EXTERNAL_PDF',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'EXTERNAL_XLSX',
    'application/vnd.ms-excel': 'EXTERNAL_XLSX',
};

export function BrainFileUploader({ onUploadComplete }: { onUploadComplete: () => void }) {
    const [dragging, setDragging] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [preview, setPreview] = useState<ExtractionPreview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const handleFile = useCallback(async (file: File) => {
        console.log(`[UI Uploader] 📄 Otrzymano plik: ${file.name} (Typ: ${file.type}, Rozmiar: ${(file.size / 1024).toFixed(2)} KB)`);
        setError(null);
        setPreview(null);

        const source = ACCEPTED_MIME[file.type];
        if (!source) {
            console.warn(`[UI Uploader] ⚠️ Nieobsługiwany format: ${file.type}`);
            setError('Nieobsługiwany format. Akceptowane: JSON (PESAM Export), PDF, XLSX.');
            return;
        }

        setUploading(true);
        console.log(`[UI Uploader] 🚀 Rozpoczynam wysyłanie do Agenta Ekstraktora...`);

        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('source', source);

            const res = await fetch('/api/kosztorysant/brain/ekstraktor', {
                method: 'POST',
                body: formData,
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error ?? 'Błąd ekstrakcji');
            }

            const data = await res.json();
            console.log(`[UI Uploader] ✅ Otrzymano odpowiedź z Ekstraktora:`, data);

            setPreview(data.preview ? { ...data.preview, uploadId: data.uploadId } : null);
            onUploadComplete();
        } catch (err) {
            console.error(`[UI Uploader] ❌ Błąd uploada:`, err);
            setError(String(err));
        } finally {
            setUploading(false);
        }
    }, [onUploadComplete]);

    const onDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    }, [handleFile]);

    const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) handleFile(file);
        e.target.value = '';
    }, [handleFile]);

    return (
        <div className="space-y-4">
            {/* Strefa przeciągania */}
            <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => inputRef.current?.click()}
                className={`relative border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all ${dragging ? 'border-blue-400 bg-blue-500/10' : 'border-slate-600 hover:border-slate-500 bg-slate-800/30 hover:bg-slate-800/50'}`}
            >
                <input ref={inputRef} type="file" accept=".json,.pdf,.xlsx,.xls" onChange={onInputChange} className="hidden" />
                {uploading ? (
                    <div className="space-y-2">
                        <div className="text-2xl animate-spin">⚙️</div>
                        <p className="text-sm text-slate-400">Trwa ekstrakcja danych przez AI (to może potrwać kilka sekund)...</p>
                    </div>
                ) : (
                    <>
                        <div className="text-3xl mb-3">🧠</div>
                        <p className="text-sm font-semibold text-white">Wgraj kosztorys do PESAM Brain</p>
                        <p className="text-xs text-slate-400 mt-1">Przeciągnij lub kliknij · JSON, PDF, XLSX</p>
                    </>
                )}
            </div>

            {error && <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400">❌ {error}</div>}

            {/* Podgląd po ekstrakcji */}
            {preview && (
                <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <p className="text-sm font-bold text-white">Wynik ekstrakcji (Czeka na zatwierdzenie)</p>
                        <span className="text-[10px] text-slate-400">Pewność modelu: {preview.confidence}%</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                        <InfoItem label="Typ obiektu" value={preview.objectType} />
                        <InfoItem label="Data projektu" value={preview.documentDate} />
                        <InfoItem label="Pozycje cenowe" value={String(preview.priceItemCount)} />
                    </div>
                    <p className="text-xs text-slate-400 mt-2">Rekord zapisany pod ID: <code className="text-blue-400">{preview.uploadId}</code>. Sprawdź go na liście poniżej.</p>
                </div>
            )}
        </div>
    );
}

function InfoItem({ label, value }: { label: string; value: string }) {
    return (
        <div className="bg-slate-700/30 rounded-lg px-2.5 py-2">
            <p className="text-[10px] text-slate-500">{label}</p>
            <p className="text-xs font-semibold text-white mt-0.5 truncate">{value}</p>
        </div>
    );
}