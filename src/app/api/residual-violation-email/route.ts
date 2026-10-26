// src/app/api/residual-violation-email/route.ts
import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase/admin';
import nodemailer from 'nodemailer';

interface ViolationItem {
    name: string;
    category?: string;
    subcategory?: string;
    quantity: number;
    unit?: string;
    ruleNotes: string;
    isWaste?: boolean;
}

interface ResidualViolationPayload {
    siteName: string;
    driverName: string;
    documentDate?: string;
    voiceTranscription?: string;
    violations: ViolationItem[];
}

export async function POST(req: Request) {
    try {
        const body: ResidualViolationPayload = await req.json();
        const { siteName, driverName, documentDate, voiceTranscription, violations } = body;

        if (!violations || violations.length === 0) {
            return NextResponse.json({ success: true, message: "Brak naruszeń do zaraportowania" }, { status: 200 });
        }

        const settingsSnap = await adminDb.doc("settings/system").get();
        if (!settingsSnap.exists) {
            return NextResponse.json({ success: false, message: "Brak dokumentu ustawień settings/system" }, { status: 200 });
        }

        const settings = settingsSnap.data() || {};
        const recipients: string[] = settings.residualAlertRecipients || [];

        if (recipients.length === 0) {
            return NextResponse.json({
                success: true,
                message: "Brak zdefiniowanych odbiorców alertów w Ustawieniach Systemu."
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

        const senderString = `"PESAM System AI - Alerty Zwrotów" <${process.env.EMAIL_USER}>`;
        const subject = `🚨 [ALERT AI PESAM] Naruszenie reguł zwrotu resztek · Budowa: ${siteName || "Nieokreślona"} · Kierowca: ${driverName || "Kierowca"}`;

        const rowsHtml = violations.map((v, idx) => `
            <tr style="border-bottom:1px solid #fee2e2; background-color: ${idx % 2 === 0 ? '#fff' : '#fff5f5'};">
                <td style="padding:10px 12px; font-weight:bold; color:#1e293b;">
                    ${v.name}
                    ${v.isWaste ? '<span style="display:inline-block; background:#fee2e2; color:#991b1b; padding:2px 6px; border-radius:4px; font-size:10px; margin-left:6px; font-weight:bold;">ODPAD</span>' : ''}
                </td>
                <td style="padding:10px 12px; color:#475569; font-size:12px;">
                    <b>${v.category || "Pozostałości"}</b><br/>
                    <span style="color:#64748b;">${v.subcategory || "-"}</span>
                </td>
                <td style="padding:10px 12px; color:#1e293b; font-weight:bold; text-align:center;">
                    ${v.quantity} ${v.unit || "szt."}
                </td>
                <td style="padding:10px 12px; color:#991b1b; background:#fff1f2; font-size:12px; font-weight:bold;">
                    ⚠️ ${v.ruleNotes || "Niezgodne z wytycznymi Szefa / Magazynu"}
                </td>
            </tr>
        `).join("");

        const htmlContent = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width:650px; margin:0 auto; background:#f8fafc; padding:24px; border-radius:16px; border:1px solid #e2e8f0;">
                <div style="background: linear-gradient(135deg, #b91c1c 0%, #ea580c 100%); color:#fff; padding:20px; border-radius:12px; text-align:center; box-shadow:0 4px 12px rgba(234, 88, 12, 0.2);">
                    <div style="font-size:28px; margin-bottom:4px;">🚨</div>
                    <h2 style="margin:0; font-size:18px; text-transform:uppercase; letter-spacing:1px; font-weight:900;">
                        Wykryto Naruszenie Reguł Zwrotu Resztek
                    </h2>
                    <p style="margin:6px 0 0; font-size:12px; opacity:0.9;">
                        Sztuczna inteligencja PESAM wykryła materiały niezgodne z wytycznymi Dyrekcji lub Magazynu.
                    </p>
                </div>

                <div style="background:#ffffff; padding:20px; margin-top:16px; border-radius:12px; border:1px solid #e2e8f0;">
                    <table style="width:100%; font-size:13px; color:#334155; margin-bottom:16px; border-collapse:collapse;">
                        <tr>
                            <td style="padding:6px 0; color:#64748b; width:130px;"><b>Budowa:</b></td>
                            <td style="padding:6px 0; font-weight:bold; color:#0f172a;">${siteName || "-"}</td>
                        </tr>
                        <tr>
                            <td style="padding:6px 0; color:#64748b;"><b>Kierowca / Zgłaszający:</b></td>
                            <td style="padding:6px 0; font-weight:bold; color:#0f172a;">${driverName || "-"}</td>
                        </tr>
                        <tr>
                            <td style="padding:6px 0; color:#64748b;"><b>Data zgłoszenia:</b></td>
                            <td style="padding:6px 0;">${documentDate || new Date().toISOString().split("T")[0]}</td>
                        </tr>
                    </table>

                    <div style="margin-top:12px; margin-bottom:8px;">
                        <h4 style="margin:0 0 10px; font-size:12px; text-transform:uppercase; color:#b91c1c; letter-spacing:0.5px;">
                            Pozycje naruszające wytyczne (${violations.length}):
                        </h4>
                        <table style="width:100%; border-collapse:collapse; border:1px solid #fecaca; border-radius:8px; overflow:hidden; font-size:13px;">
                            <thead>
                                <tr style="background:#fee2e2; color:#7f1d1d; text-align:left; font-size:11px; text-transform:uppercase;">
                                    <th style="padding:8px 12px;">Materiał</th>
                                    <th style="padding:8px 12px;">Kategoria</th>
                                    <th style="padding:8px 12px; text-align:center;">Ilość</th>
                                    <th style="padding:8px 12px;">Powód / Ocena AI</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rowsHtml}
                            </tbody>
                        </table>
                    </div>

                    ${voiceTranscription ? `
                        <div style="margin-top:20px; background:#f1f5f9; border-left:4px solid #64748b; padding:12px 16px; border-radius:0 8px 8px 0;">
                            <p style="margin:0 0 4px; font-size:11px; font-weight:bold; text-transform:uppercase; color:#475569;">
                                🎙️ Zapis nagrania głosowego kierowcy:
                            </p>
                            <p style="margin:0; font-size:12px; color:#1e293b; font-style:italic;">
                                "${voiceTranscription}"
                            </p>
                        </div>
                    ` : ""}

                    <div style="margin-top:20px; padding-top:16px; border-top:1px solid #e2e8f0; text-align:center;">
                        <p style="font-size:12px; color:#64748b; margin:0 0 10px;">
                            Zaloguj się do systemu PESAM, aby zweryfikować szkic protokołu w zakładce Magazyniera.
                        </p>
                    </div>
                </div>

                <p style="font-size:11px; color:#94a3b8; text-align:center; margin-top:16px;">
                    PESAM Sp. z o.o. · Automatyczny alert reguł AI · System Zarządzania Magazynem
                </p>
            </div>
        `;

        await transporter.sendMail({
            from: senderString,
            to: recipients,
            subject: subject,
            html: htmlContent,
        });

        return NextResponse.json({
            success: true,
            message: `Wysłano alert do ${recipients.length} odbiorców`,
            sentTo: recipients
        }, { status: 200 });

    } catch (err: any) {
        console.error("Błąd wysyłki alertu naruszenia reguł:", err);
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
