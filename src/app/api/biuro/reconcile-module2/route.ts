// src/app/api/biuro/reconcile-module2/route.ts
//
// Główny Endpoint Wykonawczy Modułu 2 (Mózg Logistyczno-Finansowy i Normalizacja Dwutorowa)
// Łączy Moduł 1 (Ingest Payload) z Modułem 2 (Reconciled Delivery)

import { NextResponse } from 'next/server';
import { Module2Orchestrator } from '@/lib/biuro/normalization/module2-orchestrator';
import { CanonicalIngestPayload } from '@/types/biuro/canonicalDocument';
import { BiuroMatchingPolicy } from '@/types/biuro/matchingPolicy.types';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { canonicalPayload, driverAudioNote, policy } = body as {
      canonicalPayload: CanonicalIngestPayload;
      driverAudioNote?: {
        text: string;
        audioRef?: string;
        driverName?: string;
      };
      policy?: BiuroMatchingPolicy;
    };

    if (!canonicalPayload || !canonicalPayload.items) {
      return NextResponse.json(
        { error: 'Brak wymaganego pola "canonicalPayload" z poprawną listą pozycji.' },
        { status: 400 }
      );
    }

    const reconciledDelivery = await Module2Orchestrator.process({
      canonicalPayload,
      driverAudioNote,
      policy,
      persistToFirestore: true,
    });

    return NextResponse.json({
      success: true,
      data: reconciledDelivery,
    });
  } catch (err: any) {
    console.error('[API /api/biuro/reconcile-module2] Error:', err);
    return NextResponse.json(
      { error: err.message || 'Błąd wewnętrzny podczas przetwarzania Modułu 2' },
      { status: 500 }
    );
  }
}
