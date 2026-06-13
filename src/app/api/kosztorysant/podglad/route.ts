import { NextResponse } from "next/server";
import { adminStorage } from "@/lib/firebase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
    try {
        const { storagePath } = await req.json();
        if (!storagePath) return NextResponse.json({ error: "Brak ścieżki" }, { status: 400 });

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const file = adminStorage.bucket(bucketName).file(storagePath);

        // Generujemy bezpieczny link ważny przez 1 godzinę
        const [url] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + 60 * 60 * 1000,
        });

        return NextResponse.json({ url });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}