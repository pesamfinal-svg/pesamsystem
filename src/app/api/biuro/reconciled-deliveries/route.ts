// src/app/api/biuro/reconciled-deliveries/route.ts
// Endpoint do odczytu, aktualizacji budowy i usuwania dokumentów WZ w kolekcji `reconciled_deliveries`
// Czysta baza Firestore: brak sztucznych danych zastępczych.

import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase/config';
import {
  collection,
  getDocs,
  query,
  orderBy,
  limit,
  doc,
  updateDoc,
  deleteDoc,
} from 'firebase/firestore';
import { ReconciledDelivery } from '@/types/biuro/reconciledDelivery.types';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const colRef = collection(db, 'reconciled_deliveries');
    const q = query(colRef, orderBy('metadata.created_at', 'desc'), limit(50));
    const snapshot = await getDocs(q);

    const list: ReconciledDelivery[] = snapshot.docs.map(d => d.data() as ReconciledDelivery);

    return NextResponse.json({
      success: true,
      count: list.length,
      data: list,
    });
  } catch (err: any) {
    console.error('[API /api/biuro/reconciled-deliveries GET] Error:', err);
    return NextResponse.json({
      success: false,
      count: 0,
      data: [],
      error: err.message,
    }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { reconciliation_id, target_site_id, target_site } = body as {
      reconciliation_id: string;
      target_site_id: string | null;
      target_site: string;
    };

    if (!reconciliation_id) {
      return NextResponse.json({ error: 'Wymagane pole: reconciliation_id' }, { status: 400 });
    }

    const deliveryRef = doc(db, 'reconciled_deliveries', reconciliation_id);
    await updateDoc(deliveryRef, {
      'parties.target_site_id': target_site_id,
      'parties.target_site': target_site,
    });

    return NextResponse.json({
      success: true,
      message: `Zaktualizowano przypisanie budowy dla ${reconciliation_id}.`,
    });
  } catch (err: any) {
    console.error('[API /api/biuro/reconciled-deliveries PATCH] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Wymagany parametr query: id' }, { status: 400 });
    }

    await deleteDoc(doc(db, 'reconciled_deliveries', id));

    return NextResponse.json({
      success: true,
      message: `Usunięto dokument WZ (${id}) z bazy Firestore.`,
    });
  } catch (err: any) {
    console.error('[API /api/biuro/reconciled-deliveries DELETE] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
