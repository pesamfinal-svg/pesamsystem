// src/app/api/biuro/vendor-catalog/route.ts
//
// Endpoint do zarządzania rzeczywistymi dialektami hurtowni w vendor_catalogs/{nip}/items

import { NextResponse } from 'next/server';
import { VendorMemoryAgent } from '@/lib/biuro/normalization/vendor-memory.agent';
import { VendorCatalogItem } from '@/types/biuro/vendorCatalog.types';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const nip = searchParams.get('nip') || undefined;

    const { vendors, rules } = await VendorMemoryAgent.fetchAllFromFirestore(nip);

    return NextResponse.json({
      success: true,
      count: rules.length,
      vendors,
      data: rules,
    });
  } catch (err: any) {
    console.error('[API /api/biuro/vendor-catalog GET] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { vendorName, ...item } = body as VendorCatalogItem & { vendorName?: string };

    if (!item.vendor_nip || !item.vendor_raw_name || !item.canonical_name) {
      return NextResponse.json(
        { error: 'Wymagane pola: vendor_nip, vendor_raw_name, canonical_name.' },
        { status: 400 }
      );
    }

    await VendorMemoryAgent.saveLearnedRule(item, vendorName);

    return NextResponse.json({
      success: true,
      message: `Zapisano regułę dialektu dla NIP ${item.vendor_nip}`,
      data: item,
    });
  } catch (err: any) {
    console.error('[API /api/biuro/vendor-catalog POST] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const nip = searchParams.get('nip');
    const key = searchParams.get('key');

    if (!nip || !key) {
      return NextResponse.json(
        { error: 'Wymagane parametry query: nip oraz key.' },
        { status: 400 }
      );
    }

    await VendorMemoryAgent.deleteRule(nip, key);

    return NextResponse.json({
      success: true,
      message: `Usunięto regułę ${key} dla NIP ${nip}.`,
    });
  } catch (err: any) {
    console.error('[API /api/biuro/vendor-catalog DELETE] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
