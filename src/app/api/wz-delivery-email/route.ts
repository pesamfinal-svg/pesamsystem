// src/app/api/wz-delivery-email/route.ts
import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import nodemailer from 'nodemailer';

interface EmailPayload {
    siteName: string;
    rawItemName: string;
    type: "BULK" | "UNIQUE";
    quantity: number;
    unit: string;
    purchasePrice?: number;
    invoiceNumber?: string;
    purchaseDate?: string;
    notes?: string;
    createdByName: string;
    assignedManagerUids: string[];
}

export async function POST(req: Request) {
    try {
        const body: EmailPayload = await req.json();
        const {
            siteName,
            rawItemName,
            type,
            quantity,
            unit,
            purchasePrice,
            invoiceNumber,
            purchaseDate,
            notes,
            createdByName,
            assignedManagerUids
        } = body;

        // 1. Pobierz e-maile przypisanych kierowników
        const managerEmails: string[] = [];
        const managerNames: string[] = [];

        if (assignedManagerUids && assignedManagerUids.length > 0) {
            for (const uid of assignedManagerUids) {
                const userSnap = await adminDb.collection("users").doc(uid).get();
                if (userSnap.exists) {
                    const data = userSnap.data() || {};
                    if (data.email) managerEmails.push(data.email);
                    const name = `${data.firstName || ''} ${data.lastName || ''}`.trim() || data.email;
                    managerNames.push(name);
                }
            }
        }

        // 2. Pobierz e-mail magazynu / dyrekcji z ustawień lub profilu magazynierów
        let warehouseEmail = "";
        let directorEmail = "";
        const settingsSnap = await adminDb.doc("settings/system").get();
        if (settingsSnap.exists) {
            const s = settingsSnap.data() || {};
            warehouseEmail = s.clsWarehouseEmail || s.warehouseEmail || "";
            directorEmail = s.clsDirectorEmail || "";
        }

        // Pobierz e-maile magazynierów jeśli brak w ustawieniach
        const warehouseUserEmails: string[] = [];
        if (!warehouseEmail) {
            const usersSnap = await adminDb.collection("users").get();
            usersSnap.docs.forEach(d => {
                const u = d.data();
                if (u.roleId === "magazynier" || u.permissionOverrides?.wzApproveDelivery) {
                    if (u.email) warehouseUserEmails.push(u.email);
                }
            });
        }

        // 3. Odbiorcy wiadomości
        const recipientList = Array.from(new Set([
            ...managerEmails,
            ...(warehouseEmail ? [warehouseEmail] : warehouseUserEmails),
            ...(directorEmail ? [directorEmail] : [])
        ])).filter(Boolean);

        if (recipientList.length === 0) {
            return NextResponse.json({ success: true, message: "Brak zdefiniowanych e-maili odbiorców." });
        }

        // 4. Konfiguracja Nodemailera
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        const senderString = `"PESAM System WZ" <${process.env.EMAIL_USER}>`;
        const subject = `🚚 [NOWA DOSTAWA WZ] Wprowadzono pozycję: ${rawItemName} dla ${siteName}`;

        const itemTypeLabel = type === "UNIQUE"
            ? "⚡ Sprzęt z numerem inwentarzowym (UNIQUE)"
            : "⚖️ Materiały / Drobnica (BULK)";

        const managerNamesText = managerNames.length > 0
            ? managerNames.join(", ")
            : "Wszyscy kierownicy budowy";

        const htmlContent = `
            <div style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto; background: #f8fafc; padding: 24px; border-radius: 16px; border: 1px solid #e2e8f0;">
                <div style="background: #2563eb; color: #ffffff; padding: 20px; border-radius: 12px; text-align: center;">
                    <h2 style="margin: 0; font-size: 20px; text-transform: uppercase; tracking-spacing: 1px;">🚚 Nowy Zakup Bezpośredni z WZ / Faktury</h2>
                    <p style="margin: 6px 0 0 0; font-size: 13px; opacity: 0.9;">Rejestracja pozycji dostarczonej bezpośrednio na budowę</p>
                </div>

                <div style="background: #ffffff; padding: 24px; margin-top: 20px; border-radius: 12px; border: 1px solid #cbd5e1;">
                    <table style="width: 100%; font-size: 14px; color: #334155; border-collapse: collapse;">
                        <tr style="border-b: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold; width: 40%;">Budowa docelowa:</td>
                            <td style="padding: 10px 0; color: #1e40af; font-weight: bold;">${siteName}</td>
                        </tr>
                        <tr style="border-b: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Kierownik / Kierownicy:</td>
                            <td style="padding: 10px 0; color: #0f172a;">${managerNamesText}</td>
                        </tr>
                        <tr style="border-b: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Oryginalna nazwa z WZ:</td>
                            <td style="padding: 10px 0; color: #0f172a; font-weight: bold;">${rawItemName}</td>
                        </tr>
                        <tr style="border-b: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Typ pozycji:</td>
                            <td style="padding: 10px 0; color: #475569;">${itemTypeLabel}</td>
                        </tr>
                        <tr style="border-b: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Ilość:</td>
                            <td style="padding: 10px 0; color: #0f172a; font-weight: bold;">${quantity} ${unit}</td>
                        </tr>
                        ${purchasePrice ? `
                        <tr style="border-b: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Cena netto (szt.):</td>
                            <td style="padding: 10px 0; color: #166534; font-weight: bold;">${purchasePrice.toFixed(2)} PLN</td>
                        </tr>` : ''}
                        ${invoiceNumber ? `
                        <tr style="border-b: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Nr dokumentu:</td>
                            <td style="padding: 10px 0; font-family: monospace;">${invoiceNumber}</td>
                        </tr>` : ''}
                        ${purchaseDate ? `
                        <tr style="border-b: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Data dokumentu:</td>
                            <td style="padding: 10px 0;">${purchaseDate}</td>
                        </tr>` : ''}
                        <tr style="border-b: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Wprowadzone przez:</td>
                            <td style="padding: 10px 0; color: #475569;">${createdByName}</td>
                        </tr>
                    </table>

                    ${notes ? `
                    <div style="background: #f1f5f9; padding: 14px; border-radius: 8px; margin-top: 16px; font-size: 13px; color: #334155;">
                        <b>Uwagi / Specyfikacja:</b><br/>
                        ${notes}
                    </div>` : ''}

                    <div style="margin-top: 24px; padding: 16px; background: #eff6ff; border-radius: 10px; border-left: 4px solid #2563eb;">
                        <p style="margin: 0; font-size: 13px; color: #1e40af; font-weight: bold;">
                            👉 Informacja dla Magazyniera:
                        </p>
                        <p style="margin: 4px 0 0 0; font-size: 12px; color: #1e3a8a;">
                            Wpis trafił do kolejki oczekującej WZ. Zaloguj się do panelu <b>„Dodaj do stanu budowy z WZ”</b>, aby przypisać pozycję do kartoteki inwentarzowej budowy.
                        </p>
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: senderString,
            to: recipientList.join(", "),
            subject: subject,
            html: htmlContent
        });

        return NextResponse.json({ success: true, recipients: recipientList });

    } catch (error: any) {
        console.error("Błąd wysyłki e-mail WZ:", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
