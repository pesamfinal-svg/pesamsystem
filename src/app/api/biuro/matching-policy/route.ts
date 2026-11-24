// src/app/api/biuro/matching-policy/route.ts
//
// Endpoint do odczytu i zapisu konfiguracji progów tolerancji i weryfikacji (settings/biuro_matching_policy)

import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase/config';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { BiuroMatchingPolicy, DEFAULT_BIURO_MATCHING_POLICY } from '@/types/biuro/matchingPolicy.types';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const policyDocRef = doc(db, 'settings', 'biuro_matching_policy');
    const snapshot = await getDoc(policyDocRef);

    if (snapshot.exists()) {
      return NextResponse.json({
        success: true,
        data: snapshot.data() as BiuroMatchingPolicy,
      });
    }

    return NextResponse.json({
      success: true,
      data: DEFAULT_BIURO_MATCHING_POLICY,
    });
  } catch (err: any) {
    console.error('[API /api/biuro/matching-policy GET] Error:', err);
    return NextResponse.json({
      success: true,
      data: DEFAULT_BIURO_MATCHING_POLICY,
      warning: 'Pobrano domyślną politykę z pamięci.',
    });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const policy = body as Partial<BiuroMatchingPolicy>;

    const mergedPolicy: BiuroMatchingPolicy = {
      voice_rules: {
        ...DEFAULT_BIURO_MATCHING_POLICY.voice_rules,
        ...(policy.voice_rules || {}),
      },
      ksef_reconciliation_rules: {
        ...DEFAULT_BIURO_MATCHING_POLICY.ksef_reconciliation_rules,
        ...(policy.ksef_reconciliation_rules || {}),
      },
      approvals: {
        ...DEFAULT_BIURO_MATCHING_POLICY.approvals,
        ...(policy.approvals || {}),
      },
    };

    const policyDocRef = doc(db, 'settings', 'biuro_matching_policy');
    await setDoc(policyDocRef, mergedPolicy, { merge: true });

    return NextResponse.json({
      success: true,
      message: 'Zaktualizowano politykę uzgadniania Modułu 2.',
      data: mergedPolicy,
    });
  } catch (err: any) {
    console.error('[API /api/biuro/matching-policy POST] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
