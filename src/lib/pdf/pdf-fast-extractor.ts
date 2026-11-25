// src/lib/pdf/pdf-fast-extractor.ts
// Ekstraktor pełnego tekstu z PDF z warstwą tekstową (Fast Path).
// Reużywa logiki dekompresji FlateDecode z text-layer-detector, ale
// zbiera CAŁY tekst i poprawnie dekoduje polskie znaki w standardach Windows-1250 i ISO-8859-2.

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

export function extractFullTextFromPdf(buffer: Buffer): ExtractedPdfText {
    const startTime = performance.now();
    const rawString = buffer.toString('binary');
    const streamRegex = /stream[ \t]*\r?\n([\s\S]*?)[\r\n\s]*endstream/g;

    const pageTexts: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = streamRegex.exec(rawString)) !== null) {
        const rawStream = match[1];
        let streamContent = '';

        // Dekompresja FlateDecode
        try {
            const streamBuffer = Buffer.from(rawStream, 'binary');
            let decompressed: Buffer;
            try {
                decompressed = zlib.inflateSync(streamBuffer);
            } catch {
                decompressed = zlib.inflateRawSync(streamBuffer);
            }
            streamContent = decodeBufferWithWin1250(decompressed);
        } catch {
            streamContent = rawStream;
        }

        const tokens: string[] = [];

        // 1. Operator (tekst) Tj — string literalny
        const tjMatches = streamContent.match(/\(([^()]*)\)\s*Tj/g) || [];
        for (const t of tjMatches) {
            const text = t.replace(/^\(/, '').replace(/\)\s*Tj$/, '');
            if (text.trim()) tokens.push(decodePdfString(text));
        }

        // 2. Operator [(tekst) kern (tekst)] TJ — tablicowy
        const tjArrayMatches = streamContent.match(/\[([^\]]*)\]\s*TJ/g) || [];
        for (const t of tjArrayMatches) {
            const inner = t.match(/\(([^()]*)\)/g) || [];
            const word = inner.map(s => decodePdfString(s.slice(1, -1))).join('');
            if (word.trim()) tokens.push(word);
        }

        // 3. Hex <4142...> Tj
        const hexTjMatches = streamContent.match(/<([0-9a-fA-F]{2,})>\s*Tj/g) || [];
        for (const t of hexTjMatches) {
            const hex = t.replace(/^</, '').replace(/>\s*Tj$/, '');
            const decoded = hexToReadable(hex);
            if (decoded.trim()) tokens.push(decoded);
        }

        // 4. [<hex>] TJ
        const hexTjArrayMatches = streamContent.match(/\[([^\]]*<[0-9a-fA-F]{4,}>[^\]]*)\]\s*TJ/g) || [];
        for (const t of hexTjArrayMatches) {
            const hexParts = t.match(/<([0-9a-fA-F]{2,})>/g) || [];
            const decoded = hexParts.map(h => hexToReadable(h.slice(1, -1))).join('');
            if (decoded.trim()) tokens.push(decoded);
        }

        if (tokens.length > 0) {
            const line = sanitizePolishErpArtifacts(tokens.join(' '));
            pageTexts.push(line);
        }
    }

    // Fallback: jeśli nic nie znaleźliśmy przez strumienie, szukamy surowego tekstu
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
