// src/lib/biuro/normalization/vendor-memory.agent.ts
//
// Podagent Profili Dostawców (Vendor Dialect Memory per NIP)
// Pamięć Firestore: vendor_catalogs/{nip}/items/{item_hash}
// Zgodny ze specyfikacją biuro-ai.md §Część 2/3

import { db } from '@/lib/firebase/config';
import { doc, getDoc, setDoc, updateDoc, increment } from 'firebase/firestore';
import { VendorCatalogItem } from '@/types/biuro/vendorCatalog.types';

// Preselekcja znanych pozycji dialektów dostawców z dokumentacji
const PRESEEDED_VENDOR_ITEMS: VendorCatalogItem[] = [
  // CMB DĘBICA SP. Z O.O. (NIP: 8722410651)
  {
    vendor_nip: '8722410651',
    vendor_raw_name: 'PROFIL C-50/3 MB MFO /10/200/',
    clean_lookup_key: 'PROFIL_C_50_3_MB_MFO',
    vendor_invoiced_unit: 'szt',
    canonical_product_id: 'MAT-STAL-C50',
    canonical_name: 'Profil stalowy ścienny C-50',
    pesam_accounting_unit: 'mb',
    conversion_rule: {
      multiplier: 3.0,
      formula: '1 szt = 3.0 mb',
      operation: 'MULTIPLY',
    },
    confidence_score: 1.0,
    learned_source: 'PRESEEDED',
    usage_count: 42,
    last_used_at: new Date().toISOString(),
  },
  {
    vendor_nip: '8722410651',
    vendor_raw_name: 'PROFIL U- 50/3MB MFO /10/200/ W.',
    clean_lookup_key: 'PROFIL_U_50_3_MB_MFO',
    vendor_invoiced_unit: 'szt',
    canonical_product_id: 'MAT-STAL-U50',
    canonical_name: 'Profil stalowy obwodowy U-50',
    pesam_accounting_unit: 'mb',
    conversion_rule: {
      multiplier: 3.0,
      formula: '1 szt = 3.0 mb',
      operation: 'MULTIPLY',
    },
    confidence_score: 1.0,
    learned_source: 'PRESEEDED',
    usage_count: 28,
    last_used_at: new Date().toISOString(),
  },
  {
    vendor_nip: '8722410651',
    vendor_raw_name: 'KLIMAS WKRĘTY SAMOW.FOSF.AT TYP TEX A 200 BTEX-35095',
    clean_lookup_key: 'KLIMAS_WKRETY_TEX_A_200',
    vendor_invoiced_unit: 'opak',
    canonical_product_id: 'MAT-WKRET-TEX-35095',
    canonical_name: 'Wkręty samowiercące TEX 3.5x9.5 mm',
    pesam_accounting_unit: 'szt',
    conversion_rule: {
      multiplier: 200.0,
      formula: '1 opak = 200 szt',
      operation: 'MULTIPLY',
    },
    confidence_score: 1.0,
    learned_source: 'PRESEEDED',
    usage_count: 35,
    last_used_at: new Date().toISOString(),
  },
  {
    vendor_nip: '8722410651',
    vendor_raw_name: 'BORAMAX TAŚMA WZMACNIANA DWUSTRONNA 25M',
    clean_lookup_key: 'BORAMAX_TASMA_WZMACNIANA_25M',
    vendor_invoiced_unit: 'szt',
    canonical_product_id: 'MAT-TASMA-BORAMAX-25M',
    canonical_name: 'Taśma wzmacniana dwustronna 25m',
    pesam_accounting_unit: 'szt',
    conversion_rule: {
      multiplier: 1.0,
      formula: '1 szt = 1 szt',
      operation: 'STATIC',
    },
    confidence_score: 1.0,
    learned_source: 'PRESEEDED',
    usage_count: 14,
    last_used_at: new Date().toISOString(),
  },
  {
    vendor_nip: '8722410651',
    vendor_raw_name: 'PŁYTA OSB-3 10/1250/2500',
    clean_lookup_key: 'PLYTA_OSB_3_10_1250_2500',
    vendor_invoiced_unit: 'szt',
    canonical_product_id: 'MAT-DREW-OSB3-10MM',
    canonical_name: 'Płyta OSB-3 grubość 10 mm',
    pesam_accounting_unit: 'm2',
    conversion_rule: {
      multiplier: 3.125,
      formula: '1.25m * 2.50m = 3.125 m2/szt',
      operation: 'MULTIPLY',
    },
    confidence_score: 1.0,
    learned_source: 'PRESEEDED',
    usage_count: 89,
    last_used_at: new Date().toISOString(),
  },
  {
    vendor_nip: '8722410651',
    vendor_raw_name: 'SCHMITH WIERTŁO SDS MESSERSCHMITH/ T5X160',
    clean_lookup_key: 'SCHMITH_WIERTLO_SDS_T5X160',
    vendor_invoiced_unit: 'szt',
    canonical_product_id: 'MAT-NARZ-WIERTLO-SDS-5X160',
    canonical_name: 'Wiertło SDS 5x160 mm',
    pesam_accounting_unit: 'szt',
    conversion_rule: {
      multiplier: 1.0,
      formula: '1 szt = 1 szt',
      operation: 'STATIC',
    },
    confidence_score: 1.0,
    learned_source: 'PRESEEDED',
    usage_count: 9,
    last_used_at: new Date().toISOString(),
  },
  {
    vendor_nip: '8722410651',
    vendor_raw_name: 'KLIMAS KOŁKI DO WBIJANIA W-SM 6X40 OPAK.50SZT',
    clean_lookup_key: 'KLIMAS_KOLKI_W_SM_6X40_OPAK_50SZT',
    vendor_invoiced_unit: 'opak',
    canonical_product_id: 'MAT-KOLKI-SM-640',
    canonical_name: 'Kołki do wbijania SM 6x40 mm',
    pesam_accounting_unit: 'szt',
    conversion_rule: {
      multiplier: 50.0,
      formula: '1 opak = 50 szt',
      operation: 'MULTIPLY',
    },
    confidence_score: 1.0,
    learned_source: 'PRESEEDED',
    usage_count: 51,
    last_used_at: new Date().toISOString(),
  },

  // SIG POLSKA SP. Z O.O. (NIP: 7790000844)
  {
    vendor_nip: '7790000844',
    vendor_raw_name: 'Płyta Knauf A 12.5mm',
    clean_lookup_key: 'PLYTA_KNAUF_A_12_5MM',
    vendor_invoiced_unit: 'm2',
    canonical_product_id: 'MAT-GK-12.5',
    canonical_name: 'Płyta gipsowo-kartonowa standardowa 12.5 mm',
    pesam_accounting_unit: 'm2',
    conversion_rule: {
      multiplier: 1.0,
      formula: '1 m2 = 1 m2 (fakturowana w m2)',
      operation: 'STATIC',
    },
    confidence_score: 1.0,
    learned_source: 'PRESEEDED',
    usage_count: 30,
    last_used_at: new Date().toISOString(),
  },
  {
    vendor_nip: '7790000844',
    vendor_raw_name: 'Profil C50 3.0M Knauf',
    clean_lookup_key: 'PROFIL_C50_3_0M_KNAUF',
    vendor_invoiced_unit: 'szt',
    canonical_product_id: 'MAT-STAL-C50',
    canonical_name: 'Profil stalowy ścienny C-50',
    pesam_accounting_unit: 'mb',
    conversion_rule: {
      multiplier: 3.0,
      formula: '1 szt = 3.0 mb',
      operation: 'MULTIPLY',
    },
    confidence_score: 1.0,
    learned_source: 'PRESEEDED',
    usage_count: 22,
    last_used_at: new Date().toISOString(),
  },

  // CASTORAMA POLSKA SP. Z O.O. (NIP: 5261040828)
  {
    vendor_nip: '5261040828',
    vendor_raw_name: 'Profil C 3m paczka 10szt',
    clean_lookup_key: 'PROFIL_C_3M_PACZKA_10SZT',
    vendor_invoiced_unit: 'paczka',
    canonical_product_id: 'MAT-STAL-C50',
    canonical_name: 'Profil stalowy ścienny C-50',
    pesam_accounting_unit: 'mb',
    conversion_rule: {
      multiplier: 30.0,
      formula: '1 paczka (10szt x 3mb) = 30.0 mb',
      operation: 'MULTIPLY',
    },
    confidence_score: 1.0,
    learned_source: 'PRESEEDED',
    usage_count: 15,
    last_used_at: new Date().toISOString(),
  },
];

export class VendorMemoryAgent {
  private static localCache: Map<string, VendorCatalogItem> = new Map();

  static initializeCache() {
    if (this.localCache.size === 0) {
      for (const item of PRESEEDED_VENDOR_ITEMS) {
        const key = this.createCacheKey(item.vendor_nip, item.clean_lookup_key);
        this.localCache.set(key, item);
      }
    }
  }

  /**
   * Oczyszcza nazwę towaru do znormalizowanego klucza słownikowego
   */
  static cleanKey(rawName: string): string {
    return rawName
      .toUpperCase()
      .replace(/[ąćęłńóśźż]/g, (match) => {
        const map: Record<string, string> = {
          'ą': 'A', 'ć': 'C', 'ę': 'E', 'ł': 'L', 'ń': 'N',
          'ó': 'O', 'ś': 'S', 'ź': 'Z', 'ż': 'Z'
        };
        return map[match] || match;
      })
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, 80);
  }

  /**
   * Generuje unikalny klucz w cache i Firestore
   */
  static createCacheKey(vendorNip: string, cleanKey: string): string {
    const sanitizedNip = (vendorNip || 'UNKNOWN').replace(/\D/g, '');
    return `${sanitizedNip}::${cleanKey}`;
  }

  /**
   * Wyszukuje pozycję w pamięci danego NIP-u (najpierw Cache w RAM, potem Firestore)
   */
  static async lookupItem(vendorNip: string, rawName: string): Promise<VendorCatalogItem | null> {
    this.initializeCache();
    const cleanLookupKey = this.cleanKey(rawName);
    const sanitizedNip = (vendorNip || '').replace(/\D/g, '');
    const cacheKey = this.createCacheKey(sanitizedNip, cleanLookupKey);

    // 1. Sprawdzenie szybkiej pamięci lokalnej (Fast RAM Cache: 0 ms, 0 zł)
    if (this.localCache.has(cacheKey)) {
      const item = this.localCache.get(cacheKey)!;
      item.usage_count += 1;
      item.last_used_at = new Date().toISOString();
      return item;
    }

    // Częściowe dopasowanie (fuzzy match) w RAM dla wariantów
    for (const [key, item] of this.localCache.entries()) {
      if (key.startsWith(sanitizedNip + '::')) {
        // Sprawdź czy klucz lub nazwa zawiera kluczowe tokeny
        const itemTokens = item.clean_lookup_key.split('_');
        const searchTokens = cleanLookupKey.split('_');
        const matchCount = searchTokens.filter(t => t.length > 2 && itemTokens.includes(t)).length;
        if (matchCount >= 3 && matchCount / Math.max(itemTokens.length, 1) > 0.6) {
          return item;
        }
      }
    }

    // 2. Sprawdzenie kolekcji Firestore: vendor_catalogs/{nip}/items/{cleanLookupKey}
    try {
      if (sanitizedNip) {
        const itemDocRef = doc(db, 'vendor_catalogs', sanitizedNip, 'items', cleanLookupKey);
        const snapshot = await getDoc(itemDocRef);
        if (snapshot.exists()) {
          const data = snapshot.data() as VendorCatalogItem;
          this.localCache.set(cacheKey, data);
          // Asynchroniczna inkrementacja licznika
          updateDoc(itemDocRef, {
            usage_count: increment(1),
            last_used_at: new Date().toISOString()
          }).catch(() => {});
          return data;
        }
      }
    } catch (err) {
      console.warn('[VendorMemoryAgent] Firestore lookup warning:', err);
    }

    return null;
  }

  /**
   * Zapisuje nowo poznaną regułę w Firestore oraz w cache RAM
   */
  static async saveLearnedRule(item: VendorCatalogItem): Promise<void> {
    this.initializeCache();
    const sanitizedNip = (item.vendor_nip || '').replace(/\D/g, '');
    const cleanLookupKey = item.clean_lookup_key || this.cleanKey(item.vendor_raw_name);
    const cacheKey = this.createCacheKey(sanitizedNip, cleanLookupKey);

    const enrichedItem: VendorCatalogItem = {
      ...item,
      clean_lookup_key: cleanLookupKey,
      vendor_nip: sanitizedNip,
      usage_count: item.usage_count || 1,
      last_used_at: new Date().toISOString(),
    };

    // Zapis w pamięci RAM
    this.localCache.set(cacheKey, enrichedItem);

    // Zapis w Firestore
    try {
      if (sanitizedNip) {
        const itemDocRef = doc(db, 'vendor_catalogs', sanitizedNip, 'items', cleanLookupKey);
        await setDoc(itemDocRef, enrichedItem, { merge: true });
      }
    } catch (err) {
      console.warn('[VendorMemoryAgent] Failed to persist learned rule in Firestore:', err);
    }
  }

  /**
   * Pobiera wszystkie reguły dla danego dostawcy (lub wszystkie preseedy)
   */
  static getAllRules(vendorNip?: string): VendorCatalogItem[] {
    this.initializeCache();
    const sanitizedNip = vendorNip ? vendorNip.replace(/\D/g, '') : null;
    const result: VendorCatalogItem[] = [];

    for (const [key, item] of this.localCache.entries()) {
      if (!sanitizedNip || key.startsWith(sanitizedNip + '::')) {
        result.push(item);
      }
    }

    return result;
  }
}
