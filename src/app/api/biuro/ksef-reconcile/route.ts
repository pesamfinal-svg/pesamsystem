// src/app/api/biuro/ksef-reconcile/route.ts
//
// Endpoint Uzgadniania Faktury KSeF z Zbuforowanymi Kwitami WZ (Moduł 2)

import { NextResponse } from 'next/server';
import { KSeFReconciler, KSeFInvoiceInput } from '@/lib/biuro/normalization/ksef-reconciler';
import { ReconciledDelivery } from '@/types/biuro/reconciledDelivery.types';
import { BiuroMatchingPolicy } from '@/types/biuro/matchingPolicy.types';
import { db } from '@/lib/firebase/config';
import { collection, getDocs, query, where, limit } from 'firebase/firestore';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { ksefInvoice, deliveries: providedDeliveries, policy } = body as {
      ksefInvoice: KSeFInvoiceInput;
      deliveries?: ReconciledDelivery[];
      policy?: BiuroMatchingPolicy;
    };

    if (!ksefInvoice || !ksefInvoice.items || ksefInvoice.items.length === 0) {
      return NextResponse.json(
        { error: 'Brak wymaganego pola "ksefInvoice" z listą pozycji faktury KSeF.' },
        { status: 400 }
      );
    }

    let deliveriesToMatch = providedDeliveries || [];

    // Jeśli nie podano dostaw w żądaniu, pobierz ostatnie zbuforowane dostawy dla danego dostawcy z Firestore
    if (deliveriesToMatch.length === 0 && ksefInvoice.vendor_nip) {
      const sanitizedNip = ksefInvoice.vendor_nip.replace(/\D/g, '');
      try {
        const deliveriesRef = collection(db, 'reconciled_deliveries');
        const q = query(
          deliveriesRef,
          where('parties.vendor.nip', '==', sanitizedNip),
          limit(20)
        );
        const snapshot = await getDocs(q);
        deliveriesToMatch = snapshot.docs.map(d => d.data() as ReconciledDelivery);
      } catch (err) {
        console.warn('[API /api/biuro/ksef-reconcile] Could not fetch deliveries from Firestore:', err);
      }
    }

    const matchResult = KSeFReconciler.reconcileInvoice({
      ksefInvoice,
      deliveries: deliveriesToMatch,
      policy,
    });

    return NextResponse.json({
      success: true,
      data: matchResult,
      matched_deliveries_count: deliveriesToMatch.length,
    });
  } catch (err: any) {
    console.error('[API /api/biuro/ksef-reconcile] Error:', err);
    return NextResponse.json(
      { error: err.message || 'Błąd wewnętrzny podczas uzgadniania faktury KSeF.' },
      { status: 500 }
    );
  }
}
