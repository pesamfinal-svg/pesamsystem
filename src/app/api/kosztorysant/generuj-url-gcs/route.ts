import { NextResponse } from "next/server";
import { adminStorage } from "@/lib/firebase/admin";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
    try {
        const { tenderId, fileName, mimeType } = await req.json();

        if (!tenderId || !fileName) {
            return NextResponse.json({ error: "Brak parametrów: tenderId lub fileName" }, { status: 400 });
        }

        console.log(`[SIGNED URL API 🔑] Generuję bezpieczny link dla: tenders/${tenderId}/documents/${fileName}`);

        const bucketName = process.env.STORAGE_BUCKET || "pesam-system-81165.firebasestorage.app";
        const bucket = adminStorage.bucket(bucketName);
        const storagePath = `tenders/${tenderId}/documents/${fileName}`;
        const file = bucket.file(storagePath);

        // Generujemy Signed URL (v4) z uprawnieniem "write" ważny przez 15 minut
        const [url] = await file.getSignedUrl({
            version: "v4",
            action: "write",
            expires: Date.now() + 15 * 60 * 1000, // 15 minut
            contentType: mimeType || "application/octet-stream"
        });

        return NextResponse.json({ url, storagePath });
    } catch (e: any) {
        console.error("[SIGNED URL API 🔑] ❌ Błąd generowania Signed URL:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}