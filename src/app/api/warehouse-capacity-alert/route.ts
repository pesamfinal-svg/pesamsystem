// src/app/api/warehouse-capacity-alert/route.ts
import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import nodemailer from 'nodemailer';

interface CapacityAlertPayload {
    locationName: string;
    totalCapacity: number;
    currentOccupied: number;
    fillPercentage: number;
    thresholdType: "ALERT" | "CRITICAL";
    categories?: string[];
    updaterName?: string;
    notes?: string;
}

export async function POST(req: Request) {
    try {
        const body: CapacityAlertPayload = await req.json();
        const { locationName, totalCapacity, currentOccupied, fillPercentage, thresholdType, categories, updaterName } = body;

        const settingsSnap = await adminDb.doc("settings/system").get();
        if (!settingsSnap.exists) {
            return NextResponse.json({ success: false, message: "Brak dokumentu ustawień settings/system" }, { status: 200 });
        }

        const settings = settingsSnap.data() || {};
        const recipients: string[] = settings.capacityAlertRecipients || [];

        if (recipients.length === 0) {
            return NextResponse.json({
                success: true,
                message: "Brak zdefiniowanych odbiorców alertów o zapełnieniu stref w Ustawieniach Systemu."
            }, { status: 200 });
        }

        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            console.warn("Brak konfiguracji EMAIL_USER / EMAIL_PASS w środowisku!");
            return NextResponse.json({
                success: false,
                message: "Brak zmiennych EMAIL_USER/EMAIL_PASS w środowisku."
            }, { status: 200 });
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        const isCritical = thresholdType === "CRITICAL" || fillPercentage >= 85;
        const freeSlots = Math.max(0, parseFloat((totalCapacity - currentOccupied).toFixed(1)));
        const senderString = `"PESAM Magazyn - Alerty Pojemności" <${process.env.EMAIL_USER}>`;
        const subject = `${isCritical ? '🚨 [KRYTYCZNE PRZEPEŁNIENIE]' : '⚠️ [OSTRZEŻENIE O ZAPEŁNIENIU]'} Magazyn PESAM: ${locationName} (${fillPercentage}%)`;

        const htmlContent = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width:650px; margin:0 auto; background:#f8fafc; padding:24px; border-radius:16px; border:1px solid #e2e8f0;">
                <div style="background: ${isCritical ? 'linear-gradient(135deg, #b91c1c 0%, #dc2626 100%)' : 'linear-gradient(135deg, #d97706 0%, #f59e0b 100%)'}; color:#fff; padding:22px; border-radius:12px; text-align:center; box-shadow:0 4px 12px rgba(0,0,0,0.1);">
                    <div style="font-size:32px; margin-bottom:6px;">${isCritical ? '🚨' : '⚠️'}</div>
                    <h2 style="margin:0; font-size:18px; text-transform:uppercase; letter-spacing:1px; font-weight:900;">
                        ${isCritical ? 'Krytyczne Przepełnienie Strefy Magazynowej' : 'Wysokie Zapełnienie Miejsca Składowania'}
                    </h2>
                    <p style="margin:6px 0 0; font-size:13px; opacity:0.95;">
                        Miejsce <b>"${locationName}"</b> osiągnęło poziom <b>${fillPercentage}%</b> pojemności.
                    </p>
                </div>

                <div style="background:#ffffff; padding:20px; margin-top:16px; border-radius:12px; border:1px solid #e2e8f0;">
                    <table style="width:100%; font-size:13px; color:#334155; margin-bottom:16px; border-collapse:collapse;">
                        <tr>
                            <td style="padding:8px 0; color:#64748b; width:160px;"><b>Strefa / Miejsce:</b></td>
                            <td style="padding:8px 0; font-weight:bold; font-size:15px; color:#0f172a;">${locationName}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0; color:#64748b;"><b>Aktualny stan:</b></td>
                            <td style="padding:8px 0; font-weight:bold; color:${isCritical ? '#dc2626' : '#d97706'}; font-size:15px;">
                                ${currentOccupied} z ${totalCapacity} JPP (${fillPercentage}%)
                            </td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0; color:#64748b;"><b>Pozostałe wolne miejsce:</b></td>
                            <td style="padding:8px 0; font-weight:bold; color:#059669;">${freeSlots} JPP / miejsc paletowych</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0; color:#64748b;"><b>Składowane kategorie:</b></td>
                            <td style="padding:8px 0; color:#334155;">${categories && categories.length > 0 ? categories.join(', ') : 'Wszystkie / Ogólne'}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0; color:#64748b;"><b>Zmiana wprowadzona przez:</b></td>
                            <td style="padding:8px 0; color:#475569;">${updaterName || "Magazynier / System"}</td>
                        </tr>
                    </table>

                    <div style="margin-top:16px; padding:12px 16px; background:${isCritical ? '#fef2f2' : '#fffbeb'}; border-radius:8px; border-left:4px solid ${isCritical ? '#ef4444' : '#f59e0b'};">
                        <p style="margin:0; font-size:12px; color:${isCritical ? '#991b1b' : '#92400e'}; line-height:1.5;">
                            <b>Rekomendacja magazynowa:</b> Wstrzymaj lub przekieruj nowe zwroty materiałów przypisanych do tej strefy, albo zaplanuj ich ponowne wydanie na trwające budowy lub utylizację.
                        </p>
                    </div>
                </div>

                <div style="margin-top:16px; text-align:center; font-size:11px; color:#94a3b8;">
                    Wiadomość wygenerowana automatycznie przez <b>PESAM System Magazynowy</b> · <a href="https://pesam-magazyn--pesam-system-81165.europe-west4.hosted.app/dashboard/inventory" style="color:#2563eb; text-decoration:none;">Zarządzaj strefami w systemie</a>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: senderString,
            to: recipients.join(', '),
            subject: subject,
            html: htmlContent
        });

        return NextResponse.json({ success: true, message: `Wysłano alert do: ${recipients.join(', ')}` }, { status: 200 });
    } catch (error: any) {
        console.error("Błąd wysyłki alertu pojemności magazynu:", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
