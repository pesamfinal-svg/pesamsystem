// src/lib/pdf/pdf-fast-extractor.ts
// Ekstraktor pełnego tekstu z PDF z warstwą tekstową (Fast Path).
// Obsługuje:
//   - FlateDecode + literalne strumienie tekstowe (Tj / TJ)
//   - CIDFont z tabelą ToUnicode CMap (<hex> Tj / [<hex>] TJ) — format Comarch ERP Optima
//   - Kodowanie Windows-1250 / latin1

import zlib from 'zlib';

export interface ExtractedPdfText {
    fullText: string;
    pageTexts: string[];
    charCount: number;
    extractionTimeMs: number;
}

// Tablica mapowania bajtów Windows-1250 na znaki Unicode
const WIN1250_MAP: Record<number, string> = {
    0x8C: 'Ś', 0x8F: 'Ź', 0x9C: 'ś', 0x9F: 'ź',
    0xA5: 'Ą', 0xB9: 'ą', 0xA3: 'Ł', 0xB3: 'ł',
    0xC6: 'Ć', 0xE6: 'ć', 0xCA: 'Ę', 0xEA: 'ę',
    0xD1: 'Ń', 0xF1: 'ń', 0xD3: 'Ó', 0xF3: 'ó',
    0xAF: 'Ż', 0xBF: 'ż'
};

// Słownik znanych substytucji z czcionek ERP w polskich dokumentach WZ (Comarch Optima, Subiekt)
export function sanitizePolishErpArtifacts(text: string): string {
    return text
        // Spółka z o.o.
        .replace(/PE\s*!\s*KA/gi, 'SPÓŁKA')
        .replace(/SP[ÓO]\s*!\s*KA/gi, 'SPÓŁKA')
        .replace(/OGRANIC\s*#/gi, 'OGRANICZONĄ')
        .replace(/ODPOWIE\s*\$\s*CI\s*#/gi, 'ODPOWIEDZIALNOŚCIĄ')
        .replace(/HAND\s*!\s*UGOWE/gi, 'HANDLOWO USŁUGOWE')
        .replace(/HANDLOWO\s+US\s*!\s*UGOWE/gi, 'HANDLOWO USŁUGOWE')
        .replace(/D\s+BICA/gi, 'DĘBICA')
        .replace(/D\s*!\s*BICA/gi, 'DĘBICA')
        // Materiały
        .replace(/P\s*!\s*YTA/gi, 'PŁYTA')
        .replace(/P\s*!\s*YTYP/gi, 'PŁYTA')
        .replace(/P!YTA/gi, 'PŁYTA')
        .replace(/P!YTYP/gi, 'PŁYTA')
        .replace(/BORAMAX\s*\$\s*MA/gi, 'BORAMAX TAŚMA')
        .replace(/TA\s*\$\s*MA/gi, 'TAŚMA')
        .replace(/WKR\s+TY/gi, 'WKRĘTY')
        .replace(/WKR\s*!\s*TY/gi, 'WKRĘTY')
        .replace(/KLIMA\$/gi, 'KLIMAS')
        .replace(/KLIMAS\s*!\s*KI/gi, 'KLIMAS KOŁKI')
        .replace(/KO\s*!\s*KI/gi, 'KOŁKI')
        .replace(/WIE\s+1\s+O/gi, 'WIERTŁO')
        .replace(/WIE1O/gi, 'WIERTŁO')
        .replace(/WIER\s*!\s*O/gi, 'WIERTŁO')
        .replace(/P\s*!\s*YT/gi, 'PŁYT')
        .replace(/SZT\s*!\s*K/gi, 'SZTUK')
        .replace(/BIE\s*!\s*CE/gi, 'BIEŻĄCE');
}

// ─── Parsowanie tablic ToUnicode CMap (format CIDFont z Comarch ERP) ────────

/**
 * Parsuje blok CMap z formatu PDF begincmap...endcmap.
 * Zwraca mapę: kod_CID (number) → znak Unicode (string).
 * Format Comarch ERP Optima: <0036> <0053> oznacza CID 0x36 → Unicode U+0053 ('S')
 */
function parseCIDMap(cmapText: string): Map<number, string> {
    const table = new Map<number, string>();
    const re = /<([0-9a-fA-F]{4})>\s*<([0-9a-fA-F]{4,8})>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmapText)) !== null) {
        const from = parseInt(m[1], 16);
        const to = parseInt(m[2], 16);
        table.set(from, String.fromCodePoint(to));
    }
    return table;
}

/**
 * Dekoduje ciąg hex 4-bajtowych kodów CID za pomocą podanej mapy ToUnicode.
 */
function decodeCIDHex(hex: string, cidMap: Map<number, string>): string {
    let result = '';
    for (let i = 0; i + 3 < hex.length; i += 4) {
        const code = parseInt(hex.slice(i, i + 4), 16);
        result += cidMap.get(code) ?? '';
    }
    return result;
}

export function extractFullTextFromPdf(buffer: Buffer): ExtractedPdfText {
    const startTime = performance.now();
    const rawString = buffer.toString('binary');

    // ── Faza 1: Wyodrębnij i zdekompresuj wszystkie strumienie ───────────────
    const streamRegex = /stream[ \t]*\r?\n([\s\S]*?)[\r\n]*endstream/g;
    const decompressedStreams: string[] = [];
    let m: RegExpExecArray | null;

    while ((m = streamRegex.exec(rawString)) !== null) {
        const rawStream = m[1];
        try {
            const buf = Buffer.from(rawStream, 'binary');
            let dec: Buffer;
            try { dec = zlib.inflateSync(buf); }
            catch { dec = zlib.inflateRawSync(buf); }
            decompressedStreams.push(dec.toString('latin1'));
        } catch {
            decompressedStreams.push(rawStream);
        }
    }

    // ── Faza 2: Zbierz mapy ToUnicode (CMap) — kluczowe dla CIDFont ──────────
    // Comarch Optima osadza osobny strumień "begincmap...endcmap" dla każdej czcionki.
    // Mapa: indeks czcionki FNTn → Map<CID, znak>
    const cidMaps: Map<number, string>[] = [];
    for (const s of decompressedStreams) {
        if (s.includes('begincmap')) {
            cidMaps.push(parseCIDMap(s));
        }
    }

    // ── Faza 3: Wyodrębnij tekst ze strumieni treści (BT…ET) ─────────────────
    const pageTexts: string[] = [];

    for (const streamContent of decompressedStreams) {
        if (!streamContent.includes('Tj') && !streamContent.includes('TJ')) continue;

        const tokens: string[] = [];

        // Śledź aktywną czcionkę wewnątrz BT…ET bloków
        const btBlocks = streamContent.match(/BT[\s\S]*?ET/g) || [streamContent];

        for (const block of btBlocks) {
            // /FNT0, /FNT1, … — indeks mapy CID
            const fontMatch = block.match(/\/(FNT(\d+))/);
            const activeCidMapIdx = fontMatch ? parseInt(fontMatch[2], 10) : 0;
            const activeCidMap = cidMaps[activeCidMapIdx] ?? new Map<number, string>();
            const hasCidMap = activeCidMap.size > 0;

            // ── CIDFont: <hex> Tj ─────────────────────────────────────────────
            const hexTjMatches = block.match(/<([0-9a-fA-F]{4,})>\s*Tj/g) || [];
            for (const t of hexTjMatches) {
                const hex = t.replace(/^</, '').replace(/>\s*Tj$/, '');
                const decoded = hasCidMap ? decodeCIDHex(hex, activeCidMap) : hexToReadable(hex);
                if (decoded.trim()) tokens.push(decoded);
            }

            // ── CIDFont: [<hex> kern] TJ ──────────────────────────────────────
            const hexTjArrayMatches = block.match(/\[([^\]]*<[0-9a-fA-F]{4,}>[^\]]*)\]\s*TJ/g) || [];
            for (const t of hexTjArrayMatches) {
                const hexParts = t.match(/<([0-9a-fA-F]{4,})>/g) || [];
                let decoded = '';
                for (const hp of hexParts) {
                    const hex = hp.slice(1, -1);
                    decoded += hasCidMap ? decodeCIDHex(hex, activeCidMap) : hexToReadable(hex);
                }
                if (decoded.trim()) tokens.push(decoded);
            }

            // ── Literalne stringi (tekst) Tj / [(tekst)] TJ ──────────────────
            // Tylko gdy brak hex — unika duplikatów w mieszanych blokach
            if (hexTjMatches.length === 0 && hexTjArrayMatches.length === 0) {
                const tjMatches = block.match(/\(([^()]*)\)\s*Tj/g) || [];
                for (const t of tjMatches) {
                    const text = t.replace(/^\(/, '').replace(/\)\s*Tj$/, '');
                    if (text.trim()) tokens.push(decodePdfString(text));
                }
                const tjArrayMatches = block.match(/\[([^\]]*)\]\s*TJ/g) || [];
                for (const t of tjArrayMatches) {
                    const inner = t.match(/\(([^()]*)\)/g) || [];
                    const word = inner.map(s => decodePdfString(s.slice(1, -1))).join('');
                    if (word.trim()) tokens.push(word);
                }
            }
        }

        if (tokens.length > 0) {
            pageTexts.push(sanitizePolishErpArtifacts(tokens.join(' ')));
        }
    }

    // ── Fallback: surowy tekst bez kompresji (starsze ERP-y, PDFy bez FlateDecode) ──
    if (pageTexts.length === 0) {
        const plainMatches = rawString.match(/\(([a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ .,\-/]{4,})\)\s*Tj/g) || [];
        if (plainMatches.length > 0) {
            const line = plainMatches.map(t => t.replace(/[()]/g, '').replace(/\s*Tj$/, '')).join(' ');
            pageTexts.push(sanitizePolishErpArtifacts(line));
        }
    }

    const fullText = sanitizePolishErpArtifacts(pageTexts.join('\n\n'));
    const extractionTimeMs = Math.round((performance.now() - startTime) * 100) / 100;

    return {
        fullText,
        pageTexts,
        charCount: fullText.length,
        extractionTimeMs
    };
}

// ─── Pomocnicze funkcje dekodujące ───────────────────────────────────────────

/**
 * Dekoduje bufor z uwzględnieniem polskich znaków w Windows-1250
 */
function decodeBufferWithWin1250(buf: Buffer): string {
    let result = '';
    for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (WIN1250_MAP[b]) {
            result += WIN1250_MAP[b];
        } else {
            result += String.fromCharCode(b);
        }
    }
    return result;
}

/**
 * Dekoduje specjalne sekwencje escape w stringu PDF z obsługą polskich kodów oktalnych
 */
function decodePdfString(raw: string): string {
    return raw
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')')
        .replace(/\\\\/g, '\\')
        .replace(/\\([0-7]{3})/g, (_, oct) => {
            const byteVal = parseInt(oct, 8);
            if (WIN1250_MAP[byteVal]) {
                return WIN1250_MAP[byteVal];
            }
            return String.fromCharCode(byteVal);
        });
}

/**
 * Konwertuje ciąg hex na czytelny tekst z obsługą UTF-16 i Windows-1250
 */
function hexToReadable(hex: string): string {
    try {
        const bytes = Buffer.from(hex, 'hex');
        if (bytes.length % 2 === 0 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
            return bytes.slice(2).toString('utf16le');
        }
        if (bytes.length % 2 === 0 && bytes.length > 2) {
            const isUtf16 = bytes.every((b, i) => i % 2 === 1 ? b === 0 : true);
            if (isUtf16) {
                const everyOther = Buffer.from(bytes.filter((_, i) => i % 2 === 0));
                return decodeBufferWithWin1250(everyOther).replace(/[^\x20-\x7E\u0100-\u017F]/g, '');
            }
        }
        return decodeBufferWithWin1250(bytes).replace(/[^\x20-\x7E\u0100-\u017F]/g, '');
    } catch {
        return '';
    }
}
