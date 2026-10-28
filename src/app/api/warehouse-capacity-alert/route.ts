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
        const rawBody: any = await req.json();

        const settingsSnap = await adminDb.doc("settings/system").get();
        if (!settingsSnap.exists) {
            return NextResponse.json({ success: false, message: "Brak dokumentu ustawień settings/system" }, { status: 200 });
        }

        const settings = settingsSnap.data() || {};
        const recipients: string[] = settings.capacityAlertRecipients || [];

        if (recipients.length === 0) {
            return NextResponse.json({
                success: false,
                message: "Brak zdefiniowanych adresów e-mail do powiadomień w Ustawieniach Systemu."
            }, { status: 200 });
        }

        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            console.warn("Brak konfiguracji EMAIL_USER / EMAIL_PASS w środowisku!");
            return NextResponse.json({
                success: false,
                message: "Brak zmiennych EMAIL_USER/EMAIL_PASS w środowisku serwera."
            }, { status: 200 });
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        // Obsługa zarówno pojedynczej strefy jak i tablicy locations
        const locationsToAlert: any[] = Array.isArray(rawBody.locations) && rawBody.locations.length > 0
            ? rawBody.locations
            : [
                {
                    name: rawBody.locationName || rawBody.name || "Strefa magazynowa",
                    totalCapacity: rawBody.totalCapacity || 0,
                    currentOccupied: rawBody.currentOccupied || 0,
                    fillPercentage: rawBody.fillPercentage ?? (rawBody.totalCapacity > 0 ? Math.round((rawBody.currentOccupied / rawBody.totalCapacity) * 100) : 0),
                    thresholdType: rawBody.thresholdType,
                    categories: rawBody.categories,
                    criticalThreshold: rawBody.criticalThreshold || 85,
                    alertThreshold: rawBody.alertThreshold || 70
                }
            ];

        const updaterName = rawBody.updaterName || "Magazynier / Użytkownik";

        // Sprawdzamy czy którekolwiek miejsce jest krytyczne
        const hasCritical = locationsToAlert.some(l => (l.thresholdType === "CRITICAL" || l.fillPercentage >= (l.criticalThreshold || 85)));
        const senderString = `"PESAM Magazyn - Alerty Pojemności" <${process.env.EMAIL_USER}>`;

        const subject = locationsToAlert.length === 1
            ? `${hasCritical ? '🚨 [KRYTYCZNE PRZEPEŁNIENIE]' : '⚠️ [OSTRZEŻENIE O ZAPEŁNIENIU]'} Magazyn PESAM: ${locationsToAlert[0].name} (${locationsToAlert[0].fillPercentage}%)`
            : `${hasCritical ? '🚨 [KRYTYCZNY ALERT]' : '⚠️ [ALERT ZAPEŁNIENIA]'} Magazyn PESAM: Przepełnienie stref magazynowych (${locationsToAlert.length} stref)`;

        const htmlContent = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width:650px; margin:0 auto; background:#f8fafc; padding:24px; border-radius:16px; border:1px solid #e2e8f0;">
                <div style="background: ${hasCritical ? 'linear-gradient(135deg, #b91c1c 0%, #dc2626 100%)' : 'linear-gradient(135deg, #d97706 0%, #f59e0b 100%)'}; color:#fff; padding:22px; border-radius:12px; text-align:center; box-shadow:0 4px 12px rgba(0,0,0,0.1);">
                    <div style="font-size:32px; margin-bottom:6px;">${hasCritical ? '🚨' : '⚠️'}</div>
                    <h2 style="margin:0; font-size:18px; text-transform:uppercase; letter-spacing:1px; font-weight:900;">
                        ${hasCritical ? 'Krytyczne Przepełnienie Stref Magazynowych' : 'Wysokie Zapełnienie Stref Magazynowych (JPP)'}
                    </h2>
                    <p style="margin:6px 0 0; font-size:13px; opacity:0.95;">
                        Alert wygenerowany dla <b>${locationsToAlert.length}</b> ${locationsToAlert.length === 1 ? 'strefy magazynowej' : 'stref magazynowych'} przez: <b>${updaterName}</b>.
                    </p>
                </div>

                <div style="background:#ffffff; padding:20px; margin-top:16px; border-radius:12px; border:1px solid #e2e8f0;">
                    ${locationsToAlert.map(loc => {
                        const isLocCritical = loc.thresholdType === "CRITICAL" || loc.fillPercentage >= (loc.criticalThreshold || 85);
                        const free = Math.round(Math.max(0, loc.totalCapacity - loc.currentOccupied) * 100) / 100;
                        return `
                            <div style="padding:14px 0; border-bottom:1px solid #f1f5f9;">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                                    <span style="font-size:15px; font-weight:bold; color:#0f172a;">📍 ${loc.name}</span>
                                    <span style="font-size:11px; font-weight:900; padding:2px 8px; border-radius:12px; background:${isLocCritical ? '#fee2e2' : '#fef3c7'}; color:${isLocCritical ? '#991b1b' : '#92400e'};">
                                        ${loc.fillPercentage}% pojemności (${isLocCritical ? 'KRYTYCZNE' : 'OSTRZEŻENIE'})
                                    </span>
                                </div>
                                <table style="width:100%; font-size:12px; color:#475569;">
                                    <tr>
                                        <td style="width:50%;"><b>Zajętość:</b> ${loc.currentOccupied} z ${loc.totalCapacity} JPP</td>
                                        <td style="width:50%; color:#059669;"><b>Wolne:</b> ${free} JPP</td>
                                    </tr>
                                    ${loc.categories && loc.categories.length > 0 ? `
                                    <tr>
                                        <td colspan="2" style="padding-top:4px; font-size:11px; color:#64748b;">Kategorie: ${loc.categories.join(', ')}</td>
                                    </tr>` : ''}
                                </table>
                            </div>
                        `;
                    }).join('')}

                    <div style="margin-top:16px; padding:12px 16px; background:${hasCritical ? '#fef2f2' : '#fffbeb'}; border-radius:8px; border-left:4px solid ${hasCritical ? '#ef4444' : '#f59e0b'};">
                        <p style="margin:0; font-size:12px; color:${hasCritical ? '#991b1b' : '#92400e'}; line-height:1.5;">
                            <b>Zalecenie dyspozytorskie:</b> Ogranicz lub wstrzymaj nowe dostawy i zwroty resztek budowlanych do powyższych stref do czasu zwolnienia miejsc paletowych (JPP).
                        </p>
                    </div>
                </div>

                <div style="margin-top:16px; text-align:center; font-size:11px; color:#94a3b8;">
                    Wiadomość wygenerowana z panelu głównego <b>PESAM System Magazynowy</b> · <a href="https://pesam-magazyn--pesam-system-81165.europe-west4.hosted.app/dashboard" style="color:#2563eb; text-decoration:none;">Otwórz Pulpit</a>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: senderString,
            to: recipients.join(', '),
            subject: subject,
            html: htmlContent
        });

        return NextResponse.json({
            success: true,
            message: `Pomyślnie wysłano alert na adresy: ${recipients.join(', ')}`
        }, { status: 200 });
    } catch (error: any) {
        console.error("Błąd wysyłki alertu pojemności magazynu:", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
