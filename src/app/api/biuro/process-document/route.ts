// src/app/api/biuro/process-document/route.ts
//
// Główny Endpoint Orkiestracji A2A (Moduł 1 - Brama Wejściowa / Ingestja)
//
// Schemat przepływu Agent-to-Agent:
// 1. IngestionRouterAgent   -> identyfikacja MIME i sygnatur, wybór agenta roboczego
// 2. Worker Agent           -> KSeF (XML) | FastPath (Digital PDF) | Vision (Skan) | Audio (STT)
// 3. GatekeeperAgent        -> walidacja syntaktyczna i matematyczna sum
// 4. A2A Handshake Fallback -> w razie niespełnienia kryteriów FastPath przekazuje do Vision
// 5. Canonical Ingest Payload -> jednolity kontrakt gotowy dla Modułu 2 (Normalizator)

import { NextResponse } from 'next/server';
import { IngestionRouterAgent } from '@/lib/biuro/ingestion/router.agent';
import { KsefWorkerAgent } from '@/lib/biuro/ingestion/workers/ksef.agent';
import { FastPathWorkerAgent } from '@/lib/biuro/ingestion/workers/fast-path.agent';
import { VisionWorkerAgent } from '@/lib/biuro/ingestion/workers/vision.agent';
import { AudioWorkerAgent } from '@/lib/biuro/ingestion/workers/audio.agent';
import { GatekeeperAgent } from '@/lib/biuro/ingestion/gatekeeper.agent';
import { CanonicalIngestPayload } from '@/types/biuro/canonicalDocument';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json(
        { error: 'Nie przesłano pliku (wymagane pole "file" w formularzu multipart).' },
        { status: 400 }
      );
    }

    const fileName = file.name || 'dokument.bin';
    const mimeType = file.type || '';
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // ── KROK 1: Dyspozytor (Ingestion Router Agent) ──────────────────────────
    const routeDecision = IngestionRouterAgent.inspect(buffer, fileName, mimeType);

    // ── KROK 2: Uruchomienie wyznaczonego Agenta Roboczego ──────────────────
    let payload: CanonicalIngestPayload;

    switch (routeDecision.targetAgent) {
      case 'Agent-KSeF':
        payload = await KsefWorkerAgent.process(buffer, fileName);
        break;

      case 'Agent-Audio':
        payload = await AudioWorkerAgent.process(buffer, fileName, mimeType);
        break;

      case 'Agent-FastPath':
        payload = await FastPathWorkerAgent.process(buffer, fileName);
        break;

      case 'Agent-Vision':
      default:
        payload = await VisionWorkerAgent.process(buffer, fileName, mimeType);
        break;
    }

    // ── KROK 3: Walidacja Syntaktyczna (Gatekeeper Agent) ────────────────────
    const verdict = GatekeeperAgent.validate(payload);

    // ── KROK 4: A2A Handshake Fallback (Siatka bezpieczeństwa) ───────────────
    // Jeśli Agent-FastPath zawiódł matematycznie (np. gubił pozycje w niestandardowym PDF),
    // następuje natychmiastowe przekazanie zadania do Agenta Wizyjnego.
    if (!verdict.isValid && verdict.requiresFallback && routeDecision.targetAgent === 'Agent-FastPath') {
      const fallbackPayload = await VisionWorkerAgent.process(buffer, fileName, mimeType, {
        fallbackFrom: 'Agent-FastPath',
        fallbackReason: verdict.reason
      });
      const fallbackVerdict = GatekeeperAgent.validate(fallbackPayload);

      return NextResponse.json({
        success: true,
        data: fallbackPayload,
        a2a_meta: {
          route_decision: routeDecision,
          initial_agent: 'Agent-FastPath',
          handshake_delegated_to: 'Agent-Vision',
          reason: verdict.reason,
          gatekeeper_verdict: fallbackVerdict
        }
      });
    }

    // ── KROK 5: Zwrócenie Zunifikowanego Kontraktu Canonical ─────────────────
    return NextResponse.json({
      success: true,
      data: payload,
      a2a_meta: {
        route_decision: routeDecision,
        gatekeeper_verdict: verdict
      }
    });

  } catch (error: any) {
    console.error('[Ingestion-Gateway-A2A] Błąd orkiestracji:', error);
    return NextResponse.json(
      {
        error: 'Błąd podczas przetwarzania dokumentu w bramie ingestji A2A.',
        details: error?.message || String(error)
      },
      { status: 500 }
    );
  }
}
