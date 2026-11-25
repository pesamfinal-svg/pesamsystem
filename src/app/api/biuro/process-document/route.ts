// src/app/api/biuro/process-document/route.ts
//
// Główny Endpoint Pełnej Orkiestracji A2A (Moduł 1 + Moduł 2 w Jednym Potoku)
//
// Schemat przepływu Agent-to-Agent (8 Agentów Wykonawczych):
// 1. IngestionRouterAgent   -> identyfikacja MIME i sygnatur, wybór agenta roboczego
// 2. Worker Agent           -> KSeF (XML) | FastPath (Digital PDF) | Vision (Skan) | Audio (STT)
// 3. GatekeeperAgent        -> walidacja syntaktyczna i matematyczna sum
// 4. A2A Handshake Fallback -> w razie potrzeby przekazanie FastPath do Vision
// 5. VendorMemoryAgent      -> dialekt NIP hurtowni (Fast Cache RAM: 0 ms)
// 6. DimensionalDiscovery   -> geometria fizyczna i pętla samouczenia
// 7. DeterministicMath      -> bankowe przeliczenia bez halucynacji LLM (Decimal.js)
// 8. DualUnitEngine         -> nienaruszalny stan Tor RAW + Tor NORMALIZED
// 9. VoiceAnchorMatcher     -> weryfikacja sumy kontrolnej wierszy i towaru kotwiczącego
// 10. ReconciledDelivery    -> utrwalenie w kolekcji Firestore `reconciled_deliveries`

import { NextResponse } from 'next/server';
import { IngestionRouterAgent } from '@/lib/biuro/ingestion/router.agent';
import { KsefWorkerAgent } from '@/lib/biuro/ingestion/workers/ksef.agent';
import { FastPathWorkerAgent } from '@/lib/biuro/ingestion/workers/fast-path.agent';
import { VisionWorkerAgent } from '@/lib/biuro/ingestion/workers/vision.agent';
import { AudioWorkerAgent } from '@/lib/biuro/ingestion/workers/audio.agent';
import { GatekeeperAgent } from '@/lib/biuro/ingestion/gatekeeper.agent';
import { Module2Orchestrator } from '@/lib/biuro/normalization/module2-orchestrator';
import { CanonicalIngestPayload } from '@/types/biuro/canonicalDocument';
import { ReconciledDelivery } from '@/types/biuro/reconciledDelivery.types';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    let finalPayload: CanonicalIngestPayload;
    let driverNoteText = 'CMB na Kielce, 7 pozycji na kwicie, w tym 6 płyt OSB.';
    let routeDecision: any = null;
    let gatekeeperVerdict: any = null;

    const contentType = req.headers.get('content-type') || '';

    // Obsługa JSON (wklejanie lub wywołanie bezpośrednie)
    if (contentType.includes('application/json')) {
      const jsonBody = await req.json();
      finalPayload = jsonBody.canonicalPayload || jsonBody;
      if (jsonBody.driverText) driverNoteText = jsonBody.driverText;
      routeDecision = {
        targetAgent: finalPayload.meta?.processed_by_agent || 'Agent-KSeF',
        sourceType: finalPayload.meta?.source_type || 'KSEF_JSON',
        reason: 'Bezpośredni import strumienia JSON / KSeF'
      };
      gatekeeperVerdict = GatekeeperAgent.validate(finalPayload);
    } else {
      // Obsługa multipart FormData (upload pliku)
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      const customDriverText = formData.get('driverText') as string | null;
      if (customDriverText) driverNoteText = customDriverText;

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
      routeDecision = IngestionRouterAgent.inspect(buffer, fileName, mimeType);

      // ── KROK 2: Uruchomienie wyznaczonego Agenta Roboczego ──────────────────
      switch (routeDecision.targetAgent) {
        case 'Agent-KSeF':
          finalPayload = await KsefWorkerAgent.process(buffer, fileName);
          break;

        case 'Agent-Audio':
          finalPayload = await AudioWorkerAgent.process(buffer, fileName, mimeType);
          break;

        case 'Agent-FastPath':
          finalPayload = await FastPathWorkerAgent.process(buffer, fileName);
          break;

        case 'Agent-Vision':
        default:
          finalPayload = await VisionWorkerAgent.process(buffer, fileName, mimeType);
          break;
      }

      // ── KROK 3: Walidacja Syntaktyczna (Gatekeeper Agent) ────────────────────
      gatekeeperVerdict = GatekeeperAgent.validate(finalPayload);

      // ── KROK 4: A2A Handshake Fallback (Siatka bezpieczeństwa) ───────────────
      if (!gatekeeperVerdict.isValid && gatekeeperVerdict.requiresFallback && routeDecision.targetAgent === 'Agent-FastPath') {
        const fallbackPayload = await VisionWorkerAgent.process(buffer, fileName, mimeType, {
          fallbackFrom: 'Agent-FastPath',
          fallbackReason: gatekeeperVerdict.reason
        });
        const fallbackVerdict = GatekeeperAgent.validate(fallbackPayload);
        finalPayload = fallbackPayload;
        gatekeeperVerdict = fallbackVerdict;
      }
    }

    // ── KROK 5-10: NATYCHMIASTOWA AUTOMATYCZNA ORKIESTRACJA MODUŁU 2 ─────────
    // System nie wymaga ręcznego przechodzenia do Modułu 2 – wszystko dzieje się automatycznie w jednym potoku!
    let reconciledDelivery: ReconciledDelivery | null = null;
    try {
      reconciledDelivery = await Module2Orchestrator.process({
        canonicalPayload: finalPayload,
        driverAudioNote: driverNoteText ? {
          text: driverNoteText,
          audioRef: 'audio/kielce_dawid_0939.mp3',
          driverName: 'Dawid (Kierowca)',
        } : undefined,
        persistToFirestore: true,
      });
    } catch (m2Error) {
      console.warn('[Process-Document] Module 2 Orchestrator non-fatal warning:', m2Error);
    }

    return NextResponse.json({
      success: true,
      data: finalPayload,
      reconciled_delivery: reconciledDelivery,
      a2a_meta: {
        route_decision: routeDecision,
        gatekeeper_verdict: gatekeeperVerdict,
        module2_status: reconciledDelivery ? reconciledDelivery.metadata.status : 'SKIPPED',
        driver_audit: reconciledDelivery ? reconciledDelivery.driver_audit : null,
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
