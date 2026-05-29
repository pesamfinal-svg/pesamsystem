// src/app/api/fetch-image/route.ts
import { NextResponse } from "next/server";

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const imageUrl = searchParams.get("url");

    if (!imageUrl) {
        return NextResponse.json({ error: "Brak parametru url" }, { status: 400 });
    }

    try {
        const response = await fetch(imageUrl, {
            headers: {
                // Udajemy prawdziwą przeglądarkę, aby serwer zewnętrzny nie zablokował pobierania
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        });

        if (!response.ok) {
            throw new Error(`Serwer zewnętrzny zwrócił status ${response.status}`);
        }

        const blob = await response.blob();
        const headers = new Headers();
        headers.set("Content-Type", response.headers.get("Content-Type") || "image/jpeg");

        return new NextResponse(blob, { headers });
    } catch (error: any) {
        return NextResponse.json({ error: error.message || "Błąd pobierania" }, { status: 500 });
    }
}