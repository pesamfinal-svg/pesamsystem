// src/app/api/biuro/detect-text-layer/route.ts
import { NextResponse } from 'next/server';
import { detectDocumentTextLayer } from '@/lib/pdf/text-layer-detector';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: Request) {
    try {
        const formData = await req.formData();
        const file = formData.get('file') as File | null;

        if (!file) {
            return NextResponse.json(
                { error: 'Nie przesłano żadnego pliku (pole "file" jest wymagane).' },
                { status: 400 }
            );
        }

        const fileName = file.name || 'dokument.bin';
        const mimeType = file.type || '';
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const result = detectDocumentTextLayer(buffer, fileName, mimeType);

        return NextResponse.json({
            success: true,
            data: result
        });
    } catch (error: any) {
        console.error('Błąd podczas wykrywania warstwy tekstowej:', error);
        return NextResponse.json(
            {
                error: 'Wystąpił błąd podczas analizy pliku',
                details: error?.message || String(error)
            },
            { status: 500 }
        );
    }
}
